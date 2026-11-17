// Offline AUSTLANG language identification (filename-based only).
//
// Language matching runs entirely against a bundled copy of the Austlang data
// pack (austlang-data.json, this folder), so there is NO network request, NO
// CORS issue, and NO API key in the client. Refresh the bundled data with:
//   npm run update:austlang
//
// The data pack ships with @describo/data-packs and is derived from the AIATSIS
// Austlang dataset (https://collection.aiatsis.gov.au/austlang/).

import AUSTLANG_DATA from "./austlang-data.json" with { type: "json" };

const GENERIC_TERMS = new Set([
  "north", "south", "east", "west", "northern", "southern", "eastern", "western",
  "northeast", "northwest", "southeast", "southwest",
  "man", "woman", "men", "women", "people", "tribe", "group", "all", "our", "country",
  "none", "n/a", "na", "unknown", "unspecified", "nil", "various", "other",
]);

function pBasename(p) { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }
function pStripExt(name) { const b = pBasename(name); const i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; }
function containsWholeWord(haystack, needle) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`, "i").test(haystack);
}
function isSpecificEnough(name) {
  if (name.length < 4) return false;
  return !name.toLowerCase().split(/\s+/).every((w) => GENERIC_TERMS.has(w));
}

// Shape a bundled Austlang record into the language entity the crate expects.
// Clones the record (the bundled data is a shared singleton — never mutate it).
function shapeMatch(rec) {
  const hit = { ...rec };
  if (hit.geo) hit.geo = { ...hit.geo, "@id": `#${String(hit.geo["@id"]).replace(/^#?_*/, "")}` };
  hit["@id"] = `#AUSTLANG_${String(hit.languageCode).replace(/[^A-Za-z0-9._-]/g, "_")}`;
  hit["custom:austlangCode"] = hit.languageCode;
  delete hit.languageCode; delete hit.source;
  if (hit["iso639-3"]) { hit["custom:iso639-3"] = hit["iso639-3"]; delete hit["iso639-3"]; }
  if (hit.glottologCode) { hit["custom:glottologCode"] = hit.glottologCode; delete hit.glottologCode; }
  return hit;
}

// Find Austlang entries whose name (or, optionally, alternate names) appears as a
// whole word in the given text. Full scan over the bundled pack (~1.2k entries),
// which reproduces — and is strictly more complete than — the old remote
// multi_match + whole-word-confirm pipeline.
function findAustlangMatches(haystack, includeAlt) {
  const out = [];
  for (const rec of AUSTLANG_DATA) {
    if (rec.source !== "Austlang") continue;
    const names = [rec.name, ...(includeAlt ? rec.alternateName || [] : [])].filter(isSpecificEnough);
    if (names.some((name) => containsWholeWord(haystack, name))) out.push(shapeMatch(rec));
  }
  return out;
}

/**
 * Identify subject languages for each file by filename (offline).
 * @returns array aligned to filesWithMeta: [{ matchedLanguages: [...] }]
 */
// Returns a Map of file id -> { matchedLanguages }.
//
// Keyed by id rather than by position in filesWithMeta, because the result is
// produced at files:prepare and consumed at crate:build — two hook stages
// apart, with every other tap's handler in between. Nothing stops a tap
// reordering, filtering or appending to that array; with positional keys any
// of those would silently attribute languages to the wrong files. Ids are
// stable whatever happens to the array.
// Matching ~1.2k Austlang entries (more with alternate names) against every
// file is real CPU work — chunked with a yield every CHUNK files so the tab
// stays responsive and the progress log below can actually paint between
// batches, instead of running as one uninterrupted synchronous loop.
const CHUNK = 25;

export async function identifyAllLanguages(filesWithMeta, includeAlt, log = () => {}, report = () => {}) {
  const total = filesWithMeta.length;
  log(`Identifying subject languages for ${total} file(s) (offline AUSTLANG, by filename)…`, "muted");
  const cache = new Map();
  const byId = new Map();
  for (let i = 0; i < total; i++) {
    const file = filesWithMeta[i];
    const base = pStripExt(file.fileName);
    let matches = cache.get(base);
    if (!matches) { matches = findAustlangMatches(base, includeAlt); cache.set(base, matches); }
    if (matches.length) log(`  ${file.fileName} → ${matches.map((m) => m.name).join(", ")}`, "muted");
    byId.set(file.id, { matchedLanguages: matches });
    if ((i + 1) % CHUNK === 0 || i + 1 === total) {
      // Progress goes to the bar, not the log: the host scales this fraction
      // into this tap's slice of the main bar and drives the secondary bar
      // with it raw. The per-match lines above are still logged, because
      // those say something a reader wants; "23/91" does not.
      report((i + 1) / total, `Language identification: ${i + 1}/${total} file(s)…`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return byId;
}
