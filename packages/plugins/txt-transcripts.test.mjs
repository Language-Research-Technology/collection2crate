// Plain-text transcripts: ca-data-prep and chat-export read a .txt as well as
// a .docx. A .txt line is given the shape of a .docx paragraph before parsing,
// so the two kinds of file go through one parser and one report — these
// checks hold that the shape really is the same.
//
//   node txt-transcripts.test.mjs
import assert from "node:assert/strict";
import { REGISTRY } from "./index.js";
import {
  processTranscriptText, paragraphNumbersByLine, plainTextAsParagraphs, decodePlainText,
  extractTranscriptText, selectTranscriptFiles, transcriptBaseName, transcriptMediaType,
} from "./plugins/ca-data-prep/process.js";
import { documentLines, textToLines } from "./src/_transcript_grammar.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

const LINES = [
  "\tTranscript: demo", "",
  "Speakers:",
  "D:\tDora [Dora Leung] (Australian, male) #dora",
  "S:\tSona [Sona Johnson] (Chinese, female) #sona", "",
  "PRELIMINARIES", "D:\thi",
  "MAIN", "S:\thi ((smiles))", "X:\twho is this",
  "POSTLIMINARIES", "S:\tbye",
];
const TXT = `${LINES.join("\r\n")}\r\n`;
// What mammoth gives for a .docx with those lines as its paragraphs.
const DOCX_TEXT = LINES.map((line) => `${line}\n\n`).join("");
const bytes = (text) => new TextEncoder().encode(text);
const shape = (result) => result.rows.map((r) => `${r.section}/${r.speakerID}/${r.text}`);

console.log("Reading a .txt");

await check("a .txt parses to the same rows, speakers and findings as the same .docx", async () => {
  const fromTxt = await processTranscriptText(await extractTranscriptText(bytes(TXT), "demo.txt"), {});
  const fromDocx = await processTranscriptText(DOCX_TEXT, {});
  assert.ok(fromTxt.rows.length >= 3, "expected some rows");
  assert.deepEqual(shape(fromTxt), shape(fromDocx));
  assert.deepEqual([...fromTxt.speakerMap.keys()], [...fromDocx.speakerMap.keys()]);
  assert.equal(fromTxt.log, fromDocx.log);
});

await check("a line number in the log is the line's number in the .txt", async () => {
  const text = plainTextAsParagraphs(TXT);
  const numbers = paragraphNumbersByLine(text);
  const extracted = text.split("\n");
  LINES.forEach((line, i) => assert.equal(numbers[extracted.indexOf(line, i * 2)], i + 1, `line ${i + 1}`));
  const { log } = await processTranscriptText(text, {});
  assert.match(log, /Line 11 \[MAIN\]: "X:/, "the undeclared X: turn is on line 11");
  assert.match(log, /Line 12: POSTLIMINARIES/);
});

await check("a saved grammar's reader sees the file's own lines", () => {
  const plain = "a\n\nb\n  \nc\n";
  assert.deepEqual(documentLines(plainTextAsParagraphs(plain)), ["a", "", "b", "  ", "c"]);
  assert.deepEqual(documentLines(plainTextAsParagraphs(TXT)), textToLines(TXT).slice(0, -1));
});

await check("UTF-8 and UTF-16 decode, and a byte-order mark is dropped", () => {
  assert.equal(decodePlainText(new Uint8Array([0xef, 0xbb, 0xbf, 0x53, 0x3a])), "S:");
  assert.equal(decodePlainText(new Uint8Array([0xff, 0xfe, 0x53, 0x00, 0x3a, 0x00])), "S:");
  assert.equal(decodePlainText(new Uint8Array([0xfe, 0xff, 0x00, 0x53, 0x00, 0x3a])), "S:");
  assert.equal(decodePlainText(bytes("Léa")), "Léa");
});

console.log("\nChoosing the files");

await check("only .docx and .txt are transcripts, named without their extension", () => {
  const picked = selectTranscriptFiles([{ fileName: "a.docx" }, { fileName: "b.TXT" }, { fileName: "c.md" }, { name: "d.txt" }]);
  assert.deepEqual(picked.map((f) => f.fileName || f.name), ["a.docx", "b.TXT", "d.txt"]);
  assert.equal(transcriptBaseName("b.TXT"), "b");
  assert.equal(transcriptMediaType("b.TXT"), "text/plain");
  assert.equal(transcriptMediaType("a.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

await check("a .txt with the same name as a .docx is skipped, whichever comes first", () => {
  const warnings = [];
  const picked = selectTranscriptFiles([
    { fileName: "x.txt", relativePath: "t/x.txt" }, { fileName: "y.txt" }, { fileName: "x.docx", relativePath: "t/x.docx" },
  ], (m) => warnings.push(m));
  assert.deepEqual(picked.map((f) => f.fileName), ["y.txt", "x.docx"]);
  assert.deepEqual(warnings, ["Skipped t/x.txt: t/x.docx has the same name and would write the same output files."]);
});

console.log("\nThrough the plugins");

const noop = () => {};
const deps = { writeFileAtPath: noop, fileExists: async () => false, readFileTextFromDirectory: noop, mergeCrateInto: noop };
const txtFile = { fileName: "demo.txt", relativePath: "transcripts/demo.txt", arrayBuffer: async () => bytes(TXT).buffer };
const ctxFor = (options) => ({ log: noop, options, config: {}, filesWithMeta: [txtFile, { fileName: "notes.md" }] });

await check("ca-data-prep processes a .txt and describes it as text/plain", async () => {
  const plugin = REGISTRY["ca-data-prep"](deps);
  assert.match(plugin.optionSchema.label, /\.txt/);
  const ctx = ctxFor({ processTranscriptDocuments: true });
  await plugin.hooks["files:prepare"].handler(ctx);
  const [record] = ctx.caDataPrep.documentRecords;
  assert.equal(ctx.caDataPrep.documentRecords.length, 1);
  assert.equal(record.baseName, "demo");
  assert.equal(record.csvName, "demo.csv");
  assert.match(record.csvText, /hi \(\(smiles\)\)/);
  await plugin.hooks["crate:build"].handler(ctx);
  const source = ctx.crate.getEntity("transcripts/demo.txt");
  assert.equal(source.encodingFormat?.[0] ?? source.encodingFormat, "text/plain");
});

await check("chat-export writes a CHAT file for a .txt", async () => {
  const plugin = REGISTRY["chat-export"](deps);
  const ctx = ctxFor({ generateChatFiles: true });
  await plugin.hooks["files:prepare"].handler(ctx);
  const [record] = ctx.chatExport.documentRecords;
  assert.equal(record.chatName, "demo.cha");
  assert.match(record.chatText, /@Participants:/);
  assert.match(record.chatText, /\*S:\s+hi/);
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
