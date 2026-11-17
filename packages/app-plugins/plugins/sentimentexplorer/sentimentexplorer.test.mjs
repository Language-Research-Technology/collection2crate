// The sentiment explorer panel's pure seams: the NRC lexicon parser,
// per-section annotation, and the summary it reports.
//
// DOM stays untested, as the rest of the UI does. What is tested is the half
// that can be wrong while looking right. Split out of the package's former
// visualisation.test.mjs, one file per panel.
//
//   npm test -w collection2crate-plugins -- sentimentexplorer.test.mjs
import assert from "node:assert/strict";
import { analyzeSentiment, annotateSection, buildSummary, parseNrcLexiconCsv } from "./index.js";
import { documentsForSelection as documentsForSentimentSelection } from "../../lib/_documents.js";

let failures = 0;
const asyncChecks = [];
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};
const checkAsync = (label, fn) => {
  asyncChecks.push((async () => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
  })());
};

check("parses the LADAL NRC CSV into case-normalized word categories", () => {
  const parsed = parseNrcLexiconCsv('\uFEFF"word","sentiment"\r\n"Excellent","joy"\r\n"excellent","positive"\r\n"excellent","trust"\r\n');
  assert.deepEqual([...parsed.get("excellent")], ["joy", "positive", "trust"]);
});

check("rejects invalid or empty NRC CSV instead of returning an empty lexicon", () => {
  assert.throws(() => parseNrcLexiconCsv(""), /empty/);
  assert.throws(() => parseNrcLexiconCsv('"word","sentiment"\n"term","unknown"'), /Invalid NRC/);
});

const lexicon = new Map([
  ["excellent", new Set(["joy", "positive", "trust"])],
  ["sad", new Set(["sadness", "negative"])],
]);

check("annotates a word belonging to several categories at once", () => {
  const [row] = annotateSection(["excellent"], "s1", lexicon);
  assert.equal(row.joy, 1);
  assert.equal(row.positive, 1);
  assert.equal(row.trust, 1);
  assert.equal(row.anger, 0);
});

check("a word absent from the lexicon annotates as all zeros", () => {
  const [row] = annotateSection(["unknown"], "s1", lexicon);
  assert.ok(Object.entries(row).every(([key, value]) => key === "section" || key === "token_index" || key === "word" || value === 0));
});

check("buildSummary counts and rounds percentages per section", () => {
  const rows = [
    ...annotateSection(["excellent", "sad"], "s1", lexicon),
    ...annotateSection(["excellent"], "s2", lexicon),
  ];
  const summary = buildSummary(rows);
  const s1 = summary.find((row) => row.section === "s1");
  assert.equal(s1.total_tokens, 2);
  assert.equal(s1.joy_n, 1);
  assert.equal(s1.joy_pct, 50);
});

check("a token never crosses a section boundary", () => {
  const { annotated } = analyzeSentiment(
    [{ source: "a.txt", text: "excellent" }, { source: "b.txt", text: "sad" }],
    lexicon,
  );
  assert.deepEqual(annotated.map((row) => [row.section, row.token_index]), [["a.txt", 1], ["b.txt", 1]]);
});

check("selects one file and combines selected CSV columns, same as collocation", () => {
  const documents = [{ source: "notes.txt", text: "excellent" }];
  const tables = [{
    source: "data.csv",
    header: ["text", "note"],
    rows: [["sad", "extra"]],
  }];
  assert.deepEqual(
    documentsForSentimentSelection(documents, tables, "data.csv", ["text"]).map((row) => row.text),
    ["sad"],
  );
  assert.deepEqual(
    documentsForSentimentSelection(documents, tables, "notes.txt").map((row) => row.text),
    ["excellent"],
  );
});

check("selects multiple files at once, each keeping its own source", () => {
  const documents = [{ source: "notes.txt", text: "excellent" }];
  const tables = [
    { source: "data.csv", header: ["text", "note"], rows: [["sad", "extra"]] },
    { source: "other.csv", header: ["text"], rows: [["joy"]] },
  ];
  const rows = documentsForSentimentSelection(documents, tables, ["notes.txt", "data.csv", "other.csv"], ["text"]);
  assert.deepEqual(rows.map((row) => [row.source, row.text]), [
    ["notes.txt", "excellent"], ["data.csv", "sad"], ["other.csv", "joy"],
  ]);
});

check("an explicit empty selection means nothing, not everything", () => {
  const documents = [{ source: "notes.txt", text: "excellent" }];
  assert.deepEqual(documentsForSentimentSelection(documents, [], []), []);
  assert.deepEqual(documentsForSentimentSelection(documents, [], undefined), documents);
});

check("a per-file column Map picks a different column from each selected table", () => {
  const tables = [
    { source: "a.csv", header: ["text", "note"], rows: [["ignored", "from-a"]] },
    { source: "b.csv", header: ["translation", "text"], rows: [["from-b", "ignored"]] },
  ];
  const columns = new Map([["a.csv", ["note"]], ["b.csv", ["translation"]]]);
  const rows = documentsForSentimentSelection([], tables, ["a.csv", "b.csv"], columns);
  assert.deepEqual(rows.map((row) => [row.source, row.text]), [
    ["a.csv", "from-a"], ["b.csv", "from-b"],
  ]);
});

await Promise.all(asyncChecks);

if (failures) {
  console.error(`\nsentimentexplorer.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
