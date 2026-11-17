import { ROCrate } from "ro-crate";
import mammoth from "mammoth";
import { processWithGrammar, formatMetadata, GRAMMAR_ISSUE_LABELS } from "./grammar_process.js";

// ---------------------------------------------------------------------------
// The transcript grammar
//
// A source document is three parts: a metadata header, a speaker block, and a
// body. Two line shapes carry everything the parser reads, and both are
// declared here so the parser and the conformance report can never drift:
//
//   speaker block   CODE: name [alternate name] (demographic info) #id
//   body row        [turn number][.] CODE: text
//
// Departures are logged, not silently corrected. A repair the parser makes is
// reported against the line it was made on, so a transcriber can fix the
// source document rather than discover the damage in the CSV.
// ---------------------------------------------------------------------------

// A speaker code: alphanumeric with light punctuation, no whitespace, no
// colon. The length bound is what keeps an ordinary word from passing as a
// code on a line that is missing its colon.
const CODE = "[A-Za-z0-9][A-Za-z0-9_.'\\-]{0,23}";
const CODE_WITH_COLON = new RegExp(`^(${CODE})[\\t ]*:[\\t ]*(.*)$`);
const CODE_WITHOUT_COLON = new RegExp(`^(${CODE})[\\t ]+(.*)$`);
const TURN_NUMBER_PREFIX = /^(\d+)(\.?)[\t ]+(.*)$/;

export const SECTION_MARKERS = ["PRELIMINARIES", "MAIN", "POSTLIMINARIES"];

// Lines belonging to the metadata header rather than to a turn: never folded
// into the turn above, never reported as a non-conforming body row.
const HEADER_PATTERNS = [
  /^Speakers:$/i,
  /^PRELIMINARIES$/i,
  /^MAIN$/i,
  /^POSTLIMINARIES$/i,
  /^Transcript:/i,
  /^Recording date:/i,
  /^Length of audio recording:/i,
  /^Length of video recording:/i,
  /^Transcriber:/i,
];

export function isHeaderLine(value) {
  const trimmed = String(value || "").trim();
  return HEADER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Which .docx paragraph each line of the extracted text belongs to.
 *
 * mammoth terminates every paragraph with a blank line, so "\n\n" is the
 * paragraph separator and a lone "\n" is a soft line break inside one. That
 * makes a raw line number roughly twice the paragraph's position — and more
 * than twice once the document has empty paragraphs of its own, each of which
 * contributes a blank line and a terminator. Reporting those raw numbers gave
 * a transcriber nothing they could find in their own document.
 *
 * Returns a 1-based paragraph number per line, aligned with `text.split("\n")`.
 * The report calls these line numbers, because that is what someone reading a
 * transcript counts; the paragraph is only how the number is arrived at.
 */
export function paragraphNumbersByLine(text) {
  const paragraphs = String(text || "").split("\n\n");
  const numbers = [];

  paragraphs.forEach((paragraph, index) => {
    const lineCount = paragraph.split("\n").length;
    for (let i = 0; i < lineCount; i += 1) numbers.push(index + 1);
    // The blank line that separated this paragraph from the next belongs to
    // this one, so a finding on it still points at the paragraph it came from.
    if (index < paragraphs.length - 1) numbers.push(index + 1);
  });

  return numbers;
}

// A paragraph that reads as a section marker but is not one: wrong case, or
// stray punctuation around it. A header has to match exactly, and when it does
// not the whole section silently disappears into the one before it — so a
// near miss is the single most consequential thing this report can point at.
const MARKER_NEAR_MISS = /^[^A-Za-z]*([A-Za-z]+)[^A-Za-z]*$/;

export function nearMissMarker(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || SECTION_MARKERS.includes(trimmed)) return null;
  const match = trimmed.match(MARKER_NEAR_MISS);
  if (!match) return null;
  const candidate = match[1].toUpperCase();
  return SECTION_MARKERS.includes(candidate) ? candidate : null;
}

const sectionName = (section) =>
  section === "PRE" ? "PRELIMINARIES" : section === "POST" ? "POSTLIMINARIES" : "MAIN";

// Every way a line can depart from the grammar, with the wording the report
// groups by. Keeping the label out of the interpolated message is what lets
// the log lead with "310 rows missing a turn-number period" instead of 310
// individually-worded lines a reader has to count for themselves.
export const ISSUE_LABELS = {
  "turn-number-missing-period": "turn number is missing its period",
  "speaker-code-missing-colon": "speaker code is not followed by a colon",
  "speaker-code-undeclared": "speaker code was not declared in the Speakers block",
  "speaker-code-missing": "no speaker code found",
  "speaker-code-duplicate": "speaker code was declared more than once",
  "text-missing": "turn has no text",
  "speaker-name-missing": "no speaker name found",
  "speaker-id-missing": "no #id found",
  "speaker-name-unbalanced-bracket": "unbalanced bracket in the speaker name",
  // Findings only a saved grammar's reader produces (grammar_process.js).
  ...GRAMMAR_ISSUE_LABELS,
};

export function normalizeText(text) {
  let normalized = String(text || "");

  normalized = normalized.replace(/\r\n/g, "\n");
  normalized = normalized.replace(/\r/g, "\n");
  normalized = normalized.replace(/\u00A0/g, " ");
  normalized = normalized.replace(/^[\t ]+/gm, "\t");
  // Regularise the gap after a code's colon — but never insert the colon
  // itself. An earlier version of this function rewrote any line starting
  // with a capital and a space into "X:\ttext", which silently turned every
  // wrapped line beginning "I ..." or "A ..." into a turn by a speaker called
  // "I" or "A", with nothing in the log to say so. A missing colon is a
  // non-conformance the body scan has to be able to see.
  normalized = normalized.replace(new RegExp(`^(${CODE}):[\\t ]+`, "gm"), "$1:\t");
  normalized = normalized.replace(/(\t.*) \t/gm, "$1 ");
  normalized = normalized.replace(/^.*END OF TRANSCRIPT.*$/gm, "");

  return normalized;
}

/**
 * Read one body line against the row grammar.
 *
 * Returns what the line is, the fields it yielded, and every way it departed
 * from the grammar. A departure never stops the line being parsed — the row
 * still reaches the CSV — it only gets recorded, which is what the report
 * this feeds exists to show.
 *
 * `declaredCodes` is the set of codes the Speakers block declared (both the
 * short code and its #id). Without it the shape of a line is all there is to
 * go on; with it, a line missing its colon can still be recognised, and a
 * colon-bearing line whose code nobody declared can be called out.
 */
export function classifyBodyLine(rawLine, declaredCodes = null) {
  const line = String(rawLine || "").trim();
  const issues = [];

  if (!line) return { kind: "blank", issues };
  if (SECTION_MARKERS.includes(line)) return { kind: "section", marker: line, issues };
  if (isHeaderLine(line)) return { kind: "header", issues };

  const declared = declaredCodes instanceof Set && declaredCodes.size ? declaredCodes : null;

  const readCode = (candidate) => {
    const withColon = candidate.match(CODE_WITH_COLON);
    if (withColon) return { code: withColon[1], text: withColon[2].trim(), colon: true };
    // Without a colon there is nothing in the line's shape to distinguish a
    // code from the first word of prose, so only a declared code counts.
    const withoutColon = candidate.match(CODE_WITHOUT_COLON);
    if (withoutColon && declared && declared.has(withoutColon[1])) {
      return { code: withoutColon[1], text: withoutColon[2].trim(), colon: false };
    }
    return null;
  };

  const numbered = line.match(TURN_NUMBER_PREFIX);
  let turnNumber = null;
  let periodPresent = true;
  let parsed = null;

  // The leading number is only a turn number if a code follows it. That is
  // what keeps a wrapped line like "1998 Budget: the figure was" from being
  // read as turn 1998 by a speaker called Budget.
  if (numbered) {
    parsed = readCode(numbered[3]);
    if (parsed) {
      turnNumber = numbered[1];
      periodPresent = numbered[2] === ".";
    }
  }
  if (!parsed) parsed = readCode(line);

  if (!parsed) {
    // A turn-number column is proof on its own that the line is a new row: a
    // wrapped continuation is the tail of a paragraph and never carries one.
    // Reading the number only once a code had been found is what made a row
    // whose speaker code is missing — a bare pause like "6\t(0.4)" — look
    // exactly like a wrap, so it folded into the turn above and its text
    // disappeared into that row's cell with nothing reported against it.
    //
    // The tab is what tells a turn-number column from prose that merely opens
    // with a numeral, and it has to: accepting a space-separated number on the
    // strength of the document being numbered elsewhere turns a wrapped
    // "1998 was the year" into turn 1998 reading "was the year", losing the
    // numeral out of the text. A space-delimited column would need the number
    // to continue the numbering run before it could be trusted.
    const columnDelimited = /^\d+\.?\t/.test(line);
    if (numbered && columnDelimited) {
      const rowIssues = [];
      if (numbered[2] !== ".") {
        rowIssues.push({ field: "turnNumber", kind: "turn-number-missing-period", detail: `turn number "${numbered[1]}"` });
      }
      rowIssues.push({ field: "speakerCode", kind: "speaker-code-missing", detail: `turn number "${numbered[1]}"` });
      const rowText = numbered[3].trim();
      if (!rowText) rowIssues.push({ field: "text", kind: "text-missing", detail: `turn number "${numbered[1]}"` });
      return { kind: "turn", turnNumber: numbered[1], code: null, text: rowText, issues: rowIssues };
    }

    return {
      kind: "continuation",
      content: line,
      issues: [{ field: "speakerCode", kind: "speaker-code-missing", detail: "the line was folded into the turn above it" }],
    };
  }

  if (turnNumber !== null && !periodPresent) {
    issues.push({ field: "turnNumber", kind: "turn-number-missing-period", detail: `turn number "${turnNumber}"` });
  }
  if (!parsed.colon) {
    issues.push({ field: "speakerCode", kind: "speaker-code-missing-colon", detail: `speaker code "${parsed.code}"` });
  }
  if (declared && !declared.has(parsed.code)) {
    issues.push({ field: "speakerCode", kind: "speaker-code-undeclared", detail: `speaker code "${parsed.code}"` });
  }
  if (!parsed.text) {
    issues.push({ field: "text", kind: "text-missing", detail: `speaker code "${parsed.code}"` });
  }

  return { kind: "turn", turnNumber, code: parsed.code, text: parsed.text, issues };
}

/**
 * Fold wrapped lines back into the turn they belong to, and report where each
 * surviving line came from.
 *
 * `lineNumbers[i]` is the 1-based line number, in the text handed in, that
 * merged line `i` started on — which is what lets the conformance report
 * point a transcriber at a line of their own document rather than at a line
 * of an intermediate the parser never shows them.
 */
export function mergeContinuationLinesWithMap(text, declaredCodes = null) {
  const sourceLines = String(text || "").split("\n");
  const lines = [];
  const lineNumbers = [];
  let inSpeakerBlock = false;

  for (let index = 0; index < sourceLines.length; index += 1) {
    const raw = sourceLines[index];
    const trimmed = raw.trim();

    // Nothing folds inside the speaker block: one declaration per line is the
    // block's whole layout, so a line there always starts a new one. Folding
    // by line shape instead would swallow a declaration whose colon is
    // missing — exactly the non-conformance this is meant to report — into
    // the declaration above it, handing one speaker another's name and #id.
    if (/^Speakers:$/i.test(trimmed)) inSpeakerBlock = true;
    else if (SECTION_MARKERS.includes(trimmed)) inSpeakerBlock = false;

    const classified = classifyBodyLine(raw, declaredCodes);
    const startsLine = inSpeakerBlock
      ? classified.kind !== "blank"
      : classified.kind !== "continuation" && classified.kind !== "blank";

    if (startsLine || !lines.length) {
      lines.push(raw);
      lineNumbers.push(index + 1);
      continue;
    }

    // A blank line ends nothing — the source wraps turns across blank lines,
    // so what folds is decided by what a line says, not by the gap before it.
    const addition = raw.trim();
    if (!addition) continue;

    // Nothing folds into a section marker or a metadata header. A wrap can
    // only continue a turn, and gluing one onto "MAIN" destroys the marker,
    // taking the section boundary — and every row's section — with it.
    const previous = lines[lines.length - 1].trim();
    if (SECTION_MARKERS.includes(previous) || isHeaderLine(previous)) {
      lines.push(raw);
      lineNumbers.push(index + 1);
      continue;
    }

    lines[lines.length - 1] = `${lines[lines.length - 1].trimEnd()} ${addition}`;
  }

  return { text: lines.join("\n"), lineNumbers };
}

export function mergeContinuationLines(text, declaredCodes = null) {
  return mergeContinuationLinesWithMap(text, declaredCodes).text;
}

/**
 * Break a speaker declaration's value into its fields.
 *
 *   Dora [Dora Leung] (Australian, male) #dora
 *   └ name
 *        └ alternate
 *                    └ demographic
 *                                   └ id
 *
 * Read right to left, because only the name is free text: whatever survives
 * once the three delimited fields are taken off the end is the name. Reading
 * left to right is what used to leave "[Dora Leung]" glued inside the name
 * and onto the Person entity built from it.
 */
export function parseSpeakerDetails(speakerText) {
  let rest = String(speakerText || "").trim();
  const issues = [];

  const idMatch = rest.match(/(?:^|\s)(#\S+)\s*$/);
  const optionalCode = idMatch ? idMatch[1] : null;
  if (idMatch) rest = rest.slice(0, idMatch.index).trim();

  const demographicMatch = rest.match(/\(([^()]*)\)\s*$/);
  const demographic = demographicMatch ? demographicMatch[1].trim() : null;
  if (demographicMatch) rest = rest.slice(0, demographicMatch.index).trim();

  const alternateMatch = rest.match(/\[([^[\]]*)\]\s*$/);
  const alternateName = alternateMatch ? alternateMatch[1].trim() : null;
  if (alternateMatch) rest = rest.slice(0, alternateMatch.index).trim();

  const name = rest.trim();

  if (!name) issues.push({ field: "name", kind: "speaker-name-missing", detail: "" });
  if (!optionalCode) issues.push({ field: "id", kind: "speaker-id-missing", detail: "" });
  if (/[[\]()]/.test(name)) {
    issues.push({ field: "name", kind: "speaker-name-unbalanced-bracket", detail: JSON.stringify(name) });
  }

  return {
    name,
    alternateName,
    demographic,
    // Kept under its old name, parentheses included, because chat-export
    // reads it as CHAT's @ID group field.
    affiliation: demographic ? `(${demographic})` : null,
    optionalCode,
    issues,
  };
}

export function splitSpeakerNameAndAffiliation(speakerText) {
  const { name, affiliation } = parseSpeakerDetails(speakerText);
  return { name, affiliation };
}

/**
 * Read the speaker block, recording a diagnostic for every line in it.
 *
 * Every line gets an entry, conforming or not. A line that yields no code at
 * all used to be skipped in silence, which is the worst case there is: the
 * speaker vanishes, and then every turn of theirs in the body shows up as an
 * unresolved speakerID with nothing to explain why.
 */
export function parseSpeakerBlock(lines, diagnostics = [], lineNumbers = null) {
  const speakers = new Map();
  let inSpeakerSection = false;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = String(lines[index] ?? "").trim();
    const lineNumber = lineNumbers ? lineNumbers[index] ?? index + 1 : index + 1;
    if (!trimmed) continue;

    if (/^Speakers:$/i.test(trimmed)) {
      inSpeakerSection = true;
      continue;
    }

    if (inSpeakerSection && trimmed === "PRELIMINARIES") {
      inSpeakerSection = false;
      break;
    }

    if (!inSpeakerSection) continue;

    const withColon = trimmed.match(CODE_WITH_COLON);
    const withoutColon = withColon ? null : trimmed.match(CODE_WITHOUT_COLON);
    const match = withColon || withoutColon;

    if (!match) {
      diagnostics.push({
        line: lineNumber,
        content: trimmed,
        code: null,
        conforming: false,
        details: null,
        issues: [{ field: "speakerCode", kind: "speaker-code-missing", detail: "the declaration was skipped" }],
      });
      continue;
    }

    const speakerID = match[1];
    const speakerText = match[2].trim();
    const details = parseSpeakerDetails(speakerText);
    const issues = [...details.issues];

    if (!withColon) {
      issues.unshift({ field: "speakerCode", kind: "speaker-code-missing-colon", detail: `speaker code "${speakerID}"` });
    }
    if (speakers.has(speakerID)) {
      issues.push({ field: "speakerCode", kind: "speaker-code-duplicate", detail: `speaker code "${speakerID}"` });
    }

    speakers.set(speakerID, {
      label: details.name || speakerText.replace(/\s*#\S+\s*$/, "").trim(),
      name: details.name,
      alternateName: details.alternateName,
      demographic: details.demographic,
      affiliation: details.affiliation,
      optionalCode: details.optionalCode,
      resolvedSpeakerID: details.optionalCode || speakerID,
      line: lineNumber,
    });

    diagnostics.push({
      line: lineNumber,
      content: trimmed,
      code: speakerID,
      conforming: issues.length === 0,
      details,
      issues,
    });
  }

  return speakers;
}

/** Both spellings of every declared code — the short one and its #id. */
export function declaredCodeSet(speakerMap) {
  const codes = new Set();
  for (const [code, details] of speakerMap.entries()) {
    codes.add(code);
    if (details.optionalCode) codes.add(details.optionalCode);
  }
  return codes;
}

// "#AA" and "Year of birth" → "#AA-year-of-birth".
const propertyValueId = (entityId, label) => `${entityId}-${String(label).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "property"}`;

export function buildSpeakerPersonEntities(speakerMap) {
  const entities = [];

  for (const [speakerID, details] of speakerMap.entries()) {
    const entityId = details.optionalCode ? details.optionalCode : `#${speakerID}`;
    const entity = {
      "@id": entityId,
      "@type": "Person",
      name: details.name || details.label || speakerID,
    };

    if (details.alternateName) entity.alternateName = details.alternateName;
    if (details.affiliation) entity.affiliation = details.affiliation;
    if (details.optionalCode) entity.identifier = details.optionalCode;
    entities.push(entity);

    // Fields a transcript grammar's own labels read from the declaration
    // ("Role", "Age"): name/value pairs, each its own PropertyValue entity.
    const extra = Object.entries(details.extra || {}).filter(([, value]) => String(value ?? "").trim());
    if (extra.length) {
      entity.additionalProperty = extra.map(([label]) => ({ "@id": propertyValueId(entityId, label) }));
      for (const [label, value] of extra) {
        entities.push({ "@id": propertyValueId(entityId, label), "@type": "PropertyValue", name: label, value: String(value).trim() });
      }
    }
  }

  return entities;
}

export function validateSectionOrder(foundSections, warnings = []) {
  const expected = ["PRELIMINARIES", "MAIN", "POSTLIMINARIES"];
  const actual = foundSections.slice();

  if (!actual.length) {
    warnings.push("No section markers found. Defaulting all rows to MAIN.");
    return;
  }

  const firstMarker = actual[0];
  if (firstMarker !== "PRELIMINARIES") {
    warnings.push(`Unexpected first section marker: ${firstMarker ?? "none"}. Expected PRELIMINARIES.`);
  }

  const orderedSeen = [];
  for (const marker of expected) {
    if (actual.includes(marker)) orderedSeen.push(marker);
  }

  if (orderedSeen.length > 0 && orderedSeen[0] !== "PRELIMINARIES") {
    warnings.push("Section order warning: expected PRELIMINARIES before MAIN.");
  }

  if (orderedSeen.includes("MAIN") && orderedSeen.indexOf("MAIN") < orderedSeen.indexOf("PRELIMINARIES")) {
    warnings.push("Section order warning: MAIN appears before PRELIMINARIES.");
  }

  if (actual.includes("POSTLIMINARIES")) {
    const mainIndex = actual.indexOf("MAIN");
    const postIndex = actual.indexOf("POSTLIMINARIES");
    if (mainIndex !== -1 && postIndex !== -1 && postIndex < mainIndex) {
      warnings.push("Section order warning: POSTLIMINARIES appears before MAIN.");
    }
  }
}

export function parseRows(text, warnings = [], sectionDiagnostics = [], headerChecks = [], options = {}) {
  const { speakers: providedSpeakers = null, lineNumbers = null, bodyDiagnostics = [] } = options;
  const rows = [];
  const lines = String(text || "").split("\n");
  const speakers = providedSpeakers || parseSpeakerBlock(lines);
  const declaredCodes = declaredCodeSet(speakers);
  const sectionOrder = [];
  let currentSection = "MAIN";
  // The speaker block is optional, like the header. A document with neither a
  // speaker block nor section markers is all body from its first line (header
  // lines are still recognised and skipped), which is what the "Defaulting all
  // rows to MAIN" warning below has always promised. With a speaker block,
  // the body still starts at the first marker: nothing else ends the block.
  const hasSpeakerBlock = lines.some((l) => /^Speakers:$/i.test(l.trim()));
  const hasMarkers = lines.some((l) => SECTION_MARKERS.includes(l.trim()));
  const bodyFromFirstTurn = !hasSpeakerBlock && !hasMarkers;
  let transcriptStarted = false;
  // In that case the body starts at the first turn whose code the document
  // uses more than once. A header line in an unlisted "Key: value" form looks
  // exactly like a turn, but its key appears once; speakers take turns. When
  // no code repeats (a very short exchange) there is nothing to tell them
  // apart, so the body starts at the first turn, provided there are at least
  // two speakers: one lone "Key: value" line is not an exchange.
  const codeUses = new Map();
  if (bodyFromFirstTurn) {
    for (const l of lines) {
      const c = classifyBodyLine(l.trim(), declaredCodes);
      if (c.kind === "turn" && c.code) codeUses.set(c.code, (codeUses.get(c.code) || 0) + 1);
    }
  }
  const anyCodeRepeats = [...codeUses.values()].some((n) => n > 1);
  const startsBody = (code) => (anyCodeRepeats ? (codeUses.get(code) || 0) > 1 : codeUses.size > 1);
  let lastRow = null;
  const sections = {
    PRELIMINARIES: { markerLine: null, rowCount: 0 },
    MAIN: { markerLine: null, rowCount: 0 },
    POSTLIMINARIES: { markerLine: null, rowCount: 0 },
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const lineNumber = lineNumbers ? lineNumbers[lineIndex] ?? lineIndex + 1 : lineIndex + 1;
    const line = rawLine.trim();
    const matchedHeader = SECTION_MARKERS.includes(line) ? line : null;
    if (!line) continue;

    // Only the markers and the paragraphs that nearly are one. Recording every
    // paragraph turned the log into a copy of the document in which each
    // ordinary turn was labelled "NO MATCH", which reads as a finding when it
    // only means the paragraph is not a section marker.
    if (matchedHeader) {
      headerChecks.push({ line: lineNumber, content: rawLine, matchedHeader, nearMiss: null });
    } else {
      const nearMiss = nearMissMarker(line);
      if (nearMiss) headerChecks.push({ line: lineNumber, content: rawLine, matchedHeader: null, nearMiss });
    }

    if (/^Speakers:$/i.test(line)) {
      transcriptStarted = false;
      continue;
    }

    if (matchedHeader) {
      transcriptStarted = true;
      currentSection = matchedHeader === "PRELIMINARIES" ? "PRE" : matchedHeader === "POSTLIMINARIES" ? "POST" : "MAIN";
      sections[matchedHeader].markerLine = lineNumber;
      sectionOrder.push(matchedHeader);
      // A turn does not continue across a section boundary, so the first
      // stray line of a new section has nothing to fold into and is reported
      // rather than appended to the last turn of the section before it.
      lastRow = null;
      continue;
    }

    const classified = classifyBodyLine(line, declaredCodes);
    if (!transcriptStarted && bodyFromFirstTurn && classified.kind === "turn" && startsBody(classified.code)) {
      transcriptStarted = true;
    }
    if (!transcriptStarted) continue;

    if (classified.kind === "header") continue;

    const record = (issues, code = null) => {
      if (!issues.length) return;
      bodyDiagnostics.push({ line: lineNumber, content: line, section: sectionName(currentSection), code, issues });
    };

    if (classified.kind === "turn") {
      record(classified.issues, classified.code);
      // A row with no code is still a row — with an empty speakerID, so the
      // gap shows in the CSV instead of hiding inside the cell above it.
      const speakerID = classified.code
        ? speakers.get(classified.code)?.optionalCode || classified.code
        : "";
      lastRow = { turnNumber: classified.turnNumber || "", speakerID, text: classified.text, section: currentSection };
      rows.push(lastRow);
      sections[sectionName(currentSection)].rowCount += 1;
      continue;
    }

    if (!lastRow) {
      record([{ field: "speakerCode", kind: "speaker-code-missing", detail: "no turn above it to fold into — the line was dropped" }]);
      continue;
    }

    record(classified.issues);
    lastRow.text = `${lastRow.text} ${line}`.trim();
  }

  validateSectionOrder(sectionOrder, warnings);
  const lastLine = Math.max(1, lines.length);
  for (const [name, details] of Object.entries(sections)) {
    if (details.markerLine === null) {
      sectionDiagnostics.push({
        name,
        processed: false,
        headerLine: null,
        line: lastLine,
        reason: "section marker was not found before the end of the document",
      });
    } else if (!details.rowCount) {
      sectionDiagnostics.push({
        name,
        processed: false,
        headerLine: details.markerLine,
        line: details.markerLine,
        reason: "section marker was found, but no valid transcript rows were found",
      });
    } else {
      sectionDiagnostics.push({
        name,
        processed: true,
        headerLine: details.markerLine,
        line: details.markerLine,
        reason: `${details.rowCount} transcript row(s) processed`,
      });
    }
  }
  return rows;
}

export function cleanCharacterValues(value) {
  const replacements = {
    "\u201C": '"',
    "\u201D": '"',
    "\u2018": "'",
    "\u2019": "'",
    "\u2014": "-",
    "\u2013": "-",
  };

  if (typeof value !== "string") return value;

  let cleaned = value.trim();
  for (const [oldChar, newChar] of Object.entries(replacements)) {
    cleaned = cleaned.replaceAll(oldChar, newChar);
  }

  return cleaned;
}

export function collectCharacterInventory(rows) {
  const chars = new Set();
  for (const row of rows) {
    const values = [row.speakerID, row.text, row.section];
    for (const value of values) {
      const text = String(value ?? "");
      for (const char of text) chars.add(char);
    }
  }
  return [...chars].sort();
}

export function collectUnresolvedSpeakerRows(rows) {
  return rows
    .map((row, index) => ({ index, speakerID: row.speakerID || "" }))
    .filter(({ speakerID }) => !String(speakerID).includes("#"));
}

export function formatUnresolvedSpeakerRows(rows) {
  const unresolved = collectUnresolvedSpeakerRows(rows);
  if (!unresolved.length) return "Unresolved speakerIDs: none";

  const lines = [`Unresolved speakerIDs (${unresolved.length}):`];
  for (const item of unresolved) lines.push(`Row ${item.index}: ${item.speakerID}`);

  return lines.join("\n");
}

export async function formatCharacterInventory(rows) {
  const chars = collectCharacterInventory(rows);
  const lines = ["Character inventory:"];
  const { unicodeName } = await import("unicode-name");

  for (const char of chars) {
    const code = `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    const name = unicodeName(char) || char;
    lines.push(`${JSON.stringify(char)}  ${code}  ${name}`);
  }

  return lines.join("\n");
}

export function stripTimecodes(text, removed = []) {
  const pattern = /\(\s*~?\d+:\d+\s*\)/g;
  let cleaned = String(text || "");
  const matches = cleaned.match(pattern) || [];
  for (const match of matches) removed.push(match);
  cleaned = cleaned.replace(pattern, "");
  return cleaned;
}

/**
 * The transcript CSV. `extraColumns` are the labels of a grammar's own
 * fields, each a column after the four every transcript has, filled from
 * `row.extra`.
 */
export function toCsv(rows, extraColumns = []) {
  const output = [["turnNumber", "speakerID", "text", "section", ...extraColumns.map(escapeCsv)].join(",")];
  for (const row of rows) {
    const turnNumber = escapeCsv(row.turnNumber || "");
    const speakerID = escapeCsv(row.speakerID || "");
    const text = escapeCsv(row.text || "");
    const section = escapeCsv(row.section || "MAIN");
    const extra = extraColumns.map((label) => `,${escapeCsv(row.extra?.[label] ?? "")}`).join("");
    output.push(`${turnNumber},${speakerID},${text},${section}${extra}`);
  }
  return output.join("\n") + "\n";
}

export function escapeCsv(value) {
  const stringValue = String(value ?? "");
  if (/[",\n]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

const SECTION_RULE = "Section header rule: a header must be a complete line whose surrounding whitespace is trimmed and whose text exactly matches PRELIMINARIES, MAIN, or POSTLIMINARIES.";

export function formatSectionDiagnostics(sectionDiagnostics, rule = SECTION_RULE) {
  const lines = ["Section processing:", rule];
  for (const section of sectionDiagnostics) {
    const status = section.processed ? "processed" : "not processed";
    const header = section.headerLine
      ? `header line ${section.headerLine}: ${JSON.stringify(section.name)}`
      : `no exact ${JSON.stringify(section.name)} header found`;
    lines.push(`${section.name}: ${status} (line ${section.line}; ${header}) - ${section.reason}`);
  }
  return lines.join("\n");
}

export function formatHeaderChecks(headerChecks) {
  const found = headerChecks.filter((check) => check.matchedHeader);
  const nearMisses = headerChecks.filter((check) => !check.matchedHeader && check.nearMiss);
  const lines = ["Section headers:"];

  if (found.length) {
    for (const check of found) lines.push(`Line ${check.line}: ${check.matchedHeader}`);
  } else {
    lines.push("None found.");
  }

  if (nearMisses.length) {
    lines.push("", `Near misses (${nearMisses.length}) — a header must be a line whose text is exactly PRELIMINARIES, MAIN, or POSTLIMINARIES:`);
    for (const check of nearMisses) {
      lines.push(`Line ${check.line}: ${JSON.stringify(check.content)} — did you mean ${check.nearMiss}?`);
    }
  }

  return lines.join("\n");
}

/** One line per issue, as "<label> (<detail>)". */
export function formatIssue(issue) {
  const label = ISSUE_LABELS[issue.kind] || issue.kind;
  return issue.detail ? `${label} — ${issue.detail}` : label;
}

/** Tally issues by kind, commonest first — the shape of the problem, before the list of it. */
export function summariseIssues(entries) {
  const counts = new Map();
  for (const entry of entries) {
    for (const issue of entry.issues || []) {
      counts.set(issue.kind, (counts.get(issue.kind) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({ kind, count, label: ISSUE_LABELS[kind] || kind }));
}

const SPEAKER_EXPECTED = [
  "Expected format: CODE: name [alternate name] (demographic info) #id",
  "The alternate name and the demographic note are optional; the code, its colon, the name and the #id are not.",
];

export function formatSpeakerBlockReport(diagnostics, expected = SPEAKER_EXPECTED) {
  const lines = ["Speaker block:", ...expected];

  if (!diagnostics.length) {
    lines.push("No speaker declarations found.");
    return lines.join("\n");
  }

  const nonConforming = diagnostics.filter((entry) => !entry.conforming);
  lines.push(`Declarations: ${diagnostics.length}, non-conforming: ${nonConforming.length}`);
  for (const { label, count } of summariseIssues(diagnostics)) lines.push(`  ${count} x ${label}`);
  lines.push("");

  for (const entry of diagnostics) {
    const fields = entry.details
      ? [
        `name ${JSON.stringify(entry.details.name || "")}`,
        entry.details.alternateName ? `alternate ${JSON.stringify(entry.details.alternateName)}` : null,
        entry.details.demographic ? `demographic ${JSON.stringify(entry.details.demographic)}` : null,
        entry.details.optionalCode ? `id ${entry.details.optionalCode}` : null,
      ].filter(Boolean).join(", ")
      : "";
    const code = entry.code ? `[${entry.code}] ` : "";
    lines.push(`Line ${entry.line}: ${entry.conforming ? "ok" : "NON-CONFORMING"} ${code}${fields}`.trimEnd());
    for (const issue of entry.issues) lines.push(`    ${formatIssue(issue)}`);
    if (!entry.conforming) lines.push(`    source: ${JSON.stringify(entry.content)}`);
  }

  return lines.join("\n");
}

const BODY_EXPECTED = [
  "Expected format: [turn number][.] CODE: text",
  "The turn number is optional and its period is expected when it is present; the speaker code, its colon, and the text are required.",
];

export function formatBodyReport(diagnostics, expected = BODY_EXPECTED) {
  const lines = ["Body rows:", ...expected];

  if (!diagnostics.length) {
    lines.push("Non-conforming rows: none");
    return lines.join("\n");
  }

  lines.push(`Non-conforming rows: ${diagnostics.length}`);
  for (const { label, count } of summariseIssues(diagnostics)) lines.push(`  ${count} x ${label}`);
  lines.push("");

  for (const entry of diagnostics) {
    lines.push(`Line ${entry.line} [${entry.section}]: ${JSON.stringify(entry.content)}`);
    for (const issue of entry.issues) lines.push(`    ${formatIssue(issue)}`);
  }

  return lines.join("\n");
}

/**
 * Rows, speakers and a conformance report for one transcript's text.
 *
 * `config.grammar` — a saved grammar (src/_transcript_grammar.js) — replaces
 * the built-in convention below with that grammar's line shapes;
 * `config.grammarName` names it in the report. Either way the result has the
 * same shape.
 */
export async function processTranscriptText(text, config = {}) {
  if (config.grammar) return processTranscriptTextWithGrammar(text, config);
  const warnings = [];
  const removedTimecodes = [];
  const sectionDiagnostics = [];
  const headerChecks = [];
  const speakerDiagnostics = [];
  const bodyDiagnostics = [];

  const normalized = normalizeText(text);
  const timecodeStripped = stripTimecodes(normalized, removedTimecodes);

  // Two passes, because the halves of the grammar depend on each other: a body
  // line missing its colon can only be recognised against the codes the
  // Speakers block declared, and the Speakers block itself has to survive
  // continuation repair before it can be read. The first pass repairs on line
  // shape alone, which is enough to read the declarations off it.
  const firstPass = mergeContinuationLinesWithMap(timecodeStripped, null);
  const declaredCodes = declaredCodeSet(parseSpeakerBlock(firstPass.text.split("\n")));

  const { text: merged, lineNumbers: rawLines } = mergeContinuationLinesWithMap(timecodeStripped, declaredCodes);
  // normalizeText and stripTimecodes both preserve line count, so the table
  // built here lines up with the indices merge reports against.
  const paragraphTable = paragraphNumbersByLine(timecodeStripped);
  const lineNumbers = rawLines.map((line) => paragraphTable[line - 1] ?? line);
  const mergedLines = merged.split("\n");
  const speakerMap = parseSpeakerBlock(mergedLines, speakerDiagnostics, lineNumbers);

  let rows = parseRows(merged, warnings, sectionDiagnostics, headerChecks, {
    speakers: speakerMap,
    lineNumbers,
    bodyDiagnostics,
  });

  // No speaker block: the speakers are the codes the turns use. Each becomes a
  // Person with a #code id, as a declared speaker without an #id would.
  const speakersFromTurns = !speakerDiagnostics.length && !mergedLines.some((l) => /^Speakers:$/i.test(l.trim()));
  if (speakersFromTurns) {
    for (const row of rows) {
      const code = row.speakerID;
      if (!code) continue;
      if (!speakerMap.has(code)) {
        speakerMap.set(code, {
          label: code, name: code, alternateName: null, demographic: null, affiliation: null,
          optionalCode: `#${code}`, resolvedSpeakerID: `#${code}`, line: null,
        });
      }
      row.speakerID = `#${code}`;
    }
  }

  if (config.headerRows > 0) rows = rows.slice(config.headerRows);
  if (config.footerRows > 0) rows = rows.slice(0, Math.max(0, rows.length - config.footerRows));

  rows = rows.map((row) => ({
    turnNumber: cleanCharacterValues(row.turnNumber || ""),
    speakerID: cleanCharacterValues(row.speakerID),
    text: cleanCharacterValues(row.text),
    section: cleanCharacterValues(row.section || "MAIN"),
  }));

  const nonConformingSpeakers = speakerDiagnostics.filter((entry) => !entry.conforming);
  const nonConforming = {
    speakers: nonConformingSpeakers,
    body: bodyDiagnostics,
    total: nonConformingSpeakers.length + bodyDiagnostics.length,
  };

  const logLines = [
    `Non-conforming lines: ${nonConforming.total} (${nonConformingSpeakers.length} in the speaker block, ${bodyDiagnostics.length} in the body).`,
    "Line numbers count the lines of the document as Word or a text editor shows them, blank lines included.",
    "",
    "Transformations applied: text normalization, continuation repair, speaker block review, section classification, character cleanup.",
    "",
    speakersFromTurns
      ? `Speaker block:\nThis document has no Speakers block (it is optional); the speakers are the codes the turns use (${speakerMap.size} found: ${[...speakerMap.keys()].join(", ") || "none"}).`
      : formatSpeakerBlockReport(speakerDiagnostics),
    "",
    formatBodyReport(bodyDiagnostics),
    "",
    formatSectionDiagnostics(sectionDiagnostics),
    "",
    formatHeaderChecks(headerChecks),
    "",
    formatUnresolvedSpeakerRows(rows),
    "",
    await formatCharacterInventory(rows),
  ];

  if (removedTimecodes.length) {
    logLines.splice(0, 0, `Timecodes removed (${removedTimecodes.length}): ${removedTimecodes.join(", ")}`);
  }

  return {
    rows,
    speakerMap,
    warnings,
    removedTimecodes,
    sectionDiagnostics,
    speakerDiagnostics,
    bodyDiagnostics,
    nonConforming,
    log: logLines.join("\n"),
  };
}

async function processTranscriptTextWithGrammar(text, config) {
  const removedTimecodes = [];
  const result = processWithGrammar(text, config.grammar, {
    grammarName: config.grammarName || config.grammar.name,
    // Timecode removal keeps the line count, so line numbers still hold.
    strip: (t) => stripTimecodes(t, removedTimecodes),
  });

  let rows = result.rows;
  if (config.headerRows > 0) rows = rows.slice(config.headerRows);
  if (config.footerRows > 0) rows = rows.slice(0, Math.max(0, rows.length - config.footerRows));
  rows = rows.map((row) => ({
    turnNumber: cleanCharacterValues(row.turnNumber || ""),
    speakerID: cleanCharacterValues(row.speakerID),
    text: cleanCharacterValues(row.text),
    section: cleanCharacterValues(row.section || "MAIN"),
    ...(row.extra ? { extra: Object.fromEntries(Object.entries(row.extra).map(([k, v]) => [k, cleanCharacterValues(v)])) } : {}),
  }));

  const { nonConforming, report } = result;
  const logLines = [
    report.grammarLine,
    `Non-conforming lines: ${nonConforming.total} (${nonConforming.speakers.length} in the speaker block, ${nonConforming.body.length} in the body, ${nonConforming.header.length} in the header).`,
    "Line numbers count the lines of the document as Word or a text editor shows them, blank lines included.",
    "",
    "Transformations applied: timecode removal, grammar parsing, continuation repair, character cleanup.",
    report.cleanupLine,
    "",
    formatMetadata(result.metadata, nonConforming.header),
    "",
    formatSpeakerBlockReport(result.speakerDiagnostics, report.speakerExpected),
    "",
    formatBodyReport(result.bodyDiagnostics, report.bodyExpected),
    "",
    formatSectionDiagnostics(result.sectionDiagnostics, report.sectionRule),
    "",
    `Ignored lines: ${result.ignored.length ? result.ignored.map((i) => i.line).join(", ") : "none"}`,
    "",
    formatUnresolvedSpeakerRows(rows),
    "",
    await formatCharacterInventory(rows),
  ];
  if (removedTimecodes.length) {
    logLines.splice(1, 0, `Timecodes removed (${removedTimecodes.length}): ${removedTimecodes.join(", ")}`);
  }

  return {
    rows,
    extraColumns: result.extraColumns || [],
    speakerMap: result.speakerMap,
    metadata: result.metadata,
    warnings: result.warnings,
    removedTimecodes,
    sectionDiagnostics: result.sectionDiagnostics,
    speakerDiagnostics: result.speakerDiagnostics,
    bodyDiagnostics: result.bodyDiagnostics,
    nonConforming,
    log: logLines.join("\n"),
  };
}

export async function resolveMammothArrayBuffer(docxSource) {
  if (!docxSource) return null;

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(docxSource)) {
    return docxSource.buffer.slice(docxSource.byteOffset, docxSource.byteOffset + docxSource.byteLength);
  }

  if (docxSource instanceof ArrayBuffer) {
    return docxSource;
  }

  if (ArrayBuffer.isView(docxSource)) {
    const view = docxSource;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  if (docxSource && typeof docxSource.arrayBuffer === "function") {
    return await docxSource.arrayBuffer();
  }

  if (docxSource && typeof docxSource.buffer !== "undefined" && docxSource.buffer instanceof ArrayBuffer) {
    const view = docxSource;
    const bytes = new Uint8Array(view.buffer, view.byteOffset || 0, view.byteLength || view.buffer.byteLength);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  return null;
}

// mammoth swaps its unzip implementation through package.json's "browser"
// field: the browser build reads only { arrayBuffer }, the Node build only
// { buffer } / { path }. Decide by runtime rather than by calling and catching.
// Probing is what this used to do, and it is expensive in a way that doesn't
// show up in tests: mammoth rejects through bluebird, which reports every
// deliberate miss to the console as an unhandled rejection, so a four-document
// folder filled the browser console with errors from a build that worked.
const IN_BROWSER = typeof window !== "undefined" && typeof window.document !== "undefined";

function toArrayBuffer(docxBuffer) {
  if (docxBuffer instanceof ArrayBuffer) return docxBuffer;
  if (ArrayBuffer.isView(docxBuffer)) {
    const bytes = new Uint8Array(docxBuffer.buffer, docxBuffer.byteOffset, docxBuffer.byteLength);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return new Uint8Array(docxBuffer || []).buffer;
}

// Buffer can exist in a bundled browser build too (node polyfills), which is
// why the runtime decides the shape and this only decides how to carry it.
function mammothOptions(arrayBuffer, forBrowser) {
  if (forBrowser) return { arrayBuffer };
  if (typeof Buffer !== "undefined") return { buffer: Buffer.from(arrayBuffer) };
  return { buffer: new Uint8Array(arrayBuffer) };
}

export async function callMammothExtractRawText(docxBuffer) {
  const arrayBuffer = toArrayBuffer(docxBuffer);
  try {
    return await mammoth.extractRawText(mammothOptions(arrayBuffer, IN_BROWSER));
  } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : String(error);
    if (!/Could not find file in options/i.test(message)) throw error;
    // The runtime guess was wrong — an exotic bundle, or jsdom in a test.
    // One retry with the other shape, rather than failing on a readable file.
    return await mammoth.extractRawText(mammothOptions(arrayBuffer, !IN_BROWSER));
  }
}

export async function extractDocumentText(docxSource) {
  if (!docxSource) return "";

  const mammothBuffer = await resolveMammothArrayBuffer(docxSource);
  if (!mammothBuffer) return "";

  const result = await callMammothExtractRawText(mammothBuffer);
  return result.value || "";
}

// ---------------------------------------------------------------------------
// Transcript source files: .docx and .txt
// ---------------------------------------------------------------------------

// The files ca-data-prep and chat-export read as transcripts.
export const TRANSCRIPT_FILE_PATTERN = /\.(docx|txt)$/i;

const SOURCE_MEDIA_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

const extensionOf = (fileName) => (String(fileName || "").match(/\.([^./\\]+)$/) || [])[1]?.toLowerCase() || "";

export const isTranscriptFile = (fileName) => TRANSCRIPT_FILE_PATTERN.test(String(fileName || ""));

// "interview.docx" and "interview.txt" both become "interview": the name the
// CSV, log, CHAT file and RepositoryObject are all given.
export const transcriptBaseName = (fileName) => String(fileName || "").replace(TRANSCRIPT_FILE_PATTERN, "");

export const transcriptMediaType = (fileName) => SOURCE_MEDIA_TYPES[extensionOf(fileName)] || "application/octet-stream";

/**
 * The transcript files among a folder's entries, one per base name.
 *
 * A folder holding both interview.docx and interview.txt (a plain-text export
 * kept beside the original, say) would have them write the same CSV and CHAT
 * file, each overwriting the other. The .docx is kept and the other skipped,
 * with `warn` told which.
 */
export function selectTranscriptFiles(entries, warn = () => {}) {
  const nameOf = (entry) => entry.fileName || entry.name || "";
  const candidates = (entries || []).filter((entry) => isTranscriptFile(nameOf(entry)));
  const rank = (entry) => (extensionOf(nameOf(entry)) === "docx" ? 0 : 1);
  const chosen = new Map();
  for (const entry of candidates) {
    const key = transcriptBaseName(nameOf(entry));
    const held = chosen.get(key);
    if (!held) { chosen.set(key, entry); continue; }
    const [keep, skip] = rank(entry) < rank(held) ? [entry, held] : [held, entry];
    chosen.set(key, keep);
    const pathOf = (e) => e.relativePath || nameOf(e);
    warn(`Skipped ${pathOf(skip)}: ${pathOf(keep)} has the same name and would write the same output files.`);
  }
  // Keep the folder's own order.
  const kept = new Set(chosen.values());
  return candidates.filter((entry) => kept.has(entry));
}

/**
 * Decode a plain-text file: UTF-8 unless a byte-order mark says UTF-16. The
 * mark itself is dropped, so it can't end up in front of the first header.
 */
export function decodePlainText(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let encoding = "utf-8";
  if (view[0] === 0xff && view[1] === 0xfe) encoding = "utf-16le";
  else if (view[0] === 0xfe && view[1] === 0xff) encoding = "utf-16be";
  return new TextDecoder(encoding).decode(view);
}

/**
 * Give plain text the shape mammoth gives a .docx: each line a paragraph,
 * ended by a blank line. Everything downstream — the line numbers in the log
 * (paragraphNumbersByLine), a saved grammar's reader (documentLines) — then
 * treats a .txt line exactly as it treats a .docx paragraph, so a line
 * number in the log is that line's number in the file.
 */
export function plainTextAsParagraphs(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  // A file's final newline ends its last line; it doesn't start another.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => `${line}\n\n`).join("");
}

/**
 * A transcript file's text, whichever kind it is: mammoth's extraction for a
 * .docx, the decoded file for a .txt.
 */
export async function extractTranscriptText(source, fileName) {
  if (extensionOf(fileName) !== "txt") return extractDocumentText(source);
  const buffer = await resolveMammothArrayBuffer(source);
  if (!buffer) return "";
  return plainTextAsParagraphs(decodePlainText(buffer));
}

// conformsTo defaults to the LDAC Collection profile's own identity (this
// function always builds a RepositoryCollection root) rather than hardcoding
// it — the caller (ca-data-prep's "crate:build" hook) passes through
// whichever profile the user actually selected, so a crate built here still
// reflects that choice instead of silently overwriting it. The default only
// matters when nothing was selected (e.g. calling this directly, as tests do).
export function buildRoCrateMetadata(collectionName, documents, conformsTo = "https://w3id.org/ldac/profile#Collection", { includeOutputs = true } = {}) {
  const crate = new ROCrate({ array: true, link: true });
  // One entry for both prefixes: merged into a seeded crate, each entry
  // would otherwise sit in its @context as one more object.
  crate.addContext({ ldac: "https://w3id.org/ldac/terms#", pcdm: "http://pcdm.org/models#" });

  crate.rootDataset["@id"] = "./";
  crate.rootDataset["@type"] = ["Dataset", "RepositoryCollection"];
  crate.rootDataset.name = collectionName;
  crate.rootDataset.conformsTo = { "@id": conformsTo };
  crate.descriptor.about = { "@id": "./" };

  const collectionEntity = {
    "@id": "./collection",
    "@type": "RepositoryCollection",
    name: collectionName,
    hasMember: documents.map((document) => ({ "@id": document.objectId })),
  };

  crate.addEntity(collectionEntity);
  crate.rootDataset.hasMember = documents.map((document) => ({ "@id": document.objectId }));

  for (const document of documents) {
    // Without its outputs, a document is its source file and its speakers: no CSV
    // file, so no main text or annotation pointing at one.
    const objectEntity = {
      "@id": document.objectId,
      "@type": "RepositoryObject",
      name: document.baseName,
      ...(includeOutputs ? { "ldac:mainText": { "@id": document.csvId } } : {}),
      hasPart: [
        { "@id": document.docxId },
        ...(includeOutputs ? [{ "@id": document.csvId }] : []),
      ],
      speaker: document.speakerRefs,
    };

    const csvFileEntity = {
      "@id": document.csvId,
      "@type": "File",
      name: document.csvName,
      encodingFormat: "text/csv",
      annotationOf: { "@id": document.docxId },
      isPartOf: { "@id": document.objectId },
    };

    const annotationEntity = {
      "@id": document.annotationId,
      "@type": "Annotation",
      annotationOf: { "@id": document.objectId },
      annotationBody: { "@id": document.csvId },
    };

    crate.addEntity(objectEntity);
    if (includeOutputs) crate.addEntity(annotationEntity);
    crate.addEntity({
      "@id": document.docxId,
      "@type": "File",
      name: document.docxName,
      encodingFormat: document.sourceEncodingFormat || transcriptMediaType(document.docxName),
    });
    if (includeOutputs) crate.addEntity(csvFileEntity);

    for (const person of document.persons) crate.addEntity(person);
  }

  return crate;
}
