// The transcript parser's line grammar — the part that decides what is a turn
// and what is a continuation of the turn before it. Everything downstream (the
// CSV, the CHAT export, the crate's Person entities) is derived from the rows
// this produces, so a line shape it fails to recognise doesn't produce a
// warning: it produces an empty CSV.
//
//   node transcript.test.mjs
import assert from "node:assert/strict";

import { processTranscriptText, toCsv, parseRows, mergeContinuationLines, normalizeText, parseSpeakerDetails, buildSpeakerPersonEntities, paragraphNumbersByLine, nearMissMarker } from "./plugins/ca-data-prep/process.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

const doc = (turns) => [
  "\tTranscript: demo", "",
  "Speakers:",
  "D:\tDora [Dora Leung] (Australian, male) #dora",
  "S:\tSona [Sona Johnson] (Chinese, female) #sona",
  "C:\tCharlie (research assistant) #charlie", "",
  "PRELIMINARIES", turns[0], "",
  "MAIN", turns[1], turns[2], "",
  "POSTLIMINARIES", turns[3],
].join("\n\n");

const UNNUMBERED = doc(["C:\tcan you tell me your name again?", "D:\thi", "S:\thi ((smiles))", "S:\toh (0.2) @"]);
const NUMBERED = doc(["1\tC:\tcan you tell me your name again?", "4\tD:\thi", "5\tS:\thi ((smiles))", "9\tS:\toh (0.2) @"]);
const NUMBERED_WITH_PERIOD = doc(["1.\tC:\tcan you tell me your name again?", "4.\tD:\thi", "5.\tS:\thi ((smiles))", "9.\tS:\toh (0.2) @"]);

const shape = (result) => result.rows.map((r) => `${r.section}/${r.speakerID}/${r.text}`);

console.log("Turn lines");

await check("an unnumbered transcript parses its turns and sections", async () => {
  const { rows } = await processTranscriptText(UNNUMBERED, {});
  assert.deepEqual(rows.map((r) => r.section), ["PRE", "MAIN", "MAIN", "POST"]);
  assert.deepEqual(rows.map((r) => r.speakerID), ["#charlie", "#dora", "#sona", "#sona"]);
});

await check("a leading turn-number column parses identically, and the number is kept", async () => {
  const numbered = await processTranscriptText(NUMBERED, {});
  const plain = await processTranscriptText(UNNUMBERED, {});
  assert.deepEqual(shape(numbered), shape(plain));
  assert.deepEqual(numbered.rows.map((r) => r.turnNumber), ["1", "4", "5", "9"]);
  assert.deepEqual(plain.rows.map((r) => r.turnNumber), ["", "", "", ""]);
});

await check("a dotted turn-number column parses identically, and the number is kept without its period", async () => {
  const numbered = await processTranscriptText(NUMBERED_WITH_PERIOD, {});
  const plain = await processTranscriptText(UNNUMBERED, {});
  assert.deepEqual(shape(numbered), shape(plain));
  assert.deepEqual(numbered.rows.map((r) => r.turnNumber), ["1", "4", "5", "9"]);
});

await check("the CSV leads with the turn number, empty where a row has none", async () => {
  const numbered = toCsv((await processTranscriptText(NUMBERED, {})).rows).split("\n");
  assert.equal(numbered[0], "turnNumber,speakerID,text,section");
  assert.equal(numbered[1], "1,#charlie,can you tell me your name again?,PRE");
  const plain = toCsv((await processTranscriptText(UNNUMBERED, {})).rows).split("\n");
  assert.equal(plain[1], ",#charlie,can you tell me your name again?,PRE");
});

await check("a numbered transcript keeps its section markers", () => {
  // The failure this guards is silent and total: before the turn-number
  // prefix was allowed, every numbered line counted as a continuation, so the
  // whole transcript — section markers included — was glued onto the last
  // speaker line of the Speakers block and parseRows returned nothing.
  const rows = parseRows(mergeContinuationLines(normalizeText(NUMBERED)));
  assert.equal(rows.length, 4, "expected four turns, one per section marker plus two in MAIN");
  assert.ok(rows.every((r) => !/^\d/.test(r.text)), "a turn number leaked into the turn's text");
});

await check("a continuation line still folds into the turn above it", async () => {
  const withWrap = NUMBERED.replace("4\tD:\thi", "4\tD:\thi\n\nand hello again");
  const { rows } = await processTranscriptText(withWrap, {});
  assert.equal(rows[1].text, "hi and hello again");
});

await check("a line with no speaker code folds into the turn above without being reported", () => {
  // The report is only worth reading if it is quiet when nothing is wrong. A
  // wrapped line is repaired before the body is scanned, so it is not a
  // finding — an earlier version scanned the pre-repair text and filed one
  // "unreviewed line" warning for every wrapped line in the document.
  const malformed = doc(["C:\tcan you tell me your name again?", "D:\thi", "this is a wrap of the line above", "S:\tbye"]);
  return processTranscriptText(malformed, {}).then((result) => {
    assert.equal(result.nonConforming.body.length, 0, "a repaired wrap should not be reported as non-conforming");
    assert.ok(
      result.rows.some((row) => row.text.includes("this is a wrap of the line above")),
      "the wrapped text should have folded into the turn above it",
    );
  });
});

await check("a numeral that isn't a turn number doesn't become a turn", () => {
  const rows = parseRows(mergeContinuationLines(normalizeText(
    doc(["C:\tin 1998 Budget: the figure was", "D:\thi", "S:\thi", "S:\tbye"])
  )));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].text, "in 1998 Budget: the figure was");
});

await check("a stray line at the top of a section is reported, not glued onto the marker", () => {
  // Two failures at once if a section's first line is a stray: the marker
  // stops being an exact match, so the section boundary disappears, and the
  // text is credited to the last turn of the section before it.
  const stray = doc(["C:\tcan you tell me your name again?", "a stray opening line", "D:\thi", "S:\tbye"]);
  return processTranscriptText(stray, {}).then((result) => {
    assert.deepEqual(result.rows.map((row) => row.section), ["PRE", "MAIN", "POST"], "the section boundaries were lost");
    assert.ok(
      !result.rows.some((row) => row.text.includes("a stray opening line")),
      "the stray line was credited to a turn in another section",
    );
    const kinds = result.nonConforming.body.flatMap((entry) => entry.issues.map((issue) => issue.kind));
    assert.ok(kinds.includes("speaker-code-missing"), `expected a missing-code finding, got ${kinds.join(", ")}`);
  });
});

await check("a numbered row with no speaker code is its own row, not a wrap", async () => {
  // The turn-number column is what proves this is a row. Without reading it,
  // a bare pause looked exactly like a wrapped line: it folded into the turn
  // above, "6\t(0.4)" ended up inside that row's text cell, and the report —
  // which reads the repaired text — had nothing left to find.
  const withPause = doc(["C:\tcan you tell me your name again?", "5\tS:\thi ((smiles))", "6\t(0.4)", "7\tD:\tso"]);
  const result = await processTranscriptText(withPause, {});
  const main = result.rows.filter((row) => row.section === "MAIN");
  assert.deepEqual(main.map((row) => row.text), ["hi ((smiles))", "(0.4)"], "the pause was folded into the turn above");
  assert.equal(main[1].speakerID, "", "a row with no code gets an empty speakerID, not the one above it");
  const kinds = result.nonConforming.body
    .filter((entry) => entry.content.includes("(0.4)"))
    .flatMap((entry) => entry.issues.map((issue) => issue.kind));
  assert.ok(kinds.includes("speaker-code-missing"), `expected a missing-code finding, got ${kinds.join(", ")}`);
});

await check("a wrapped line opening with a numeral is still a wrap", async () => {
  // The tab is what separates a turn-number column from prose. Accepting a
  // space-separated numeral because the document is numbered elsewhere would
  // read "1998 was the year" as turn 1998 and drop the numeral from the text.
  const withYear = doc(["C:\tcan you tell me your name again?", "5\tS:\tthe figure was", "1998 was the year", "7\tD:\tso"]);
  const result = await processTranscriptText(withYear, {});
  assert.ok(
    result.rows.some((row) => row.text === "the figure was 1998 was the year"),
    `the numeral should have stayed in the turn's text, got ${JSON.stringify(result.rows.map((r) => r.text))}`,
  );
});

console.log("\nSpeaker declarations");

await check("a declaration splits into name, alternate name, demographic note and id", () => {
  const parsed = parseSpeakerDetails("Dora [Dora Leung] (Australian, male) #dora");
  assert.equal(parsed.name, "Dora");
  assert.equal(parsed.alternateName, "Dora Leung");
  assert.equal(parsed.demographic, "Australian, male");
  assert.equal(parsed.optionalCode, "#dora");
  assert.deepEqual(parsed.issues, []);
});

await check("the alternate name and the demographic note are both optional", () => {
  const parsed = parseSpeakerDetails("Charlie (research assistant) #charlie");
  assert.equal(parsed.name, "Charlie");
  assert.equal(parsed.alternateName, null);
  assert.equal(parsed.demographic, "research assistant");
  assert.deepEqual(parsed.issues, []);
});

await check("the alternate name reaches the Person entity instead of the name", async () => {
  const { speakerMap } = await processTranscriptText(UNNUMBERED, {});
  const dora = buildSpeakerPersonEntities(speakerMap).find((entity) => entity["@id"] === "#dora");
  assert.equal(dora.name, "Dora", "the bracketed alternate used to be glued into the name");
  assert.equal(dora.alternateName, "Dora Leung");
});

await check("a declaration with no #id is reported", async () => {
  const noId = UNNUMBERED.replace("C:\tCharlie (research assistant) #charlie", "C:\tCharlie (research assistant)");
  const { nonConforming } = await processTranscriptText(noId, {});
  const issues = nonConforming.speakers.flatMap((entry) => entry.issues.map((issue) => issue.kind));
  assert.ok(issues.includes("speaker-id-missing"), `expected a missing-id finding, got ${issues.join(", ")}`);
});

await check("a declaration missing its colon is read, reported, and does not rob the one above it", async () => {
  // The failure this guards is silent and cross-contaminating: without a
  // colon the line looked like a continuation, so it folded into the
  // declaration above and handed that speaker this one's name and #id.
  const noColon = UNNUMBERED.replace("S:\tSona", "S\tSona");
  const { speakerMap, nonConforming } = await processTranscriptText(noColon, {});
  assert.equal(speakerMap.get("D").optionalCode, "#dora", "Dora's declaration was contaminated");
  assert.equal(speakerMap.get("S").optionalCode, "#sona", "Sona's declaration was lost");
  const issues = nonConforming.speakers.flatMap((entry) => entry.issues.map((issue) => issue.kind));
  assert.ok(issues.includes("speaker-code-missing-colon"), `expected a missing-colon finding, got ${issues.join(", ")}`);
});

console.log("\nBody row conformance");

const bodyKinds = async (source) => {
  const { nonConforming } = await processTranscriptText(source, {});
  return nonConforming.body.flatMap((entry) => entry.issues.map((issue) => issue.kind));
};

await check("a turn number without its period is reported, and the row is unaffected", async () => {
  const kinds = await bodyKinds(NUMBERED);
  assert.ok(kinds.includes("turn-number-missing-period"), `expected a missing-period finding, got ${kinds.join(", ")}`);
  assert.deepEqual(shape(await processTranscriptText(NUMBERED, {})), shape(await processTranscriptText(UNNUMBERED, {})));
});

await check("a turn number with its period is not reported", async () => {
  const kinds = await bodyKinds(NUMBERED_WITH_PERIOD);
  assert.ok(!kinds.includes("turn-number-missing-period"), `expected no missing-period finding, got ${kinds.join(", ")}`);
});

await check("a declared code without its colon is still attributed, and reported", async () => {
  const noColon = UNNUMBERED.replace("D:\thi", "D\thi");
  const result = await processTranscriptText(noColon, {});
  assert.equal(result.rows[1].speakerID, "#dora", "the turn should still be Dora's");
  const kinds = result.nonConforming.body.flatMap((entry) => entry.issues.map((issue) => issue.kind));
  assert.ok(kinds.includes("speaker-code-missing-colon"), `expected a missing-colon finding, got ${kinds.join(", ")}`);
});

await check("a code nobody declared is reported", async () => {
  const kinds = await bodyKinds(UNNUMBERED.replace("D:\thi", "X:\thi"));
  assert.ok(kinds.includes("speaker-code-undeclared"), `expected an undeclared-code finding, got ${kinds.join(", ")}`);
});

await check("a turn with no text is reported", async () => {
  const kinds = await bodyKinds(UNNUMBERED.replace("D:\thi", "D:"));
  assert.ok(kinds.includes("text-missing"), `expected a missing-text finding, got ${kinds.join(", ")}`);
});

await check("a multi-character code is a turn when the Speakers block declared it", async () => {
  const widened = UNNUMBERED
    .replace("C:\tCharlie (research assistant) #charlie", "INT:\tCharlie (research assistant) #charlie")
    .replace("C:\tcan you tell me your name again?", "INT:\tcan you tell me your name again?");
  const result = await processTranscriptText(widened, {});
  assert.equal(result.rows[0].speakerID, "#charlie");
  assert.equal(result.nonConforming.body.length, 0, "a declared multi-character code is not a finding");
});

await check("a wrapped line starting with a capital does not become a speaker", async () => {
  // normalizeText used to rewrite any line starting with a capital and a
  // space into "X:\ttext", so "I came back home" became a turn by a speaker
  // called "I" — splitting the turn, misattributing the text, and reporting
  // nothing at all.
  const wrapped = doc(["C:\thow was it?", "D:\tI went to the shop and then", "I came back home again", "S:\tbye"]);
  const result = await processTranscriptText(wrapped, {});
  assert.ok(!result.rows.some((row) => row.speakerID === "I"), "a phantom speaker was created from a wrapped line");
  assert.ok(
    result.rows.some((row) => row.text === "I went to the shop and then I came back home again"),
    `the wrap should have folded into Dora's turn, got ${JSON.stringify(result.rows.map((r) => r.text))}`,
  );
});

await check("the log leads with a count and names the line of every finding", async () => {
  const { log, nonConforming } = await processTranscriptText(NUMBERED.replace("5\tS:\thi ((smiles))", "5\tS:"), {});
  assert.ok(log.startsWith(`Non-conforming lines: ${nonConforming.total}`), "the log should open with the total");
  assert.ok(log.includes("Expected format: CODE: name [alternate name] (demographic info) #id"));
  assert.ok(log.includes("Expected format: [turn number][.] CODE: text"));
  for (const entry of nonConforming.body) {
    assert.ok(log.includes(`Line ${entry.line} [${entry.section}]`), `line ${entry.line} is missing from the log`);
  }
});

console.log("\nParagraph numbering");

await check("a line number counts .docx paragraphs, not extracted lines", () => {
  // mammoth terminates every paragraph with a blank line, so consecutive
  // paragraphs sit two extracted lines apart and an empty paragraph adds two
  // more. Reporting the raw line number gave a transcriber a figure that
  // drifted further from their document the further down it went.
  const extracted = [
    "Transcript: demo", "",
    "Recording date: 2020-01-01", "",
    "", "",
    "Speakers:", "",
    "D:\tDora #dora", "",
  ].join("\n");
  const numbers = paragraphNumbersByLine(extracted);
  assert.equal(numbers[0], 1, "the first line is paragraph 1");
  assert.equal(numbers[2], 2, "two extracted lines on, paragraph 2");
  assert.equal(numbers[6], 4, "an empty paragraph of its own still counts");
  assert.equal(numbers[8], 5, "the speaker declaration is paragraph 5");
});

console.log("\nSection headers");

await check("a near-miss marker is recognised, an ordinary line is not", () => {
  assert.equal(nearMissMarker("Main"), "MAIN");
  assert.equal(nearMissMarker("MAIN:"), "MAIN");
  assert.equal(nearMissMarker(" preliminaries. "), "PRELIMINARIES");
  assert.equal(nearMissMarker("MAIN"), null, "an exact marker is not a near miss");
  assert.equal(nearMissMarker("MAIN points to discuss"), null, "a line that merely starts with the word is not");
  assert.equal(nearMissMarker("D:\thi"), null);
});

await check("the header report lists the markers found and any near miss, not every paragraph", async () => {
  const misspelt = UNNUMBERED.replace("\n\nMAIN\n\n", "\n\nMain\n\n");
  const { log } = await processTranscriptText(misspelt, {});
  const section = log.split("Section headers:")[1].split("\n\nUnresolved")[0];
  assert.ok(section.includes("PRELIMINARIES"), "the markers that did match should be listed");
  assert.ok(section.includes("did you mean MAIN?"), `expected a near-miss line, got:\n${section}`);
  assert.ok(!log.includes("NO MATCH"), "the per-paragraph MATCH/NO MATCH dump should be gone");
  assert.ok(
    !section.includes("can you tell me your name again?"),
    "an ordinary turn should not appear in the header report",
  );
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
