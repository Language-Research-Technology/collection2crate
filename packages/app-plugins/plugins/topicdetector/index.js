// Topic Detector: unsupervised LDA to explore a corpus, then seeded LDA to
// name and assign topics from edited seed words. The engine (tokenising,
// vocabulary trimming, both Gibbs samplers) is kept separate from the panel
// so it is testable without a DOM. See SPEC.md for the full contract.

import { buildCsvText, copyText, downloadCsv } from "../../src/_csv.js";
import {
  attributionFooter, button, dataTable, element, field, flashLabel,
  note, resultsBar,
} from "../../src/_panel.js";

const TOKEN = /[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;
const HAS_LETTER = /\p{L}/u;
const MAX_RENDERED_ROWS = 2000;
const DEFAULT_ITERATIONS = 200;
const DEFAULT_SEED_BOOST = 1000;
const RESIDUAL_TOPIC_NAME = "other";

const TOPIC_COLOURS = [
  "#51247a", "#e07b39", "#27ae60", "#2980b9", "#c0392b",
  "#f39c12", "#8e44ad", "#16a085", "#d35400", "#2c3e50",
];

// Short, English-only, enough to keep "the of a" off a topic's top terms.
// Defaults on here (unlike ngrams' stopword option): a person is about to
// read these words as a topic's name, and function words drowning out
// content words is the likelier failure for that specific reading.
const ENGLISH_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "in", "on",
  "at", "to", "for", "with", "without", "by", "from", "up", "down", "out",
  "off", "over", "under", "again", "further", "is", "am", "are", "was",
  "were", "be", "been", "being", "do", "does", "did", "doing", "have", "has",
  "had", "having", "this", "that", "these", "those", "it", "its", "as", "so",
  "than", "too", "very", "can", "will", "just", "don", "should", "now", "i",
  "you", "he", "she", "we", "they", "them", "his", "her", "their", "our",
  "your", "my", "me", "him", "us", "not", "no", "nor", "only", "own", "same",
  "such", "both", "each", "few", "more", "most", "other", "some", "any",
  "all", "there", "here", "when", "where", "why", "how", "what", "which",
  "who", "whom",
]);

// Matching the R app's STOPWORD_LANGS: a short, common-function-word list
// per language, so "remove stopwords" is not English-only here either.
const STOPWORDS_BY_LANG = {
  none: null,
  en: ENGLISH_STOPWORDS,
  de: new Set([
    "der", "die", "das", "und", "ist", "in", "zu", "den", "dem", "des", "ein",
    "eine", "einer", "eines", "einem", "einen", "nicht", "auch", "als", "am",
    "an", "auf", "aus", "bei", "bin", "bis", "bist", "da", "damit", "dann",
    "doch", "dort", "du", "er", "es", "etwas", "euer", "eure", "für", "gegen",
    "gewesen", "hab", "habe", "haben", "hat", "hatte", "hatten", "hier", "hin",
    "hinter", "ich", "ihm", "ihn", "ihr", "ihre", "im", "immer", "ins", "ja",
    "jede", "jedem", "jeden", "jeder", "jedes", "jener", "jetzt", "kann",
    "kein", "können", "könnte", "machen", "man", "manche", "mehr", "mein",
    "meine", "mit", "muss", "musste", "nach", "nein", "nichts", "noch", "nun",
    "nur", "ob", "oder", "ohne", "sehr", "sein", "seine", "seit", "sich",
    "sie", "sind", "so", "solche", "soll", "sollte", "sondern", "sonst",
    "über", "um", "uns", "unser", "unter", "viel", "vom", "von", "vor",
    "wann", "warum", "was", "weiter", "weitere", "wenn", "wer", "werde",
    "werden", "wie", "wieder", "will", "wir", "wird", "wirst", "wo", "wollen",
    "während", "würde", "würden", "zum", "zur", "zwar", "zwischen",
  ]),
  fr: new Set([
    "le", "la", "les", "un", "une", "des", "du", "de", "et", "à", "il", "elle",
    "ils", "elles", "on", "nous", "vous", "je", "tu", "est", "sont", "été",
    "être", "avoir", "ai", "as", "a", "avons", "avez", "ont", "que", "qui",
    "quoi", "dont", "où", "ce", "cette", "ces", "cet", "son", "sa", "ses",
    "leur", "leurs", "mon", "ma", "mes", "ton", "ta", "tes", "notre", "nos",
    "votre", "vos", "pas", "ne", "plus", "moins", "très", "tout", "toute",
    "tous", "toutes", "dans", "sur", "sous", "avec", "sans", "pour", "par",
    "au", "aux", "donc", "or", "ni", "car", "mais", "comme", "si", "alors",
    "quand", "aussi", "bien", "encore", "déjà", "ici", "là", "y", "se",
  ]),
  es: new Set([
    "el", "la", "los", "las", "un", "una", "unos", "unas", "y", "o", "de",
    "del", "al", "a", "que", "en", "es", "son", "fue", "ser", "estar", "está",
    "están", "haber", "he", "has", "ha", "hemos", "han", "yo", "tú", "él",
    "ella", "nosotros", "vosotros", "ellos", "ellas", "su", "sus", "mi",
    "mis", "tu", "tus", "nuestro", "nuestra", "nuestros", "nuestras", "este",
    "esta", "estos", "estas", "ese", "esa", "esos", "esas", "no", "sí",
    "más", "menos", "muy", "todo", "toda", "todos", "todas", "con", "sin",
    "para", "por", "como", "cuando", "donde", "porque", "pero", "también",
    "ya", "aquí", "allí", "entonces", "así", "desde", "hasta", "sobre",
    "entre",
  ]),
  it: new Set([
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "e", "o", "di",
    "da", "del", "della", "dei", "delle", "al", "alla", "ai", "alle", "che",
    "in", "è", "sono", "essere", "stato", "ho", "hai", "ha", "abbiamo",
    "avete", "hanno", "io", "tu", "lui", "lei", "noi", "voi", "loro", "suo",
    "sua", "suoi", "sue", "mio", "mia", "miei", "mie", "tuo", "tua", "tuoi",
    "tue", "nostro", "nostra", "questo", "questa", "questi", "queste",
    "quello", "quella", "non", "più", "meno", "molto", "tutto", "tutta",
    "tutti", "tutte", "con", "senza", "per", "come", "quando", "dove",
    "perché", "ma", "anche", "già", "qui", "qua", "allora", "così",
  ]),
  nl: new Set([
    "de", "het", "een", "en", "van", "in", "is", "dat", "op", "te", "zijn",
    "er", "aan", "met", "voor", "niet", "als", "bij", "om", "dan", "dus",
    "wij", "jij", "jullie", "hij", "zij", "ze", "hun", "haar", "mijn",
    "jouw", "onze", "uw", "deze", "dit", "die", "geen", "wel", "meer",
    "minder", "heel", "alle", "allemaal", "zonder", "door", "over", "onder",
    "tussen", "waar", "wanneer", "omdat", "maar", "ook", "al", "hier", "daar",
    "zo",
  ]),
  pt: new Set([
    "o", "a", "os", "as", "um", "uma", "uns", "umas", "e", "ou", "de", "do",
    "da", "dos", "das", "ao", "aos", "à", "às", "que", "em", "é", "são",
    "foi", "ser", "estar", "está", "estão", "ter", "tenho", "tem", "temos",
    "têm", "eu", "tu", "ele", "ela", "nós", "vós", "eles", "elas", "seu",
    "sua", "seus", "suas", "meu", "minha", "meus", "minhas", "teu", "tua",
    "teus", "tuas", "nosso", "nossa", "nossos", "nossas", "este", "esta",
    "estes", "estas", "esse", "essa", "esses", "essas", "não", "sim", "mais",
    "menos", "muito", "todo", "toda", "todos", "todas", "com", "sem", "para",
    "por", "como", "quando", "onde", "porque", "mas", "também", "já", "aqui",
    "ali", "então", "assim",
  ]),
  ru: new Set([
    "и", "в", "во", "не", "что", "он", "на", "я", "с", "со", "как", "а", "то",
    "все", "она", "так", "его", "но", "да", "ты", "к", "у", "же", "вы", "за",
    "бы", "по", "только", "ее", "мне", "было", "вот", "от", "меня", "еще",
    "нет", "о", "из", "ему", "теперь", "когда", "даже", "ну", "ли", "если",
    "уже", "или", "ни", "быть", "был", "него", "до", "вас", "опять", "уж",
    "вам", "ведь", "там", "потом", "себя", "ничего", "ей", "может", "они",
    "тут", "где", "есть", "надо", "ней", "для", "мы", "тебя", "их", "чем",
    "была", "сам", "без", "чего", "раз", "тоже", "себе", "под", "будет",
    "тогда", "кто", "этот", "того", "потому", "этого", "какой", "совсем",
    "здесь", "этом", "один", "почти", "мой", "тем", "чтобы", "нее", "сейчас",
    "были", "куда", "зачем", "всех", "можно", "при", "наконец", "два", "об",
    "другой", "после", "над", "больше", "тот", "через", "эти", "нас", "про",
    "них", "более", "всегда", "конечно", "перед", "такой", "им",
  ]),
  ar: new Set([
    "في", "من", "إلى", "على", "و", "أن", "إن", "هذا", "هذه", "ذلك", "تلك",
    "التي", "الذي", "الذين", "هو", "هي", "هم", "هن", "أنت", "أنتم", "أنا",
    "نحن", "كان", "كانت", "يكون", "تكون", "لم", "لا", "لن", "ما", "مع", "عن",
    "بعد", "قبل", "عند", "كل", "بعض", "غير", "إذا", "حتى", "ثم", "أو", "لكن",
    "كما", "قد", "لقد", "إلا", "أي", "هناك", "الآن", "حيث", "بين", "فوق",
    "تحت", "أمام", "خلف", "حول",
  ]),
};

const STOPWORD_LANGUAGE_LABELS = {
  none: "None (keep all words)", en: "English", de: "German", fr: "French",
  es: "Spanish", it: "Italian", nl: "Dutch", pt: "Portuguese", ru: "Russian", ar: "Arabic",
};

// Unicode-aware words, lowercased, then drop single characters and anything
// with no letter at all (matching the R app's remove_numbers/remove_symbols
// pass) — not `[A-Za-z0-9]`, which would silently drop non-English letters.
export function tokenize(text) {
  const tokens = String(text || "").match(TOKEN) || [];
  return tokens.map((token) => token.toLocaleLowerCase())
    .filter((token) => token.length > 1 && HAS_LETTER.test(token));
}

/** Build the analysis documents for one or more selected sources. Plain-text
 * files are one document each; table rows are individual documents.
 * `sources` may be a single source string, an array, or omitted/`null` for
 * every loaded file; an explicit empty array means nothing selected.
 * `columns` picks which columns of a table source supply its text — an
 * array shared across every selected table, or a `Map<source, string[]>`
 * for a different column per file (mirrors sentimentexplorer's function of
 * the same name).
 */
export function documentsForSelection(documents, tables, sources, columns = []) {
  const everyFileDocument = () => {
    const bySource = new Map();
    const order = [];
    for (const document of documents || []) {
      if (!document.source) continue;
      if (!bySource.has(document.source)) { bySource.set(document.source, []); order.push(document.source); }
      bySource.get(document.source).push(document.text || "");
    }
    return order.map((source) => ({ source, text: bySource.get(source).join(" ").trim() })).filter((doc) => doc.text);
  };

  if (sources == null) return everyFileDocument();
  const list = Array.isArray(sources) ? sources : [sources];
  if (list.includes("__all__")) return everyFileDocument();
  if (!list.length) return [];

  const bySource = new Map(everyFileDocument().map((doc) => [doc.source, doc.text]));
  const result = [];
  for (const source of list) {
    const table = (tables || []).find((candidate) => candidate.source === source);
    if (!table) {
      const text = bySource.get(source);
      if (text) result.push({ source, text });
      continue;
    }
    const chosen = columns instanceof Map ? columns.get(source) : columns;
    const useColumns = chosen && chosen.length ? new Set(chosen) : new Set(table.header);
    table.rows.forEach((cells, index) => {
      const text = table.header
        .map((column, columnIndex) => useColumns.has(column) ? cells[columnIndex] || "" : "")
        .filter(Boolean)
        .join(" ")
        .trim();
      if (!text) return;
      result.push({
        id: `${source}#row-${index + 1}`,
        source,
        label: `${source} · row ${index + 1}`,
        text,
      });
    });
  }
  return result;
}

/**
 * Trim a corpus's vocabulary and drop empty documents.
 *
 * @param {string[][]} documentTokenLists one token array per document
 * @param {{minTermFreq?: number, minDocFreq?: number, stopwords?: Set<string>|null}} options
 * @returns {{vocabulary: string[], documents: number[][], keptDocumentIndexes: number[], droppedDocumentIndexes: number[]}}
 */
export function buildVocabulary(documentTokenLists, options = {}) {
  const { minTermFreq = 2, minDocFreq = 2, stopwords = null } = options;
  const termFreq = new Map();
  const docFreq = new Map();
  const cleaned = (documentTokenLists || []).map((tokens) => {
    const filtered = stopwords ? tokens.filter((token) => !stopwords.has(token)) : tokens;
    const seenInDoc = new Set();
    for (const token of filtered) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
      if (!seenInDoc.has(token)) { seenInDoc.add(token); docFreq.set(token, (docFreq.get(token) || 0) + 1); }
    }
    return filtered;
  });

  const vocabulary = [...termFreq.keys()]
    .filter((token) => termFreq.get(token) >= minTermFreq && docFreq.get(token) >= minDocFreq)
    .sort();
  const index = new Map(vocabulary.map((token, i) => [token, i]));

  const documents = [];
  const keptDocumentIndexes = [];
  const droppedDocumentIndexes = [];
  cleaned.forEach((tokens, docIndex) => {
    const kept = [];
    for (const token of tokens) {
      const wordIndex = index.get(token);
      if (wordIndex !== undefined) kept.push(wordIndex);
    }
    if (kept.length) { documents.push(kept); keptDocumentIndexes.push(docIndex); }
    else droppedDocumentIndexes.push(docIndex);
  });

  return { vocabulary, documents, keptDocumentIndexes, droppedDocumentIndexes };
}

// A small, seeded PRNG (mulberry32) — LDA here must be deterministic for a
// fixed seed, which Math.random() cannot give us.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleTopic(weights, total, rng) {
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// The collapsed Gibbs sampler shared by the unsupervised and seeded passes.
// `betaMatrix[topic][word]` lets the seeded pass boost a topic's own seed
// words without a second code path; the plain pass just uses a flat beta.
//
// Resumable rather than "run N iterations and return": a real corpus can
// take long enough that running every iteration in one synchronous call
// freezes the tab for the whole duration regardless of any spinner. Chunking
// through `runIterations` lets a caller (see fitLDAAsync/fitSeededLDAAsync
// below) yield back to the browser between chunks, so the page stays
// responsive and a progress indicator can actually update.
function createGibbsSampler(documents, vocabularySize, k, { seed, alpha, betaMatrix, betaTotals }) {
  const rng = mulberry32(seed);
  const nDocs = documents.length;
  const docTopicCounts = Array.from({ length: nDocs }, () => new Array(k).fill(0));
  const docTotals = new Array(nDocs).fill(0);
  const topicTermCounts = Array.from({ length: k }, () => new Array(vocabularySize).fill(0));
  const topicTotals = new Array(k).fill(0);
  const assignments = documents.map((doc) => new Array(doc.length).fill(0));

  for (let d = 0; d < nDocs; d++) {
    const doc = documents[d];
    for (let pos = 0; pos < doc.length; pos++) {
      const topic = Math.floor(rng() * k);
      assignments[d][pos] = topic;
      docTopicCounts[d][topic]++; docTotals[d]++;
      topicTermCounts[topic][doc[pos]]++; topicTotals[topic]++;
    }
  }

  const weights = new Array(k);
  function runIterations(count) {
    for (let iter = 0; iter < count; iter++) {
      for (let d = 0; d < nDocs; d++) {
        const doc = documents[d];
        for (let pos = 0; pos < doc.length; pos++) {
          const w = doc[pos];
          const previousTopic = assignments[d][pos];
          docTopicCounts[d][previousTopic]--; docTotals[d]--;
          topicTermCounts[previousTopic][w]--; topicTotals[previousTopic]--;

          let total = 0;
          for (let t = 0; t < k; t++) {
            const docPart = docTopicCounts[d][t] + alpha;
            const termPart = (topicTermCounts[t][w] + betaMatrix[t][w]) / (topicTotals[t] + betaTotals[t]);
            weights[t] = docPart * termPart;
            total += weights[t];
          }
          const topic = sampleTopic(weights, total, rng);

          assignments[d][pos] = topic;
          docTopicCounts[d][topic]++; docTotals[d]++;
          topicTermCounts[topic][w]++; topicTotals[topic]++;
        }
      }
    }
  }

  function getResult() {
    const termTopicWeights = topicTermCounts.map((counts, t) =>
      counts.map((count, w) => (count + betaMatrix[t][w]) / (topicTotals[t] + betaTotals[t])));
    const docTopicWeights = docTopicCounts.map((counts, d) =>
      counts.map((count) => (count + alpha) / (docTotals[d] + k * alpha)));
    return { termTopicWeights, docTopicWeights, assignments };
  }

  return { runIterations, getResult };
}

function gibbsLDA(documents, vocabularySize, k, { seed, iterations, alpha, betaMatrix, betaTotals }) {
  const sampler = createGibbsSampler(documents, vocabularySize, k, { seed, alpha, betaMatrix, betaTotals });
  sampler.runIterations(iterations);
  return sampler.getResult();
}

// Yield one repaint (a rAF, then a macrotask) so the browser can actually
// paint and stay responsive between sampler chunks — a chain of promises
// resolved synchronously would never give it the chance.
function yieldToBrowser() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

const DEFAULT_CHUNK_SIZE = 10;

/**
 * The async, non-freezing counterpart of `fitLDA`: same result, but run in
 * chunks of `chunkSize` iterations with a yield to the browser between each,
 * reporting fractional progress via `onProgress`.
 */
export async function fitLDAAsync(documents, vocabularySize, options = {}, onProgress) {
  const {
    k = 5, seed = 1234, iterations = DEFAULT_ITERATIONS,
    alpha = 50 / Math.max(k, 1), beta = 0.1, chunkSize = DEFAULT_CHUNK_SIZE,
  } = options;
  const betaMatrix = Array.from({ length: k }, () => new Array(vocabularySize).fill(beta));
  const betaTotals = new Array(k).fill(beta * vocabularySize);
  const sampler = createGibbsSampler(documents, vocabularySize, k, { seed, alpha, betaMatrix, betaTotals });
  for (let done = 0; done < iterations; done += chunkSize) {
    sampler.runIterations(Math.min(chunkSize, iterations - done));
    onProgress?.(Math.min(1, (done + chunkSize) / iterations));
    await yieldToBrowser();
  }
  const { termTopicWeights, docTopicWeights, assignments } = sampler.getResult();
  return { k, termTopicWeights, docTopicWeights, assignments };
}

/**
 * Stage 1 — unsupervised LDA over the trimmed vocabulary.
 * @param {number[][]} documents each document as vocabulary-index tokens
 * @param {number} vocabularySize
 */
export function fitLDA(documents, vocabularySize, options = {}) {
  const {
    k = 5, seed = 1234, iterations = DEFAULT_ITERATIONS,
    alpha = 50 / Math.max(k, 1), beta = 0.1,
  } = options;
  const betaMatrix = Array.from({ length: k }, () => new Array(vocabularySize).fill(beta));
  const betaTotals = new Array(k).fill(beta * vocabularySize);
  const { termTopicWeights, docTopicWeights, assignments } =
    gibbsLDA(documents, vocabularySize, k, { seed, iterations, alpha, betaMatrix, betaTotals });
  return { k, termTopicWeights, docTopicWeights, assignments };
}

/** Most probable `n` terms per topic, most probable first. */
export function topTermsPerTopic(termTopicWeights, vocabulary, n = 10) {
  return termTopicWeights.map((weights) => {
    const withTerm = weights.map((weight, i) => [vocabulary[i], weight]);
    withTerm.sort((a, b) => b[1] - a[1]);
    return withTerm.slice(0, n).map(([term]) => term);
  });
}

/**
 * Parse and validate the per-topic name/seed-words editor into the
 * structure `fitSeededLDA` consumes. Throws when no topic has seed words —
 * the panel reports that, matching the R app's own check.
 */
export function buildSeedDictionary(topicNames, seedWordsPerTopic) {
  const topics = (topicNames || []).map((name, i) => ({
    name: (name || "").trim() || `Topic${String(i + 1).padStart(2, "0")}`,
    words: [...new Set((seedWordsPerTopic[i] || []).map((word) => word.trim().toLocaleLowerCase()).filter(Boolean))],
  })).filter((topic) => topic.words.length);
  if (!topics.length) throw new Error("At least one topic must have seed words.");
  return topics;
}

/**
 * Stage 2 — seeded LDA. Adds one residual topic (`RESIDUAL_TOPIC_NAME`) with
 * a flat prior to catch content matching no seed dictionary, and boosts
 * each seeded topic's own seed-word priors so the sampler is pulled toward
 * them without simply enumerating them back out.
 */
export function fitSeededLDA(documents, vocabulary, seedDictionary, options = {}) {
  const {
    seed = 1234, iterations = DEFAULT_ITERATIONS, beta = 0.1,
    seedBoost = DEFAULT_SEED_BOOST, alpha,
  } = options;
  const vocabIndex = new Map(vocabulary.map((term, i) => [term, i]));
  const seededTopicCount = seedDictionary.length;
  const k = seededTopicCount + 1;
  const alphaValue = alpha ?? 50 / k;

  const betaMatrix = Array.from({ length: k }, () => new Array(vocabulary.length).fill(beta));
  seedDictionary.forEach((topic, t) => {
    for (const word of topic.words) {
      const wordIndex = vocabIndex.get(word);
      if (wordIndex !== undefined) betaMatrix[t][wordIndex] = beta * seedBoost;
    }
  });
  const betaTotals = betaMatrix.map((row) => row.reduce((sum, value) => sum + value, 0));

  const { termTopicWeights, docTopicWeights, assignments } =
    gibbsLDA(documents, vocabulary.length, k, { seed, iterations, alpha: alphaValue, betaMatrix, betaTotals });
  const topicNames = [...seedDictionary.map((topic) => topic.name), RESIDUAL_TOPIC_NAME];
  return { k, topicNames, termTopicWeights, docTopicWeights, assignments };
}

/** The async, non-freezing counterpart of `fitSeededLDA` — see `fitLDAAsync`. */
export async function fitSeededLDAAsync(documents, vocabulary, seedDictionary, options = {}, onProgress) {
  const {
    seed = 1234, iterations = DEFAULT_ITERATIONS, beta = 0.1,
    seedBoost = DEFAULT_SEED_BOOST, alpha, chunkSize = DEFAULT_CHUNK_SIZE,
  } = options;
  const vocabIndex = new Map(vocabulary.map((term, i) => [term, i]));
  const seededTopicCount = seedDictionary.length;
  const k = seededTopicCount + 1;
  const alphaValue = alpha ?? 50 / k;

  const betaMatrix = Array.from({ length: k }, () => new Array(vocabulary.length).fill(beta));
  seedDictionary.forEach((topic, t) => {
    for (const word of topic.words) {
      const wordIndex = vocabIndex.get(word);
      if (wordIndex !== undefined) betaMatrix[t][wordIndex] = beta * seedBoost;
    }
  });
  const betaTotals = betaMatrix.map((row) => row.reduce((sum, value) => sum + value, 0));

  const sampler = createGibbsSampler(documents, vocabulary.length, k, { seed, alpha: alphaValue, betaMatrix, betaTotals });
  for (let done = 0; done < iterations; done += chunkSize) {
    sampler.runIterations(Math.min(chunkSize, iterations - done));
    onProgress?.(Math.min(1, (done + chunkSize) / iterations));
    await yieldToBrowser();
  }
  const { termTopicWeights, docTopicWeights, assignments } = sampler.getResult();
  const topicNames = [...seedDictionary.map((topic) => topic.name), RESIDUAL_TOPIC_NAME];
  return { k, topicNames, termTopicWeights, docTopicWeights, assignments };
}

let instanceCounter = 0;
const slugDate = () => new Date().toISOString().slice(0, 10);
const display = (value) => (typeof value === "number" ? value.toFixed(4) : String(value ?? ""));
const downloadText = (filename, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = element("a", { attrs: { href: url, download: filename } });
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
};

// One clearly separated heading style, matching sentimentexplorer's panel.
function ensureStyle() {
  if (document.getElementById("topicdetector-style")) return;
  const style = element("style", { attrs: { id: "topicdetector-style" } });
  style.textContent = [
    ".topic-section-heading {",
    "  margin: 1.5rem 0 0.5rem; padding-bottom: 0.25rem;",
    "  border-bottom: 2px solid var(--border); font-size: 0.95rem;",
    "  font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;",
    "  color: var(--muted);",
    "}",
    ".topic-section-heading:first-child { margin-top: 0; }",
    ".topic-seed-row {",
    "  display: grid; grid-template-columns: minmax(10rem, 1fr) minmax(0, 4fr);",
    "  gap: 0.75rem; align-items: end; width: 100%;",
    "}",
    ".topic-seed-row .field { min-width: 0; width: 100%; }",
    ".topic-seed-row .field input { width: 100%; }",
    ".topic-chart-row {",
    "  display: grid; grid-template-columns: minmax(8rem, 12rem) minmax(3rem, 1fr) 6rem;",
    "  align-items: center; gap: 0.5rem; margin-block: 0.25rem;",
    "}",
    ".topic-documents-list {",
    "  display: block; max-height: 10rem; overflow-y: auto; overflow-x: hidden;",
    "  padding: 0.5rem; border: 1px solid var(--border);",
    "}",
    ".topic-document-item { display: block; overflow-wrap: anywhere; padding-block: 0.1rem; }",
    ".topic-assignment-table-scroll {",
    "  max-height: 50rem; overflow-y: auto; border: 1px solid var(--border);",
    "}",
    ".topic-spinner {",
    "  display: inline-block; width: 1rem; height: 1rem; margin-right: 0.5rem;",
    "  border: 2px solid var(--border); border-top-color: var(--accent, #51247a);",
    "  border-radius: 50%; vertical-align: -0.2rem;",
    "  animation: topic-spin 0.7s linear infinite;",
    "}",
    // `[hidden]` alone loses to the class rule above at equal specificity —
    // without this, setting `.hidden = true` never actually hides it.
    ".topic-spinner[hidden] { display: none; }",
    "@keyframes topic-spin { to { transform: rotate(360deg); } }",
  ].join("\n");
  document.head.append(style);
}
const sectionHeading = (text) => element("h3", { className: "topic-section-heading", text });

/**
 * Run a computation with visible feedback: disable `triggerButton`, show a
 * spinner and a status message, yield one repaint so it actually paints,
 * then await `work` (which should itself yield periodically if it's slow —
 * see fitLDAAsync/fitSeededLDAAsync — so the tab stays responsive and the
 * spinner keeps animating throughout, not just before a frozen stretch).
 */
async function runWithSpinner(triggerButton, spinner, statusEl, label, work) {
  triggerButton.disabled = true;
  spinner.hidden = false;
  statusEl.textContent = label;
  await yieldToBrowser();
  try { await work(); }
  finally { spinner.hidden = true; triggerButton.disabled = false; }
}

function renderTopicFrequencyChart(topicNames, bestTopicIndexes) {
  const counts = topicNames.map((_, t) => bestTopicIndexes.filter((best) => best === t).length);
  const total = bestTopicIndexes.length || 1;
  const maxCount = Math.max(...counts, 1);
  const wrap = element("div", {});
  const header = element("div", { className: "topic-chart-row" }, [
    element("strong", { text: "Topic" }), element("strong", { text: "Documents" }), element("strong", { text: "Count (%)" }),
  ]);
  wrap.append(header);
  topicNames.forEach((name, t) => {
    const count = counts[t];
    const pct = Math.round((count / total) * 1000) / 10;
    const bar = element("span", {});
    Object.assign(bar.style, {
      display: "block", height: "1.25rem", borderRadius: "0.2rem",
      background: TOPIC_COLOURS[t % TOPIC_COLOURS.length], width: `${Math.max(1, (count / maxCount) * 100)}%`,
    });
    const row = element("div", { className: "topic-chart-row" }, [
      element("span", { text: name }), bar,
      element("span", { className: "mono", text: `${count} (${display(pct)}%)` }),
    ]);
    wrap.append(row);
  });
  return wrap;
}

export function createPlugin() {
  return {
    name: "topicdetector",
    visualisation: {
      label: "Topic Detector",
      hint: "Find and name latent topics across documents with unsupervised, then seeded, LDA.",
      render(container, { documents = [], tables = [] }) {
        ensureStyle();
        const panelId = ++instanceCounter;
        let workingDocs = [];
        let vocabResult = null;
        let unsupResult = null;
        let unsupTopTerms = [];
        let seedInputs = [];
        let seededResult = null;
        let seededTopTerms = [];
        let parameters = null;
        let effectiveMinDocFreqUsed = null;

        const introHeading = element("h2", { text: "Topic Detector" });
        const introText = note(
          "Select one or more loaded files below (every file is selected by default) \u2014 each file " +
          "is one document. If a selected file is a table (CSV/TSV), choose which of its columns " +
          "supply its text. Run the unsupervised LDA first to explore topics; edit the seed " +
          "dictionary it produces, then run the seeded LDA to name and assign topics to every document."
        );

        const sourceOptions = [...new Set([
          ...(documents || []).map((document) => document.source),
          ...(tables || []).map((table) => table.source),
        ].filter(Boolean))].sort((left, right) => left.localeCompare(right));
        const sourceSelect = element("select", {
          attrs: { multiple: true, size: Math.min(8, Math.max(3, sourceOptions.length)), "aria-label": "Files" },
        });
        sourceSelect.append(...sourceOptions.map((source) => element("option", { text: source, attrs: { value: source } })));
        [...sourceSelect.options].forEach((option) => { option.selected = true; });
        const columnsHost = element("div", { className: "actions" });
        let columnSelects = new Map();
        const documentsHost = element("div", { className: "topic-documents-list" });

        const stopwordLangSelect = element("select", { attrs: { "aria-label": "Remove stopwords" } });
        stopwordLangSelect.append(...Object.entries(STOPWORD_LANGUAGE_LABELS).map(([value, label]) =>
          element("option", { text: label, attrs: { value } })));
        stopwordLangSelect.value = "en";
        const minTermFreq = element("input", { attrs: { type: "number", min: 1, value: 2 } });
        const minDocFreq = element("input", { attrs: { type: "number", min: 1, value: 2 } });
        const kInput = element("input", { attrs: { type: "number", min: 2, max: 30, value: 5 } });
        const seedInput = element("input", { attrs: { type: "number", min: 1, value: 1234 } });
        const topNInput = element("input", { attrs: { type: "number", min: 5, max: 25, value: 10 } });

        const status = element("p", { className: "field-hint" });
        const unsupSpinner = element("span", { className: "topic-spinner", attrs: { role: "status", "aria-label": "Running" } });
        unsupSpinner.hidden = true;
        const seededSpinner = element("span", { className: "topic-spinner", attrs: { role: "status", "aria-label": "Running" } });
        seededSpinner.hidden = true;
        const runUnsupButton = button("Run unsupervised LDA", { primary: true });
        const stage1Wrap = element("div", { attrs: { hidden: true } });
        const stage1Terms = element("div");
        const seedDictHost = element("div");
        const runSeededButton = button("Run seeded LDA", { primary: true });
        runSeededButton.disabled = true;
        const stage2Wrap = element("div", { attrs: { hidden: true } });
        const stage2Terms = element("div");
        const docAssignHost = element("div");
        const chartHost = element("div");
        const parametersHost = element("div");

        const selectedSources = () => [...sourceSelect.selectedOptions].map((option) => option.value);
        const selectedColumnsMap = () => {
          const map = new Map();
          for (const [source, columnSelect] of columnSelects) map.set(source, [...columnSelect.selectedOptions].map((option) => option.value));
          return map;
        };

        function updateColumns() {
          const chosen = new Set(selectedSources());
          const matchingTables = (tables || []).filter((table) => chosen.has(table.source));
          columnsHost.replaceChildren();
          columnSelects = new Map();
          if (!matchingTables.length) { columnsHost.hidden = true; return; }
          for (const table of matchingTables) {
            const columnSelect = element("select", {
              attrs: { multiple: true, size: Math.min(4, Math.max(2, table.header.length)), "aria-label": `Columns for ${table.source}` },
            });
            columnSelect.append(...table.header.map((column) => element("option", { text: column, attrs: { value: column } })));
            const textColumn = table.header.findIndex((column) => column.trim().toLowerCase() === "text");
            [...columnSelect.options].forEach((option, index) => { option.selected = textColumn >= 0 ? index === textColumn : true; });
            columnSelect.addEventListener("change", rebuildCorpus);
            columnSelects.set(table.source, columnSelect);
            columnsHost.append(field(table.source, columnSelect));
          }
          columnsHost.hidden = false;
        }

        function clearResults() {
          vocabResult = null; unsupResult = null; unsupTopTerms = []; seedInputs = [];
          seededResult = null; seededTopTerms = []; parameters = null; effectiveMinDocFreqUsed = null;
          stage1Wrap.hidden = true; stage2Wrap.hidden = true;
          seedDictHost.replaceChildren(note("Run the unsupervised LDA above first \u2014 the seed dictionary will be pre-filled automatically."));
          runSeededButton.disabled = true;
        }

        // Selecting a file or its columns changes the corpus, so any earlier
        // model no longer describes it.
        function rebuildCorpus() {
          workingDocs = documentsForSelection(documents, tables, selectedSources(), selectedColumnsMap());
          documentsHost.replaceChildren(
            element("strong", { text: "Documents" }),
            ...workingDocs.map((doc) => element("span", { className: "field-hint topic-document-item", text: doc.label || doc.source })),
          );
          clearResults();
          status.textContent = workingDocs.length ? `${workingDocs.length} document(s) loaded.` : "No text loaded for the selected file(s).";
        }

        const stopwordSet = () => STOPWORDS_BY_LANG[stopwordLangSelect.value] || null;
        const intInput = (input, fallback, min, max) => Math.min(max, Math.max(min, Number.parseInt(input.value, 10) || fallback));

        function renderTopTermsTable(host, topicNames, topTerms, n) {
          const headers = topicNames;
          const { body, node } = dataTable(headers);
          for (let rank = 0; rank < n; rank++) {
            body.append(element("tr", {}, topTerms.map((terms) => element("td", { text: terms[rank] || "", className: "mono" }))));
          }
          host.replaceChildren(node);
        }

        function renderSeedCards(topicNames, topTerms) {
          seedInputs = topicNames.map((name, i) => ({
            nameInput: element("input", { attrs: { type: "text", value: name } }),
            wordsInput: element("input", { attrs: { type: "text", value: (topTerms[i] || []).join(", ") } }),
          }));
          seedDictHost.replaceChildren(...seedInputs.map((row, i) => element("div", { className: "topic-seed-row" }, [
            field(`Topic ${i + 1} name`, row.nameInput), field("Seed words (comma-separated)", row.wordsInput),
          ])));
          runSeededButton.disabled = false;
        }

        async function runUnsupervised() {
          if (!workingDocs.length) { status.textContent = "No text loaded for the selected file(s)."; return; }
          const tokensPerDoc = workingDocs.map((doc) => tokenize(doc.text));
          // No term can appear in more documents than are selected — with a
          // single file (one document), a minimum document frequency of 2
          // would empty the vocabulary every time. Clamp it rather than
          // reporting a generic "no documents remain" a person can't act on.
          const effectiveMinDocFreq = Math.min(
            intInput(minDocFreq, 2, 1, Number.MAX_SAFE_INTEGER), workingDocs.length,
          );
          effectiveMinDocFreqUsed = effectiveMinDocFreq;
          vocabResult = buildVocabulary(tokensPerDoc, {
            minTermFreq: intInput(minTermFreq, 2, 1, Number.MAX_SAFE_INTEGER),
            minDocFreq: effectiveMinDocFreq,
            stopwords: stopwordSet(),
          });
          if (!vocabResult.documents.length) {
            status.textContent = "No documents remain after filtering \u2014 lower the minimum term/document frequency.";
            stage1Wrap.hidden = true; stage2Wrap.hidden = true;
            return;
          }
          const k = intInput(kInput, 5, 2, 30);
          const seed = intInput(seedInput, 1234, 1, Number.MAX_SAFE_INTEGER);
          const topN = intInput(topNInput, 10, 5, 25);
          unsupResult = await fitLDAAsync(vocabResult.documents, vocabResult.vocabulary.length, { k, seed },
            (progress) => { status.textContent = `Running unsupervised LDA\u2026 ${Math.round(progress * 100)}%`; });
          unsupTopTerms = topTermsPerTopic(unsupResult.termTopicWeights, vocabResult.vocabulary, topN);

          const topicNames = unsupTopTerms.map((_, i) => `Topic ${i + 1}`);
          renderTopTermsTable(stage1Terms, topicNames, unsupTopTerms, topN);
          renderSeedCards(topicNames, unsupTopTerms);
          stage1Wrap.hidden = false; stage2Wrap.hidden = true;
          const dropped = vocabResult.droppedDocumentIndexes.length;
          status.textContent = dropped ? `${dropped} document(s) dropped as empty after filtering.` : "";
        }

        async function runSeeded() {
          if (!vocabResult || !unsupResult) { status.textContent = "Run the unsupervised LDA first."; return; }
          let seedDictionary;
          try {
            seedDictionary = buildSeedDictionary(
              seedInputs.map((row) => row.nameInput.value),
              seedInputs.map((row) => row.wordsInput.value.split(",")),
            );
          } catch (e) {
            status.textContent = e.message;
            return;
          }
          const seed = intInput(seedInput, 1234, 1, Number.MAX_SAFE_INTEGER);
          const topN = intInput(topNInput, 10, 5, 25);
          seededResult = await fitSeededLDAAsync(vocabResult.documents, vocabResult.vocabulary, seedDictionary, { seed },
            (progress) => { status.textContent = `Running seeded LDA\u2026 ${Math.round(progress * 100)}%`; });
          seededTopTerms = topTermsPerTopic(seededResult.termTopicWeights, vocabResult.vocabulary, topN);

          renderTopTermsTable(stage2Terms, seededResult.topicNames, seededTopTerms, topN);

          const bestTopicIndexes = seededResult.docTopicWeights.map((weights) => weights.indexOf(Math.max(...weights)));
          const headers = ["Document", "Best topic", ...seededResult.topicNames];
          const { body, node } = dataTable(headers);
          node.classList.add("topic-assignment-table-scroll");
          const shown = seededResult.docTopicWeights.slice(0, MAX_RENDERED_ROWS);
          shown.forEach((weights, d) => {
            const sourceDoc = workingDocs[vocabResult.keptDocumentIndexes[d]];
            const source = sourceDoc?.label || sourceDoc?.source || `document ${d + 1}`;
            body.append(element("tr", {}, [
              element("td", { text: source, className: "mono" }),
              element("td", { text: seededResult.topicNames[bestTopicIndexes[d]] }),
              ...weights.map((weight) => element("td", { text: display(weight) })),
            ]));
          });
          docAssignHost.replaceChildren(node);

          chartHost.replaceChildren(renderTopicFrequencyChart(seededResult.topicNames, bestTopicIndexes));

          parameters = {
            files: selectedSources().length === sourceOptions.length ? "All files" : selectedSources().join(", "),
            stopwords: STOPWORD_LANGUAGE_LABELS[stopwordLangSelect.value],
            minTermFreq: String(intInput(minTermFreq, 2, 1, Number.MAX_SAFE_INTEGER)),
            minDocFreq: String(effectiveMinDocFreqUsed),
            k: String(unsupResult.k), seed: String(seed), topN: String(topN),
            seedDictionary: seedDictionary.map((t) => `${t.name}: ${t.words.join("/")}`).join("; "),
          };
          renderParameters();
          stage2Wrap.hidden = false;
          status.textContent = "";
        }

        function renderParameters() {
          const { body, node } = dataTable(["Parameter", "Value"]);
          for (const [key, value] of Object.entries(parameters)) body.append(element("tr", {}, [element("td", { text: key }), element("td", { text: value })]));
          parametersHost.replaceChildren(node);
        }
        const parameterText = () => Object.entries(parameters).map(([key, value]) => `${key}: ${value}`).join("\n");

        const stage1Csv = () => buildCsvText(unsupTopTerms.map((_, i) => `Topic ${i + 1}`),
          Array.from({ length: intInput(topNInput, 10, 5, 25) }, (_, rank) => unsupTopTerms.map((terms) => terms[rank] || "")));
        const stage2Csv = () => buildCsvText(seededResult.topicNames,
          Array.from({ length: intInput(topNInput, 10, 5, 25) }, (_, rank) => seededTopTerms.map((terms) => terms[rank] || "")));
        const docAssignCsv = () => {
          const headers = ["Document", "Best topic", ...seededResult.topicNames];
          const rows = seededResult.docTopicWeights.map((weights, d) => {
            const sourceDoc = workingDocs[vocabResult.keptDocumentIndexes[d]];
            const source = sourceDoc?.label || sourceDoc?.source || `document ${d + 1}`;
            const best = seededResult.topicNames[weights.indexOf(Math.max(...weights))];
            return [source, best, ...weights.map(display)];
          });
          return buildCsvText(headers, rows);
        };

        const copyStage1 = button("Copy CSV", { onClick: async () => { if (unsupTopTerms.length && await copyText(stage1Csv())) flashLabel(copyStage1, "Copied"); } });
        const copyStage2 = button("Copy CSV", { onClick: async () => { if (seededTopTerms.length && await copyText(stage2Csv())) flashLabel(copyStage2, "Copied"); } });
        const copyDocs = button("Copy CSV", { onClick: async () => { if (seededResult && await copyText(docAssignCsv())) flashLabel(copyDocs, "Copied"); } });

        sourceSelect.addEventListener("change", () => { updateColumns(); rebuildCorpus(); });
        runUnsupButton.addEventListener("click", () =>
          runWithSpinner(runUnsupButton, unsupSpinner, status, "Running unsupervised LDA\u2026", runUnsupervised));
        runSeededButton.addEventListener("click", () =>
          runWithSpinner(runSeededButton, seededSpinner, status, "Running seeded LDA\u2026", runSeeded));

        stage1Wrap.append(
          sectionHeading("Stage 1 \u2014 Unsupervised LDA"),
          resultsBar("", [copyStage1, button("Save CSV", { onClick: () => unsupTopTerms.length && downloadCsv(`topicdetector-stage1-${slugDate()}.csv`, stage1Csv()) })]),
          stage1Terms,
          sectionHeading("Seed dictionary"),
          note("Edit each topic's name and seed words, then press \u201cRun seeded LDA\u201d."),
          seedDictHost,
          element("div", { className: "actions" }, [runSeededButton, seededSpinner]),
        );

        stage2Wrap.append(
          sectionHeading("Stage 2 \u2014 Seeded LDA"),
          resultsBar("", [copyStage2, button("Save CSV", { onClick: () => seededTopTerms.length && downloadCsv(`topicdetector-stage2-${slugDate()}.csv`, stage2Csv()) })]),
          stage2Terms,
          sectionHeading("Document assignments"),
          resultsBar("", [copyDocs, button("Save CSV", { onClick: () => seededResult && downloadCsv(`topicdetector-documents-${slugDate()}.csv`, docAssignCsv()) })]),
          docAssignHost,
          sectionHeading("Topic frequency"),
          chartHost,
          sectionHeading("Parameters"),
          resultsBar("", [button("Save parameters", { onClick: () => parameters && downloadText(`topicdetector-parameters-${slugDate()}.txt`, parameterText()) })]),
          parametersHost,
        );

        container.replaceChildren(
          introHeading, introText,
          element("div", { className: "actions" }, [field("Files", sourceSelect)]),
          columnsHost,
          documentsHost,
          element("div", { className: "actions" }, [
            field("Remove stopwords", stopwordLangSelect), field("Min. term freq.", minTermFreq), field("Min. doc freq.", minDocFreq),
          ]),
          element("div", { className: "actions" }, [
            field("k (topics)", kInput), field("Random seed", seedInput), field("Top terms per topic", topNInput),
            runUnsupButton, unsupSpinner,
          ]),
          status,
          stage1Wrap,
          stage2Wrap,
          attributionFooter({
            logo: "https://ladal.edu.au/images/ladal_icon_white.png",
            logoAlt: "",
            logoBackground: "#51247a",
            href: "https://ladal.edu.au",
            text: "Language Technology and Data Analysis Laboratory",
            comment: "Developed with permission from LADAL.",
          }),
        );
        updateColumns();
        rebuildCorpus();
      },
    },
  };
}
