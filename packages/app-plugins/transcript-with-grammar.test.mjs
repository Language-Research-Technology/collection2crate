// ca-data-prep and chat-export parsing with a saved transcript grammar
// (src/_transcript_grammar.js) instead of the built-in convention.
//
// Placeholder names only — see "Names in fixtures" in the project notes.
//
//   node transcript-with-grammar.test.mjs
import assert from "node:assert/strict";
import { buildGrammar, documentLines, grammarFingerprint, grammarPath, listSavedGrammars } from "./src/_transcript_grammar.js";
import { processTranscriptText, buildSpeakerPersonEntities, toCsv } from "./plugins/ca-data-prep/process.js";
import { resolveTranscriptGrammar, warnIfGrammarChanged } from "./plugins/ca-data-prep/index.js";
import { generateChatText } from "./plugins/chat-export/index.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

// mammoth's shape: every paragraph followed by a blank line.
const asDocx = (paragraphs) => paragraphs.join("\n\n") + "\n\n";

const markup = (line, parts) => {
  let from = 0;
  return {
    line,
    spans: parts.map(([field, text]) => {
      const start = line.indexOf(text, from);
      if (start < 0) throw new Error(`"${text}" not in "${line}"`);
      from = start + text.length;
      return { field, start, end: from };
    }),
  };
};

// A layout the built-in convention cannot read at all.
const OWN_LAYOUT = [
  "Title: demo-03",                                    // 1
  "Participants",                                      // 2
  "AA = Alex {Alex Example} <Researcher> @p001",       // 3
  "BB = Sam <Participant> @p002",                      // 4
  "OPENING",                                           // 5
  "[1] AA > first turn (~0:12)",                       // 6
  "[2] BB > second turn",                              // 7
  "that wraps",                                        // 8
  "BODY",                                              // 9
  "[3] ZZ > nobody declared ZZ",                       // 10
  "[4] (0.5)",                                         // 11
  "[5] AA > last",                                     // 12
  "THE END",                                           // 13
];
const ownLines = documentLines(asDocx(OWN_LAYOUT));
const OWN = buildGrammar({
  name: "own",
  lines: ownLines,
  roles: ["header", "speakers", "speakers", "speakers", "main", "main", "main", "main", "main", "main", "main", "main", "ignore"],
  markers: ownLines.map((l) => ["Participants", "OPENING", "BODY"].includes(l)),
  speakerSamples: [
    markup(OWN_LAYOUT[2], [["code", "AA"], ["name", "Alex"], ["alternateName", "Alex Example"], ["affiliation", "Researcher"], ["id", "p001"]]),
    markup(OWN_LAYOUT[3], [["code", "BB"], ["name", "Sam"], ["affiliation", "Participant"], ["id", "p002"]]),
  ],
  turnSamples: [markup(OWN_LAYOUT[6], [["turn", "2"], ["speaker", "BB"], ["text", "second turn"]])],
});

const own = await processTranscriptText(asDocx(OWN_LAYOUT), { grammar: OWN, grammarName: "own" });

console.log("Parsing a layout of its own");

await check("rows come out in the CSV shape, speakers resolved to their ids", () => {
  assert.deepEqual(own.rows, [
    { turnNumber: "1", speakerID: "#p001", text: "first turn", section: "OPENING" },
    { turnNumber: "2", speakerID: "#p002", text: "second turn that wraps", section: "OPENING" },
    { turnNumber: "3", speakerID: "ZZ", text: "nobody declared ZZ", section: "BODY" },
    { turnNumber: "4", speakerID: "", text: "(0.5)", section: "BODY" },
    { turnNumber: "5", speakerID: "#p001", text: "last", section: "BODY" },
  ]);
});

await check("timecodes are removed as they are by the built-in reader", () => {
  assert.deepEqual(own.removedTimecodes, ["(~0:12)"]);
});

await check("speakers become the same Person entities the built-in reader makes", () => {
  assert.deepEqual(buildSpeakerPersonEntities(own.speakerMap), [
    { "@id": "#p001", "@type": "Person", name: "Alex", alternateName: "Alex Example", affiliation: "(Researcher)", identifier: "#p001" },
    { "@id": "#p002", "@type": "Person", name: "Sam", affiliation: "(Participant)", identifier: "#p002" },
  ]);
});

await check("an undeclared speaker, a folded line and a malformed row are each reported on their own line", () => {
  const found = own.bodyDiagnostics.map((d) => [d.line, d.issues.map((i) => i.kind).join()]);
  assert.deepEqual(found, [[8, "line-folded"], [10, "speaker-code-undeclared"], [11, "turn-row-malformed"]]);
  assert.equal(own.nonConforming.total, 3);
});

await check("header metadata is returned, and the ignored line is not a finding", () => {
  assert.deepEqual(own.metadata, { Title: "demo-03" });
  assert.ok(own.log.includes("Ignored lines: 13"));
});

await check("the log names the grammar and what it expected", () => {
  assert.ok(own.log.startsWith('Parsed with the transcript grammar "own" (_config/transcript-grammar/own.json).'));
  assert.ok(own.log.includes('Expected format (grammar "own"): code · name · [alternate name] · affiliation · id'));
  assert.ok(own.log.includes('Expected format (grammar "own"): turn number · speaker · text'));
  assert.ok(own.log.includes("Line 11 [BODY]"), "findings carry the document's own line numbers");
  assert.ok(own.log.includes("Section markers (grammar \"own\"): OPENING, BODY."));
});

await check("a section missing from the document is reported, and out-of-order sections warned about", async () => {
  const noBody = await processTranscriptText(asDocx(OWN_LAYOUT.filter((l) => l !== "BODY")), { grammar: OWN });
  assert.equal(noBody.sectionDiagnostics.find((s) => s.name === "BODY").processed, false);

  const threeSections = {
    ...OWN,
    regions: { ...OWN.regions, main: { ...OWN.regions.main, sections: ["OPENING", "BODY", "CLOSING"], sectionPattern: "^\\s*(?:OPENING|BODY|CLOSING)\\s*$" } },
  };
  const reordered = [...OWN_LAYOUT.slice(0, 8), "CLOSING", "[9] BB > bye", ...OWN_LAYOUT.slice(8)];
  const result = await processTranscriptText(asDocx(reordered), { grammar: threeSections, grammarName: "own" });
  assert.ok(result.warnings.includes("Section order: found OPENING, CLOSING, BODY; the grammar expects OPENING, BODY, CLOSING."), result.warnings.join(" | "));
});

await check("the built-in reader cannot read this layout — which is the point", async () => {
  const builtIn = await processTranscriptText(asDocx(OWN_LAYOUT), {});
  assert.equal(builtIn.rows.length, 0);
});

console.log("\nThe built-in convention, as a grammar");

// The fixture the built-in reader's own tests use, marked up as a grammar.
const CONVENTION = [
  "\tTranscript: demo",
  "",
  "Speakers:",
  "D:\tDora [Dora Leung] (Australian, male) #dora",
  "S:\tSona [Sona Johnson] (Chinese, female) #sona",
  "C:\tCharlie (research assistant) #charlie",
  "",
  "PRELIMINARIES", "1\tC:\tcan you tell me your name again?", "",
  "MAIN", "4\tD:\thi", "5\tS:\thi ((smiles))", "",
  "POSTLIMINARIES", "9\tS:\toh (0.2) @",
];
const convLines = documentLines(asDocx(CONVENTION));
const regionOf = (i) => (i < 2 ? "header" : i < 7 ? "speakers" : "main");
const CONV = buildGrammar({
  name: "convention",
  lines: convLines,
  roles: convLines.map((_, i) => regionOf(i)),
  markers: convLines.map((l) => ["Speakers:", "PRELIMINARIES", "MAIN", "POSTLIMINARIES"].includes(l)),
  speakerSamples: [
    markup(CONVENTION[3], [["code", "D"], ["name", "Dora"], ["alternateName", "Dora Leung"], ["affiliation", "Australian, male"], ["id", "dora"]]),
    markup(CONVENTION[5], [["code", "C"], ["name", "Charlie"], ["affiliation", "research assistant"], ["id", "charlie"]]),
  ],
  turnSamples: [markup(CONVENTION[8], [["turn", "1"], ["speaker", "C"], ["text", "can you tell me your name again?"]])],
});

await check("on a conforming document, the grammar and the built-in reader agree row for row", async () => {
  const text = asDocx(CONVENTION);
  const builtIn = await processTranscriptText(text, {});
  const viaGrammar = await processTranscriptText(text, { grammar: CONV });
  assert.deepEqual(viaGrammar.rows, builtIn.rows);
  assert.deepEqual(buildSpeakerPersonEntities(viaGrammar.speakerMap), buildSpeakerPersonEntities(builtIn.speakerMap));
  assert.equal(viaGrammar.nonConforming.total, 0);
});

await check("PRELIMINARIES and POSTLIMINARIES keep their CSV abbreviations", async () => {
  const { rows } = await processTranscriptText(asDocx(CONVENTION), { grammar: CONV });
  assert.deepEqual(rows.map((r) => r.section), ["PRE", "MAIN", "MAIN", "POST"]);
});

await check("headerRows / footerRows still trim rows", async () => {
  const { rows } = await processTranscriptText(asDocx(CONVENTION), { grammar: CONV, headerRows: 1, footerRows: 1 });
  assert.equal(rows.length, 2);
});

console.log("\nSpeakers named on every row, with fixed text ignored");

// No speaker list: each turn carries its speaker inside a tag.
const TAGGED = [
  "Title: tagged-01",                              // 1
  "00:01-00:02",                                   // 2  a timestamp, marked Ignore
  "<u speaker=Kai> first line",                    // 3
  "00:03-00:09",                                   // 4  a different timestamp, same shape
  "<u speaker=Rin>second, no space",               // 5
  "<u speaker=Kai> ここも",                        // 6
];
const taggedLines = documentLines(asDocx(TAGGED));
const TAG = buildGrammar({
  name: "tagged",
  lines: taggedLines,
  roles: ["header", "ignore", "main", "main", "main", "main"],
  markers: taggedLines.map(() => false),
  speakerSamples: [],
  turnSamples: [markup(TAGGED[2], [["ignore", "<u speaker="], ["speaker", "Kai"], ["ignore", ">"], ["text", "first line"]])],
});

await check("the tag is matched as written and not captured; the space after it is optional", async () => {
  assert.equal(TAG.speakerRow, null);
  assert.match(TAG.turnRow.pattern, /^\^\[\\t \]\*<u\[\\t \]\+speaker=/);
  const { rows } = await processTranscriptText(asDocx([...TAGGED, "<x speaker=Kai> wrong tag"]), { grammar: TAG });
  assert.deepEqual(rows.slice(0, 2), [
    { turnNumber: "", speakerID: "#Kai", text: "first line", section: "MAIN" },
    { turnNumber: "", speakerID: "#Rin", text: "second, no space", section: "MAIN" },
  ]);
  assert.equal(rows.length, 3, "a different tag is not a row");
  assert.equal(rows[2].text, "ここも <x speaker=Kai> wrong tag", "…so it folds into the turn above, and is reported");
});

await check("with no speaker list, the turns' speakers become the Person entities and none is 'undeclared'", async () => {
  const result = await processTranscriptText(asDocx(TAGGED), { grammar: TAG, grammarName: "tagged" });
  assert.deepEqual(buildSpeakerPersonEntities(result.speakerMap).map((p) => [p["@id"], p.name]), [["#Kai", "Kai"], ["#Rin", "Rin"]]);
  assert.equal(result.bodyDiagnostics.filter((d) => d.issues.some((i) => i.kind === "speaker-code-undeclared")).length, 0);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.log.includes('has no speaker rows; the speakers are the names the turns give (2 found)'));
  assert.deepEqual(result.metadata, { Title: "tagged-01" });
  assert.ok(result.log.includes("Ignored lines: 2, 4"), "an ignored timestamp line matches other timestamps too");
  assert.ok(result.log.includes("Cleanup: 1 line-skip rule(s) (2 line(s) skipped), 0 removal rule(s): none"), result.log.slice(0, 600));
});

console.log("\nA speaker block is optional per document");

await check("a document without the grammar's speaker block still parses, with speakers from its turns", async () => {
  const text = asDocx(OWN_LAYOUT.filter((_, i) => i < 1 || i > 3));   // drop Participants and both declarations
  const result = await processTranscriptText(text, { grammar: OWN, grammarName: "own" });
  assert.deepEqual(result.rows.map((r) => r.speakerID), ["#AA", "#BB", "#ZZ", "", "#AA"]);
  assert.deepEqual([...result.speakerMap.keys()], ["AA", "BB", "ZZ"]);
  assert.equal(result.bodyDiagnostics.some((d) => d.issues.some((i) => i.kind === "speaker-code-undeclared")), false);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.log.includes("This document has no speaker block (it is optional)"));
  assert.deepEqual(result.metadata, { Title: "demo-03" });
});

await check("…and without a main marker either, the body starts at the first turn — but a known header key stays header", async () => {
  const noMarkers = { ...OWN, regions: { ...OWN.regions, speakers: { start: null }, main: { start: null, sections: [], sectionPattern: null } } };
  const turnShaped = { ...noMarkers, turnRow: { ...noMarkers.turnRow, pattern: "^[\\t ]*(?<speaker>[\\p{L}\\p{N}]{1,24})[\\t ]*:[\\t ]*(?<text>.*?)[\\t ]*$" }, regions: { ...noMarkers.regions, header: { keys: ["Title"] } } };
  const result = await processTranscriptText(asDocx(["Title: t", "AA: hello", "BB: hi"]), { grammar: turnShaped });
  assert.deepEqual(result.metadata, { Title: "t" });
  assert.deepEqual(result.rows.map((r) => `${r.speakerID} ${r.text}`), ["#AA hello", "#BB hi"]);
});

console.log("\nThe built-in convention without a Speakers block");

await check("turns still parse, speakers come from their codes, and no markers means all MAIN", async () => {
  const d = (ps) => ps.join("\n\n") + "\n\n";
  const marked = await processTranscriptText(d(["Transcript: demo", "PRELIMINARIES", "1.\tA:\thello", "MAIN", "2.\tB:\thi"]), {});
  assert.deepEqual(marked.rows, [
    { turnNumber: "1", speakerID: "#A", text: "hello", section: "PRE" },
    { turnNumber: "2", speakerID: "#B", text: "hi", section: "MAIN" },
  ]);
  assert.deepEqual(buildSpeakerPersonEntities(marked.speakerMap).map((p) => p["@id"]), ["#A", "#B"]);
  assert.ok(marked.log.includes("no Speakers block (it is optional)"));
  const bare = await processTranscriptText(d(["Transcript: demo", "A:\thello", "B:\thi"]), {});
  assert.deepEqual(bare.rows.map((r) => `${r.section} ${r.speakerID} ${r.text}`), ["MAIN #A hello", "MAIN #B hi"]);
  // With a Speakers block, nothing changes: the body still waits for a marker.
  const blocked = await processTranscriptText(d(["Speakers:", "A:\tAl #al", "A:\tnot a turn yet", "MAIN", "A:\thi"]), {});
  assert.deepEqual(blocked.rows.map((r) => r.text), ["hi"]);
});

console.log("\nchat-export");

await check("a CHAT file is generated from the grammar's reading", async () => {
  const chat = await generateChatText(asDocx(OWN_LAYOUT), { grammar: OWN, grammarName: "own", corpusId: "demo" });
  const lines = chat.trim().split("\n");
  assert.equal(lines[0], "@Participants: AA Participant, BB Participant");
  assert.ok(lines.includes("@ID: |demo|AA|||Researcher||Participant|||"), lines.join("\n"));
  assert.ok(lines.includes("*AA: first turn"));
  assert.ok(lines.includes("*BB: second turn that wraps"));
});

console.log("\nChoosing a grammar in a folder");

function fakeFolder(files) {
  const readText = async (_dir, path) => (files.has(path) ? files.get(path) : null);
  const dirAt = (prefix) => ({
    async getDirectoryHandle(name) {
      const p = `${prefix}${name}/`;
      if (![...files.keys()].some((k) => k.startsWith(p))) throw new Error("NotFoundError");
      return dirAt(p);
    },
    async *entries() {
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) yield [key.slice(prefix.length), { kind: "file" }];
      }
    },
  });
  return { dirHandle: dirAt(""), readText };
}

const logger = () => {
  const entries = [];
  const log = (message, level) => entries.push({ message, level });
  return { log, entries };
};

await check("no grammar chosen means the built-in convention", async () => {
  const { dirHandle, readText } = fakeFolder(new Map());
  assert.equal(await resolveTranscriptGrammar({ dirHandle, options: {} }, readText), null);
  assert.equal(await warnIfGrammarChanged({ dirHandle, options: {}, caDataPrep: { grammar: null }, log: () => {} }, readText), false);
});

await check("saved grammars are listed and a chosen one loaded once per run", async () => {
  const files = new Map([[grammarPath("own"), JSON.stringify(OWN)], [grammarPath("convention"), JSON.stringify(CONV)], ["_config/other/x.json", "{}"]]);
  const { dirHandle, readText } = fakeFolder(files);
  assert.deepEqual(await listSavedGrammars(dirHandle), ["convention", "own"]);
  let reads = 0;
  const counting = async (...args) => { reads++; return readText(...args); };
  const ctx = { dirHandle, options: { transcriptGrammar: "own" } };
  const first = await resolveTranscriptGrammar(ctx, counting);
  const second = await resolveTranscriptGrammar(ctx, counting);
  assert.equal(first, second);
  assert.equal(reads, 1);
  assert.equal(first.fingerprint, grammarFingerprint(OWN));
});

await check("a chosen grammar that is missing or broken fails, rather than falling back", async () => {
  const { dirHandle, readText } = fakeFolder(new Map([[grammarPath("broken"), "{ nope"]]));
  await assert.rejects(resolveTranscriptGrammar({ dirHandle, options: { transcriptGrammar: "gone" } }, readText), /gone\.json not found/);
  await assert.rejects(resolveTranscriptGrammar({ dirHandle, options: { transcriptGrammar: "broken" } }, readText), /not valid JSON/);
});

await check("Build warns when the grammar changed after Process — and not when it was only re-saved", async () => {
  const files = new Map([[grammarPath("own"), JSON.stringify(OWN)]]);
  const { dirHandle, readText } = fakeFolder(files);
  const used = { name: "own", fingerprint: grammarFingerprint(OWN) };
  const ctx = (log) => ({ dirHandle, options: { transcriptGrammar: "own" }, caDataPrep: { grammar: used }, log });

  let l = logger();
  files.set(grammarPath("own"), JSON.stringify({ ...OWN, savedAt: "later", markedUpFrom: "another.docx" }));
  assert.equal(await warnIfGrammarChanged(ctx(l.log), readText), false);
  assert.equal(l.entries.length, 0);

  l = logger();
  files.set(grammarPath("own"), JSON.stringify({ ...OWN, ignore: [] }));
  assert.equal(await warnIfGrammarChanged(ctx(l.log), readText), true);
  assert.match(l.entries[0].message, /has changed since Process/);
  assert.equal(l.entries[0].level, "warn");

  l = logger();
  assert.equal(await warnIfGrammarChanged({ ...ctx(l.log), options: { transcriptGrammar: "" } }, readText), true);
  assert.match(l.entries[0].message, /parsed with the grammar "own", but the built-in convention is chosen now/);
});

await check("a grammar's own labels become extra CSV columns, headed by the label", async () => {
  const lines = ["1\tAA:\tfirst turn\t[low]", "2\tBB:\tsecond, turn\t[high]"];
  const grammar = buildGrammar({
    name: "labels", lines, roles: lines.map(() => "main"), markers: lines.map(() => false),
    speakerSamples: [], layout: { header: false, speakers: false, markers: false },
    customFields: [{ key: "c_pitch", label: "Pitch level" }],
    turnSamples: [markup(lines[0], [["turn", "1"], ["speaker", "AA"], ["text", "first turn"], ["c_pitch", "low"]])],
  });
  const result = await processTranscriptText(lines.join("\n"), { grammar, grammarName: "labels" });
  assert.deepEqual(result.extraColumns, ["Pitch level"]);
  assert.equal(toCsv(result.rows, result.extraColumns),
    'turnNumber,speakerID,text,section,Pitch level\n1,#AA,first turn,MAIN,low\n2,#BB,"second, turn",MAIN,high\n');
  // Without labels, the CSV is the four columns every transcript has.
  assert.equal(toCsv(result.rows).split("\n")[0], "turnNumber,speakerID,text,section");
});

await check("a grammar's own speaker labels become PropertyValues of each speaker's Person", async () => {
  const lines = ["Speakers:", "AA: Alex [teacher]", "BB: Sam [student]", "", "BODY", "1\tAA:\thello", "2\tBB:\thi"];
  const grammar = buildGrammar({
    name: "roles", lines,
    roles: ["speakers", "speakers", "speakers", "speakers", "main", "main", "main"],
    markers: [true, false, false, false, true, false, false],
    layout: { header: false, speakers: true, markers: true },
    speakerCustomFields: [{ key: "c_role", label: "Role" }],
    speakerSamples: [markup(lines[1], [["code", "AA"], ["name", "Alex"], ["c_role", "teacher"]])],
    turnSamples: [markup(lines[5], [["turn", "1"], ["speaker", "AA"], ["text", "hello"]])],
  });
  assert.deepEqual(grammar.speakerRow.customFields, [{ key: "c_role", label: "Role" }]);
  const result = await processTranscriptText(lines.join("\n"), { grammar, grammarName: "roles" });
  assert.equal(result.nonConforming.total, 0);
  const entities = buildSpeakerPersonEntities(result.speakerMap);
  const alex = entities.find((e) => e["@id"] === "#AA");
  assert.deepEqual(alex.additionalProperty, [{ "@id": "#AA-role" }]);
  assert.deepEqual(entities.find((e) => e["@id"] === "#AA-role"), { "@id": "#AA-role", "@type": "PropertyValue", name: "Role", value: "teacher" });
  assert.equal(entities.find((e) => e["@id"] === "#BB-role").value, "student");
  // The CSV is untouched: speaker labels are about speakers, not rows.
  assert.equal(toCsv(result.rows, result.extraColumns).split("\n")[0], "turnNumber,speakerID,text,section");
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
