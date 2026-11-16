// transcript-grammar: patterns generated from markup, and the parser that
// reads documents with them. The editor itself is DOM and stays untested
// here; everything it saves comes out of these functions.
//
// Names below are placeholders with no connection to any participant — see
// "Names in fixtures" in the project notes.
//
//   node transcript-grammar.test.mjs
import assert from "node:assert/strict";
import {
  SPEAKER_FIELDS, TURN_FIELDS, DEFAULT_GRAMMAR,
  buildRowPattern, buildRegions, buildGrammar, checkRegionOrder, decomposeSample,
  escapeRegex, parseWithGrammar, spansFromMatch, suggestRegions, suggestSamples,
  textToLines, validateGrammar, applyCleanup, exactPattern, shapePattern, patternError,
  applyLayout, grammarLayout, dropColumns, columnRulesFor, columnRuleError, droppedColumnRanges,
  describeColumnRule, grammarFingerprint, buildFixedRowPattern, looksFixedWidth, describeFixedColumn, fixedColumnError,
  customFieldKey, customLabelError, turnFieldDefs, speakerFieldDefs,
} from "./src/_transcript_grammar.js";

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

// Mark `line` up by naming the text of each field, in order.
const markup = (line, parts) => {
  let from = 0;
  const spans = parts.map(([field, text]) => {
    const start = line.indexOf(text, from);
    if (start < 0) throw new Error(`"${text}" not in "${line}"`);
    from = start + text.length;
    return { field, start, end: from };
  });
  return { line, spans };
};

const LINES = [
  "Transcript: demo-01",
  "Recording date: 2020-01-01",
  "",
  "Participants",
  "AA:\tAlex [Alex Example] (Researcher, Place A) #p001",
  "BB:\tSam (Participant) #p002",
  "",
  "OPENING",
  "1\tAA:\tfirst turn",
  "2\tBB:\tsecond turn",
  "that wraps onto a second line",
  "BODY",
  "3\tAA:\tthird turn",
  "4\t(0.5)",
  "5.\tBB:\tfifth turn has a period",
  "-- end --",
];

const ROLES = [
  "header", "header", "header",
  "speakers", "speakers", "speakers", "speakers",
  "main", "main", "main", "main", "main", "main", "main", "main",
  "ignore",
];
const MARKERS = LINES.map((l) => ["Participants", "OPENING", "BODY"].includes(l));

const SPEAKER_SAMPLES = [
  markup(LINES[4], [["code", "AA"], ["name", "Alex"], ["alternateName", "Alex Example"], ["affiliation", "Researcher, Place A"], ["id", "p001"]]),
  markup(LINES[5], [["code", "BB"], ["name", "Sam"], ["affiliation", "Participant"], ["id", "p002"]]),
];
const TURN_SAMPLES = [markup(LINES[8], [["turn", "1"], ["speaker", "AA"], ["text", "first turn"]])];

const GRAMMAR = buildGrammar({
  name: "demo", lines: LINES, roles: ROLES, markers: MARKERS,
  speakerSamples: SPEAKER_SAMPLES, turnSamples: TURN_SAMPLES,
});

console.log("Row patterns");

check("a speaker pattern reads every field the samples marked", () => {
  const spec = buildRowPattern(SPEAKER_SAMPLES, SPEAKER_FIELDS);
  const m = LINES[4].match(new RegExp(spec.pattern, spec.flags));
  assert.ok(m, spec.pattern);
  assert.deepEqual({ ...m.groups }, {
    code: "AA", name: "Alex", alternateName: "Alex Example", affiliation: "Researcher, Place A", id: "p001",
  });
});

check("a field only some samples have is optional, and its brackets go with it", () => {
  const spec = buildRowPattern(SPEAKER_SAMPLES, SPEAKER_FIELDS);
  assert.deepEqual(spec.fields.filter((f) => f.optional).map((f) => f.key), ["alternateName"]);
  const m = LINES[5].match(new RegExp(spec.pattern, spec.flags));
  assert.equal(m.groups.alternateName, undefined);
  assert.equal(m.groups.name, "Sam");
  assert.equal(m.groups.affiliation, "Participant");
});

check("a row shape neither sample had exactly still parses when it fits the pattern", () => {
  const spec = buildRowPattern(SPEAKER_SAMPLES, SPEAKER_FIELDS);
  const m = "CC:  Robin Q [Robin Quux] (Visitor)   #p003".match(new RegExp(spec.pattern, spec.flags));
  assert.ok(m);
  assert.equal(m.groups.name, "Robin Q");
  assert.equal(m.groups.alternateName, "Robin Quux");
});

check("a required field that is missing fails the match rather than shifting fields", () => {
  const spec = buildRowPattern(SPEAKER_SAMPLES, SPEAKER_FIELDS);
  assert.equal(new RegExp(spec.pattern, spec.flags).test("DD:\tNoId (Participant)"), false);
});

check("a field can be forced optional even when every sample has it", () => {
  const spec = buildRowPattern(SPEAKER_SAMPLES, SPEAKER_FIELDS, { optional: ["affiliation"] });
  assert.ok(new RegExp(spec.pattern, spec.flags).test("DD:\tKim #p004"));
});

check("stray punctuation after the last field is tolerated, not required", () => {
  const withComma = markup("AA:\tAlex (R) #p001,", [["code", "AA"], ["name", "Alex"], ["affiliation", "R"], ["id", "p001"]]);
  const spec = buildRowPattern([withComma], SPEAKER_FIELDS);
  const re = new RegExp(spec.pattern, spec.flags);
  assert.ok(re.test("BB:\tSam (P) #p002,"));
  assert.ok(re.test("BB:\tSam (P) #p002"));
  assert.equal("BB:\tSam (P) #p002,".match(re).groups.id, "p002");
});

check("a tab between turn number and speaker stays a tab", () => {
  const spec = buildRowPattern(TURN_SAMPLES, TURN_FIELDS);
  const re = new RegExp(spec.pattern, spec.flags);
  assert.ok(re.test("12\tAA:\ttext"));
  assert.equal(re.test("1998 was: the year"), false);
});

check("marking a sample without a turn number makes the number optional", () => {
  const spec = buildRowPattern([...TURN_SAMPLES, markup("BB:\thello", [["speaker", "BB"], ["text", "hello"]])], TURN_FIELDS);
  const re = new RegExp(spec.pattern, spec.flags);
  assert.equal("CC:\tunnumbered".match(re).groups.speaker, "CC");
  assert.equal("7\tCC:\tnumbered".match(re).groups.turn, "7");
});

check("an empty text field still matches", () => {
  const spec = buildRowPattern(TURN_SAMPLES, TURN_FIELDS);
  assert.equal("3\tAA:\t".match(new RegExp(spec.pattern, spec.flags)).groups.text, "");
});

check("text left unmarked is never written into the pattern", () => {
  // Speaker marked, text not: the words after it must not become a literal.
  const spec = buildRowPattern([markup("A:\ttest text?", [["speaker", "A"]])], TURN_FIELDS);
  assert.ok(!spec.pattern.includes("test"), spec.pattern);
  assert.deepEqual(spec.unmarked, ["test text?"]);
  assert.ok(new RegExp(spec.pattern, spec.flags).test("B:\tsomething else entirely"));
  const between = buildRowPattern([markup("7 said A: hi", [["turn", "7"], ["speaker", "A"], ["text", "hi"]])], TURN_FIELDS);
  assert.ok(!between.pattern.includes("said"), between.pattern);
  assert.equal("9 whispered B: yo".match(new RegExp(between.pattern, between.flags)).groups.speaker, "B");
  const grammar = buildGrammar({ name: "x", lines: LINES, roles: ROLES, markers: MARKERS, speakerSamples: SPEAKER_SAMPLES, turnSamples: [markup("A:\ttest text?", [["speaker", "A"]])] });
  assert.ok(!JSON.stringify(grammar).includes("test text"), "unmarked sample text must not be saved");
});

check("ignored text is matched as written, digits aside, and never captured", () => {
  const line = "[05:36] <u who=A> hello";
  const spec = buildRowPattern([markup(line, [["ignore", "[05:36] <u who="], ["speaker", "A"], ["ignore", ">"], ["text", "hello"]])], TURN_FIELDS);
  const re = new RegExp(spec.pattern, spec.flags);
  assert.deepEqual({ ..."[12:01] <u who=Bo>hi there".match(re).groups }, { speaker: "Bo", text: "hi there" });
  assert.equal(re.test("[12:01] <x who=Bo> hi"), false, "the fixed text is required");
  assert.deepEqual(spec.unmarked, []);
  assert.deepEqual(spec.fields.map((f) => f.key), ["speaker", "text"], "ignore is not a field");
});

check("a sample with only ignored text yields no pattern", () => {
  assert.equal(buildRowPattern([markup("<u>", [["ignore", "<u>"]])], TURN_FIELDS), null);
});

check("an ignored line's digits match any digits", () => {
  const { ignore } = buildRegions(["05:36-05:37"], ["ignore"], [false]);
  assert.ok(new RegExp(ignore[0], "u").test("11:02-11:15"));
  assert.equal(new RegExp(ignore[0], "u").test("11:02 - later"), false);
});

console.log("Cleanup");

check("shape and exact removal patterns", () => {
  assert.equal(shapePattern("[05:36]"), "\\[\\d+:\\d+\\]");
  assert.equal(shapePattern("(laughs)"), "\\(\\p{L}+\\)");
  assert.ok(new RegExp(shapePattern("(~0:12)"), "u").test("so (~11:02) then"));
  assert.ok(new RegExp(exactPattern("<u  speaker="), "u").test("<u speaker=A>"));
  assert.equal(new RegExp(exactPattern("<u speaker="), "u").test("<x speaker=A>"), false);
});

check("patterns are checked before use, including ones that match nothing at all", () => {
  assert.equal(patternError("\\d+"), null);
  assert.match(patternError("(unclosed"), /Invalid|Unterminated/i);
  assert.match(patternError("x*", { global: true }), /empty/);
  assert.equal(patternError("   "), "empty pattern");
});

check("cleanup skips lines anywhere and removes text only from speaker and main lines", () => {
  const lines = ["Recorded: (~0:00)", "Speakers:", "A:\tAl (~0:01) #a", "MAIN", "00:01-00:02", "A:\thi (~0:02) there", "A:\t(~0:03)"];
  const roles = ["header", "speakers", "speakers", "main", "main", "main", "main"];
  const markers = [false, true, false, true, false, false, false];
  const r = applyCleanup(lines, roles, markers, { drop: ["^\\s*\\d+:\\d+-\\d+:\\d+\\s*$"], strip: ["\\(~\\d+:\\d+\\)"] });
  assert.deepEqual(r.lines, ["Recorded: (~0:00)", "Speakers:", "A:\tAl #a", "MAIN", "", "A:\thi there", "A:\t"]);
  assert.deepEqual(r.dropHits, [[4]]);
  assert.deepEqual(r.stripHits, [[2, 5, 6]]);
  assert.equal(r.changes.length, 4);
});

check("a saved grammar applies its cleanup when parsing", () => {
  const lines = ["Title: t", "[00:01] <u who=A> hello (laughs) there", "00:05-00:06", "[00:09] <u who=B> bye"];
  const roles = ["header", "main", "main", "main"];
  const cleanup = { drop: ["^\\s*\\d+:\\d+-\\d+:\\d+\\s*$"], strip: [shapePattern("[00:01]"), shapePattern("(laughs)"), exactPattern("<u who=")] };
  const clean = applyCleanup(lines, roles, lines.map(() => false), cleanup);
  assert.equal(clean.lines[1], "A> hello there");
  const grammar = buildGrammar({
    name: "c", lines, roles, markers: lines.map(() => false), speakerSamples: [], cleanup,
    turnSamples: [markup(clean.lines[1], [["speaker", "A"], ["text", "hello there"]])],
  });
  assert.deepEqual(grammar.strip.map((s) => s.pattern), cleanup.strip);
  assert.deepEqual(grammar.ignore, cleanup.drop);
  assert.deepEqual(validateGrammar(grammar), []);
  const parsed = parseWithGrammar(lines, grammar);
  assert.deepEqual(parsed.turns.map((t) => [t.speaker, t.text]), [["A", "hello there"], ["B", "bye"]]);
  assert.deepEqual(parsed.ignored.map((i) => i.line), [3]);
  assert.deepEqual(validateGrammar({ ...grammar, strip: [{ pattern: "(" }] }).length, 1);
});

console.log("Dropped columns");

check("a tab-separated column is a field, and goes with its tab", () => {
  const line = "7\tA:\tx1\thello there\t/";
  assert.deepEqual(columnRulesFor(line, { start: 5, end: 7 }), [{ tab: 2 }]);
  assert.deepEqual(columnRulesFor(line, { start: 0, end: 4 }), [{ tab: 0 }, { tab: 1 }], "a selection over two fields drops both");
  assert.equal(dropColumns(line, [{ tab: 2 }]), "7\tA:\thello there\t/");
  assert.equal(dropColumns(line, [{ tab: 0 }, { tab: 4 }]), "A:\tx1\thello there");
  assert.equal(dropColumns(line, [{ tab: 9 }]), line, "a column the line doesn't have changes nothing");
  assert.equal(dropColumns("no tabs here", [{ tab: 0 }]), "no tabs here", "a tab rule leaves a line without tabs alone");
  assert.deepEqual(droppedColumnRanges(line, [{ tab: 2 }]), [{ start: 5, end: 7 }]);
});

check("a space-aligned column is a span, widened to its neighbours", () => {
  const rows = [
    "1   A:  x1     hello",
    "12  B:  y123   bye now",
    "3   A:         (no code)",
  ];
  const rule = columnRulesFor(rows[0], { start: 8, end: 10 });
  assert.deepEqual(rule, [{ from: 6, to: 15 }]);
  assert.equal(describeColumnRule(rule[0]), "Characters 7–15");
  assert.deepEqual(rows.map((r) => dropColumns(r, rule)), ["1   A: hello", "12  B: bye now", "3   A: (no code)"],
    "a longer value in the same column goes too, and the columns either side close up to one space");
  assert.equal(dropColumns(rows[0], columnRulesFor(rows[0], { start: 0, end: 1 })), "A:  x1     hello", "a first column leaves no space behind");
  assert.equal(dropColumns(rows[0], columnRulesFor(rows[0], { start: 15, end: 20 })), "1   A:  x1", "nor does a last one");
  assert.equal(dropColumns("short", [{ from: 10, to: 20 }]), "short", "a line that ends before the column is left as it is");
  assert.equal(dropColumns("a\tb", [{ from: 0, to: 1 }]), "a\tb", "a span rule leaves a line with tabs alone");
});

check("a column rule is checked before use", () => {
  assert.equal(columnRuleError({ tab: 0 }), null);
  assert.equal(columnRuleError({ from: 2, to: 5 }), null);
  assert.ok(columnRuleError({ tab: -1 }));
  assert.ok(columnRuleError({ from: 5, to: 5 }));
  assert.ok(columnRuleError({ from: 1.5, to: 5 }));
  assert.ok(columnRuleError({}));
});

check("cleanup drops columns from main rows only, before its removals", () => {
  const lines = ["Title:\tt", "Speakers:", "A:\tAl\t#a", "MAIN", "1\tA:\t[x]\thi [x] there", "2\tA:\tzz\tbye"];
  const roles = ["header", "speakers", "speakers", "main", "main", "main"];
  const markers = [false, true, false, true, false, false];
  const r = applyCleanup(lines, roles, markers, { drop: [], strip: ["\\[x\\]"], columns: [{ tab: 2 }, { tab: 7 }] });
  assert.deepEqual(r.lines, ["Title:\tt", "Speakers:", "A:\tAl\t#a", "MAIN", "1\tA:\thi there", "2\tA:\tbye"]);
  assert.deepEqual(r.columnHits, [[4, 5], []]);
  assert.deepEqual(r.stripHits, [[4]], "the removal still counts the row it changed");
});

check("a saved grammar drops the columns when parsing, and says so in its fingerprint", () => {
  const lines = ["Title: t", "1  A:  x1   hello there", "2  B:  y22  bye", "            and more"];
  const roles = ["header", "main", "main", "main"];
  const markers = lines.map(() => false);
  const columns = columnRulesFor(lines[1], { start: 7, end: 9 });
  const clean = applyCleanup(lines, roles, markers, { drop: [], strip: [], columns });
  assert.equal(clean.lines[1], "1  A: hello there");
  const make = (cleanup) => buildGrammar({
    name: "cols", lines, roles, markers, speakerSamples: [], cleanup,
    turnSamples: [markup(clean.lines[1], [["turn", "1"], ["speaker", "A"], ["text", "hello there"]])],
  });
  const grammar = make({ drop: [], strip: [], columns: [...columns, ...columns, { tab: -1 }] });
  assert.deepEqual(grammar.dropColumns, columns, "saved once each, and never an invalid one");
  assert.deepEqual(validateGrammar(grammar), []);
  const parsed = parseWithGrammar(lines, grammar);
  assert.deepEqual(parsed.turns.map((t) => [t.turn, t.speaker, t.text]), [["1", "A", "hello there"], ["2", "B", "bye and more"]]);
  assert.equal(parsed.metadata.Title, "t", "the header is read as it is");

  const without = make({ drop: [], strip: [], columns: [] });
  assert.deepEqual(without.dropColumns, []);
  assert.notEqual(grammarFingerprint(grammar), grammarFingerprint(without));
  const { dropColumns: _, ...older } = without;
  assert.equal(grammarFingerprint(older), grammarFingerprint(without), "a grammar saved before dropped columns keeps its fingerprint");
  assert.equal(validateGrammar({ ...grammar, dropColumns: [{ from: 3 }] }).length, 1);
  assert.equal(validateGrammar(older).length, 0);
});

check("dropped columns don't touch the speaker info", () => {
  const grammar = { ...GRAMMAR, dropColumns: [{ tab: 1 }] };
  const parsed = parseWithGrammar(["Participants", "AA:\tAlex (R) #p1", "OPENING", "1\tx\tAA:\thi"], grammar);
  assert.equal(parsed.speakers[0].code, "AA");
  assert.deepEqual(parsed.turns.map((t) => [t.speaker, t.text]), [["AA", "hi"]]);
});

check("a line the cleanup empties is skipped, not folded into the turn above", () => {
  const grammar = { ...GRAMMAR, strip: [{ pattern: "\\[noise\\]", flags: "u" }] };
  const parsed = parseWithGrammar(["Participants", "AA:\tAlex (R) #p1", "OPENING", "1\tAA:\thi", "[noise]"], grammar);
  assert.equal(parsed.turns[0].text, "hi");
  assert.deepEqual(parsed.ignored.map((i) => i.line), [5]);
});

check("unicode codes and names parse", () => {
  const sample = markup("Ŋa:\tŊarri (Élder) #x1", [["code", "Ŋa"], ["name", "Ŋarri"], ["affiliation", "Élder"], ["id", "x1"]]);
  const spec = buildRowPattern([sample], SPEAKER_FIELDS);
  assert.equal("Ŋu:\tŊulu (Élder) #x2".match(new RegExp(spec.pattern, spec.flags)).groups.code, "Ŋu");
});

check("samples that disagree on field order are refused", () => {
  const reordered = markup("p003 Alex AA", [["id", "p003"], ["name", "Alex"], ["code", "AA"]]);
  assert.throws(() => buildRowPattern([SPEAKER_SAMPLES[0], reordered], SPEAKER_FIELDS), /different orders/);
});

check("overlapping marks are refused", () => {
  assert.throws(() => decomposeSample({ line: "AA: Alex", spans: [{ field: "code", start: 0, end: 3 }, { field: "name", start: 2, end: 8 }] }), /overlap/);
});

check("a sample with no marks yields no pattern", () => {
  assert.equal(buildRowPattern([{ line: "AA: x", spans: [] }], TURN_FIELDS), null);
});

check("escaped literals compile under the u flag", () => {
  for (const text of ["a-b", "#id", "x: y", "(a) [b] {c}", "1.5*2+3?", "a/b|c^$"]) {
    assert.ok(new RegExp(`^${escapeRegex(text)}$`, "u").test(text), text);
  }
});

console.log("Regions");

check("markers become region starts and section names; ignored lines become patterns", () => {
  const { regions, ignore } = buildRegions(LINES, ROLES, MARKERS);
  assert.ok(new RegExp(regions.speakers.start, "u").test("Participants"));
  assert.ok(new RegExp(regions.main.start, "u").test("OPENING"));
  assert.deepEqual(regions.main.sections, ["OPENING", "BODY"]);
  assert.deepEqual(regions.header.keys, ["Transcript", "Recording date"]);
  assert.equal(ignore.length, 1);
  assert.ok(new RegExp(ignore[0], "u").test("--   end --"));
});

check("regions out of order are reported once, and missing regions named", () => {
  assert.deepEqual(checkRegionOrder(ROLES), []);
  const problems = checkRegionOrder(["header", "main", "speakers", "speakers"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Line 3 is marked Speaker info but comes after Main/);
  assert.deepEqual(checkRegionOrder(["header"]), ["No lines are marked Main."]);
  assert.deepEqual(checkRegionOrder(["header", "main"]), [], "speaker info is optional");
});

console.log("Parsing another document");

const OTHER = [
  "Transcript: demo-02",
  "Transcriber: Someone",
  "Participants",
  "CC:\tRobin (Visitor) #p003",
  "DD:\tKim [Kim Placeholder] (Participant) #p004",
  "OPENING",
  "1\tCC:\thello",
  "2\tDD:\thi there",
  "and more",
  "BODY",
  "3\tCC:\tbye",
  "4\t(1.2)",
  "stray line",
  "-- end --",
].join("\n");

const parsed = parseWithGrammar(OTHER, GRAMMAR);

check("header lines become metadata", () => {
  assert.deepEqual(parsed.metadata, { Transcript: "demo-02", Transcriber: "Someone" });
});

check("speakers are read with their fields, trimmed, blanks for absent optionals", () => {
  assert.deepEqual(parsed.speakers.map(({ line, ...s }) => s), [
    { code: "CC", name: "Robin", alternateName: "", affiliation: "Visitor", id: "p003" },
    { code: "DD", name: "Kim", alternateName: "Kim Placeholder", affiliation: "Participant", id: "p004" },
  ]);
});

check("turns carry their section, and a wrapped line folds into the turn above", () => {
  assert.deepEqual(parsed.turns.filter((t) => !t.malformed).map((t) => `${t.section}/${t.turn}/${t.speaker}/${t.text}`), [
    "OPENING/1/CC/hello",
    "OPENING/2/DD/hi there and more",
    "BODY/3/CC/bye",
  ]);
  assert.deepEqual(parsed.continuations.map((c) => [c.line, c.into]), [[9, 8], [13, 12]]);
});

check("a numbered line that doesn't match is a malformed row with no speaker — and what follows folds into it, not the turn before", () => {
  const malformed = parsed.turns.filter((t) => t.malformed);
  assert.deepEqual(malformed, [{ line: 12, section: "BODY", turn: "4", speaker: "", text: "(1.2) stray line", malformed: true }]);
  assert.equal(parsed.turns.find((t) => t.turn === "3").text, "bye");
  assert.deepEqual(parsed.unmatched, []);
});

check("a line with nothing above it to fold into is unmatched", () => {
  const result = parseWithGrammar(["Participants", "OPENING", "stray", "1\tCC:\thi"], GRAMMAR);
  assert.deepEqual(result.unmatched.map((u) => [u.line, u.region]), [[3, "main"]]);
});

check("an ignored line is recorded as ignored", () => {
  assert.deepEqual(parsed.ignored.map((i) => i.line), [14]);
});

check("every non-blank line is accounted for exactly once", () => {
  const lines = OTHER.split("\n");
  const counted = Object.keys(parsed.metadata).length + parsed.speakers.length + parsed.turns.length
    + parsed.sections.length + parsed.continuations.length + parsed.ignored.length + parsed.unmatched.length
    + 1; // the "Participants" marker
  assert.equal(counted, lines.filter((l) => l.trim()).length);
});

check("without marker lines, region boundaries come from the row shapes", () => {
  const roles = ROLES.slice();
  const grammar = buildGrammar({
    name: "no-markers", lines: LINES, roles, markers: LINES.map(() => false),
    speakerSamples: SPEAKER_SAMPLES, turnSamples: TURN_SAMPLES,
  });
  assert.equal(grammar.regions.speakers.start, null);
  assert.equal(grammar.regions.main.start, null);
  const result = parseWithGrammar(["Title: x", "CC:\tRobin (Visitor) #p003", "1\tCC:\thello"], grammar);
  assert.equal(result.metadata.Title, "x");
  assert.equal(result.speakers.length, 1);
  assert.equal(result.turns.length, 1);
});

check("a .docx's paragraphs are the lines, soft breaks folded in", () => {
  assert.deepEqual(textToLines("A: b\n\nC\nD\n\n\n\nE\n\n", { paragraphs: true }), ["A: b", "C D", "", "E"]);
  assert.deepEqual(textToLines("a\r\nb\rc"), ["a", "b", "c"]);
});

console.log("The saved config");

check("the grammar validates and carries no sample text", () => {
  assert.deepEqual(validateGrammar(GRAMMAR), []);
  const json = JSON.stringify(GRAMMAR);
  for (const word of ["Alex", "Example", "Sam", "Researcher", "Place A", "p001", "first turn"]) {
    assert.ok(!json.includes(word), `saved grammar contains "${word}"`);
  }
});

check("a round trip through JSON parses the same", () => {
  const again = parseWithGrammar(OTHER, JSON.parse(JSON.stringify(GRAMMAR)));
  assert.deepEqual(again.turns, parsed.turns);
});

check("a broken pattern is caught by validation", () => {
  const broken = { ...GRAMMAR, turnRow: { ...GRAMMAR.turnRow, pattern: "(unclosed" } };
  assert.match(validateGrammar(broken).join(), /turnRow/);
  assert.match(validateGrammar({ ...GRAMMAR, version: 99 }).join(), /unsupported version/);
});

console.log("Starting points");

check("region suggestions follow the ca-data-prep convention", () => {
  const lines = ["Transcript: t", "Speakers:", "A:\tAl #a", "", "MAIN", "A:\thi", "END OF TRANSCRIPT"];
  const { roles, markers } = suggestRegions(lines);
  assert.deepEqual(roles, ["header", "speakers", "speakers", "speakers", "main", "main", "ignore"]);
  assert.deepEqual(markers, [false, true, false, false, true, false, false]);
});

check("a saved grammar suggests regions for a new document by parsing it", () => {
  const { roles, markers } = suggestRegions(OTHER.split("\n"), GRAMMAR);
  assert.equal(roles[3], "speakers");
  assert.equal(markers[2], true);
  assert.equal(roles[13], "ignore");
});

check("sample suggestions pick the fullest row and a sparser one", () => {
  const picked = suggestSamples(LINES, ROLES, MARKERS, "speakers", DEFAULT_GRAMMAR.speakerRow);
  assert.deepEqual(picked.map((p) => p.index), [4, 5]);
  const names = picked[0].spans.map((s) => LINES[4].slice(s.start, s.end));
  assert.deepEqual(names, ["AA", "Alex", "Alex Example", "Researcher, Place A", "p001"]);
});

check("spans from a match are trimmed to the text", () => {
  const spans = spansFromMatch("AA:\tAlex   [Alex Example] #p001", DEFAULT_GRAMMAR.speakerRow);
  const name = spans.find((s) => s.field === "name");
  assert.equal("AA:\tAlex   [Alex Example] #p001".slice(name.start, name.end), "Alex");
});

check("suggested samples regenerate a grammar that parses the sample itself", () => {
  const speakerSamples = suggestSamples(LINES, ROLES, MARKERS, "speakers", DEFAULT_GRAMMAR.speakerRow);
  const turnSamples = suggestSamples(LINES, ROLES, MARKERS, "main", DEFAULT_GRAMMAR.turnRow);
  const grammar = buildGrammar({ name: "x", lines: LINES, roles: ROLES, markers: MARKERS, speakerSamples, turnSamples });
  const result = parseWithGrammar(LINES, grammar);
  assert.equal(result.speakers.length, 2);
  assert.equal(result.turns.filter((t) => !t.malformed).length, 3);
  // "4\t(0.5)" and the period-numbered row: both kept as malformed rows, neither folded.
  assert.deepEqual(result.turns.filter((t) => t.malformed).map((t) => t.line), [14, 15]);
  assert.deepEqual(result.unmatched, []);
});

console.log("Layout: parts a format doesn't have");

// A chat-style export: every line a row, the first ones included. One of the
// rows looks like a header line ("Topic: …") and one like a section marker.
const ROWS_ONLY = [
  "Topic: first thing said",
  "BB: a reply",
  "INTERVAL",
  "AA: and another",
];
const rowsOnlySamples = (lines) => [markup(lines[1], [["speaker", "BB"], ["text", "a reply"]])];

check("saved grammars without a layout have every part", () => {
  assert.deepEqual(grammarLayout({ regions: {} }), { header: true, speakers: true, markers: true });
  assert.deepEqual(grammarLayout(null), { header: true, speakers: true, markers: true });
});

check("unticking a part turns its lines into Main and clears the markers", () => {
  const roles = ["header", "speakers", "main", "ignore"];
  const markers = [false, true, true, false];
  applyLayout(roles, markers, { header: false, speakers: false, markers: false });
  assert.deepEqual(roles, ["main", "main", "main", "ignore"]);
  assert.deepEqual(markers, [false, false, false, false]);
});

check("a main-only grammar reads every line as a row, from the first", () => {
  const layout = { header: false, speakers: false, markers: false };
  const roles = ROWS_ONLY.map(() => "main");
  const markers = ROWS_ONLY.map(() => false);
  const grammar = buildGrammar({ name: "rows", lines: ROWS_ONLY, roles, markers, turnSamples: rowsOnlySamples(ROWS_ONLY), speakerSamples: [], layout });
  assert.deepEqual(grammar.regions.layout, layout);
  assert.equal(grammar.speakerRow, null);
  const result = parseWithGrammar([...ROWS_ONLY, "Title: still a row"], grammar);
  assert.deepEqual(result.turns.map((t) => t.speaker), ["Topic", "BB", "AA", "Title"]);
  assert.deepEqual(result.metadata, {});
  assert.deepEqual(result.sections, []);
  // "INTERVAL" is not a row, so it folds into the row above instead of being a marker.
  assert.deepEqual(result.continuations.map((c) => c.line), [3]);
});

check("with the parts ticked, the same markup reads the first line as a header", () => {
  const roles = ["header", "main", "main", "main"];
  const markers = [false, false, true, false];
  const grammar = buildGrammar({ name: "rows", lines: ROWS_ONLY, roles, markers, turnSamples: rowsOnlySamples(ROWS_ONLY), speakerSamples: [] });
  const result = parseWithGrammar(ROWS_ONLY, grammar);
  assert.deepEqual(result.metadata, { Topic: "first thing said" });
  assert.deepEqual(result.sections.map((x) => x.name), ["INTERVAL"]);
});

check("no header but speaker info: the speaker rows come first, then the turns", () => {
  const lines = ["AA:\tAlex #p001", "BB:\tSam #p002", "1\tAA\thello", "2\tBB\thi"];
  const layout = { header: false, speakers: true, markers: false };
  const grammar = buildGrammar({
    name: "x", lines, layout,
    roles: ["speakers", "speakers", "main", "main"], markers: [false, false, false, false],
    speakerSamples: [markup(lines[0], [["code", "AA"], ["name", "Alex"], ["id", "p001"]])],
    turnSamples: [markup(lines[2], [["turn", "1"], ["speaker", "AA"], ["text", "hello"]])],
  });
  const result = parseWithGrammar(lines, grammar);
  assert.deepEqual(result.speakers.map((x) => x.code), ["AA", "BB"]);
  assert.deepEqual(result.turns.map((t) => t.text), ["hello", "hi"]);
  // …and a document without the speaker rows is still all turns.
  assert.deepEqual(parseWithGrammar(lines.slice(2), grammar).turns.length, 2);
  assert.deepEqual(result.unmatched, []);
});

check("a speaker pattern is not saved when the format has no speaker info", () => {
  const grammar = buildGrammar({
    name: "x", lines: LINES, roles: ROLES, markers: MARKERS,
    speakerSamples: suggestSamples(LINES, ROLES, MARKERS, "speakers", DEFAULT_GRAMMAR.speakerRow),
    turnSamples: suggestSamples(LINES, ROLES, MARKERS, "main", DEFAULT_GRAMMAR.turnRow),
    layout: { header: true, speakers: false, markers: true },
  });
  assert.equal(grammar.speakerRow, null);
  assert.equal(grammar.regions.speakers.start, null);
});

// ---------------------------------------------------------------------------
// Fixed-width rows
// ---------------------------------------------------------------------------

// Laid out like a London-Lund Corpus line: text id, a right-aligned turn
// number, counters, an optional "(" before the speaker, a code, the text, and
// a closing "/" in the last column. Every line the same width.
const FIXED = (turn, overlap, speaker, text) =>
  ` 1 1   1 ${String(turn).padStart(4)} 1 1${overlap ? "(" : " "}${speaker}    11  ${text.padEnd(50)} / `;
const FIXED_LINES = [
  FIXED(10, false, "B", "first words here#"),
  FIXED(20, false, "A", "a reply#"),
  FIXED(100, false, "A", "a longer turn number#"),
  FIXED(110, true, "B", "overlapping talk#"),
  FIXED(120, false, " ", "nobody speaking here"),
];
const fixedSample = (index = 0) => {
  const line = FIXED_LINES[index];
  return markup(line, [["turn", String([10, 20, 100, 110, 120][index])], ["speaker", line[18]], ["text", line.slice(26, 76).trim()]]);
};
const FIXED_ROLES = FIXED_LINES.map(() => "main");
const FIXED_MARKERS = FIXED_LINES.map(() => false);
const FIXED_LAYOUT = { header: false, speakers: false, markers: false };

check("fixed width: a format of same-width rows is recognised, and ordinary rows are not", () => {
  assert.equal(looksFixedWidth(FIXED_LINES), true);
  assert.equal(looksFixedWidth(LINES.slice(8, 11)), false);
});

check("fixed width: marked fields widen over the blanks either side into columns", () => {
  const spec = buildFixedRowPattern([fixedSample()], TURN_FIELDS);
  assert.equal(spec.fixedWidth, true);
  assert.deepEqual(spec.columns.map((c) => c.key), ["turn", "speaker", "text"]);
  const turn = spec.columns[0];
  // The "10" was marked; the column also covers a right-aligned "100".
  assert.ok(turn.from <= 10 && turn.to >= 13, JSON.stringify(turn));
  // Text stops short of the closing "/".
  const text = spec.columns[2];
  assert.equal(FIXED_LINES[0].slice(text.to).trim(), "/");
  assert.equal(describeFixedColumn({ from: 0, to: 4 }), "characters 1–4");
  assert.equal(describeFixedColumn({ from: 4, to: null }), "characters 5 to the end");
});

check("fixed width: every row is read by column, punctuation beside a code is not kept", () => {
  const grammar = buildGrammar({
    name: "fixed", lines: FIXED_LINES, roles: FIXED_ROLES, markers: FIXED_MARKERS,
    speakerSamples: [], turnSamples: [fixedSample()], optional: { turnRow: ["speaker"] },
    layout: FIXED_LAYOUT, fixedWidth: true,
  });
  assert.deepEqual(validateGrammar(grammar), []);
  const parsed = parseWithGrammar(FIXED_LINES, grammar);
  assert.deepEqual(parsed.unmatched, []);
  assert.deepEqual(parsed.turns.map((t) => [t.turn, t.speaker, t.text]), [
    ["10", "B", "first words here#"],
    ["20", "A", "a reply#"],
    ["100", "A", "a longer turn number#"],
    ["110", "B", "overlapping talk#"],
    ["120", "", "nobody speaking here"],
  ]);
});

check("fixed width: a saved grammar maps back onto its columns for editing", () => {
  const spec = buildFixedRowPattern([fixedSample()], TURN_FIELDS);
  const spans = spansFromMatch(FIXED_LINES[2], spec);
  assert.deepEqual(spans.map((s) => FIXED_LINES[2].slice(s.start, s.end)), ["100", "A", "a longer turn number#"]);
});

check("fixed width: removals apply to field values, not the line, so columns stay put", () => {
  const grammar = buildGrammar({
    name: "fixed", lines: FIXED_LINES, roles: FIXED_ROLES, markers: FIXED_MARKERS,
    speakerSamples: [], turnSamples: [fixedSample()], optional: { turnRow: ["speaker"] },
    layout: FIXED_LAYOUT, fixedWidth: true,
    cleanup: { drop: [], strip: ["#", " 1 1"], columns: [{ from: 0, to: 4 }] },
  });
  // Unmarked columns are left out already; a dropped column would move them.
  assert.deepEqual(grammar.dropColumns, []);
  const parsed = parseWithGrammar(FIXED_LINES, grammar);
  assert.deepEqual(parsed.turns.slice(0, 2).map((t) => [t.turn, t.speaker, t.text]), [["10", "B", "first words here"], ["20", "A", "a reply"]]);
});

check("fixed width: samples that put a field in different places are refused", () => {
  const moved = { line: FIXED_LINES[1], spans: [{ field: "turn", start: 0, end: 2 }, { field: "text", start: 26, end: 34 }] };
  assert.throws(() => buildFixedRowPattern([fixedSample(), moved], TURN_FIELDS), /different columns/);
});

check("fixed width: a row with a turn number that doesn't fit is kept, read by its columns", () => {
  const grammar = buildGrammar({
    name: "fixed", lines: FIXED_LINES, roles: FIXED_ROLES, markers: FIXED_MARKERS,
    speakerSamples: [], turnSamples: [fixedSample()], layout: FIXED_LAYOUT, fixedWidth: true,
  });
  const parsed = parseWithGrammar(FIXED_LINES, grammar);
  const blank = parsed.turns.find((t) => t.turn === "120");
  assert.equal(blank.malformed, true);
  assert.equal(blank.text, "nobody speaking here");
});

check("fixed width: a column set by hand replaces the one the marks give", () => {
  const auto = buildFixedRowPattern([fixedSample()], TURN_FIELDS);
  const autoText = auto.columns.find((c) => c.key === "text");
  // Text cut to its first five characters.
  const spec = buildFixedRowPattern([fixedSample()], TURN_FIELDS, { columns: { text: { from: 27, to: 32 } } });
  assert.deepEqual(spec.columns.find((c) => c.key === "text"), { key: "text", from: 27, to: 32 });
  assert.deepEqual(spec.edited, ["text"]);
  assert.deepEqual(spec.autoColumns.find((c) => c.key === "text"), autoText);
  const m = FIXED_LINES[0].match(new RegExp(spec.pattern, "u"));
  assert.equal(m.groups.text, "first");
});

check("fixed width: a column set by hand that overlaps another, or runs backwards, is refused", () => {
  assert.throws(() => buildFixedRowPattern([fixedSample()], TURN_FIELDS, { columns: { turn: { from: 8, to: 20 } } }), /share columns/);
  assert.equal(fixedColumnError({ from: 5, to: 5 }), "the last character must come at or after the first");
  assert.equal(fixedColumnError({ from: 5, to: null }), null);
  assert.throws(() => buildFixedRowPattern([fixedSample()], TURN_FIELDS, { columns: { turn: { from: -1, to: 4 } } }), /Turn number/);
});

check("fixed width: hand-set columns are saved, and the editor-only details are not", () => {
  const grammar = buildGrammar({
    name: "fixed", lines: FIXED_LINES, roles: FIXED_ROLES, markers: FIXED_MARKERS,
    speakerSamples: [], turnSamples: [fixedSample()], layout: FIXED_LAYOUT, fixedWidth: true,
    fixedColumns: { text: { from: 26, to: null } },
  });
  assert.deepEqual(grammar.turnRow.columns.find((c) => c.key === "text"), { key: "text", from: 26, to: null });
  assert.equal("autoColumns" in grammar.turnRow, false);
  assert.equal("edited" in grammar.turnRow, false);
  // Open-ended text now takes the closing "/" too.
  assert.match(parseWithGrammar(FIXED_LINES, grammar).turns[1].text, /^a reply#\s+\/$/);
});

// ---------------------------------------------------------------------------
// Joining rows split over lines
// ---------------------------------------------------------------------------

const SPLIT_LINES = [
  FIXED(10, false, "B", "the first half of a"),
  FIXED(10, false, "B", "long unit#"),
  FIXED(20, false, "A", "a reply#"),
  FIXED(10, false, "B", "not straight after#"),
  FIXED(30, false, "B", "one speaker"),
  FIXED(30, false, "A", "then another#"),
  FIXED(40, false, "B", "three"),
  FIXED(40, true, "B", "lines"),
  FIXED(40, false, "B", "long#"),
];
const splitGrammar = (joinRepeats) => buildGrammar({
  name: "split", lines: SPLIT_LINES, roles: SPLIT_LINES.map(() => "main"), markers: SPLIT_LINES.map(() => false),
  speakerSamples: [], turnSamples: [fixedSample()], layout: FIXED_LAYOUT, fixedWidth: true, joinRepeats,
});

check("joining: a row repeating the turn number and speaker of the row above joins it", () => {
  const parsed = parseWithGrammar(SPLIT_LINES, splitGrammar(true));
  assert.deepEqual(parsed.turns.map((t) => [t.line, t.turn, t.speaker, t.text]), [
    [1, "10", "B", "the first half of a long unit#"],
    [3, "20", "A", "a reply#"],
    // Not straight after the first 10, so not joined to it.
    [4, "10", "B", "not straight after#"],
    // Same number, another speaker: two rows.
    [5, "30", "B", "one speaker"],
    [6, "30", "A", "then another#"],
    // Punctuation beside the speaker doesn't make it another speaker.
    [7, "40", "B", "three lines long#"],
  ]);
  assert.deepEqual(parsed.joined.map((j) => [j.line, j.into]), [[2, 1], [8, 7], [9, 7]]);
  assert.equal(parsed.roles[1], "main:joined");
});

check("joining: off unless the grammar says so, and saved in its fingerprint", () => {
  assert.equal(parseWithGrammar(SPLIT_LINES, splitGrammar(false)).turns.length, 9);
  assert.equal(splitGrammar(false).turnRow.joinRepeats, undefined);
  assert.equal(splitGrammar(true).turnRow.joinRepeats, true);
  assert.notEqual(grammarFingerprint(splitGrammar(true)), grammarFingerprint(splitGrammar(false)));
});

check("joining: works the same for rows read by a text pattern", () => {
  const lines = ["1\tAA:\tfirst part", "1\tAA:\tsecond part", "2\tBB:\treply"];
  const grammar = buildGrammar({
    name: "text", lines, roles: lines.map(() => "main"), markers: lines.map(() => false),
    speakerSamples: [], turnSamples: [markup(lines[0], [["turn", "1"], ["speaker", "AA"], ["text", "first part"]])],
    layout: FIXED_LAYOUT, joinRepeats: true,
  });
  assert.deepEqual(parseWithGrammar(lines, grammar).turns.map((t) => t.text), ["first part second part", "reply"]);
});

// ---------------------------------------------------------------------------
// Custom labels
// ---------------------------------------------------------------------------

const PROSODY = { key: "c_prosody", label: "Prosody" };

check("custom labels: keys are group names, unique, and labels can't repeat a field", () => {
  assert.equal(customFieldKey("Prosodic code"), "c_prosodic_code");
  assert.equal(customFieldKey("Prosody", ["c_prosody"]), "c_prosody_2");
  assert.equal(customFieldKey("声調"), "c_field");
  assert.equal(customLabelError("text"), 'there is already a "text"');
  assert.equal(customLabelError("Prosody", [PROSODY]), 'there is already a "Prosody"');
  assert.equal(customLabelError("  "), "give the label a name");
  assert.equal(customLabelError("Overlap", [PROSODY]), null);
  assert.deepEqual(turnFieldDefs([PROSODY]).map((f) => f.key), ["turn", "speaker", "text", "c_prosody"]);
});

check("custom labels: a marked label is read from its column in fixed-width rows", () => {
  const sample = fixedSample();
  sample.spans.push({ field: PROSODY.key, start: 23, end: 25 });
  const grammar = buildGrammar({
    name: "fixed", lines: FIXED_LINES, roles: FIXED_ROLES, markers: FIXED_MARKERS,
    speakerSamples: [], turnSamples: [sample], optional: { turnRow: ["speaker"] },
    layout: FIXED_LAYOUT, fixedWidth: true, customFields: [PROSODY, { key: "c_unused", label: "Unused" }],
  });
  assert.deepEqual(validateGrammar(grammar), []);
  // Only the labels a sample marks are saved.
  assert.deepEqual(grammar.turnRow.customFields, [PROSODY]);
  const turns = parseWithGrammar(FIXED_LINES, grammar).turns;
  assert.deepEqual(turns.map((t) => t.c_prosody), ["11", "11", "11", "11", "11"]);
  assert.equal(turns[0].text, "first words here#");
});

check("custom labels: a marked label is read in text-pattern rows too", () => {
  const lines = ["1\tAA:\tfirst part\t[low]", "2\tBB:\treply\t[high]"];
  const grammar = buildGrammar({
    name: "text", lines, roles: lines.map(() => "main"), markers: lines.map(() => false),
    speakerSamples: [], layout: FIXED_LAYOUT, customFields: [{ key: "c_pitch", label: "Pitch" }],
    turnSamples: [markup(lines[0], [["turn", "1"], ["speaker", "AA"], ["text", "first part"], ["c_pitch", "low"]])],
  });
  const turns = parseWithGrammar(lines, grammar).turns;
  assert.deepEqual(turns.map((t) => [t.text, t.c_pitch]), [["first part", "low"], ["reply", "high"]]);
});

check("custom labels: a saved grammar's labels are checked", () => {
  const grammar = splitGrammar(false);
  grammar.turnRow.customFields = [{ key: "bad key", label: "" }];
  assert.equal(validateGrammar(grammar).length, 2);
});

check("custom labels: speaker rows take labels of their own, checked against speaker fields", () => {
  assert.equal(customLabelError("Name", [], SPEAKER_FIELDS), 'there is already a "Name"');
  assert.equal(customLabelError("Text", [], SPEAKER_FIELDS), null);
  assert.deepEqual(speakerFieldDefs([{ key: "c_role", label: "Role" }]).map((f) => f.key), ["code", "name", "alternateName", "affiliation", "id", "c_role"]);
  const grammar = splitGrammar(false);
  grammar.speakerRow = { pattern: "^x$", customFields: [{ key: "nope", label: "Role" }] };
  assert.match(validateGrammar(grammar).join(" "), /speakerRow\.customFields\[0\]/);
});

if (failures) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll transcript-grammar checks passed.");
