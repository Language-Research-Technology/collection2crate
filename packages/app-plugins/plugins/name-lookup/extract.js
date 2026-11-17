// Named entity recognition over a file's text: the people's and places' names
// it mentions. compromise (and its lexicon) and the PDF reader are imported
// here, and this module is itself only imported when the plugin's option is
// on, so none of them reaches the main bundle of a build that never asks.
import nlp from "compromise";
import { extractDocumentText, decodePlainText } from "../ca-data-prep/process.js";

// What can be read as text. Anything else (audio, images, spreadsheets) is
// skipped without a word — most of a language-resources folder isn't prose.
const PLAIN_TEXT = /\.(txt|md|markdown)$/i;
const WORD = /\.docx$/i;
const PDF = /\.pdf$/i;

export const isReadableForNames = (fileName) =>
  PLAIN_TEXT.test(fileName) || WORD.test(fileName) || PDF.test(fileName);

// unpdf is pdf.js built to run without a worker, so the same call works in the
// browser and under node (the tests). Its own pdf.js build loads on first use.
async function pdfText(bytes) {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
  return text;
}

/** The text of one file, from its bytes; "" for a type this doesn't read. */
export async function fileText(bytes, fileName) {
  if (!bytes) return "";
  if (WORD.test(fileName)) return extractDocumentText(bytes);
  if (PDF.test(fileName)) return pdfText(bytes);
  if (PLAIN_TEXT.test(fileName)) return decodePlainText(bytes);
  return "";
}

// compromise reads "John Smith's family" as two people, "John" and "Smith's";
// without the possessive it reads one. A curly apostrophe is common in Word.
const POSSESSIVE = /(\p{L})['’]s\b/gu;

// Punctuation after a word that ends a name: "George Watson, Jambun" is two.
const BREAK_AFTER = /[,.;:!?()\[\]"“”]/;

// The names in a view, honorifics dropped ("Mrs. Mary O'Brien" → "Mary
// O'Brien"), each word without the punctuation around it ("Palm Island." →
// "Palm Island"), so a name is spelled the same wherever it occurs. A match
// running across a comma or full stop is split there, and a piece of three
// letters or fewer is dropped.
// One to three letters is an initial, an abbreviation or a stray fragment
// ("M", "T", "Mt", "Dr") far more often than a name. Counted over the whole
// name, so "M. Dixon" stays; a real three-letter place (Ayr) goes too.
export const MIN_NAME_LETTERS = 4;
const tooShort = (name) => (name.match(/\p{L}/gu) || []).length < MIN_NAME_LETTERS;

function namesOf(view) {
  const out = new Set();
  for (const match of view.not("#Honorific").json({ terms: { text: true, post: true } })) {
    let words = [];
    const flush = () => {
      const name = words.join(" ").trim();
      if (name && !tooShort(name)) out.add(name);
      words = [];
    };
    for (const term of match.terms) {
      if (term.text) words.push(term.text);
      if (BREAK_AFTER.test(term.post || "")) flush();
    }
    flush();
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// A people list: names someone typed out, one per line, used instead of NER's
// guesses about who is a person.
// ---------------------------------------------------------------------------

// One spelling of a name for comparing: case, runs of whitespace and curly
// apostrophes don't make two names different.
const nameKey = (name) => String(name).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();

/**
 * The names in a people list's text: one per line, blank lines and lines
 * starting with # skipped, each name once (the first spelling kept).
 */
export function parseNameList(text) {
  const seen = new Map();
  for (const line of String(text || "").replace(/^\uFEFF/, "").split(/\r\n?|\n/)) {
    const name = line.replace(/\s+/g, " ").trim();
    if (!name || name.startsWith("#")) continue;
    if (!seen.has(nameKey(name))) seen.set(nameKey(name), name);
  }
  return [...seen.values()];
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A function finding which of `names` a text mentions, returned in the list's
 * own spelling. A name matches whole — not "Ann" inside "Annerley" — in any
 * case, with any whitespace between its words (a PDF line break included) and
 * either apostrophe; where two overlap, the longer wins ("Mary O'Brien" over
 * "Mary"). The list is taken as it is: the short-name filter NER's names go
 * through doesn't apply.
 */
export function createNameMatcher(names) {
  const byKey = new Map(names.map((name) => [nameKey(name), name]));
  if (!byKey.size) return () => [];
  // One pattern over thousands of names tests every one at every position, so
  // each text gets a pattern of only the names whose every word it contains —
  // a name can't match without them — and a file mentioning a few names costs
  // a few. A name's words are its runs of letters and digits, the same runs
  // the text is split into.
  const runsOf = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const listed = [...byKey.values()].map((name) => ({ name, runs: runsOf(name) }));
  const patternFor = (name) => name.split(" ").map((word) => escapeRegExp(word).replace(/['’‘]/g, "['’‘]")).join("\\s+");
  return (text) => {
    const source = String(text || "");
    const runs = new Set(runsOf(source));
    const present = listed.filter(({ runs: words }) => words.every((word) => runs.has(word))).map(({ name }) => name);
    if (!present.length) return [];
    const patterns = present.sort((a, b) => b.length - a.length).map(patternFor);
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${patterns.join("|")})(?![\\p{L}\\p{N}])`, "giu");
    const found = new Set();
    for (const match of source.matchAll(pattern)) {
      const name = byKey.get(nameKey(match[0]));
      if (name) found.add(name);
    }
    // In the order the text first mentions them.
    return [...found];
  };
}

/**
 * The distinct names in `text`, in the order first seen: compromise's people
 * and places, and every other proper-noun phrase as a `candidate` — compromise
 * knows few places outside its lexicon (Yarrabah, Kuranda), so those are left
 * for a gazetteer to decide.
 *
 * With `findPeople` (createNameMatcher over a people list), the people are the
 * listed names the text mentions, and NER's own idea of who is a person is
 * set aside — those names are neither people nor, since compromise judged
 * them to be people, places. A listed name is never a place.
 */
export function extractNames(text, { findPeople = null } = {}) {
  const doc = nlp(String(text || "").replace(POSSESSIVE, "$1"));
  const people = findPeople ? findPeople(text) : namesOf(doc.people());
  const listed = new Set(findPeople ? people.map(nameKey) : []);
  const places = namesOf(doc.places()).filter((name) => !listed.has(nameKey(name)));
  const known = new Set([...people, ...places]);
  const candidates = namesOf(doc.match("#ProperNoun+").not("(#Person|#Place)"))
    .filter((name) => !known.has(name) && !listed.has(nameKey(name)));
  return { people, places, candidates };
}
