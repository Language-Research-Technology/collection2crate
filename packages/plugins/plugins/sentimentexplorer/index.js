// Sentiment Explorer: NRC word-emotion lexicon annotation, per section.
// The engine is kept separate from the panel so its counting is testable.
//
// The NRC lexicon is fetched from LADAL only after the user requests it; it is
// not redistributed with this repository because its data terms differ from
// the software licence.

import { buildCsvText, copyText, downloadCsv } from "../../src/_csv.js";
import {
  attributionFooter, button, checkbox, dataTable, element, field, flashLabel,
  note, resultsBar,
} from "../../src/_panel.js";

const TOKEN = /[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;
const MAX_RENDERED_ROWS = 2000;
const NRC_LEXICON_URL = "https://raw.githubusercontent.com/SLCLADAL/tools/main/sentimentexplorer/nrc_lexicon.csv";

export const NRC_CATEGORIES = [
  "anger", "anticipation", "disgust", "fear", "joy",
  "sadness", "surprise", "trust", "negative", "positive",
];

export function parseNrcLexiconCsv(csvText) {
  const parseRow = (line, lineNumber) => {
    const fields = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (quoted) {
        if (character === '"' && line[index + 1] === '"') { value += '"'; index++; }
        else if (character === '"') quoted = false;
        else value += character;
      } else if (character === '"' && value === "") quoted = true;
      else if (character === ",") { fields.push(value); value = ""; }
      else value += character;
    }
    if (quoted) throw new Error(`Unclosed quoted field on line ${lineNumber}.`);
    fields.push(value);
    return fields;
  };

  const lines = String(csvText || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error("The NRC lexicon file is empty.");
  const header = parseRow(lines[0], 1).map((field) => field.trim().toLowerCase());
  if (header[0] !== "word" || header[1] !== "sentiment") {
    throw new Error("The file must have the NRC CSV columns 'word' and 'sentiment'.");
  }

  const lexicon = new Map();
  const validCategories = new Set(NRC_CATEGORIES);
  for (const [index, line] of lines.slice(1).entries()) {
    const [rawWord, rawCategory] = parseRow(line, index + 2);
    const word = rawWord?.trim().toLocaleLowerCase();
    const category = rawCategory?.trim().toLocaleLowerCase();
    if (!word || !validCategories.has(category)) {
      throw new Error(`Invalid NRC word/category entry on line ${index + 2}.`);
    }
    if (!lexicon.has(word)) lexicon.set(word, new Set());
    lexicon.get(word).add(category);
  }
  if (!lexicon.size) throw new Error("The NRC lexicon file contains no entries.");
  return lexicon;
}

const CATEGORY_LABELS = {
  anger: "Anger", anticipation: "Anticipation", disgust: "Disgust", fear: "Fear",
  joy: "Joy", sadness: "Sadness", surprise: "Surprise", trust: "Trust",
  negative: "Negative", positive: "Positive",
};

const CATEGORY_COLOURS = {
  anger: "#c0392b", anticipation: "#e67e22", disgust: "#8e44ad", fear: "#2c3e50",
  joy: "#f1c40f", sadness: "#2980b9", surprise: "#1abc9c", trust: "#27ae60",
  negative: "#e74c3c", positive: "#2ecc71",
};

const SUMMARY_COLUMNS = ["section", "total_tokens", ...NRC_CATEGORIES.flatMap((c) => [`${c}_n`, `${c}_pct`])];
const TOKEN_COLUMNS = ["section", "token_index", "word", ...NRC_CATEGORIES];

const PARAMETER_LABELS = { file: "File", columns: "CSV columns", sections: "Sections", categories: "Categories" };

const NRC_CITATION =
  "Mohammad, S.M. & Turney, P.D. (2013). Crowdsourcing a Word-Emotion Association Lexicon. " +
  "Computational Intelligence, 29(3): 436-465. https://doi.org/10.1111/j.1467-8640.2012.00460.x";
const NRC_BIBTEX =
  "@article{mohammad13,\n" +
  "  author  = {Mohammad, Saif M. and Turney, Peter D.},\n" +
  "  title   = {Crowdsourcing a Word-Emotion Association Lexicon},\n" +
  "  journal = {Computational Intelligence},\n" +
  "  volume  = {29},\n" +
  "  number  = {3},\n" +
  "  pages   = {436--465},\n" +
  "  year    = {2013},\n" +
  "  doi     = {10.1111/j.1467-8640.2012.00460.x}\n" +
  "}";

// Unicode-aware words, lowercased unconditionally — the R app always
// lowercases before matching, and there is no case-sensitivity option here.
export function tokenize(text) {
  const tokens = String(text || "").match(TOKEN) || [];
  return tokens.map((token) => token.toLocaleLowerCase());
}

/**
 * Annotate one section's tokens against the NRC lexicon.
 *
 * @param {string[]} words
 * @param {string} sectionName
 * @param {Map<string, Set<string>>} lexicon word → the categories it belongs to
 * @returns {Array<{section, token_index, word, ...NRC_CATEGORIES}>}
 */
export function annotateSection(words, sectionName, lexicon) {
  return (words || []).map((word, index) => {
    const categories = lexicon?.get(word);
    const row = { section: sectionName, token_index: index + 1, word };
    for (const category of NRC_CATEGORIES) row[category] = categories?.has(category) ? 1 : 0;
    return row;
  });
}

/** One summary row per section: total tokens, and each category's count and percent. */
export function buildSummary(annotatedRows) {
  const order = [];
  const bySection = new Map();
  for (const row of annotatedRows || []) {
    if (!bySection.has(row.section)) { bySection.set(row.section, []); order.push(row.section); }
    bySection.get(row.section).push(row);
  }
  return order.map((section) => {
    const rows = bySection.get(section);
    const total = rows.length;
    const summary = { section, total_tokens: total };
    for (const category of NRC_CATEGORIES) {
      const n = rows.reduce((count, row) => count + row[category], 0);
      summary[`${category}_n`] = n;
      summary[`${category}_pct`] = total ? Math.round((n / total) * 1000) / 10 : 0;
    }
    return summary;
  });
}

/**
 * Group documents into sections, tokenise each section's combined text, and
 * annotate it. `sectionOf(document)` resolves a document to its section name;
 * documents resolving to the same name are merged (concatenated, in document
 * order) before tokenising — a token never crosses a section boundary.
 */
export function analyzeSentiment(documents, lexicon, { sectionOf = (doc) => doc.source || "" } = {}) {
  const order = [];
  const bySection = new Map();
  for (const document of documents || []) {
    const name = sectionOf(document) || "untitled";
    if (!bySection.has(name)) { bySection.set(name, []); order.push(name); }
    bySection.get(name).push(document);
  }
  const annotated = [];
  for (const name of order) {
    const text = bySection.get(name).map((document) => document.text || "").join(" ");
    // Not a spread push: a large corpus's token count can exceed the engine's
    // call-stack argument limit and throw "Maximum call stack size exceeded".
    for (const row of annotateSection(tokenize(text), name, lexicon)) annotated.push(row);
  }
  return { annotated, summary: buildSummary(annotated), sections: order };
}

/**
 * Build the analysis documents for one or more selected sources. `sources`
 * may be a single source string (back-compat), an array of sources, or
 * omitted/`null` for every loaded document; an explicit empty array means
 * nothing selected.
 *
 * `columns` picks which columns of a table source supply its text:
 *   - an array applies the same column names to every selected table
 *     (collocation's behavior, and this function's own back-compat form).
 *   - a `Map<source, string[]>` applies a different column list per source,
 *     so two files can each contribute a different named column.
 * Either way, a table with no explicit selection falls back to every column
 * in its own header.
 */
export function documentsForSelection(documents, tables, sources, columns = []) {
  if (sources == null) return documents || [];
  const list = Array.isArray(sources) ? sources : [sources];
  if (list.includes("__all__")) return documents || [];
  if (!list.length) return [];

  const columnsFor = (table) => {
    const chosen = columns instanceof Map ? columns.get(table.source) : columns;
    return chosen && chosen.length ? new Set(chosen) : new Set(table.header);
  };
  const result = [];
  for (const source of list) {
    const table = (tables || []).find((candidate) => candidate.source === source);
    if (!table) {
      result.push(...(documents || []).filter((document) => document.source === source));
      continue;
    }
    const useColumns = columnsFor(table);
    result.push(...table.rows.map((cells, index) => ({
      id: `${source}#${index}`,
      source,
      speaker: "",
      text: table.header
        .map((column, columnIndex) => useColumns.has(column) ? cells[columnIndex] || "" : "")
        .filter(Boolean)
        .join(" "),
    })).filter((document) => document.text.trim()));
  }
  return result;
}

// One clearly separated heading style for every top-level section of the
// panel (Chart, Summary, Tokens, Citation, Parameters), injected once.
function ensureStyle() {
  if (document.getElementById("sentimentexplorer-style")) return;
  const style = element("style", { attrs: { id: "sentimentexplorer-style" } });
  style.textContent = [
    ".sentiment-section-heading {",
    "  margin: 1.5rem 0 0.5rem;",
    "  padding-bottom: 0.25rem;",
    "  border-bottom: 2px solid var(--border);",
    "  font-size: 0.95rem;",
    "  font-weight: 700;",
    "  text-transform: uppercase;",
    "  letter-spacing: 0.04em;",
    "  color: var(--muted);",
    "}",
    ".sentiment-section-heading:first-child { margin-top: 0; }",
    ".sentiment-token-nav {",
    "  display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem;",
    "  margin-bottom: 0.75rem;",
    "}",
    ".sentiment-token-section-heading {",
    "  margin-top: 1.25rem; scroll-margin-top: 1rem;",
    "}",
    ".sentiment-token-table-scroll {",
    "  max-height: 50rem; overflow-y: auto; border: 1px solid var(--border);",
    "}",
  ].join("\n");
  document.head.append(style);
}

const sectionHeading = (text) => element("h3", { className: "sentiment-section-heading", text });

/** A filesystem/DOM-id-safe stub of a section name, for anchors and jump links. */
function slug(text) {
  return String(text || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
}

// Anchor ids are scoped to one panel instance so two open panels never clash.
let instanceCounter = 0;

const display = (value) => (typeof value === "number" ? value.toFixed(1) : String(value ?? ""));
const slugDate = () => new Date().toISOString().slice(0, 10);
const downloadText = (filename, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = element("a", { attrs: { href: url, download: filename } });
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
};

/** The NRC lexicon's citation, BibTeX and license note — read this before the token table. */
function buildCitation() {
  const blockquote = (text) => {
    const node = element("blockquote", { text });
    Object.assign(node.style, { borderLeft: "3px solid var(--border)", margin: "0.4rem 0", padding: "0.2rem 0 0.2rem 0.75rem", color: "var(--muted)" });
    return node;
  };
  return element("div", { className: "sentiment-citation" }, [
    element("h4", { className: "sentiment-section-heading", text: "NRC Word-Emotion Association Lexicon" }),
    element("p", { text: "This tool uses the NRC Word-Emotion Association Lexicon (EmoLex). Please cite it in any published work:" }),
    blockquote(NRC_CITATION),
    element("p", {}, [element("strong", { text: "BibTeX:" })]),
    element("pre", { className: "mono", text: NRC_BIBTEX }),
    element("p", {}, [
      element("strong", { text: "License note: " }),
      "The NRC lexicon is free for research and educational use. Commercial use requires " +
      "permission from Saif M. Mohammad (saif.mohammad@nrc-cnrc.gc.ca).",
    ]),
  ]);
}

/** Parameters as a labelled table for the panel, and the same labels as plain text for the download. */
function renderParameters(host, parameters) {
  const { body, node } = dataTable(["Parameter", "Value"]);
  for (const [key, label] of Object.entries(PARAMETER_LABELS)) {
    body.append(element("tr", {}, [element("td", { text: label }), element("td", { text: parameters[key] || "\u2014" })]));
  }
  host.replaceChildren(node);
}

const parameterText = (parameters) => Object.entries(PARAMETER_LABELS)
  .map(([key, label]) => `${label}: ${parameters[key] || ""}`).join("\n");

function renderChart(summary, categories) {
  const wrap = element("div", { className: "sentiment-chart" });
  const maxPct = summary.reduce((max, row) => categories.reduce((m, cat) => Math.max(m, row[`${cat}_pct`]), max), 1e-9);
  const columnHeader = element("div", { className: "sentiment-chart-row" }, [
    element("strong", { text: "Category" }),
    element("strong", { text: "% of tokens" }),
    element("strong", { text: "Count (%)" }),
  ]);
  Object.assign(columnHeader.style, {
    display: "grid", gridTemplateColumns: "minmax(8rem, 12rem) minmax(3rem, 1fr) 6rem",
    alignItems: "center", gap: "0.5rem", marginBlock: "0.5rem 0.25rem",
  });
  wrap.append(columnHeader);
  for (const row of summary) {
    const section = element("section", {}, [element("h3", { text: row.section })]);
    for (const category of categories) {
      const pct = row[`${category}_pct`];
      const n = row[`${category}_n`];
      const bar = element("span", {});
      Object.assign(bar.style, {
        display: "block", height: "1.25rem", borderRadius: "0.2rem",
        background: CATEGORY_COLOURS[category], width: `${Math.max(1, (pct / maxPct) * 100)}%`,
      });
      const chartRow = element("div", { className: "sentiment-chart-row" }, [
        element("span", { text: CATEGORY_LABELS[category] }), bar,
        element("span", { className: "mono", text: `${n} (${display(pct)}%)` }),
      ]);
      Object.assign(chartRow.style, {
        display: "grid", gridTemplateColumns: "minmax(8rem, 12rem) minmax(3rem, 1fr) 6rem",
        alignItems: "center", gap: "0.5rem", marginBlock: "0.25rem",
      });
      section.append(chartRow);
    }
    wrap.append(section);
  }
  return wrap;
}

export function createPlugin() {
  return {
    name: "sentimentexplorer",
    visualisation: {
      label: "Sentiment Explorer",
      hint: "Annotate text with the NRC word-emotion lexicon and summarise the result per section.",
      render(container, { documents = [], tables = [] }) {
        ensureStyle();
        const panelId = ++instanceCounter;
        let annotated = [];
        let summary = [];
        let parameters = null;
        let sectionInputs = new Map();

        // File selector: analyse every loaded source, or select a subset —
        // each selected source becomes its own section (below), and the CSV
        // columns field picks which columns supply the text for whichever
        // selected sources are tables (SPEC.md "File and column selection").
        // Multi-select, like the columns field, rather than one-file-at-a-time.
        const sourceOptions = [...new Set([
          ...(documents || []).map((document) => document.source),
          ...(tables || []).map((table) => table.source),
        ].filter(Boolean))].sort((left, right) => left.localeCompare(right));
        const sourceSelect = element("select", {
          attrs: { multiple: true, size: Math.min(8, Math.max(3, sourceOptions.length)), "aria-label": "Files" },
        });
        // Every loaded file is a section by default — the multi-select narrows
        // that down rather than starting from nothing selected.
        sourceSelect.append(...sourceOptions.map((source) => element("option", { text: source, attrs: { value: source } })));
        [...sourceSelect.options].forEach((option) => { option.selected = true; });
        // One column multi-select per selected table source, not one shared
        // list — a different file can contribute a different named column.
        const columnsHost = element("div", { className: "actions" });
        let columnSelects = new Map();

        const categoryChecks = NRC_CATEGORIES.map((category) => checkbox(CATEGORY_LABELS[category], { checked: true }));

        const status = element("p", { className: "field-hint" });
        const resultsWrap = element("div", { attrs: { hidden: true } });
        const chart = element("div");
        const summaryHost = element("div");
        const tokenHost = element("div");
        const sectionsHost = element("div", { className: "actions" });
        const filter = element("input", { attrs: { type: "search", placeholder: "Filter tokens…", "aria-label": "Filter tokens" } });
        const count = element("span", { className: "field-hint" });
        const parametersHost = element("div");
        const citation = buildCitation();
        let lexicon = null;
        const lexiconError = note("The NRC lexicon could not be downloaded. Check your connection and try again.");
        lexiconError.hidden = true;
        const lexiconSourceLink = element("a", {
          text: "LADAL's NRC lexicon CSV",
          attrs: { href: NRC_LEXICON_URL, target: "_blank", rel: "noopener noreferrer" },
        });
        const lexiconDoiLink = element("a", {
          text: "10.1111/j.1467-8640.2012.00460.x",
          attrs: { href: "https://doi.org/10.1111/j.1467-8640.2012.00460.x", target: "_blank", rel: "noopener noreferrer" },
        });
        const lexiconInfo = element("p", { className: "field-hint" }, [
          "The NRC data has licensing terms separate from this software, so it is not bundled here. " +
          "Click the button to load the data from ", lexiconSourceLink,
          " into this browser session. It will not be saved to your computer or bundled with the tool. " +
          "The lexicon was created by Saif M. Mohammad; see the publication DOI ", lexiconDoiLink, ". " +
          "The lexicon is free for research and educational use; " +
          "commercial use requires permission from its author.",
        ]);

        // Always visible, unlike the results below: a person landing on this
        // panel with no prior context needs to be told what the Files list is
        // for and that renaming Sections is how files get grouped together.
        const introHeading = element("h2", { text: "NRC Emotion & Sentiment by Section" });
        const introText = note(
          "Select one or more loaded files below (every file is selected by default). " +
          "If a selected file is a table (CSV/TSV), choose which of its columns supply the text " +
          "for that file. Each selected file becomes its own section under \u201cSections\u201d \u2014 " +
          "rename a section there, or give two or more sections the same name to merge them into " +
          "one before analysing. Then press Analyse."
        );

        const selectedSources = () => [...sourceSelect.selectedOptions].map((option) => option.value);
        const selectedColumnsMap = () => {
          const map = new Map();
          for (const [source, columnSelect] of columnSelects) map.set(source, [...columnSelect.selectedOptions].map((option) => option.value));
          return map;
        };
        const workingDocuments = () => documentsForSelection(documents, tables, selectedSources(), selectedColumnsMap());

        // Rebuilt on every source change: one select per selected table source,
        // each defaulting to its own `text` column when it has one, else every
        // column of that table. `documentsForSelection` reads each independently.
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
            [...columnSelect.options].forEach((option, index) => {
              option.selected = textColumn >= 0 ? index === textColumn : true;
            });
            columnSelect.addEventListener("change", rebuildSections);
            columnSelects.set(table.source, columnSelect);
            columnsHost.append(field(table.source, columnSelect));
          }
          columnsHost.hidden = false;
        }

        // Selecting a file or its columns changes the working document set, so
        // any earlier analysis no longer describes it — clear it rather than
        // leaving stale results next to a new section list.
        function rebuildSections() {
          const working = workingDocuments();
          const workingSources = [...new Set(working.map((document) => document.source).filter(Boolean))]
            .sort((left, right) => left.localeCompare(right));
          sectionInputs = new Map(workingSources.map((source) => [
            source,
            element("input", { attrs: { type: "text", value: source, "aria-label": `Section name for ${source}` } }),
          ]));
          sectionsHost.replaceChildren(
            element("strong", { text: "Sections" }),
            ...workingSources.map((source) => field(source, sectionInputs.get(source))),
          );
          annotated = []; summary = []; parameters = null;
          resultsWrap.hidden = true;
          lexiconError.hidden = true;
          status.textContent = working.length ? `${working.length} text item(s) loaded.` : "No text loaded for the selected file.";
        }

        const sectionOf = (document) => (sectionInputs.get(document.source)?.value || "").trim() || document.source || "untitled";
        const visibleCategories = () => NRC_CATEGORIES.filter((category, index) => categoryChecks[index].input.checked);

        const summaryCsv = () => buildCsvText(SUMMARY_COLUMNS, summary.map((row) => SUMMARY_COLUMNS.map((c) => row[c])));
        const tokenCsv = () => buildCsvText(TOKEN_COLUMNS, annotated.map((row) => TOKEN_COLUMNS.map((c) => row[c])));

        function renderSummaryTable(categories) {
          const headers = ["Section", "Total tokens", ...categories.flatMap((c) => [`${CATEGORY_LABELS[c]} (n)`, `${CATEGORY_LABELS[c]} (%)`])];
          const { body, node } = dataTable(headers);
          for (const row of summary) {
            body.append(element("tr", {}, [
              element("td", { text: row.section }),
              element("td", { text: String(row.total_tokens) }),
              ...categories.flatMap((c) => [
                element("td", { text: String(row[`${c}_n`]) }),
                element("td", { text: `${display(row[`${c}_pct`])}%` }),
              ]),
            ]));
          }
          summaryHost.replaceChildren(node);
        }

        function renderTokenTable(categories) {
          const headers = ["Section", "Token #", "Word", ...categories.map((c) => CATEGORY_LABELS[c])];
          const query = filter.value.trim().toLocaleLowerCase();
          const matches = query
            ? annotated.filter((row) => row.word.includes(query) || row.section.toLocaleLowerCase().includes(query))
            : annotated;
          const shown = matches.slice(0, MAX_RENDERED_ROWS);

          // One table per section rather than one long table: a corpus of any
          // size then scrolls as a handful of anchored, jump-to sections
          // instead of one table a person has to hunt through by hand.
          const order = [];
          const bySection = new Map();
          for (const row of shown) {
            if (!bySection.has(row.section)) { bySection.set(row.section, []); order.push(row.section); }
            bySection.get(row.section).push(row);
          }
          const anchorId = (section) => `sentiment-tokens-${panelId}-${slug(section)}`;

          const nav = order.length > 1 ? element("nav", { className: "sentiment-token-nav" }, [
            element("span", { className: "field-hint", text: "Jump to section:" }),
            ...order.map((section) => button(`${section} (${bySection.get(section).length})`, {
              onClick: () => document.getElementById(anchorId(section))?.scrollIntoView({ behavior: "smooth", block: "start" }),
            })),
          ]) : null;

          const groups = order.map((section, index) => {
            const { body, node } = dataTable(headers);
            for (const row of bySection.get(section)) {
              body.append(element("tr", {}, [
                element("td", { text: row.section }),
                element("td", { text: String(row.token_index) }),
                element("td", { text: row.word, className: "mono" }),
                ...categories.map((c) => element("td", { text: row[c] ? "yes" : "" })),
              ]));
            }
            // Capped and scrollable so a large section's table stays put in
            // its own space rather than pushing the rest of the panel down.
            node.classList.add("sentiment-token-table-scroll");
            const heading = element("h4", {
              className: "sentiment-section-heading sentiment-token-section-heading",
              text: `${section} (${bySection.get(section).length})`,
              attrs: { id: anchorId(section) },
            });
            // Proceeding past a long table is the point: straight on to the
            // next section without a long manual scroll.
            const footerActions = [];
            if (index < order.length - 1) {
              const next = order[index + 1];
              footerActions.push(button(`Next section: ${next} \u2193`, {
                onClick: () => document.getElementById(anchorId(next))?.scrollIntoView({ behavior: "smooth", block: "start" }),
              }));
            }
            return element("div", {}, [heading, node, ...(footerActions.length ? [element("div", { className: "actions" }, footerActions)] : [])]);
          });

          tokenHost.replaceChildren(...(nav ? [nav] : []), ...groups);
          count.textContent = matches.length > shown.length
            ? `${matches.length} token(s) (showing the first ${shown.length})`
            : `${matches.length} token(s)`;
        }

        function renderAll() {
          const categories = visibleCategories();
          chart.replaceChildren(renderChart(summary, categories));
          renderSummaryTable(categories);
          renderTokenTable(categories);
        }

        async function loadLexicon() {
          loadLexiconButton.disabled = true;
          status.textContent = "Loading the NRC lexicon from LADAL…";
          lexiconError.hidden = true;
          try {
            const response = await fetch(NRC_LEXICON_URL);
            if (!response.ok) throw new Error(`Download failed (${response.status}).`);
            const csv = await response.text();
            lexicon = parseNrcLexiconCsv(csv);
            analyseButton.disabled = false;
            status.textContent = "NRC lexicon loaded and ready for this browser session.";
          } catch (error) {
            lexicon = null;
            analyseButton.disabled = true;
            status.textContent = "The NRC lexicon could not be loaded.";
            lexiconError.hidden = false;
          } finally {
            loadLexiconButton.disabled = false;
          }
        }

        const loadLexiconButton = button("Load NRC lexicon", { primary: true, onClick: loadLexicon });
        const analyseButton = button("Analyse", { primary: true, onClick: analyse });
        analyseButton.disabled = true;
        const workflowArrow = element("span", {
          text: "\u2192",
          attrs: { title: "Load the NRC lexicon before analysing", "aria-label": "then" },
        });

        async function analyse() {
          const working = workingDocuments();
          if (!working.length) { status.textContent = "No text loaded for the selected file."; return; }
          if (!lexicon) return;
          lexiconError.hidden = true;
          const result = analyzeSentiment(working, lexicon, { sectionOf });
          annotated = result.annotated;
          summary = result.summary;
          parameters = {
            file: selectedSources().length === sourceOptions.length ? "All files" : selectedSources().join(", "),
            columns: [...columnSelects.entries()]
              .map(([source, columnSelect]) => `${source}: ${[...columnSelect.selectedOptions].map((option) => option.value).join("/")}`)
              .join("; "),
            sections: [...sectionInputs.keys()].map((source) => `${source} \u2192 ${sectionOf({ source })}`).join("; "),
            categories: visibleCategories().map((c) => CATEGORY_LABELS[c]).join(", "),
          };
          renderParameters(parametersHost, parameters);
          resultsWrap.hidden = false;
          status.textContent = annotated.length ? "" : "No tokens were found in the selected documents.";
          renderAll();
        }

        sourceSelect.addEventListener("change", () => { updateColumns(); rebuildSections(); });
        categoryChecks.forEach(({ input }) => input.addEventListener("change", () => { if (summary.length) renderAll(); }));
        filter.addEventListener("input", () => { if (annotated.length) renderTokenTable(visibleCategories()); });

        const copySummary = button("Copy summary CSV", {
          onClick: async () => { if (summary.length && await copyText(summaryCsv())) flashLabel(copySummary, "Copied"); },
        });
        const copyTokens = button("Copy token CSV", {
          onClick: async () => { if (annotated.length && await copyText(tokenCsv())) flashLabel(copyTokens, "Copied"); },
        });

        resultsWrap.append(
          sectionHeading("Chart"),
          element("p", { className: "field-hint", text: "Percentage of tokens matching each category \u00b7 bar labels show count and %" }),
          chart,
          sectionHeading("Summary"),
          resultsBar("", [
            copySummary,
            button("Save summary CSV", { onClick: () => summary.length && downloadCsv(`sentiment-summary-${slugDate()}.csv`, summaryCsv()) }),
          ]),
          summaryHost,
          sectionHeading("Tokens"),
          resultsBar("", [
            count, filter, copyTokens,
            button("Save token CSV", { onClick: () => annotated.length && downloadCsv(`sentiment-tokens-${slugDate()}.csv`, tokenCsv()) }),
            button("Save parameters", { onClick: () => parameters && downloadText(`sentimentexplorer-parameters-${slugDate()}.txt`, parameterText(parameters)) }),
          ]),
          tokenHost,
          sectionHeading("Citation"), citation,
          sectionHeading("Parameters"), parametersHost,
        );

        container.replaceChildren(
          introHeading,
          introText,
          element("div", { className: "actions" }, [field("Files", sourceSelect)]),
          columnsHost,
          sectionsHost,
          element("div", { className: "actions" }, categoryChecks.map((c) => c.node)),
          lexiconInfo,
          element("div", { className: "actions" }, [loadLexiconButton, workflowArrow, analyseButton]),
          lexiconError,
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
        updateColumns();
        rebuildSections();
      },
    },
  };
}
