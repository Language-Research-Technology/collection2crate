// The concordance panel's pure seams: which documents a selection covers,
// and how a search window is cut around each match.
//
// DOM stays untested, as the rest of the UI does. What is tested is the half
// that can be wrong while looking right. Split out of the package's former
// visualisation.test.mjs, one file per panel.
//
//   npm test -w collection2crate-plugins -- concordance.test.mjs
import assert from "node:assert/strict";
import { search, searchAsync } from "./index.js";
import { documentsForSelection as documentsForConcordanceSelection } from "../../lib/_documents.js";

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


const docs = (...lines) => lines.map((text, i) => ({ id: `d${i}`, source: "test.csv", speaker: "", text }));

check("selects all files, a text source, or chosen CSV columns", () => {
  const documents = [
    { source: "notes.txt", text: "climate notes" },
    { source: "data.csv", text: "climate fallback" },
  ];
  const tables = [{
    source: "data.csv",
    header: ["text", "note"],
    rows: [["climate report", "other climate"]],
  }];
  assert.deepEqual(
    documentsForConcordanceSelection(documents, tables, "__all__"),
    documents,
  );
  assert.deepEqual(
    documentsForConcordanceSelection(documents, tables, "notes.txt").map((document) => document.text),
    ["climate notes"],
  );
  assert.deepEqual(
    documentsForConcordanceSelection(documents, tables, "data.csv", ["note"]).map((document) => document.text),
    ["other climate"],
  );
});

check("finds every occurrence, with a window either side", () => {
  const rows = search(docs("the quick brown fox jumps over the lazy dog"), "fox", { windowSize: 2 });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { left: rows[0].left, keyword: rows[0].keyword, right: rows[0].right },
    { left: "quick brown", keyword: "fox", right: "jumps over" },
    "two words either side, and the keyword exactly as written"
  );
});

check("a window wider than the text takes what there is", () => {
  const [row] = search(docs("fox jumps"), "fox", { windowSize: 5 });
  assert.equal(row.left, "", "nothing to the left of the first word");
  assert.equal(row.right, "jumps");
});

check("case-insensitive by default, and reports what it matched", () => {
  const rows = search(docs("Fox and fox"), "fox", { windowSize: 2 });
  assert.deepEqual(rows.map((r) => r.keyword), ["Fox", "fox"],
    "each row carries the text as it appeared, not the query");
  assert.equal(search(docs("Fox and fox"), "fox", { caseSensitive: true }).length, 1);
});

check("whole word only matches whole words", () => {
  assert.equal(search(docs("the foxes ran"), "fox", { wholeWord: true }).length, 0);
  assert.equal(search(docs("the fox ran"), "fox", { wholeWord: true }).length, 1);
});

check("a literal query is not read as a pattern", () => {
  assert.equal(search(docs("a.b and axb"), "a.b").length, 1,
    "the dot is a dot unless regex is on");
  assert.equal(search(docs("a.b and axb"), "a.b", { regex: true }).length, 2);
});

check("fixed matching treats the query as an exact literal", () => {
  assert.equal(search(docs("climate change and climate"), "climate", { matchType: "fixed" }).length, 2);
  assert.equal(search(docs("climate change"), "climate change", { matchType: "fixed" }).length, 1);
});

check("glob matching treats brackets literally and supports ? and * wildcards", () => {
  assert.deepEqual(
    search(docs("woman women womxn"), "wom[ae]n", { matchType: "glob" }).map((row) => row.keyword),
    [],
    "glob metacharacters are not interpreted as regular expressions"
  );
  assert.deepEqual(
    search(docs("woman women womxn"), "wom?n", { matchType: "glob" }).map((row) => row.keyword),
    ["woman", "women", "womxn"],
    "? matches any single character",
  );
  assert.deepEqual(
    search(docs("the economy"), "the *", { matchType: "glob" }).map((row) => row.keyword),
    ["the economy"],
  );
});

check("a pattern that can match nothing still terminates", () => {
  // Would spin forever on a zero-length match without the guard.
  const rows = search(docs("aaa"), "b*", { regex: true });
  assert.ok(Array.isArray(rows), "returned rather than hanging");
});

check("an invalid pattern throws for the panel to report", () => {
  assert.throws(() => search(docs("x"), "(unclosed", { regex: true }));
});

check("searches every document and says which it came from", () => {
  const two = [
    { source: "a.csv", speaker: "CHI", text: "fox one" },
    { source: "b.csv", speaker: "MOT", text: "fox two" },
  ];
  assert.deepEqual(search(two, "fox").map((r) => [r.source, r.speaker]),
    [["a.csv", "CHI"], ["b.csv", "MOT"]]);
});

checkAsync("async search returns the same matches while reporting progress", async () => {
  const documents = Array.from({ length: 25 }, (_, index) => ({
    source: `doc-${index}.txt`, text: index % 2 ? "climate policy" : "other text",
  }));
  const progress = [];
  const rows = await searchAsync(documents, "climate", { matchType: "fixed" }, (value) => progress.push(value));
  assert.deepEqual(rows, search(documents, "climate", { matchType: "fixed" }));
  assert.deepEqual(progress, [0.4, 0.8, 1]);
});

await Promise.all(asyncChecks);

if (failures) {
  console.error(`\nconcordance.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
