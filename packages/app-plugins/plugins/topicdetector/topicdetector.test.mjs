// The topic detector panel's pure seams: vocabulary, seeded and plain LDA,
// and the top terms reported per topic.
//
// DOM stays untested, as the rest of the UI does. What is tested is the half
// that can be wrong while looking right. Split out of the package's former
// visualisation.test.mjs, one file per panel.
//
//   npm test -w collection2crate-plugins -- topicdetector.test.mjs
import assert from "node:assert/strict";
import { buildSeedDictionary, buildVocabulary, fitLDA, fitSeededLDA, topTermsPerTopic, documentsForSelection as documentsForTopicSelection, tokenize as tokenizeTopics } from "./index.js";

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

check("tokenises Unicode words and drops single characters and pure numbers", () => {
  assert.deepEqual(tokenizeTopics("Yolŋu-matha a 123 don't 2026"), ["yolŋu-matha", "don't"]);
});

check("table rows are independent documents while plain-file lines merge into one document", () => {
  const flat = [
    { source: "a.txt", text: "first line" },
    { source: "a.txt", text: "second line" },
  ];
  const tables = [{ source: "b.csv", header: ["text"], rows: [["row one"], ["row two"]] }];
  const docs = documentsForTopicSelection(flat, tables, ["a.txt", "b.csv"], []);
  assert.deepEqual(docs.map((d) => [d.source, d.label || "", d.text]), [
    ["a.txt", "", "first line second line"],
    ["b.csv", "b.csv · row 1", "row one"],
    ["b.csv", "b.csv · row 2", "row two"],
  ]);
});

check("buildVocabulary trims by frequency and drops emptied documents", () => {
  const docs = [["a", "a", "b"], ["a", "c"], ["z"]];
  const { vocabulary, documents, keptDocumentIndexes, droppedDocumentIndexes } =
    buildVocabulary(docs, { minTermFreq: 2, minDocFreq: 2 });
  assert.deepEqual(vocabulary, ["a"]);
  assert.deepEqual(keptDocumentIndexes, [0, 1]);
  assert.deepEqual(droppedDocumentIndexes, [2], "the doc with only 'z' has nothing left after trimming");
  assert.deepEqual(documents, [[0, 0], [0]]);
});

check("fitLDA is deterministic for a fixed seed", () => {
  const docs = [[0, 1, 0, 1], [1, 2, 1, 2], [0, 0, 2, 2]];
  const a = fitLDA(docs, 3, { k: 2, seed: 7, iterations: 25 });
  const b = fitLDA(docs, 3, { k: 2, seed: 7, iterations: 25 });
  assert.deepEqual(a.termTopicWeights, b.termTopicWeights);
  assert.deepEqual(a.docTopicWeights, b.docTopicWeights);
});

check("topTermsPerTopic orders most probable term first", () => {
  const vocabulary = ["apple", "banana", "cherry"];
  const weights = [[0.1, 0.7, 0.2], [0.6, 0.1, 0.3]];
  assert.deepEqual(topTermsPerTopic(weights, vocabulary, 2), [
    ["banana", "cherry"], ["apple", "cherry"],
  ]);
});

check("buildSeedDictionary drops empty topics and throws when none have words", () => {
  const dict = buildSeedDictionary(["Fruit", "Empty"], [["apple", "banana"], []]);
  assert.deepEqual(dict.map((t) => t.name), ["Fruit"]);
  assert.throws(() => buildSeedDictionary(["A", "B"], [[], []]));
});

check("fitSeededLDA pulls a seed-word-dominated document toward its topic, and an unmatched one toward 'other'", () => {
  const vocabulary = ["apple", "banana", "rocket", "engine"];
  // doc 0/1: fruit words; doc 2: unrelated to any seed word.
  const docs = [
    [0, 1, 0, 1, 0], [1, 0, 1, 0, 1],
    [2, 3, 2, 3, 2],
  ];
  const dict = buildSeedDictionary(["Fruit"], [["apple", "banana"]]);
  const result = fitSeededLDA(docs, vocabulary, dict, { seed: 3, iterations: 50 });
  assert.deepEqual(result.topicNames, ["Fruit", "other"]);
  const best = result.docTopicWeights.map((w) => w.indexOf(Math.max(...w)));
  assert.equal(best[0], 0, "a fruit-heavy document is assigned to the seeded topic");
  assert.equal(best[1], 0);
  assert.equal(best[2], 1, "a document matching no seed word falls to the residual topic");
});

await Promise.all(asyncChecks);

if (failures) {
  console.error(`\ntopicdetector.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
