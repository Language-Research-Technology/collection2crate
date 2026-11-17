// N-grams: contiguous word sequences ranked by frequency, with association
// measures for bigrams. Follows the LADAL collocations tutorial
// (https://ladal.edu.au/tutorials/collocations/collocations.html).
//
// A visualisation panel, not a build plugin (SPEC-PLUGINS.md).

import { buildCsvText, copyText, downloadCsv } from "../../src/_csv.js";
import { button, checkbox, dataTable, element, field, numberInput } from "../../src/_panel.js";

const MAX_RENDERED_ROWS = 2000;

// Letters, marks and digits, with an optional internal apostrophe or hyphen:
// "don't", "Yolŋu-matha", "naïve". Deliberately not [A-Za-z0-9], which drops
// every non-ASCII letter and would quietly mangle most of the orthographies
// this tool exists to serve.
const TOKEN = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;

// English function words, enough to take "the of a" off the top of a frequency
// list. English and nothing else — which is why the panel's checkbox is off by
// default and says so: filtering a Gurindji corpus through this list drops
// real words, and nothing on screen would admit it.
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

export function tokenize(text, caseSensitive = false) {
  const tokens = String(text || "").match(TOKEN) || [];
  return caseSensitive ? tokens : tokens.map((token) => token.toLowerCase());
}

const hasStopword = (ngram) => ngram.split(" ").some((word) => ENGLISH_STOPWORDS.has(word.toLowerCase()));

// Counts every n-gram, and — whatever n is — every unigram and the token
// total, which is what the bigram measures need. An n-gram never spans two
// documents: each one is its own utterance or line, so the window stops at
// its end rather than inventing a pair across a speaker change.
function countNgrams(documents, { n, caseSensitive }) {
  const counts = new Map();
  const unigrams = new Map();
  let total = 0;
  for (const doc of documents || []) {
    const tokens = tokenize(doc.text, caseSensitive);
    for (const token of tokens) {
      unigrams.set(token, (unigrams.get(token) || 0) + 1);
      total++;
    }
    for (let i = 0; i + n <= tokens.length; i++) {
      const key = tokens.slice(i, i + n).join(" ");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return { counts, unigrams, total };
}

/**
 * Rank the n-grams of `documents`, most frequent first.
 *
 * For bigrams each row also carries Mutual Information and a t-score, from the
 * pair's count O, the two words' counts f1/f2 and the token total N:
 *
 *   expected = f1 * f2 / N ;  MI = log2(O / expected) ;  t = (O - expected) / sqrt(O)
 *
 * The tutorial's log-ratio, log2((O/N)/(E/N)), is the same number as MI, so it
 * is not reported as a third column.
 *
 * @param {Array<{text: string}>} documents
 * @param {{n: number, caseSensitive?: boolean, removeStopwords?: boolean, minFreq?: number}} options
 */
export function analyzeNgrams(documents, options) {
  const { n, removeStopwords = false, minFreq = 1 } = options;
  const { counts, unigrams, total } = countNgrams(documents, { n, caseSensitive: !!options.caseSensitive });

  const rows = [];
  for (const [ngram, count] of counts) {
    if (count < minFreq) continue;
    if (removeStopwords && hasStopword(ngram)) continue;
    const row = { ngram, count };
    if (n === 2) {
      const [first, second] = ngram.split(" ");
      const expected = total > 0 ? ((unigrams.get(first) || 0) * (unigrams.get(second) || 0)) / total : 0;
      row.mi = expected > 0 ? Math.log2(count / expected) : null;
      row.tScore = (count - expected) / Math.sqrt(Math.max(count, 1));
    }
    rows.push(row);
  }
  return rows.sort((a, b) => b.count - a.count);
}

const score = (value) => (value === null || value === undefined ? "" : value.toFixed(2));

export function createPlugin() {
  return {
    name: "ngrams",
    visualisation: {
      label: "N-grams",
      hint: "Rank frequent word sequences; bigrams also get MI and t-score.",
      render(container, { documents = [] }) {
        let rows = [];
        let currentN = 2;

        const nInput = numberInput({ value: 2, min: 1, max: 5 });
        const minFreqInput = numberInput({ value: 2, min: 1 });
        const caseSensitive = checkbox("Case sensitive");
        const removeStopwords = checkbox("Remove English stopwords");
        const filterInput = element("input", {
          attrs: { type: "search", placeholder: "Filter results…", "aria-label": "Filter results" },
        });
        const status = element("p", { className: "field-hint" });
        const count = element("span", { className: "field-hint" });
        const resultsWrap = element("div", { attrs: { hidden: true } });
        let table = null;
        let body = null;

        const shownRows = () => {
          const filter = filterInput.value.trim().toLowerCase();
          return filter ? rows.filter((row) => row.ngram.toLowerCase().includes(filter)) : rows;
        };

        const csv = () => (currentN === 2
          ? buildCsvText(["ngram", "count", "mi", "t_score"], rows.map((r) => [r.ngram, r.count, score(r.mi), score(r.tScore)]))
          : buildCsvText(["ngram", "count"], rows.map((r) => [r.ngram, r.count])));

        function buildTable() {
          const headers = currentN === 2
            ? ["N-gram", { label: "Count", className: "ngram-num" }, { label: "MI", className: "ngram-num" }, { label: "t-score", className: "ngram-num" }]
            : ["N-gram", { label: "Count", className: "ngram-num" }];
          const built = dataTable(headers);
          body = built.body;
          if (table) table.replaceWith(built.node);
          else resultsWrap.append(built.node);
          table = built.node;
        }

        function renderRows() {
          const filtered = shownRows();
          const shown = filtered.slice(0, MAX_RENDERED_ROWS);
          body.replaceChildren();
          for (const row of shown) {
            const cells = [
              element("td", { text: row.ngram }),
              element("td", { text: String(row.count), className: "ngram-num" }),
            ];
            if (currentN === 2) {
              cells.push(
                element("td", { text: score(row.mi), className: "ngram-num" }),
                element("td", { text: score(row.tScore), className: "ngram-num" }),
              );
            }
            body.append(element("tr", {}, cells));
          }
          count.textContent = filtered.length > shown.length
            ? `${filtered.length} unique n-gram(s) (showing the first ${shown.length})`
            : `${filtered.length} unique n-gram(s)`;
        }

        function analyse() {
          if (!documents.length) { status.textContent = "No text loaded — choose an output folder."; return; }
          currentN = Math.min(5, Math.max(1, parseInt(nInput.value, 10) || 2));
          rows = analyzeNgrams(documents, {
            n: currentN,
            minFreq: Math.max(1, parseInt(minFreqInput.value, 10) || 1),
            caseSensitive: caseSensitive.input.checked,
            removeStopwords: removeStopwords.input.checked,
          });
          status.textContent = "";
          resultsWrap.hidden = false;
          buildTable();
          renderRows();
          sortMi.hidden = currentN !== 2;
          sortT.hidden = currentN !== 2;
        }

        const sortBy = (compare) => () => { rows = [...rows].sort(compare); renderRows(); };
        const sortMi = button("Sort by MI", { onClick: sortBy((a, b) => (b.mi ?? -Infinity) - (a.mi ?? -Infinity)) });
        const sortT = button("Sort by t-score", { onClick: sortBy((a, b) => (b.tScore ?? -Infinity) - (a.tScore ?? -Infinity)) });
        sortMi.hidden = true;
        sortT.hidden = true;

        const copyButton = button("Copy CSV", {
          onClick: async () => {
            if (!rows.length) return;
            const ok = await copyText(csv());
            status.textContent = ok ? "" : "The browser would not give access to the clipboard.";
            if (ok) {
              copyButton.textContent = "Copied";
              setTimeout(() => { copyButton.textContent = "Copy CSV"; }, 1500);
            }
          },
        });

        filterInput.addEventListener("input", () => { if (rows.length) renderRows(); });

        resultsWrap.append(element("div", { className: "actions" }, [
          count,
          button("Sort by frequency", { onClick: sortBy((a, b) => b.count - a.count) }),
          sortMi,
          sortT,
          copyButton,
          button("Save CSV", { onClick: () => rows.length && downloadCsv(`ngrams-n${currentN}.csv`, csv()) }),
        ]));

        container.replaceChildren(
          element("div", { className: "actions" }, [
            field("N-gram size", nInput),
            field("Minimum frequency", minFreqInput),
            button("Analyse", { primary: true, onClick: analyse }),
          ]),
          element("div", { className: "actions" }, [caseSensitive.node, removeStopwords.node, filterInput]),
          status,
          resultsWrap,
        );

        status.textContent = documents.length
          ? `${documents.length} line(s) loaded. Choose a size and analyse.`
          : "No text loaded — choose an output folder.";
      },
    },
  };
}
