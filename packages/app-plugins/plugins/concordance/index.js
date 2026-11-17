// Concordance (KWIC — keyword in context): every occurrence of a search term
// across the loaded documents, with a few words either side. Follows the LADAL
// concordancing tutorial (https://ladal.edu.au/tutorials/concordancing/).
//
// A visualisation panel, not a build plugin: it taps no hook, runs during no
// build, and does nothing until someone types in it (SPEC-PLUGINS.md).

import { buildCsvText, copyText, downloadCsv } from "../../src/_csv.js";
import {
  attributionFooter, button, checkbox, dataTable, element, field, note, select,
} from "../../src/_panel.js";

// Rendering every row of a corpus-wide match set locks the page up for no
// benefit — nobody reads row 4000. Exports carry everything.
const MAX_RENDERED_ROWS = 2000;
const SEARCH_CHUNK_SIZE = 10;

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function globToRegex(value) {
  return Array.from(value, (character) => {
    if (character === "*") return "[\\s\\S]*";
    if (character === "?") return "[\\s\\S]";
    return escapeRegExp(character);
  }).join("");
}

/** A filesystem-safe stub of the query, for the saved file's name. */
function slugify(value) {
  const slug = String(value || "").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 40) || "query";
}

function buildMatcher(query, options) {
  const matchType = options.matchType || (options.regex ? "regex" : "fixed");
  let pattern;
  if (matchType === "regex") pattern = query;
  else if (matchType === "glob") pattern = globToRegex(query);
  else if (matchType === "fixed") pattern = escapeRegExp(query);
  else throw new RangeError(`Unknown match type: ${matchType}`);
  if (matchType === "fixed" && options.wholeWord) pattern = `\\b${pattern}\\b`;
  return new RegExp(pattern, options.caseSensitive ? "g" : "gi");
}

// Slice the raw text either side of the match and trim to whole words, rather
// than tokenising every document up front: the same window, a fraction of the
// work, and the keyword survives exactly as it was written.
function contextWords(text, count, fromEnd) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return (fromEnd ? words.slice(-count) : words.slice(0, count)).join(" ");
}

/**
 * Every match of `query` across `documents`, in document order.
 *
 * @param {Array<{source: string, speaker?: string, text: string}>} documents
 * @param {string} query
 * @param {{matchType?: "fixed"|"glob"|"regex", regex?: boolean, wholeWord?: boolean, caseSensitive?: boolean, windowSize?: number}} options
 * @returns {Array<{source, speaker, left, keyword, right}>}
 */
export function search(documents, query, options = {}) {
  const windowSize = options.windowSize || 5;
  const matcher = buildMatcher(query, options);
  const results = [];
  for (const doc of documents || []) {
    matcher.lastIndex = 0;
    let match;
    while ((match = matcher.exec(doc.text || ""))) {
      // A pattern that can match nothing ("x*") would otherwise never advance.
      if (match[0] === "") { matcher.lastIndex++; continue; }
      results.push({
        source: doc.source,
        speaker: doc.speaker || "",
        left: contextWords(doc.text.slice(0, match.index), windowSize, true),
        keyword: match[0],
        right: contextWords(doc.text.slice(match.index + match[0].length), windowSize, false),
      });
    }
  }
  return results;
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    const continueWork = () => setTimeout(resolve, 0);
    if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(continueWork);
    else continueWork();
  });
}

/** Search in document chunks so the panel can paint progress and stay responsive. */
export async function searchAsync(documents, query, options = {}, onProgress) {
  const corpus = documents || [];
  const results = [];
  await yieldToBrowser();
  for (let start = 0; start < corpus.length; start += SEARCH_CHUNK_SIZE) {
    for (const row of search(corpus.slice(start, start + SEARCH_CHUNK_SIZE), query, options)) results.push(row);
    onProgress?.(Math.min(1, (start + SEARCH_CHUNK_SIZE) / corpus.length));
    if (start + SEARCH_CHUNK_SIZE < corpus.length) await yieldToBrowser();
  }
  return results;
}

/** Select documents from one source, using selected columns for CSV/TSV files. */
export function documentsForSelection(documents, tables, source, columns = []) {
  if (!source || source === "__all__") return documents || [];
  const table = (tables || []).find((candidate) => candidate.source === source);
  if (!table) return (documents || []).filter((document) => document.source === source);

  const selected = columns.length ? new Set(columns) : new Set(table.header);
  return table.rows.map((cells, index) => ({
    id: `${source}#${index}`,
    source,
    speaker: "",
    text: table.header
      .map((column, columnIndex) => selected.has(column) ? cells[columnIndex] || "" : "")
      .filter(Boolean)
      .join(" "),
  })).filter((document) => document.text.trim());
}

const COLUMNS = ["source", "speaker", "left", "keyword", "right"];

export function createPlugin() {
  return {
    name: "concordance",
    visualisation: {
      label: "Wordfinder",
      hint: "Search for a word or phrase and see every occurrence in context.",
      render(container, { documents = [], tables = [] }) {
        let results = [];
        let query = "";
        let searchInProgress = false;

        const sources = [...new Set([
          ...(documents || []).map((document) => document.source),
          ...(tables || []).map((table) => table.source),
        ].filter(Boolean))].sort((left, right) => left.localeCompare(right));
        const sourceSelect = select([
          { value: "__all__", label: "All files" },
          ...sources.map((source) => ({ value: source, label: source })),
        ], { value: "__all__" });
        const columnSelect = element("select", { attrs: { multiple: true, size: 4, "aria-label": "CSV columns" } });
        const columnField = field("CSV columns", columnSelect);

        const queryInput = element("input", {
          attrs: { type: "search", placeholder: "Word or phrase…", "aria-label": "Search term" },
        });
        const caseSensitive = checkbox("Case sensitive");
        const matchType = select([
          { label: "Fixed (exact)", value: "fixed" },
          { label: "Glob (wildcard)", value: "glob" },
          { label: "Regex", value: "regex" },
        ], { value: "fixed" });
        const windowInput = element("input", {
          attrs: { type: "range", min: 1, max: 15, step: 1, value: 5, "aria-label": "Context window (words each side)" },
        });
        const windowValue = element("output", { text: "5" });
        const status = element("p", { className: "field-hint" });
        const spinner = element("span", {
          className: "wordfinder-spinner",
          attrs: { role: "status", "aria-label": "Searching" },
        });
        spinner.hidden = true;
        const searchButton = button("Search", { primary: true, onClick: runSearch });
        const count = element("span", { className: "field-hint" });
        // Left context is right-aligned so it runs up against the keyword: a
        // concordance is read down the column of what precedes the word, and
        // ragged-left text hides exactly the thing being compared.
        const { body, node: table } = dataTable([
          "Source", "Speaker",
          { label: "Left context", className: "kwic-left" },
          { label: "Keyword", className: "kwic-keyword" },
          "Right context",
        ]);
        const resultsWrap = element("div", { attrs: { hidden: true } });

        function selectedColumns() {
          return [...columnSelect.selectedOptions].map((option) => option.value);
        }

        function updateColumns() {
          const selectedTable = tables.find((candidate) => candidate.source === sourceSelect.value);
          columnSelect.replaceChildren();
          if (!selectedTable) {
            columnField.hidden = true;
            return;
          }
          columnSelect.append(...selectedTable.header.map((column) => element("option", {
            text: column,
            attrs: { value: column },
          })));
          const textColumn = selectedTable.header.findIndex((column) => column.trim().toLowerCase() === "text");
          [...columnSelect.options].forEach((option, index) => {
            option.selected = textColumn >= 0 ? index === textColumn : true;
          });
          columnField.hidden = false;
        }

        const csv = () => buildCsvText(COLUMNS, results.map((r) => COLUMNS.map((c) => r[c])));

        function renderRows() {
          body.replaceChildren();
          const shown = results.slice(0, MAX_RENDERED_ROWS);
          for (const row of shown) {
            body.append(element("tr", {}, [
              element("td", { text: row.source, attrs: { title: row.source } }),
              element("td", { text: row.speaker }),
              element("td", { text: row.left, className: "kwic-left" }),
              element("td", { text: row.keyword, className: "kwic-keyword" }),
              element("td", { text: row.right }),
            ]));
          }
          count.textContent = results.length > shown.length
            ? `${results.length} matches (showing the first ${shown.length})`
            : `${results.length} match${results.length === 1 ? "" : "es"}`;
        }

        async function runSearch() {
          if (searchInProgress) return;
          query = queryInput.value.trim();
          if (!query) { status.textContent = "Enter a word or phrase to search for."; return; }
          const selectedDocuments = documentsForSelection(documents, tables, sourceSelect.value, selectedColumns());
          if (!selectedDocuments.length) { status.textContent = "No text loaded for the selected file."; return; }
          searchInProgress = true;
          searchButton.disabled = true;
          queryInput.disabled = true;
          sourceSelect.disabled = true;
          columnSelect.disabled = true;
          spinner.hidden = false;
          status.textContent = "Searching loaded text... 0%";
          try {
            const found = await searchAsync(selectedDocuments, query, {
              matchType: matchType.value,
              caseSensitive: caseSensitive.input.checked,
              windowSize: Math.min(15, Math.max(1, parseInt(windowInput.value, 10) || 5)),
            }, (progress) => { status.textContent = `Searching loaded text... ${Math.round(progress * 100)}%`; });
            results = found;
            status.textContent = "";
            resultsWrap.hidden = false;
            renderRows();
          } catch (e) {
            // An invalid regex is the person's typing, not a failure: say what
            // the engine said and leave the last good results on screen.
            status.textContent = `Invalid pattern: ${e.message}`;
          } finally {
            searchInProgress = false;
            searchButton.disabled = false;
            queryInput.disabled = false;
            sourceSelect.disabled = false;
            columnSelect.disabled = false;
            spinner.hidden = true;
          }
        }

        const sortBy = (key) => () => {
          results = [...results].sort((a, b) => a[key].localeCompare(b[key]));
          renderRows();
        };
        const copyButton = button("Copy CSV", {
          onClick: async () => {
            if (!results.length) return;
            const ok = await copyText(csv());
            status.textContent = ok ? "" : "The browser would not give access to the clipboard.";
            if (ok) {
              const label = copyButton.textContent;
              copyButton.textContent = "Copied";
              setTimeout(() => { copyButton.textContent = label; }, 1500);
            }
          },
        });

        queryInput.addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });
        windowInput.addEventListener("input", () => { windowValue.value = windowInput.value; windowValue.textContent = windowInput.value; });

        resultsWrap.append(
          element("h2", { text: "Concordance Lines" }),
          element("div", { className: "actions" }, [
            count,
            button("Sort by left context", { onClick: sortBy("left") }),
            button("Sort by right context", { onClick: sortBy("right") }),
            copyButton,
            button("Save CSV", {
              onClick: () => results.length && downloadCsv(`wordfinder-${slugify(query)}.csv`, csv()),
            }),
          ]),
          element("div", { className: "concordance-results-scroll" }, [table]),
        );
        const resultsScroll = resultsWrap.querySelector(".concordance-results-scroll");
        Object.assign(resultsScroll.style, { maxHeight: "50rem", overflow: "auto" });

        container.replaceChildren(
          element("h2", { text: "Wordfinder" }),
          note("Search for a word or phrase and see every occurrence in context."),
          element("div", { className: "actions" }, [field("File", sourceSelect), columnField]),
          element("h3", { text: "Search" }),
          element("div", { className: "actions" }, [
            field("Search term or pattern", queryInput),
            searchButton,
            spinner,
          ]),
          element("p", { className: "field-hint" }, [
            element("strong", { text: "Examples: " }),
            element("code", { text: "climate" }),
            element("span", { text: " · " }),
            element("code", { text: "the economy" }),
            element("span", { text: " · " }),
            element("code", { text: "wom[ae]n" }),
            element("span", { text: " (regex)" }),
          ]),
          element("div", { className: "actions" }, [
            field("Match type", matchType),
            caseSensitive.node,
          ]),
          element("div", { className: "actions" }, [
            field("Context window (words each side)", windowInput),
            windowValue,
          ]),
          status,
          resultsWrap,
          attributionFooter({
            logo: "https://ladal.edu.au/images/ladal_icon_white.png",
            logoAlt: "",
            logoBackground: "#51247a",
            href: "https://ladal.edu.au",
            text: "Language Technology and Data Analysis Laboratory",
            comment: "Developed with permission from LADAL.",
          }),
        );

        const spinnerStyle = element("style");
        spinnerStyle.textContent = [
          ".wordfinder-spinner {",
          "  display: inline-block; width: 1rem; height: 1rem;",
          "  border: 2px solid var(--border); border-top-color: var(--accent, #51247a);",
          "  border-radius: 50%; vertical-align: middle; animation: wordfinder-spin 0.7s linear infinite;",
          "}",
          ".wordfinder-spinner[hidden] { display: none; }",
          "@keyframes wordfinder-spin { to { transform: rotate(360deg); } }",
        ].join("\n");
        document.head.append(spinnerStyle);

        sourceSelect.addEventListener("change", updateColumns);
        updateColumns();
        status.textContent = documents.length
          ? `${documents.length} text item(s) loaded. Enter a word or phrase to search for.`
          : "No text loaded — choose an output folder.";
      },
    },
  };
}
