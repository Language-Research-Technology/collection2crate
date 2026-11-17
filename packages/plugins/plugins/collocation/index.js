// Collocation analysis: association measures for words in a node window.
// The engine is kept separate from the panel so its statistics can be tested.

import { buildCsvText, copyText, downloadCsv } from "../../src/_csv.js";
import {
  attributionFooter, button, checkbox, dataTable, element, field, flashLabel, numberInput,
  note, resultsBar, select,
} from "../../src/_panel.js";

const TOKEN = /[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;
const RESULT_COLUMNS = [
  "node", "collocate", "O", "E", "f_node", "f_collocate", "N", "OE", "MI", "MI2", "MI3",
  "G2", "tscore", "DeltaP12", "DeltaP21", "Fisher",
];
const MEASURES = [
  ["OE", "Observed / expected frequency"],
  ["MI", "Mutual information: log2(O / E)"],
  ["MI2", "MI2: log2(O^2 / E)"],
  ["MI3", "MI3: log2(O^3 / E)"],
  ["G2", "Log-likelihood ratio (G2)"],
  ["tscore", "t-score: (O - E) / sqrt(O)"],
  ["DeltaP12", "P(collocate | node) - P(collocate | not node)"],
  ["DeltaP21", "P(node | collocate) - P(node | not collocate)"],
  ["Fisher", "Two-tailed Fisher exact-test p-value"],
];
const MEASURE_IDS = new Set(MEASURES.map(([id]) => id));
const log2 = (value) => Math.log(value) / Math.LN2;

export function tokenize(text, ignoreCase = true) {
  const tokens = String(text || "").match(TOKEN) || [];
  return ignoreCase ? tokens.map((token) => token.toLocaleLowerCase()) : tokens;
}

export function parseNodes(raw, ignoreCase = true) {
  const values = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const seen = new Set();
  return values.map((value) => String(value).trim())
    .filter(Boolean)
    .map((value) => ignoreCase ? value.toLocaleLowerCase() : value)
    .filter((value) => !seen.has(value) && seen.add(value));
}

/** Build the analysis documents for one source and, for tables, its columns. */
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

// Lanczos log-gamma is enough for exact Fisher probabilities without adding a
// statistics dependency to a browser panel.
function logGamma(value) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let sum = 0.9999999999998099;
  const shifted = value - 1;
  for (let i = 0; i < coefficients.length; i++) sum += coefficients[i] / (shifted + i + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

const logChoose = (n, k) => (k < 0 || k > n ? -Infinity : logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1));
const normalCdf = (value) => {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
};

/** Exact for tables <= 2000; normal hypergeometric approximation above that. */
export function fisherExact(a, b, c, d) {
  const total = a + b + c + d;
  const rowOne = a + b;
  const colOne = a + c;
  if (total > 2000) {
    const mean = (rowOne * colOne) / total;
    const variance = rowOne * colOne * (total - rowOne) * (total - colOne)
      / (total * total * Math.max(total - 1, 1));
    if (!variance) return a === mean ? 1 : 0;
    const z = (Math.abs(a - mean) - 0.5) / Math.sqrt(variance);
    return Math.min(1, Math.max(0, 2 * (1 - normalCdf(z))));
  }
  const min = Math.max(0, rowOne - (total - colOne));
  const max = Math.min(rowOne, colOne);
  const observedLog = logChoose(rowOne, a) + logChoose(total - rowOne, colOne - a) - logChoose(total, colOne);
  let probability = 0;
  for (let x = min; x <= max; x++) {
    const logProbability = logChoose(rowOne, x)
      + logChoose(total - rowOne, colOne - x) - logChoose(total, colOne);
    if (logProbability <= observedLog + 1e-12) probability += Math.exp(logProbability);
  }
  return Math.min(1, probability);
}

function safeMeasure(value) {
  return Number.isFinite(value) ? value : null;
}

function g2(a, b, c, d) {
  const total = a + b + c + d;
  const rowOne = a + b;
  const rowTwo = c + d;
  const colOne = a + c;
  const colTwo = b + d;
  const cells = [[a, rowOne * colOne / total], [b, rowOne * colTwo / total],
    [c, rowTwo * colOne / total], [d, rowTwo * colTwo / total]];
  return safeMeasure(2 * cells.reduce((sum, [observed, expected]) => (
    observed === 0 || expected === 0 ? sum : sum + observed * Math.log(observed / expected)
  ), 0));
}

function numericOption(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

/** Calculate all collocation rows for one concatenated corpus. */
export function analyzeCollocations(documents, options = {}) {
  const ignoreCase = options.ignoreCase !== false;
  const tokens = (documents || []).flatMap((document) => tokenize(document?.text, ignoreCase));
  const nodes = parseNodes(options.nodes, ignoreCase);
  const spanLeft = numericOption(options.spanLeft, 5, 1, 20);
  const spanRight = numericOption(options.spanRight, 5, 1, 20);
  const minFreq = numericOption(options.minFreq, 2, 1, Number.MAX_SAFE_INTEGER);
  const total = tokens.length;
  if (!total || !nodes.length) return [];

  const frequencies = new Map();
  tokens.forEach((token) => frequencies.set(token, (frequencies.get(token) || 0) + 1));
  const rows = [];
  for (const node of nodes) {
    const nodeFrequency = frequencies.get(node) || 0;
    if (!nodeFrequency) continue;
    const cooccurrences = new Map();
    for (let position = 0; position < tokens.length; position++) {
      if (tokens[position] !== node) continue;
      const start = Math.max(0, position - spanLeft);
      const end = Math.min(total - 1, position + spanRight);
      for (let index = start; index <= end; index++) {
        if (index === position) continue;
        const collocate = tokens[index];
        cooccurrences.set(collocate, (cooccurrences.get(collocate) || 0) + 1);
      }
    }
    for (const [collocate, observed] of cooccurrences) {
      if (observed < minFreq) continue;
      const collocateFrequency = frequencies.get(collocate);
      const expected = (nodeFrequency * collocateFrequency) / total;
      const a = observed;
      const b = Math.max(nodeFrequency - observed, 0);
      const c = Math.max(collocateFrequency - observed, 0);
      const d = Math.max(total - nodeFrequency - collocateFrequency + observed, 0);
      rows.push({
        node, collocate, O: observed, E: expected, f_node: nodeFrequency,
        f_collocate: collocateFrequency, N: total,
        OE: safeMeasure(observed / expected),
        MI: safeMeasure(log2(observed / expected)),
        MI2: safeMeasure(log2((observed ** 2) / expected)),
        MI3: safeMeasure(log2((observed ** 3) / expected)),
        G2: g2(a, b, c, d),
        tscore: safeMeasure((observed - expected) / Math.sqrt(observed)),
        DeltaP12: safeMeasure(observed / nodeFrequency - c / Math.max(total - nodeFrequency, 1)),
        DeltaP21: safeMeasure(observed / collocateFrequency - b / Math.max(total - collocateFrequency, 1)),
        Fisher: safeMeasure(fisherExact(a, b, c, d)),
      });
    }
  }
  return rows;
}

const display = (value) => typeof value === "number" ? value.toFixed(4) : "";
const rowValues = (row) => RESULT_COLUMNS.map((column) => (
  ["E", "OE", "MI", "MI2", "MI3", "G2", "tscore", "DeltaP12", "DeltaP21", "Fisher"].includes(column)
    ? display(row[column]) : row[column]
));
const slugDate = () => new Date().toISOString().slice(0, 10);
const downloadText = (filename, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = element("a", { attrs: { href: url, download: filename } });
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
};

function sortedRows(rows, measure) {
  return [...rows].sort((left, right) => {
    if (measure === "collocate" || measure === "node") return String(left[measure]).localeCompare(String(right[measure]));
    return (right[measure] ?? -Infinity) - (left[measure] ?? -Infinity);
  });
}

function renderChart(rows, measure, topN, context) {
  const wrap = element("div", { className: "collocation-chart" });
  const columnHeader = element("div", { className: "collocation-chart-row" }, [
    element("strong", { text: "Collocate" }),
    element("strong", { text: "Association strength" }),
    element("strong", { text: measure }),
  ]);
  columnHeader.style.display = "grid";
  columnHeader.style.gridTemplateColumns = "minmax(8rem, 16rem) minmax(3rem, 1fr) 5rem";
  columnHeader.style.alignItems = "center";
  columnHeader.style.gap = "0.5rem";
  columnHeader.style.marginBlock = "0.5rem 0.25rem";
  wrap.append(columnHeader);
  for (const node of [...new Set(rows.map((row) => row.node))]) {
    const nodeRows = sortedRows(rows.filter((row) => row.node === node && row[measure] !== null), measure).slice(0, topN);
    if (!nodeRows.length) continue;
    const values = nodeRows.map((row) => Math.abs(row[measure]));
    const maximum = Math.max(...values, 1e-12);
    const section = element("section", {}, [element("h3", { text: node })]);
    for (const row of nodeRows) {
      const bar = element("span", { className: "collocation-bar" });
      bar.style.width = `${Math.max(1, Math.abs(row[measure]) / maximum * 100)}%`;
      bar.style.display = "block";
      bar.style.height = "1.25rem";
      bar.style.background = "var(--accent, #51247a)";
      bar.style.borderRadius = "0.2rem";
      bar.title = `${row.collocate}: ${display(row[measure])}`;
      const chartRow = element("div", { className: "collocation-chart-row" }, [
        element("span", { className: "mono", text: row.collocate }), bar,
        element("span", { className: "mono", text: display(row[measure]) }),
      ]);
      chartRow.style.display = "grid";
      chartRow.style.gridTemplateColumns = "minmax(8rem, 16rem) minmax(3rem, 1fr) 5rem";
      chartRow.style.alignItems = "center";
      chartRow.style.gap = "0.5rem";
      chartRow.style.marginBlock = "0.25rem";
      section.append(chartRow);
    }
    wrap.append(section);
  }
  wrap.prepend(note(`Top ${topN} collocates by ${measure}; window L${context.spanLeft}/R${context.spanRight}, minimum frequency ${context.minFreq}, ${context.total} tokens.`));
  return wrap;
}

const GUIDE = MEASURES.map(([measure, description]) => ({ measure, description }));

export function createPlugin() {
  return {
    name: "collocation",
    visualisation: {
      label: "Collocations",
      hint: "Find words associated with one or more node words in a token window.",
      render(container, { documents = [], tables = [] }) {
        let rows = [];
        let parameters = null;
        const introHeading = element("h2", { text: "Collocations" });
        const introText = note(
          "Choose one file or all files to analyse. For CSV/TSV files, select the columns containing text. " +
          "Enter one or more comma-separated node words, set the left/right context window and frequency " +
          "threshold, then calculate to see nearby collocates ranked by the selected association measure."
        );
        const sources = [...new Set([
          ...(documents || []).map((document) => document.source),
          ...(tables || []).map((table) => table.source),
        ].filter(Boolean))].sort((left, right) => left.localeCompare(right));
        const sourceSelect = select([
          { value: "__all__", label: "All files" },
          ...sources.map((source) => ({ value: source, label: source })),
        ], { value: "__all__" });
        const columnSelect = element("select", { attrs: { multiple: true, size: 4, "aria-label": "CSV columns" } });
        const nodesInput = element("input", { attrs: { type: "search", placeholder: "e.g. climate, change", "aria-label": "Node words" } });
        const ignoreCase = checkbox("Ignore case", { checked: true });
        const spanLeft = numberInput({ value: 5, min: 1, max: 20 });
        const spanRight = numberInput({ value: 5, min: 1, max: 20 });
        const minFreq = numberInput({ value: 2, min: 1 });
        const topN = numberInput({ value: 20, min: 5, max: 100 });
        const measure = select(MEASURES.map(([value]) => ({ value, label: value })), { value: "DeltaP12" });
        const filter = element("input", { attrs: { type: "search", placeholder: "Filter results…", "aria-label": "Filter results" } });
        const status = element("p", { className: "field-hint" });
        const resultsWrap = element("div", { attrs: { hidden: true } });
        const { body, node: table } = dataTable(RESULT_COLUMNS.map((column) => column));
        table.style.maxHeight = "50rem";
        table.style.overflowY = "auto";
        const chart = element("div");
        const guideTable = dataTable(["Measure", "Definition"]);
        GUIDE.forEach(({ measure: id, description }) => guideTable.body.append(element("tr", {}, [element("td", { text: id }), element("td", { text: description })])));
        const parameterView = element("pre", { className: "mono" });
        const count = element("span", { className: "field-hint" });

        function selectedColumns() {
          return [...columnSelect.selectedOptions].map((option) => option.value);
        }

        function updateColumns() {
          const table = tables.find((candidate) => candidate.source === sourceSelect.value);
          columnSelect.replaceChildren();
          if (!table) {
            columnSelect.hidden = true;
            columnField.hidden = true;
            return;
          }
          columnSelect.append(...table.header.map((column) => element("option", {
            text: column,
            attrs: { value: column },
          })));
          const textColumn = table.header.findIndex((column) => column.trim().toLowerCase() === "text");
          [...columnSelect.options].forEach((option, index) => {
            option.selected = textColumn >= 0 ? index === textColumn : true;
          });
          columnSelect.hidden = false;
          columnField.hidden = false;
        }

        const columnField = field("CSV columns", columnSelect);

        const csv = () => buildCsvText(RESULT_COLUMNS, rows.map(rowValues));
        const visibleRows = () => {
          const query = filter.value.trim().toLocaleLowerCase();
          return query ? rows.filter((row) => RESULT_COLUMNS.some((column) => String(row[column] ?? "").toLocaleLowerCase().includes(query))) : rows;
        };
        function renderRows() {
          const shown = sortedRows(visibleRows(), measure.value);
          body.replaceChildren();
          for (const row of shown) body.append(element("tr", {}, RESULT_COLUMNS.map((column) => element("td", { text: ["E", "OE", "MI", "MI2", "MI3", "G2", "tscore", "DeltaP12", "DeltaP21", "Fisher"].includes(column) ? display(row[column]) : String(row[column] ?? "") }))));
          count.textContent = `${shown.length} of ${rows.length} result row${rows.length === 1 ? "" : "s"}`;
        }
        function calculate() {
          const selectedDocuments = documentsForSelection(documents, tables, sourceSelect.value, selectedColumns());
          if (!selectedDocuments.length) { status.textContent = "No text loaded for the selected file."; return; }
          if (!parseNodes(nodesInput.value).length) { status.textContent = "Enter at least one node word."; return; }
          parameters = {
            nodes: nodesInput.value, ignoreCase: ignoreCase.input.checked,
            source: sourceSelect.value === "__all__" ? "All files" : sourceSelect.value,
            columns: selectedColumns().join(", "),
            spanLeft: numericOption(spanLeft.value, 5, 1, 20), spanRight: numericOption(spanRight.value, 5, 1, 20),
            minFreq: numericOption(minFreq.value, 2, 1, Number.MAX_SAFE_INTEGER),
            topN: numericOption(topN.value, 20, 5, 100), measure: MEASURE_IDS.has(measure.value) ? measure.value : "DeltaP12",
          };
          rows = analyzeCollocations(selectedDocuments, parameters);
          resultsWrap.hidden = false;
          status.textContent = rows.length ? "" : "No collocates found. Try lowering the minimum frequency or widening the window.";
          parameterView.textContent = Object.entries(parameters).map(([key, value]) => `${key}: ${value}`).join("\n");
          chart.replaceChildren(renderChart(rows, parameters.measure, parameters.topN, { ...parameters, total: rows[0]?.N || 0 }));
          renderRows();
        }
        const copy = button("Copy CSV", { onClick: async () => { if (rows.length && await copyText(csv())) flashLabel(copy, "Copied"); } });
        sourceSelect.addEventListener("change", updateColumns);
        filter.addEventListener("input", renderRows);
        measure.addEventListener("change", () => { if (parameters) { parameters.measure = measure.value; chart.replaceChildren(renderChart(rows, measure.value, parameters.topN, { ...parameters, total: rows[0]?.N || 0 })); renderRows(); } });
        resultsWrap.append(
          resultsBar("", [count, copy, button("Save CSV", { onClick: () => rows.length && downloadCsv(`collocations-${slugDate()}.csv`, csv()) }), button("Save parameters", { onClick: () => parameters && downloadText(`collocation-parameters-${slugDate()}.txt`, parameterView.textContent) })]),
          element("h3", { text: "Chart" }), chart,
          element("h3", { text: "Results" }), table,
          element("h3", { text: "Measure guide" }), guideTable.node,
          element("h3", { text: "Parameters" }), parameterView,
        );
        const calculateButton = button("Calculate", { primary: true, onClick: calculate });
        const nodeWordsControl = element("span", { className: "collocation-node-control" }, [
          nodesInput,
          calculateButton,
        ]);
        nodeWordsControl.style.display = "flex";
        nodeWordsControl.style.alignItems = "center";
        nodeWordsControl.style.gap = "0.5rem";
        const nodeWordsField = element("label", { className: "field" }, [
          element("span", { className: "field-label", text: "Node words" }),
          nodeWordsControl,
        ]);
        nodeWordsField.style.display = "flex";
        nodeWordsField.style.flexDirection = "column";
        nodeWordsField.style.alignItems = "stretch";
        nodeWordsField.style.gap = "0.25rem";
        container.replaceChildren(
          introHeading,
          introText,
          element("div", { className: "actions" }, [field("File", sourceSelect), columnField]),
          nodeWordsField,
          element("div", { className: "actions" }, [ignoreCase.node, field("Left span", spanLeft), field("Right span", spanRight), field("Min. frequency", minFreq), field("Top N", topN), field("Plot measure", measure), filter]),
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
        status.textContent = documents.length ? `${documents.length} text item(s) loaded.` : "No text loaded — choose an output folder.";
      },
    },
  };
}
