// lib/_tokenize.js: the word tokens every text-analysis panel counts.
//
//   npm test -w collection2crate-plugins -- tokenize
import assert from "node:assert/strict";
import { tokenize } from "./_tokenize.js";

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

check("keeps non-English letters and combining marks inside a word", () => {
  assert.deepEqual(tokenize("Yolŋu ŋurra café"), ["yolŋu", "ŋurra", "café"]);
  assert.deepEqual(tokenize("café"), ["café"], "a combining accent is part of its word");
});

check("joins a word across a straight or curly apostrophe and a hyphen", () => {
  assert.deepEqual(tokenize("don't can’t Yolŋu-matha"), ["don't", "can’t", "yolŋu-matha"]);
});

check("a joining mark at a word's edge is not part of it", () => {
  assert.deepEqual(tokenize("-word- 'quoted' a--b"), ["word", "quoted", "a", "b"]);
});

check("punctuation and spaces split words; digits are words", () => {
  assert.deepEqual(tokenize("one, two. three!\n2026"), ["one", "two", "three", "2026"]);
});

check("lowercases by default and keeps case when asked", () => {
  assert.deepEqual(tokenize("The Cat SAT"), ["the", "cat", "sat"]);
  assert.deepEqual(tokenize("The Cat SAT", { lowercase: false }), ["The", "Cat", "SAT"]);
});

check("empty, null, undefined and non-string input give no tokens or a string's tokens", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
  assert.deepEqual(tokenize(42), ["42"]);
});

check("repeated calls give the same answer (the pattern holds no state between calls)", () => {
  const text = "alpha beta gamma";
  assert.deepEqual(tokenize(text), tokenize(text));
});

if (failures) {
  console.error(`\ntokenize.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
