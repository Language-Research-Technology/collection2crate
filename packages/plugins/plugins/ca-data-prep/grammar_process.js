// Transcript processing driven by a saved grammar (plugins/transcript-grammar)
// instead of the built-in convention in process.js.
//
// The result has exactly the shape processTranscriptText() returns — rows,
// speakerMap, diagnostics, nonConforming, log — so everything downstream
// (the CSV, the log file, the Person entities, chat-export's CHAT file) is
// unchanged by which reader produced it. What differs is only where the line
// shapes come from, and so what the report says was expected.
//
// The grammar parser accounts for every non-blank line. This module turns that
// accounting into the same kind of findings the built-in reader reports:
// a line the grammar could not read is non-conforming (and, when it opens with
// a turn number, still a row — with no speaker), a wrapped line folded
// into the turn above is recorded against its own line, and a turn whose
// speaker nobody declared is flagged — never dropped.

import { documentLines, parseWithGrammar, grammarPath, describeColumnRule, describeFixedColumn, SPEAKER_FIELDS, TURN_FIELDS } from "../../src/_transcript_grammar.js";

// The three section names the built-in convention abbreviates in the CSV.
// A grammar's other section names go into the CSV as written.
const SECTION_CODES = { PRELIMINARIES: "PRE", MAIN: "MAIN", POSTLIMINARIES: "POST" };
export const sectionCode = (name) => (name ? SECTION_CODES[name] || name : "MAIN");

export const GRAMMAR_ISSUE_LABELS = {
  "speaker-row-unmatched": "line does not match the grammar's speaker row",
  "turn-row-unmatched": "line does not match the grammar's turn row",
  "turn-row-malformed": "row has a turn number but does not match the grammar's turn row",
  "header-line-unmatched": "header line is not \"Key: value\"",
  "line-folded": "not a turn — joined to the turn above as a wrapped line",
  "section-order": "section is out of the grammar's order",
};

const idWithHash = (id) => (id ? (id.startsWith("#") ? id : `#${id}`) : null);
const orNull = (value) => (value ? value : null);
// An id for a speaker named only on their turns: stable, and usable as an
// RO-Crate "#fragment" whatever script the name is in.
const slug = (name) => String(name).trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_.-]/gu, "") || "speaker";

/** A readable statement of a row's fields, for the report's "Expected" line. */
export function describeRow(spec, fieldDefs) {
  if (!spec) return "(none)";
  const fields = spec.fields?.length
    ? spec.fields
    : fieldDefs.filter((f) => new RegExp(`\\(\\?<${f.key}>`).test(spec.pattern)).map((f) => ({ ...f, optional: false }));
  const describe = (f) => {
    const name = f.optional ? `[${f.label.toLowerCase()}]` : f.label.toLowerCase();
    return spec.fixedWidth && Number.isInteger(f.from) ? `${name} (${describeFixedColumn(f)})` : name;
  };
  return fields.map(describe).join(" · ");
}

/**
 * Parse `text` with `grammar`. `strip(text)` is applied first — the caller's
 * line-preserving clean-up (timecode removal) — so the line numbers still
 * point at the document.
 */
export function processWithGrammar(text, grammar, { grammarName = grammar?.name || "", strip = (t) => t } = {}) {
  const lines = documentLines(strip(String(text || "")));
  const parsed = parseWithGrammar(lines, grammar);
  const warnings = [];

  // Speakers. Keyed by code, or by the bare id when the grammar marks no code.
  const speakerMap = new Map();
  const speakerDiagnostics = [];
  const byId = new Map();
  // A grammar's own speaker fields, by label, for the Person entities.
  const speakerCustom = grammar.speakerRow?.customFields || [];
  for (const speaker of parsed.speakers) {
    const key = speaker.code || String(speaker.id || "").replace(/^#/, "");
    const optionalCode = idWithHash(speaker.id);
    const issues = [];
    if (!key) issues.push({ field: "speakerCode", kind: "speaker-code-missing", detail: "the declaration has neither a code nor an id" });
    if (key && speakerMap.has(key)) issues.push({ field: "speakerCode", kind: "speaker-code-duplicate", detail: `speaker code "${key}"` });
    const details = {
      name: speaker.name || "",
      alternateName: orNull(speaker.alternateName),
      demographic: orNull(speaker.affiliation),
      // Parenthesised, as process.js keeps it: chat-export reads it as the
      // CHAT @ID group field and strips the parentheses itself.
      affiliation: speaker.affiliation ? `(${speaker.affiliation})` : null,
      optionalCode,
      issues,
    };
    if (key) {
      speakerMap.set(key, {
        label: details.name || key,
        name: details.name,
        alternateName: details.alternateName,
        demographic: details.demographic,
        affiliation: details.affiliation,
        optionalCode,
        resolvedSpeakerID: optionalCode || key,
        line: speaker.line,
        ...(speakerCustom.length ? { extra: Object.fromEntries(speakerCustom.map((f) => [f.label, speaker[f.key] || ""])) } : {}),
      });
      if (optionalCode) byId.set(optionalCode, key);
    }
    speakerDiagnostics.push({
      line: speaker.line,
      content: lines[speaker.line - 1],
      code: key || null,
      conforming: issues.length === 0,
      details,
      issues,
    });
  }

  const unmatchedIn = (region) => parsed.unmatched.filter((u) => u.region === region);
  for (const u of unmatchedIn("speakers")) {
    speakerDiagnostics.push({
      line: u.line, content: u.text.trim(), code: null, conforming: false, details: null,
      issues: [{ field: "speakerCode", kind: "speaker-row-unmatched", detail: "the declaration was skipped" }],
    });
  }
  speakerDiagnostics.sort((a, b) => a.line - b.line);

  // A grammar with no speaker rows names the speaker on every turn instead
  // ("<u speaker=Daiki>"), and a document may leave its speaker block out even
  // when the grammar has one — it is optional, like the header. Either way the
  // speakers are whoever the turns name, in order of first appearance, and
  // there is no declaration to check against.
  const grammarHasSpeakers = !!grammar.speakerRow?.pattern;
  const documentHasSpeakerBlock = parsed.speakers.length > 0 || unmatchedIn("speakers").length > 0
    || parsed.roles.some((role) => role === "speakers:marker");
  const declaresSpeakers = grammarHasSpeakers && documentHasSpeakerBlock;
  if (!declaresSpeakers) {
    for (const turn of parsed.turns) {
      const name = turn.speaker;
      if (!name || speakerMap.has(name)) continue;
      const id = `#${slug(name)}`;
      speakerMap.set(name, {
        label: name, name, alternateName: null, demographic: null, affiliation: null,
        optionalCode: id, resolvedSpeakerID: id, line: turn.line,
      });
      byId.set(id, name);
    }
  }

  // Turns.
  const declared = new Set();
  for (const [code, details] of speakerMap) {
    declared.add(code);
    if (details.optionalCode) { declared.add(details.optionalCode); declared.add(details.optionalCode.slice(1)); }
  }
  const resolveSpeaker = (value) => {
    if (!value) return "";
    const key = speakerMap.has(value) ? value : byId.get(idWithHash(value));
    return key ? speakerMap.get(key).optionalCode || key : value;
  };

  const bodyDiagnostics = [];
  const customFields = grammar.turnRow?.customFields || [];
  const rows = parsed.turns.map((turn) => {
    const issues = [];
    if (turn.malformed) issues.push({ field: "row", kind: "turn-row-malformed", detail: `turn number "${turn.turn}" — added to the CSV with no speaker` });
    else if (!turn.speaker) issues.push({ field: "speakerCode", kind: "speaker-code-missing", detail: turn.turn ? `turn number "${turn.turn}"` : "" });
    else if (declaresSpeakers && !declared.has(turn.speaker)) issues.push({ field: "speakerCode", kind: "speaker-code-undeclared", detail: `speaker code "${turn.speaker}"` });
    if (!turn.text) issues.push({ field: "text", kind: "text-missing", detail: turn.speaker ? `speaker code "${turn.speaker}"` : "" });
    if (issues.length) {
      bodyDiagnostics.push({ line: turn.line, content: lines[turn.line - 1].trim(), section: turn.section || "(no section)", code: turn.speaker || null, issues });
    }
    const row = { turnNumber: turn.turn || "", speakerID: resolveSpeaker(turn.speaker), text: turn.text || "", section: sectionCode(turn.section) };
    // A grammar's own fields ride along, by label, for the CSV's extra columns.
    if (customFields.length) row.extra = Object.fromEntries(customFields.map((f) => [f.label, turn[f.key] || ""]));
    return row;
  });

  const sectionAt = (line) => {
    let name = "(no section)";
    for (const s of parsed.sections) if (s.line < line) name = s.name;
    return name;
  };
  for (const c of parsed.continuations) {
    bodyDiagnostics.push({
      line: c.line, content: c.text.trim(), section: sectionAt(c.line), code: null,
      issues: [{ field: "text", kind: "line-folded", detail: `joined to the turn on line ${c.into}` }],
    });
  }
  for (const u of unmatchedIn("main")) {
    bodyDiagnostics.push({
      line: u.line, content: u.text.trim(), section: sectionAt(u.line), code: null,
      issues: [{ field: "row", kind: "turn-row-unmatched", detail: "the line was not added to the CSV" }],
    });
  }
  bodyDiagnostics.sort((a, b) => a.line - b.line);

  // Sections: which of the grammar's were found, in what order, with how many rows.
  const declaredSections = grammar.regions?.main?.sections || [];
  const sectionDiagnostics = declaredSections.map((name) => {
    const found = parsed.sections.find((s) => s.name === name);
    const count = parsed.turns.filter((t) => t.section === name).length;
    const lastLine = Math.max(1, lines.length);
    if (!found) return { name, processed: false, headerLine: null, line: lastLine, reason: "section marker was not found before the end of the document" };
    if (!count) return { name, processed: false, headerLine: found.line, line: found.line, reason: "section marker was found, but no transcript rows were found" };
    return { name, processed: true, headerLine: found.line, line: found.line, reason: `${count} transcript row(s) processed` };
  });
  const foundOrder = parsed.sections.map((s) => s.name);
  const expectedOrder = declaredSections.filter((name) => foundOrder.includes(name));
  const firstSeen = [...new Set(foundOrder)];
  if (firstSeen.join("|") !== expectedOrder.join("|")) {
    warnings.push(`Section order: found ${firstSeen.join(", ")}; the grammar expects ${declaredSections.join(", ")}.`);
  }
  if (declaresSpeakers && !parsed.speakers.length) warnings.push(`No speaker declarations matched the grammar "${grammarName}".`);
  if (!parsed.turns.length) warnings.push(`No transcript rows matched the grammar "${grammarName}".`);

  const headerUnmatched = unmatchedIn("header");
  const nonConformingSpeakers = speakerDiagnostics.filter((entry) => !entry.conforming);
  const nonConforming = {
    speakers: nonConformingSpeakers,
    body: bodyDiagnostics,
    header: headerUnmatched,
    total: nonConformingSpeakers.length + bodyDiagnostics.length + headerUnmatched.length,
  };

  return {
    rows,
    extraColumns: customFields.map((f) => f.label),
    speakerMap,
    metadata: parsed.metadata,
    warnings,
    sectionDiagnostics,
    speakerDiagnostics,
    bodyDiagnostics,
    nonConforming,
    ignored: parsed.ignored,
    report: {
      grammarLine: `Parsed with the transcript grammar "${grammarName}" (${grammarPath(grammarName)}).`,
      cleanupLine: `Cleanup: ${(grammar.ignore || []).length} line-skip rule(s) (${parsed.ignored.length} line(s) skipped), ${(grammar.strip || []).length} removal rule(s): ${(grammar.strip || []).map((r) => r.pattern).join("  ") || "none"}` +
        `, ${(grammar.dropColumns || []).length} dropped column(s) in main rows: ${(grammar.dropColumns || []).map(describeColumnRule).join("; ") || "none"}` +
        (grammar.turnRow?.joinRepeats ? `; ${parsed.joined.length} row(s) joined to the row above for repeating its turn number and speaker` : ""),
      speakerExpected: declaresSpeakers
        ? [
          `Expected format (grammar "${grammarName}"): ${describeRow(grammar.speakerRow, SPEAKER_FIELDS)} — bracketed fields are optional.`,
          `Pattern: ${grammar.speakerRow.pattern}`,
        ]
        : [grammarHasSpeakers
          ? `This document has no speaker block (it is optional); the speakers are the names the turns give (${speakerMap.size} found).`
          : `The grammar "${grammarName}" has no speaker rows; the speakers are the names the turns give (${speakerMap.size} found).`],
      bodyExpected: [
        `Expected format (grammar "${grammarName}"): ${describeRow(grammar.turnRow, TURN_FIELDS)} — bracketed fields are optional.`,
        `Pattern: ${grammar.turnRow?.pattern ?? "(none)"}`,
      ],
      sectionRule: declaredSections.length
        ? `Section markers (grammar "${grammarName}"): ${declaredSections.join(", ")}.`
        : `The grammar "${grammarName}" declares no section markers; every row is in MAIN.`,
    },
  };
}

export function formatMetadata(metadata, headerUnmatched = []) {
  const lines = ["Header metadata:"];
  const entries = Object.entries(metadata || {});
  if (!entries.length) lines.push("None found.");
  for (const [key, value] of entries) lines.push(`${key}: ${value}`);
  if (headerUnmatched.length) {
    lines.push("", `Header lines that are not "Key: value" (${headerUnmatched.length}):`);
    for (const u of headerUnmatched) lines.push(`Line ${u.line}: ${JSON.stringify(u.text)}`);
  }
  return lines.join("\n");
}
