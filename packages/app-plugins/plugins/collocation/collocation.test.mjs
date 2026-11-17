// The collocation panel's pure seams: tokenising, document selection,
// co-occurrence counts and Fisher's exact test.
//
// DOM stays untested, as the rest of the UI does. What is tested is the half
// that can be wrong while looking right. Split out of the package's former
// visualisation.test.mjs, one file per panel.
//
//   npm test -w collection2crate-plugins -- collocation.test.mjs
import assert from "node:assert/strict";
import { analyzeCollocations, documentsForSelection, fisherExact, tokenize as tokenizeCollocations } from "./index.js";

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

check("tokenises Unicode words and matches nodes without case", () => {
  assert.deepEqual(tokenizeCollocations("YOLNGU-matha ŋurra don't"), ["yolngu-matha", "ŋurra", "don't"]);
  const rows = analyzeCollocations(docs("YOLNGU-matha ŋurra"), { nodes: "yolngu-matha", minFreq: 1, spanLeft: 1, spanRight: 1 });
  assert.equal(rows[0].collocate, "ŋurra");
});

check("uses one corpus stream and independent left/right windows", () => {
  const rows = analyzeCollocations(docs("left node right", "after"), {
    nodes: "node", minFreq: 1, spanLeft: 1, spanRight: 2,
  });
  assert.deepEqual(rows.map((row) => row.collocate), ["left", "right", "after"]);
});

check("handles comma-separated nodes and frequency filtering", () => {
  const rows = analyzeCollocations(docs("a x b a x b"), {
    nodes: "a, b, missing", minFreq: 2, spanLeft: 1, spanRight: 1,
  });
  assert.deepEqual(rows.map((row) => [row.node, row.collocate, row.O]), [["a", "x", 2], ["b", "x", 2]]);
});

check("returns hand-worked association measures and stable columns", () => {
  const [row] = analyzeCollocations(docs("a b c a b c"), {
    nodes: "a", minFreq: 2, spanLeft: 1, spanRight: 1,
  }).filter((candidate) => candidate.collocate === "b");
  assert.deepEqual(Object.keys(row), [
    "node", "collocate", "O", "E", "f_node", "f_collocate", "N", "OE", "MI", "MI2", "MI3",
    "G2", "tscore", "DeltaP12", "DeltaP21", "Fisher",
  ]);
  assert.equal(row.O, 2);
  assert.equal(row.E, 2 * 2 / 6);
  assert.ok(Math.abs(row.MI - Math.log2(3)) < 1e-9);
  assert.ok(Math.abs(row.tscore - (2 - 2 / 3) / Math.SQRT2) < 1e-9);
  assert.ok(Math.abs(row.Fisher - 1 / 15) < 1e-9);
});

check("Fisher exact handles a known table and large tables", () => {
  assert.ok(Math.abs(fisherExact(2, 0, 0, 4) - 1 / 15) < 1e-9);
  assert.equal(fisherExact(0, 0, 0, 2001), 1);
});

check("selects one file and combines selected CSV columns", () => {
  const documents = [
    { source: "notes.txt", text: "node note" },
    { source: "data.csv", text: "node ignored" },
  ];
  const tables = [{
    source: "data.csv",
    header: ["text", "translation", "speaker"],
    rows: [["node", "ŋurra", "CHI"]],
  }];
  assert.deepEqual(
    documentsForSelection(documents, tables, "data.csv", ["text", "translation"]).map((row) => row.text),
    ["node ŋurra"],
    "selected CSV columns become one analysis document per row"
  );
  assert.deepEqual(
    documentsForSelection(documents, tables, "notes.txt").map((row) => row.text),
    ["node note"],
    "non-CSV sources keep their existing document text"
  );
});

await Promise.all(asyncChecks);

if (failures) {
  console.error(`\ncollocation.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
