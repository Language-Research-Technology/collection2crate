// textcleaner: automated tests for the pure cleaning engine, stats calculation,
// destination path resolution, and plugin contract.
//
// Run with:
//   node textcleaner.test.mjs

import assert from "node:assert/strict";
import {
  cleanText,
  calculateStats,
  defaultCleaningOptions,
  resolveDestinationPath,
  PREBUILT_RULES,
  escapeRegex,
} from "./plugins/textcleaner/cleaner.js";
import { createPlugin } from "./plugins/textcleaner/index.js";

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${label}\n       ${e.message}`);
  }
};

console.log("Prebuilt removal options");

check("tags: removes simple and nested XML/HTML tags and attributes", () => {
  const input = "<p class='lead'>Hello <strong>World</strong>! <a href=\"https://example.com\">Link</a></p>";
  const output = cleanText(input, { prebuilt: ["tags"] });
  assert.equal(output, "Hello World! Link");
});

check("nonalpha: preserves Unicode letters and numbers while removing symbols and punctuation", () => {
  const input = "Héllo, wörld! 123 #cool @user; café-au-lait. æ, ø, å, ñ.";
  const output = cleanText(input, { prebuilt: ["nonalpha"] });
  assert.equal(output, "Héllo wörld 123 cool user caféaulait æ ø å ñ");
});

check("punct: removes punctuation while preserving letters, numbers, and whitespace", () => {
  const input = "Hello, world! (123) - [test]: \"quote\".\nNext line.";
  const output = cleanText(input, { prebuilt: ["punct"] });
  assert.equal(output, "Hello world 123  test quote\nNext line");
});

check("numbers: removes all digit sequences", () => {
  const input = "Participant 12 scored 98.5 on test 3.";
  const output = cleanText(input, { prebuilt: ["numbers"] });
  assert.equal(output, "Participant  scored . on test .");
});

check("urls: removes http, https, and www URLs", () => {
  const input = "Visit https://ladal.edu.au or http://example.org/path?q=1 and www.google.com for info.";
  const output = cleanText(input, { prebuilt: ["urls"] });
  assert.equal(output, "Visit  or  and  for info.");
});

check("emails: removes standard email addresses", () => {
  const input = "Contact researcher.name_01@sub.domain.org or user+tag@example.com for details.";
  const output = cleanText(input, { prebuilt: ["emails"] });
  assert.equal(output, "Contact  or  for details.");
});

check("speaker: removes corpus speaker turn markers like [SPEAKER_A]: and <S1A-001$A>", () => {
  const input = "[SPEAKER_1]: Hello there!\n<S1A-001$A> <#> Good morning.\n<B> Yes.\n[P2] Sure.";
  const output = cleanText(input, { prebuilt: ["speaker"] });
  assert.equal(output, " Hello there!\nGood morning.\nYes.\nSure.");
});

check("whitespace: collapses spaces/tabs, limits multiple line breaks, and trims lines", () => {
  const input = "   First   line   with   spaces.\t\t\n\n\n\n\n   Second line.   \n\n   Third line.   ";
  const output = cleanText(input, { prebuilt: ["whitespace"] });
  assert.equal(output, "First line with spaces.\n\nSecond line.\n\nThird line.");
});

console.log("Custom patterns and replacements");

check("custom regex removals: strips matches and gracefully ignores invalid regexes", () => {
  const input = "Foo BAR baz 123 [NOTE: drop this]";
  const output = cleanText(input, {
    customPatterns: [
      "\\[NOTE:.*?\\]",
      "\\bBAR\\b",
      "[invalid(regex", // syntactically invalid, should be skipped safely
      "",
    ],
  });
  assert.equal(output, "Foo  baz 123 ");
});

check("find-and-replace: regex mode supports capture groups ($1, $2)", () => {
  const input = "Date: 2024-05-18, Date: 2025-12-31";
  const output = cleanText(input, {
    replacements: [
      { find: "(\\d{4})-(\\d{2})-(\\d{2})", replace: "$3/$2/$1", isRegex: true },
    ],
  });
  assert.equal(output, "Date: 18/05/2024, Date: 31/12/2025");
});

check("find-and-replace: literal mode with case sensitivity and ignoreCase", () => {
  const input = "Apple and apple and APPLE";
  const sensitive = cleanText(input, {
    replacements: [{ find: "Apple", replace: "Orange", isRegex: false, ignoreCase: false }],
  });
  assert.equal(sensitive, "Orange and apple and APPLE");

  const insensitive = cleanText(input, {
    replacements: [{ find: "Apple", replace: "Fruit", isRegex: false, ignoreCase: true }],
  });
  assert.equal(insensitive, "Fruit and Fruit and Fruit");
});

console.log("Order of operations");

check("order of operations: replacements happen before lowercase, whitespace is last", () => {
  const input = "  <p>Hello  WORLD</p>\n\n\n\n  GoodBYE  ";
  const output = cleanText(input, {
    prebuilt: ["tags", "whitespace"],
    replacements: [{ find: "WORLD", replace: "Universe", isRegex: false }],
    lowercase: true,
  });
  assert.equal(output, "hello universe\n\ngoodbye");
});

console.log("Statistics calculation");

check("calculateStats: computes exact character reduction metrics", () => {
  const original = "Hello World 12345"; // 17 chars
  const cleaned = "Hello World"; // 11 chars
  const stats = calculateStats(original, cleaned);
  assert.deepEqual(stats, {
    originalChars: 17,
    cleanedChars: 11,
    removedChars: 6,
    percentRemoved: 35.3,
  });
});

check("calculateStats: handles empty text without division by zero", () => {
  const stats = calculateStats("", "");
  assert.deepEqual(stats, {
    originalChars: 0,
    cleanedChars: 0,
    removedChars: 0,
    percentRemoved: 0,
  });
});

console.log("Destination path resolution");

check("resolveDestinationPath: preserve mode into subfolder", () => {
  const path = resolveDestinationPath({
    sourcePath: "raw/transcripts/interview-01.txt",
    destinationFolder: "cleaned",
    namingMode: "preserve",
  });
  assert.equal(path, "cleaned/interview-01.txt");
});

check("resolveDestinationPath: suffix mode into subfolder", () => {
  const path = resolveDestinationPath({
    sourcePath: "raw/transcripts/interview-01.txt",
    destinationFolder: "_outputs/cleaned/",
    namingMode: "suffix",
    suffix: "_clean",
  });
  assert.equal(path, "_outputs/cleaned/interview-01_clean.txt");
});

check("resolveDestinationPath: suffix mode alongside source when destination folder is empty", () => {
  const path = resolveDestinationPath({
    sourcePath: "corpus/texts/doc.txt",
    destinationFolder: "",
    namingMode: "suffix",
    suffix: "_cleaned",
  });
  assert.equal(path, "corpus/texts/doc_cleaned.txt");
});

check("resolveDestinationPath: prefix mode into subfolder", () => {
  const path = resolveDestinationPath({
    sourcePath: "raw/interview-01.txt",
    destinationFolder: "cleaned",
    namingMode: "prefix",
    prefix: "clean_",
  });
  assert.equal(path, "cleaned/clean_interview-01.txt");
});

check("resolveDestinationPath: overwrite mode keeps source path exactly", () => {
  const path = resolveDestinationPath({
    sourcePath: "texts/doc.txt",
    destinationFolder: "cleaned",
    placementMode: "overwrite",
  });
  assert.equal(path, "texts/doc.txt");
});

console.log("Plugin contract");

check("createPlugin: returns textcleaner with action optionSchema", () => {
  const plugin = createPlugin({});
  assert.equal(plugin.name, "textcleaner");
  assert.ok(plugin.optionSchema, "plugin has optionSchema");
  assert.equal(plugin.optionSchema.type, "action");
  assert.equal(typeof plugin.optionSchema.run, "function");
  assert.deepEqual(plugin.outputPaths, [{ path: "_config/textcleaner", kind: "dir" }]);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll textcleaner tests passed!");
}
