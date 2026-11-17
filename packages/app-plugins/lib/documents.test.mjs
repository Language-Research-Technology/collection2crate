// lib/_documents.js: which documents a text-analysis panel analyses for the
// sources and columns a person picked.
//
//   npm test -w collection2crate-plugins -- documents
import assert from "node:assert/strict";
import { ALL_SOURCES, documentsForSelection } from "./_documents.js";

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

const documents = [
  { source: "a.txt", text: "first paragraph" },
  { source: "b.txt", text: "other file" },
  { source: "a.txt", text: "second paragraph" },
];
const tables = [
  { source: "t.csv", header: ["id", "text", "note"], rows: [["1", "hello", "n1"], ["2", "", ""], ["3", "world"]] },
  { source: "u.csv", header: ["text", "extra"], rows: [["only", "x"]] },
];
const texts = (docs) => docs.map((doc) => doc.text);

check("every file: ALL_SOURCES, null, undefined or an empty string", () => {
  for (const sources of [ALL_SOURCES, null, undefined, "", [ALL_SOURCES], ["a.txt", ALL_SOURCES]]) {
    assert.deepEqual(documentsForSelection(documents, tables, sources), documents, `for ${JSON.stringify(sources)}`);
  }
});

check("an empty list selects nothing", () => {
  assert.deepEqual(documentsForSelection(documents, tables, []), []);
});

check("a single source and a one-item list select the same documents", () => {
  assert.deepEqual(documentsForSelection(documents, tables, "a.txt"), documentsForSelection(documents, tables, ["a.txt"]));
  assert.deepEqual(texts(documentsForSelection(documents, tables, "a.txt")), ["first paragraph", "second paragraph"]);
});

check("several sources come back in the order they were selected", () => {
  assert.deepEqual(texts(documentsForSelection(documents, tables, ["b.txt", "a.txt"])),
    ["other file", "first paragraph", "second paragraph"]);
});

check("a source that isn't loaded contributes nothing", () => {
  assert.deepEqual(documentsForSelection(documents, tables, ["missing.txt"]), []);
});

check("a table becomes one document per row, from every column when none are chosen", () => {
  assert.deepEqual(documentsForSelection([], tables, "t.csv"), [
    { id: "t.csv#0", source: "t.csv", speaker: "", text: "1 hello n1" },
    { id: "t.csv#1", source: "t.csv", speaker: "", text: "2" },
    { id: "t.csv#2", source: "t.csv", speaker: "", text: "3 world" },
  ]);
});

check("chosen columns supply a row's text, and blank rows are skipped", () => {
  assert.deepEqual(documentsForSelection([], tables, "t.csv", ["text"]).map((doc) => [doc.id, doc.text]),
    [["t.csv#0", "hello"], ["t.csv#2", "world"]], "row 1 has no text in the chosen column");
});

check("one column list applies to every selected table", () => {
  assert.deepEqual(texts(documentsForSelection([], tables, ["t.csv", "u.csv"], ["text"])), ["hello", "world", "only"]);
});

check("a Map chooses columns per table; a table missing from it uses every column", () => {
  const columns = new Map([["t.csv", ["note"]]]);
  assert.deepEqual(texts(documentsForSelection([], tables, ["t.csv", "u.csv"], columns)), ["n1", "only x"]);
});

check("tables and files mix in one selection", () => {
  assert.deepEqual(texts(documentsForSelection(documents, tables, ["u.csv", "b.txt"], ["text"])), ["only", "other file"]);
});

check("missing documents or tables count as none loaded", () => {
  assert.deepEqual(documentsForSelection(null, null, ALL_SOURCES), []);
  assert.deepEqual(documentsForSelection(undefined, undefined, ["a.txt"]), []);
});

check("fileDocuments decides what a file contributes; it is asked once per file source, null for all", () => {
  const asked = [];
  const fileDocuments = (docs, source) => { asked.push(source); return [{ source, text: `${docs.length} docs` }]; };
  assert.deepEqual(documentsForSelection(documents, tables, ALL_SOURCES, [], { fileDocuments }), [{ source: null, text: "3 docs" }]);
  documentsForSelection(documents, tables, ["a.txt", "t.csv", "b.txt"], [], { fileDocuments });
  assert.deepEqual(asked, [null, "a.txt", "b.txt"], "a table source never reaches fileDocuments");
});

check("rowDocument shapes each row, given its 0-based index and untrimmed text", () => {
  const padded = [{ source: "p.csv", header: ["text"], rows: [[" spaced "], ["  "]] }];
  const rowDocument = (source, index, text) => ({ source, index, text });
  assert.deepEqual(documentsForSelection([], padded, "p.csv", [], { rowDocument }),
    [{ source: "p.csv", index: 0, text: " spaced " }], "a whitespace-only row is still skipped");
});

if (failures) {
  console.error(`\ndocuments.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
