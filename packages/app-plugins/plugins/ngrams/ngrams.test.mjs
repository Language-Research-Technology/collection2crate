// The ngrams panel's pure seams: tokenising, and n-grams that never run
// across a speaker change.
//
// DOM stays untested, as the rest of the UI does. What is tested is the half
// that can be wrong while looking right. Split out of the package's former
// visualisation.test.mjs, one file per panel.
//
//   npm test -w collection2crate-plugins -- ngrams.test.mjs
import assert from "node:assert/strict";
import { analyzeNgrams } from "./index.js";
import { tokenize } from "../../lib/_tokenize.js";

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

check("tokenises non-ASCII orthographies as words", () => {
  assert.deepEqual(tokenize("Yolŋu-matha ŋurra don't"), ["yolŋu-matha", "ŋurra", "don't"],
    "the whole point of not using [A-Za-z0-9]");
});

check("counts n-grams and ranks them by frequency", () => {
  const rows = analyzeNgrams(docs("a b a b", "a b"), { n: 2, minFreq: 1 });
  const ab = rows.find((r) => r.ngram === "a b");
  assert.equal(ab.count, 3);
  assert.equal(rows[0].ngram, "a b", "most frequent first");
});

check("an n-gram never spans two documents", () => {
  // "b c" would exist only by running the window across the boundary.
  const rows = analyzeNgrams(docs("a b", "c d"), { n: 2, minFreq: 1 });
  assert.deepEqual(rows.map((r) => r.ngram).sort(), ["a b", "c d"]);
});

check("minimum frequency and stopwords filter rows out", () => {
  const corpus = docs("the cat sat", "the cat ran", "the cat sat");
  assert.equal(analyzeNgrams(corpus, { n: 2, minFreq: 3 }).length, 1, "only 'the cat' occurs three times");
  const noStop = analyzeNgrams(corpus, { n: 2, minFreq: 1, removeStopwords: true });
  assert.ok(!noStop.some((r) => r.ngram.split(" ").includes("the")),
    "a stopword anywhere in the n-gram drops it");
});

check("stopwords are not removed unless asked", () => {
  const rows = analyzeNgrams(docs("the cat", "the cat"), { n: 2, minFreq: 1 });
  assert.equal(rows[0].ngram, "the cat",
    "the default keeps them: the list is English and the corpus may not be");
});

check("MI and t-score, against hand-worked numbers", () => {
  // "a b" twice in "a b c a b c": N=6 tokens, f(a)=2, f(b)=2, O=2.
  // expected = 2*2/6 = 0.666… ; MI = log2(2/0.666…) = log2(3) ≈ 1.585
  // t = (2 - 0.666…)/sqrt(2) ≈ 0.943
  const [row] = analyzeNgrams(docs("a b c a b c"), { n: 2, minFreq: 2 });
  assert.equal(row.ngram, "a b");
  assert.ok(Math.abs(row.mi - Math.log2(3)) < 1e-9, `MI was ${row.mi}`);
  assert.ok(Math.abs(row.tScore - (2 - 4 / 6) / Math.SQRT2) < 1e-9, `t was ${row.tScore}`);
});

check("no association measures for anything but bigrams", () => {
  const [row] = analyzeNgrams(docs("a b c a b c"), { n: 3, minFreq: 2 });
  assert.ok(!("mi" in row) && !("tScore" in row), "MI is defined for pairs, not triples");
});

await Promise.all(asyncChecks);

if (failures) {
  console.error(`\nngrams.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
