// The Text Classifier's pure functions, and its port of THX-01's input and
// probability code checked against what the model's own Python code produced
// (plugins/textclassifier/thx01.fixture.json, from tools/make_fixture.py).
//
//   node textclassifier.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assignLabels, columnValues, compareLabels, confidence, labelCounts, normaliseLabelSet,
  resultsTable, rowsForSelection, splitLabels, withLabelType,
} from "./plugins/textclassifier/engine.js";
import {
  buildHead, buildSequence, normaliseText, probabilities, questionsFor, scoresFromProbabilities, toInternal,
} from "./plugins/textclassifier/thx01.js";
import { MODELS } from "./plugins/textclassifier/models.js";

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};
const close = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

const fixture = JSON.parse(readFileSync(new URL("./plugins/textclassifier/thx01.fixture.json", import.meta.url)));
// The fixture's stand-in tokenizer: one token per character.
const stubEncode = (text) => [...String(text)].map((c) => 10 + (c.codePointAt(0) % 1000));

console.log("THX-01 port against the Python reference");

for (const ref of fixture.sequences) {
  check(`builds the same input as Python: ${ref.name}`, () => {
    const { ids, markers } = buildSequence(stubEncode, ref.state, ref.question);
    assert.deepEqual(markers, ref.markers, "option positions differ");
    assert.deepEqual(ids, ref.ids, "token ids differ");
  });
}

for (const ref of fixture.probabilities) {
  const q = toInternal(ref.question);
  check(`same probabilities as Python: ${q.t} with ${ref.logits.length} options`, () => {
    const p = probabilities(ref.logits, { choice: 0, score: 1, noul: 2 }[q.t]);
    if (q.t === "noul") close(p[1], ref.answer.noul, 1e-4, "P(yes)");
    else {
      Object.values(ref.answer.probabilities).forEach((expected, i) => close(p[i], expected, 1e-4, `option ${i}`));
      close(confidence(p), ref.answer.confidence, 1e-4, "confidence");
    }
  });
}

check("marks long text as truncated, and short text as not", () => {
  const long = fixture.sequences.find((s) => s.name === "long text truncated");
  assert.equal(buildSequence(stubEncode, long.state, long.question).truncated, true);
  assert.equal(buildSequence(stubEncode, "short", long.question).truncated, false);
});

check("collapses runs of spaces and tabs, keeping newlines", () => {
  assert.equal(normaliseText("a  b\t\tc \t d\n\ne"), "a b c d\n\ne");
});

check("one label per row asks one multiple-choice question; any number asks one yes/no per label", () => {
  const single = normaliseLabelSet({ question: "Which?", type: "single", labels: [{ name: "a", description: "x" }, { name: "b", description: "" }] });
  const qs = questionsFor(single);
  assert.equal(qs.length, 1);
  assert.deepEqual(qs[0].question.criteria, { a: "x", b: "" });
  const multi = normaliseLabelSet({ ...single, type: "multi" });
  const mq = questionsFor(multi);
  assert.deepEqual(mq.map((q) => q.question.type), ["noul", "noul"]);
  assert.equal(buildHead(stubEncode, mq[0].question).markers.length, 2);
  assert.deepEqual(scoresFromProbabilities(multi, { a: [0.3, 0.7], b: [0.9, 0.1] }), { a: 0.7, b: 0.1 });
  assert.deepEqual(scoresFromProbabilities(single, { choice: [0.25, 0.75] }), { a: 0.25, b: 0.75 });
});

console.log("\nrows and label sets");

const table = {
  source: "_outputs/roctable/Turn.csv",
  header: ["conversation", "speaker", "text", "theme"],
  rows: [
    ["c1", "A", "We moved to Canberra in 1972.", "migration"],
    ["c1", "B", "", ""],
    ["c1", "A", "I spoke Greek with my grandmother.", "language; family"],
    ["c2", "B", "Mostly the cold.", ""],
  ],
};

check("selects non-empty rows with kept columns and 1-based row numbers", () => {
  const { items, skippedEmpty } = rowsForSelection(table, { textColumn: "text", keepColumns: ["conversation", "text"], labelColumn: "theme" });
  assert.equal(skippedEmpty, 1);
  assert.deepEqual(items.map((i) => i.row), [1, 3, 4]);
  assert.deepEqual(items[0].kept, { conversation: "c1" }, "the text column is not repeated in kept");
  assert.equal(items[1].existing, "language; family");
});

check("filters rows on a column value", () => {
  const { items, filteredOut } = rowsForSelection(table, { textColumn: "text", filter: { column: "conversation", value: "c2" } });
  assert.deepEqual(items.map((i) => i.row), [4]);
  assert.equal(filteredOut, 3);
});

check("lists a column's values, most frequent first", () => {
  assert.deepEqual(columnValues(table, "conversation"), [{ value: "c1", count: 3 }, { value: "c2", count: 1 }]);
});

check("rejects a text column the table does not have", () => {
  assert.throws(() => rowsForSelection(table, { textColumn: "body" }), /no column "body"/);
});

check("label sets: drops empty rows, rejects duplicates and missing names, sets default thresholds", () => {
  const set = normaliseLabelSet({ question: " Q ", type: "multi", labels: [{ name: "a" }, { name: "", description: "" }, { name: "b", threshold: "0.7" }] });
  assert.deepEqual(set.labels, [{ name: "a", description: "", threshold: 0.5 }, { name: "b", description: "", threshold: 0.7 }]);
  assert.equal(set.question, "Q");
  assert.throws(() => normaliseLabelSet({ question: "Q", labels: [{ name: "a" }, { name: "A" }] }), /used twice/);
  assert.throws(() => normaliseLabelSet({ question: "Q", labels: [{ description: "x" }, { name: "b" }] }), /no name/);
  assert.throws(() => normaliseLabelSet({ question: "Q", type: "single", labels: [{ name: "a" }] }), /at least two/);
  assert.throws(() => normaliseLabelSet({ question: "", labels: [{ name: "a" }, { name: "b" }] }), /question/);
  assert.throws(() => normaliseLabelSet({ question: "Q", type: "multi", labels: [{ name: "a", threshold: 2 }] }), /between 0 and 1/);
  assert.equal(normaliseLabelSet({ question: "", type: "multi", labels: [{ name: "a" }] }).labels.length, 1, "multi needs no question");
});

check("switching label type drops 'none' for any number of labels and restores it for one per row", () => {
  const set = { question: "Q", type: "single", labels: [{ name: "a", description: "x" }, { name: "None", description: "nothing" }] };
  const multi = withLabelType(set, "multi");
  assert.deepEqual(multi.labels.map((l) => l.name), ["a"]);
  assert.deepEqual(withLabelType(multi, "single").labels.map((l) => l.name), ["a", "none"]);
  assert.deepEqual(withLabelType(set, "single").labels.map((l) => l.name), ["a", "None"], "an existing none is not added twice");
});

check("any number of labels asks the model to judge a statement per label", () => {
  const set = normaliseLabelSet({ type: "multi", labels: [{ name: "work", description: "jobs and careers" }, { name: "food" }] });
  assert.deepEqual(questionsFor(set).map((q) => q.question.instructions),
    ["The text is about work: jobs and careers.", "The text is about food."]);
});

console.log("\nassigning and comparing labels");

const single = normaliseLabelSet({ question: "Q", type: "single", labels: [{ name: "migration" }, { name: "language" }, { name: "none" }] });
const multi = normaliseLabelSet({ question: "Q", type: "multi", labels: [{ name: "language", threshold: 0.5 }, { name: "family", threshold: 0.8 }] });

check("one label per row takes the most probable label, with entropy confidence", () => {
  const a = assignLabels({ migration: 0.7, language: 0.2, none: 0.1 }, single);
  assert.deepEqual(a.labels, ["migration"]);
  close(a.confidence, 1 - (-(0.7 * Math.log(0.7) + 0.2 * Math.log(0.2) + 0.1 * Math.log(0.1))) / Math.log(3), 1e-12, "confidence");
  close(confidence([1 / 3, 1 / 3, 1 / 3]), 0, 1e-12, "uniform");
});

check("any number of labels uses each label's own threshold", () => {
  assert.deepEqual(assignLabels({ language: 0.5, family: 0.79 }, multi).labels, ["language"]);
  assert.deepEqual(assignLabels({ language: 0.49, family: 0.8 }, multi).labels, ["family"]);
});

check("splits existing label cells on ; and |", () => {
  assert.deepEqual(splitLabels(" a ;b| c "), ["a", "b", "c"]);
  assert.deepEqual(splitLabels(""), []);
});

check("compares one label per row: agreement, precision, recall, confusion, unmatched values", () => {
  const rows = [
    { assigned: ["migration"], existing: "Migration" },
    { assigned: ["migration"], existing: "language" },
    { assigned: ["language"], existing: "language" },
    { assigned: ["none"], existing: "" },
    { assigned: ["none"], existing: "weather" },
  ];
  const c = compareLabels(rows, single);
  assert.equal(c.compared, 4);
  assert.equal(c.agreed, 2);
  assert.deepEqual(c.disagreements, [1, 4]);
  const migration = c.perLabel.find((p) => p.label === "migration");
  assert.deepEqual([migration.support, migration.assigned, migration.truePositive], [1, 2, 1]);
  assert.equal(migration.precision, 0.5);
  assert.equal(migration.recall, 1);
  assert.equal(c.perLabel.find((p) => p.label === "none").recall, null, "no existing 'none' rows: recall undefined");
  assert.equal(c.confusion.counts.language.migration, 1);
  assert.equal(c.confusion.counts.migration.migration, 1);
  assert.deepEqual(c.unmatched, [{ value: "weather", count: 1 }]);
});

check("compares any number of labels as sets", () => {
  const c = compareLabels([
    { assigned: ["language", "family"], existing: "family; language" },
    { assigned: ["language"], existing: "language|family" },
  ], multi);
  assert.equal(c.agreed, 1);
  assert.equal(c.perLabel.find((p) => p.label === "family").recall, 0.5);
  assert.equal(c.confusion, null);
});

check("counts rows per label", () => {
  assert.deepEqual(labelCounts([{ labels: ["language"] }, { labels: ["language", "family"] }, { labels: [] }], multi),
    [{ label: "language", count: 2 }, { label: "family", count: 1 }]);
});

check("builds the results table, leaving out rows a stopped run never reached", () => {
  const { items } = rowsForSelection(table, { textColumn: "text", keepColumns: ["conversation"] });
  const results = [
    { scores: { migration: 0.9, language: 0.05, none: 0.05 }, truncated: false },
    { scores: { migration: 0.1, language: 0.8, none: 0.1 }, truncated: true },
    null,
  ];
  const t = resultsTable(items, results, single, { keepColumns: ["conversation"], textColumn: "text" });
  assert.deepEqual(t.header, ["row", "conversation", "text", "label", "p_migration", "p_language", "p_none", "confidence", "truncated"]);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[1].slice(0, 7), ["3", "c1", "I spoke Greek with my grandmother.", "language", "0.1", "0.8", "0.1"]);
  assert.equal(t.rows[1][8], "true");
});

console.log("\nmodels");

check("every model entry has what the panel needs", () => {
  for (const m of MODELS) {
    for (const field of ["id", "name", "serves", "files", "licence", "source", "credit"]) assert.ok(m[field], `${m.id} lacks ${field}`);
    assert.equal(typeof m.load, "function");
    assert.ok(["description", "example"].includes(m.serves));
  }
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
