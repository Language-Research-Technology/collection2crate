// Text Classifier: assign theme or topic labels to the rows of a loaded table.
// See SPEC.md. The pure parts are in engine.js (rows, label sets, comparison,
// results) and thx01.js (the model's input and probabilities); the models the
// panel can use are listed in models.js.

import { buildCsvText, copyText, downloadCsv } from "../../src/_csv.js";
import { button, dataTable, element, field, flashLabel, note, resultsBar, select } from "../../src/_panel.js";
import {
  columnValues, compareLabels, assignLabels, defaultLabelSet, labelCounts, normaliseLabelSet,
  resultsTable, rowsForSelection, settingsRecord, withLabelType,
} from "./engine.js";
import { MODELS, modelById } from "./models.js";

export const CONFIG_PATH = "_config/textclassifier/labels.json";
const MAX_RENDERED_ROWS = 2000;
const URL_STORAGE_KEY = "textclassifier-model-url";
const NONE = "__none__";

// Loaded models, by model ID and URL. A loaded model is a few hundred MB in
// memory and takes seconds to start, so it outlives a single render() rather
// than being loaded again each time the panel is shown.
const loadedModels = new Map();

function ensureStyle() {
  if (document.getElementById("textclassifier-style")) return;
  const style = element("style", { attrs: { id: "textclassifier-style" } });
  style.textContent = `
.textclassifier-section-heading {
  margin: 1.5rem 0 0.5rem; padding-bottom: 0.25rem; border-bottom: 2px solid var(--border);
  font-size: 0.95rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);
}
.textclassifier-label-row {
  display: grid; grid-template-columns: minmax(8rem, 1fr) minmax(0, 4fr) 6rem auto; gap: 0.5rem; align-items: end;
}
.textclassifier-label-row.single { grid-template-columns: minmax(8rem, 1fr) minmax(0, 4fr) auto; }
.textclassifier-label-row .field { min-width: 0; }
.textclassifier-label-row input { width: 100%; box-sizing: border-box; }
.textclassifier-wide { width: 100%; box-sizing: border-box; }
.textclassifier-error { color: #c0392b; }
.textclassifier-progress { width: 100%; max-width: 32rem; }
.textclassifier-num { text-align: right; font-variant-numeric: tabular-nums; }
.textclassifier-results-scroll { max-height: 40rem; overflow-y: auto; }
.textclassifier-text-cell { min-width: 20rem; }
.textclassifier-settings { white-space: pre-wrap; font-size: 0.85rem; }
.textclassifier-bars text { fill: currentColor; font-size: 12px; }
.textclassifier-bars rect { fill: var(--accent, #51247a); }
`;
  document.head.append(style);
}

const sectionHeading = (text) => element("h3", { className: "textclassifier-section-heading", text });
const formatP = (p) => (p == null ? "" : p.toFixed(2));
const formatPct = (p) => (p == null ? "–" : `${(p * 100).toFixed(1)}%`);
const shorten = (text, n = 200) => (text.length > n ? `${text.slice(0, n)}…` : text);
const slug = (s) => String(s).split("/").pop().replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "table";
const megabytes = (bytes) => `${Math.round(bytes / 1e6)} MB`;

function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function readStoredUrl() {
  try { return localStorage.getItem(URL_STORAGE_KEY) || ""; } catch { return ""; }
}
function storeUrl(url) {
  try { localStorage.setItem(URL_STORAGE_KEY, url); } catch { /* private window: not remembered */ }
}

function multiSelect(options, { selected = [], size = 4, label }) {
  const node = element("select", { attrs: { multiple: true, size: Math.min(size, Math.max(2, options.length)), "aria-label": label } });
  for (const option of options) {
    const o = element("option", { text: option, attrs: { value: option } });
    o.selected = selected.includes(option);
    node.append(o);
  }
  return node;
}

/** Horizontal bars, one per label, as plain SVG. */
function barChart(counts, total) {
  const ns = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs, text) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const row = 22, labelWidth = 160, barWidth = 360, countWidth = 110;
  const max = Math.max(1, ...counts.map((c) => c.count));
  const svg = svgEl("svg", {
    class: "textclassifier-bars", width: labelWidth + barWidth + countWidth, height: counts.length * row + 4,
    role: "img", "aria-label": "Rows per label",
  });
  counts.forEach((c, i) => {
    const y = i * row + 2;
    svg.append(
      svgEl("text", { x: labelWidth - 8, y: y + 14, "text-anchor": "end" }, shorten(c.label, 24)),
      svgEl("rect", { x: labelWidth, y: y + 3, height: row - 8, width: Math.max(1, (c.count / max) * barWidth), rx: 2 }),
      svgEl("text", { x: labelWidth + barWidth + 8, y: y + 14 }, `${c.count} (${formatPct(total ? c.count / total : 0)})`),
    );
  });
  return svg;
}

export function createPlugin(deps = {}) {
  const { readFileTextFromDirectory, writeFileAtPath } = deps;
  return {
    name: "textclassifier",
    visualisation: {
      label: "Text Classifier",
      hint: "Assign theme or topic labels to the rows of a table, from label descriptions or from rows already labelled.",
      render(container, { tables = [], dirHandle = null, log = () => {} }) {
        ensureStyle();
        const intro = [
          element("h2", { text: "Text Classifier" }),
          note("Give each row of a table one or more labels, such as themes or topics. Describe each label, and a " +
            "classification model running in this browser decides which labels fit each row. Texts are not sent anywhere."),
        ];
        if (!tables.length) {
          container.replaceChildren(...intro, note(
            "No tables are loaded. Turn on the “Export RO-Crate tables” option, build, then choose the " +
            "roctable output folder above."));
          return;
        }

        // ---- state for this render
        let labelSet = defaultLabelSet();
        let labelsValid = null;
        let runState = null; // { stop } while a run is in progress
        let model = MODELS.find((m) => m.serves === "description");
        let modelUrl = readStoredUrl() || model.baseUrl;

        // ---- rows
        const tableSelect = select(tables.map((t, i) => ({ value: String(i), label: t.source })));
        const textColumnHost = element("span");
        const keepHost = element("span");
        const filterColumnHost = element("span");
        const filterValueHost = element("span");
        const compareHost = element("span");
        const rowsStatus = element("p", { className: "field-hint" });
        let textColumn, keepColumns, filterColumn, filterValue, compareColumn;

        const table = () => tables[Number(tableSelect.value)];

        function setupColumns() {
          const header = table().header;
          const textDefault = header.find((c) => c.trim().toLowerCase() === "text") || header[0];
          textColumn = select(header, { value: textDefault });
          keepColumns = multiSelect(header, { selected: header.filter((c) => c !== textDefault), label: "Columns to keep" });
          filterColumn = select([{ value: NONE, label: "(all rows)" }, ...header]);
          filterValue = select([]);
          filterValue.disabled = true;
          compareColumn = select([{ value: NONE, label: "(none)" }, ...header]);
          textColumnHost.replaceChildren(field("Text column", textColumn));
          keepHost.replaceChildren(field("Columns to keep in the results", keepColumns));
          filterColumnHost.replaceChildren(field("Only rows where", filterColumn));
          filterValueHost.replaceChildren(field("is", filterValue));
          compareHost.replaceChildren(field("Existing labels to compare with", compareColumn));
          for (const control of [textColumn, keepColumns, filterValue, compareColumn]) control.addEventListener("change", selectionChanged);
          filterColumn.addEventListener("change", () => {
            const column = filterColumn.value;
            filterValue.replaceChildren(...(column === NONE ? [] : columnValues(table(), column).map(({ value, count }) =>
              element("option", { text: `${value || "(empty)"} (${count})`, attrs: { value } }))));
            filterValue.disabled = column === NONE;
            selectionChanged();
          });
        }

        function selection() {
          return {
            textColumn: textColumn.value,
            keepColumns: [...keepColumns.selectedOptions].map((o) => o.value),
            filter: filterColumn.value === NONE ? null : { column: filterColumn.value, value: filterValue.value },
            labelColumn: compareColumn.value === NONE ? null : compareColumn.value,
          };
        }

        function currentRows() {
          return rowsForSelection(table(), selection());
        }

        function selectionChanged() {
          const { items, skippedEmpty, filteredOut } = currentRows();
          const parts = [`${items.length} row${items.length === 1 ? "" : "s"} to classify`];
          if (skippedEmpty) parts.push(`${skippedEmpty} with empty text skipped`);
          if (filteredOut) parts.push(`${filteredOut} left out by the filter`);
          rowsStatus.textContent = parts.join("; ") + ".";
          clearResults();
        }

        tableSelect.addEventListener("change", () => { setupColumns(); selectionChanged(); });

        // ---- labels
        const methodSelect = select([
          { value: "description", label: "By description" },
          { value: "example", label: "By example (not built yet)" },
        ]);
        methodSelect.options[1].disabled = true;
        const questionInput = element("input", { className: "textclassifier-wide", attrs: { type: "text" } });
        const typeSelect = select([
          { value: "single", label: "One label per row" },
          { value: "multi", label: "Any number of labels per row" },
        ]);
        const questionField = field("Question", questionInput);
        const labelRowsHost = element("div");
        const labelsStatus = element("p", { className: "field-hint" });
        const addLabelButton = button("Add label", { onClick: () => { readEditor(); labelSet.labels.push({ name: "", description: "" }); drawLabelRows(); labelsChanged(); } });
        const fileInput = element("input", { attrs: { type: "file", accept: ".json,application/json", hidden: true } });

        function drawLabelRows() {
          const multi = labelSet.type === "multi";
          labelRowsHost.replaceChildren(...labelSet.labels.map((label, i) => {
            const name = element("input", { attrs: { type: "text", value: label.name, "data-field": "name", "aria-label": `Label ${i + 1} name` } });
            const description = element("input", { attrs: { type: "text", value: label.description, "data-field": "description", "aria-label": `Label ${i + 1} description` } });
            const threshold = element("input", { attrs: { type: "number", min: 0, max: 1, step: 0.05, value: label.threshold ?? 0.5, "data-field": "threshold", "aria-label": `Label ${i + 1} threshold` } });
            const remove = button("Remove", { onClick: () => { readEditor(); labelSet.labels.splice(i, 1); drawLabelRows(); labelsChanged(); } });
            for (const input of [name, description, threshold]) input.addEventListener("input", labelsChanged);
            return element("div", { className: `textclassifier-label-row${multi ? "" : " single"}` }, [
              field(i === 0 ? "Label" : "", name),
              field(i === 0 ? "Description: what counts as this label" : "", description),
              multi ? field(i === 0 ? "Threshold" : "", threshold) : null,
              remove,
            ]);
          }));
        }

        function readEditor() {
          const rows = [...labelRowsHost.children].map((row) => {
            const get = (f) => row.querySelector(`[data-field="${f}"]`)?.value ?? "";
            const out = { name: get("name"), description: get("description") };
            if (labelSet.type === "multi") out.threshold = get("threshold");
            return out;
          });
          labelSet = { ...labelSet, question: questionInput.value, type: typeSelect.value, labels: rows };
        }

        // The framing question is only asked for one label per row.
        function showQuestion() { questionField.hidden = labelSet.type !== "single"; }

        function showLabelSet(set) {
          labelSet = { ...set, labels: set.labels.map((l) => ({ ...l })) };
          questionInput.value = labelSet.question;
          typeSelect.value = labelSet.type;
          drawLabelRows();
          showQuestion();
          labelsChanged();
        }

        function labelsChanged() {
          readEditor();
          try {
            labelsValid = normaliseLabelSet(labelSet);
            labelsStatus.className = "field-hint";
            labelsStatus.textContent = `${labelsValid.labels.length} labels.`;
            if (labelsValid.type === "single" && labelsValid.labels.length > 24) {
              labelsValid = null;
              labelsStatus.className = "field-hint textclassifier-error";
              labelsStatus.textContent = "One label per row allows at most 24 labels. Use any number of labels per row, or fewer labels.";
            }
          } catch (error) {
            labelsValid = null;
            labelsStatus.className = "field-hint textclassifier-error";
            labelsStatus.textContent = error.message;
          }
          clearResults();
        }

        questionInput.addEventListener("input", labelsChanged);
        typeSelect.addEventListener("change", () => {
          readEditor();
          labelSet = withLabelType(labelSet, typeSelect.value);
          drawLabelRows();
          showQuestion();
          labelsChanged();
        });

        const saveLabelsButton = button("Save to folder", {
          title: `Saves to ${CONFIG_PATH}`,
          onClick: async () => {
            if (!labelsValid) return;
            if (!dirHandle || !writeFileAtPath) { labelsStatus.textContent = `Choose a collection folder before saving ${CONFIG_PATH}.`; return; }
            try {
              await writeFileAtPath(dirHandle, CONFIG_PATH, `${JSON.stringify(labelsValid, null, 2)}\n`);
              flashLabel(saveLabelsButton, "Saved");
            } catch (error) {
              labelsStatus.textContent = `Could not save ${CONFIG_PATH}: ${error.message}`;
              log(`Text Classifier: could not save ${CONFIG_PATH}: ${error.message}`, "warn");
            }
          },
        });
        const downloadLabelsButton = button("Download JSON", {
          onClick: () => labelsValid && downloadText(`textclassifier-labels-${slug(labelsValid.name)}.json`, `${JSON.stringify(labelsValid, null, 2)}\n`, "application/json"),
        });
        const openLabelsButton = button("Open JSON file…", { onClick: () => fileInput.click() });
        fileInput.addEventListener("change", async () => {
          const file = fileInput.files?.[0];
          fileInput.value = "";
          if (!file) return;
          try { showLabelSet(normaliseLabelSet(JSON.parse(await file.text()))); }
          catch (error) { labelsStatus.className = "field-hint textclassifier-error"; labelsStatus.textContent = `Could not open ${file.name}: ${error.message}`; }
        });

        async function loadSavedLabels() {
          if (!dirHandle || !readFileTextFromDirectory) return;
          try {
            const text = await readFileTextFromDirectory(dirHandle, CONFIG_PATH);
            if (text) {
              showLabelSet(normaliseLabelSet(JSON.parse(text)));
              labelsStatus.textContent += ` Loaded from ${CONFIG_PATH}.`;
            }
          } catch (error) {
            log(`Text Classifier: could not read ${CONFIG_PATH}: ${error.message}`, "warn");
          }
        }

        // ---- model
        const urlInput = element("input", { className: "textclassifier-wide", attrs: { type: "url", value: modelUrl, placeholder: "https://…/thx01/" } });
        const loadButton = button(`Load model (${megabytes(model.downloadBytes)} download, kept by the browser after the first time)`, { primary: true });
        const modelProgress = element("progress", { className: "textclassifier-progress", attrs: { hidden: true } });
        const modelStatus = element("p", { className: "field-hint" });
        const modelChoice = MODELS.length > 1
          ? field("Model", select(MODELS.filter((m) => m.serves === "description").map((m) => ({ value: m.id, label: m.name })), { value: model.id }))
          : element("p", { text: model.name });
        modelChoice.querySelector("select")?.addEventListener("change", (event) => {
          model = modelById(event.target.value);
          showModelState();
        });
        const modelKey = () => `${model.id} ${modelUrl}`;
        const loadedModel = () => loadedModels.get(modelKey()) || null;

        function showModelState() {
          const m = loadedModel();
          loadButton.hidden = Boolean(m);
          modelStatus.textContent = m ? `${model.name} is loaded and running on ${m.backend}.` : "";
          updateRunButton();
        }

        urlInput.addEventListener("change", () => { modelUrl = urlInput.value.trim(); storeUrl(modelUrl); showModelState(); });
        loadButton.addEventListener("click", async () => {
          modelUrl = urlInput.value.trim();
          if (!modelUrl) { modelStatus.textContent = "Enter the address the model files are served from."; return; }
          storeUrl(modelUrl);
          loadButton.disabled = true;
          modelProgress.hidden = false;
          modelProgress.removeAttribute("value");
          modelStatus.textContent = "Downloading the model…";
          try {
            const started = performance.now();
            const loaded = await model.load({
              baseUrl: modelUrl,
              onProgress: ({ received, total, cached }) => {
                if (total) { modelProgress.max = total; modelProgress.value = received; }
                modelStatus.textContent = cached ? "Reading the model from the browser's storage…"
                  : `Downloading the model: ${megabytes(received)}${total ? ` of ${megabytes(total)}` : ""}`;
              },
            });
            loadedModels.set(modelKey(), loaded);
            log(`Text Classifier: loaded ${model.name} on ${loaded.backend} in ${duration(performance.now() - started)}.`);
          } catch (error) {
            modelStatus.textContent = `Could not load the model: ${error.message}`;
            log(`Text Classifier: could not load ${model.name}: ${error.message}`, "warn");
            loadButton.disabled = false;
            modelProgress.hidden = true;
            return;
          }
          loadButton.disabled = false;
          modelProgress.hidden = true;
          showModelState();
        });

        // ---- run
        const runButton = button("Classify", { primary: true });
        const stopButton = button("Stop");
        stopButton.hidden = true;
        const runProgress = element("progress", { className: "textclassifier-progress", attrs: { hidden: true } });
        const runStatus = element("p", { className: "field-hint" });
        const resultsHost = element("div");

        function updateRunButton() {
          runButton.disabled = Boolean(runState) || !loadedModel() || !labelsValid;
          runButton.title = !loadedModel() ? "Load the model first." : !labelsValid ? "Fix the labels first." : "";
        }

        function clearResults() {
          if (runState) return; // a change during a run is picked up next time
          resultsHost.replaceChildren();
          runStatus.textContent = "";
          updateRunButton();
        }

        stopButton.addEventListener("click", () => { if (runState) runState.stop = true; });
        runButton.addEventListener("click", async () => {
          const loaded = loadedModel();
          if (!loaded || !labelsValid) return;
          const set = labelsValid;
          const chosen = selection();
          const { items } = currentRows();
          if (!items.length) { runStatus.textContent = "No rows to classify."; return; }
          runState = { stop: false };
          updateRunButton();
          stopButton.hidden = false;
          runProgress.hidden = false;
          runProgress.max = items.length;
          runProgress.value = 0;
          resultsHost.replaceChildren();
          const started = performance.now();
          let results;
          try {
            results = await loaded.classify(items.map((i) => i.text), set, {
              shouldStop: () => runState.stop,
              onProgress: (done, total) => {
                runProgress.value = done;
                const elapsed = performance.now() - started;
                const left = done ? (elapsed / done) * (total - done) : 0;
                runStatus.textContent = `${done} of ${total} rows classified, about ${duration(left)} left.`;
              },
            });
          } catch (error) {
            runStatus.textContent = `Classification failed: ${error.message}`;
            log(`Text Classifier: classification failed: ${error.message}`, "warn");
            results = null;
          }
          const elapsed = performance.now() - started;
          const stopped = runState.stop;
          runState = null;
          stopButton.hidden = true;
          runProgress.hidden = true;
          updateRunButton();
          if (!results) return;
          const done = results.filter(Boolean).length;
          const truncated = results.filter((r) => r?.truncated).length;
          runStatus.textContent = `${stopped ? "Stopped. " : ""}${done} of ${items.length} rows classified in ${duration(elapsed)} on ${loaded.backend}.` +
            (truncated ? ` ${truncated} row${truncated === 1 ? " was" : "s were"} too long and only the start was read (see the truncated column).` : "");
          showResults({ items, results, set, chosen, backend: loaded.backend });
        });

        // ---- results
        function showResults({ items, results, set, chosen, backend }) {
          const reached = items.map((item, i) => ({ item, result: results[i] })).filter((r) => r.result);
          const assignments = reached.map((r) => assignLabels(r.result.scores, set));
          const csvTable = resultsTable(items, results, set, { keepColumns: chosen.keepColumns, textColumn: chosen.textColumn });
          const csv = () => buildCsvText(csvTable.header, csvTable.rows);
          const fileBase = `textclassifier-${slug(table().source)}`;
          const nodes = [];

          nodes.push(sectionHeading(set.type === "single" ? "Rows per label" : "Rows per label (a row can have several)"),
            barChart(labelCounts(assignments, set), reached.length));

          if (chosen.labelColumn) nodes.push(...comparisonNodes(reached, assignments, set, chosen, fileBase));

          const copyButton = button("Copy CSV", { onClick: async () => { if (await copyText(csv())) flashLabel(copyButton, "Copied"); } });
          const shown = Math.min(csvTable.rows.length, MAX_RENDERED_ROWS);
          nodes.push(
            sectionHeading("Results"),
            resultsBar(shown < csvTable.rows.length ? `Showing ${shown} of ${csvTable.rows.length} rows; the CSV has them all.` : `${csvTable.rows.length} rows.`,
              [copyButton, button("Save CSV", { onClick: () => downloadCsv(`${fileBase}.csv`, csv()) })]),
            resultsTableNode(csvTable, chosen.textColumn, shown),
          );

          const record = settingsRecord({
            table: table().source, ...chosen, labelSet: set, model: `${model.name} (${model.source})`, backend,
            rowsClassified: reached.length, date: new Date().toISOString(),
          });
          nodes.push(
            sectionHeading("Settings used"),
            resultsBar("", [button("Save settings", { onClick: () => downloadText(`${fileBase}-settings.txt`, record) })]),
            element("pre", { className: "textclassifier-settings mono", text: record }),
          );
          resultsHost.replaceChildren(...nodes);
        }

        function resultsTableNode(csvTable, textColumnName, shown) {
          const numeric = new Set(csvTable.header.map((h, i) => (h.startsWith("p_") || h === "confidence" || h === "row" ? i : -1)));
          const textIndex = csvTable.header.indexOf(textColumnName);
          const { body, node } = dataTable(csvTable.header.map((h, i) => ({ label: h, className: numeric.has(i) ? "textclassifier-num" : undefined })));
          for (const row of csvTable.rows.slice(0, shown)) {
            body.append(element("tr", {}, row.map((cell, i) => element("td", {
              text: i === textIndex ? shorten(cell) : numeric.has(i) && cell !== "" && i !== 0 ? formatP(Number(cell)) : cell,
              className: i === textIndex ? "textclassifier-text-cell" : numeric.has(i) ? "textclassifier-num mono" : undefined,
              attrs: i === textIndex && cell.length > 200 ? { title: cell } : undefined,
            }))));
          }
          node.classList.add("textclassifier-results-scroll");
          return node;
        }

        function comparisonNodes(reached, assignments, set, chosen, fileBase) {
          const rows = reached.map((r, i) => ({ assigned: assignments[i].labels, existing: r.item.existing }));
          const c = compareLabels(rows, set);
          const nodes = [sectionHeading(`Compared with the ${chosen.labelColumn} column`)];
          if (!c.compared) {
            nodes.push(note(`No classified row has a value in ${chosen.labelColumn}.`));
            return nodes;
          }
          nodes.push(element("p", { text: `The labels agree on ${c.agreed} of ${c.compared} rows (${formatPct(c.agreement)}). ` +
            (set.type === "multi" ? "A row agrees when its set of labels is the same." : "") }));
          if (c.unmatched.length) {
            nodes.push(note(`Values in ${chosen.labelColumn} that match no label name: ` +
              c.unmatched.slice(0, 20).map((u) => `${u.value} (${u.count})`).join(", ") + (c.unmatched.length > 20 ? ", …" : "") +
              ". Rows with these values count as disagreements."));
          }
          const per = dataTable(["Label", { label: "Existing rows", className: "textclassifier-num" }, { label: "Assigned rows", className: "textclassifier-num" },
            { label: "Precision", className: "textclassifier-num" }, { label: "Recall", className: "textclassifier-num" }]);
          for (const p of c.perLabel) {
            per.body.append(element("tr", {}, [p.label, p.support, p.assigned, formatPct(p.precision), formatPct(p.recall)]
              .map((v, i) => element("td", { text: String(v), className: i ? "textclassifier-num mono" : undefined }))));
          }
          nodes.push(note("Precision: of the rows given a label here, the share that already had it. Recall: of the rows that already had a label, the share given it here."), per.node);

          if (c.confusion) {
            const labels = c.confusion.labels;
            const conf = dataTable(["Existing ↓ / assigned →", ...labels.map((l) => ({ label: l, className: "textclassifier-num" }))]);
            for (const existing of labels) {
              conf.body.append(element("tr", {}, [
                element("th", { text: existing }),
                ...labels.map((assigned) => element("td", { text: String(c.confusion.counts[existing][assigned]), className: "textclassifier-num mono" })),
              ]));
            }
            nodes.push(element("p", { className: "field-hint", text: "Rows by existing label (down) and assigned label (across)." }), conf.node);
          }

          if (c.disagreements.length) {
            const header = ["row", ...chosen.keepColumns.filter((k) => k !== chosen.textColumn && k !== chosen.labelColumn), chosen.textColumn, `existing (${chosen.labelColumn})`, "assigned"];
            const disagreeRows = c.disagreements.map((i) => [
              String(reached[i].item.row),
              ...header.slice(1, -3).map((k) => reached[i].item.kept[k] ?? ""),
              reached[i].item.text, rows[i].existing, rows[i].assigned.join("; "),
            ]);
            const disagreeCsv = () => buildCsvText(header, disagreeRows);
            const copyDisagree = button("Copy CSV", { onClick: async () => { if (await copyText(disagreeCsv())) flashLabel(copyDisagree, "Copied"); } });
            const shown = Math.min(disagreeRows.length, MAX_RENDERED_ROWS);
            const t = dataTable(header);
            for (const row of disagreeRows.slice(0, shown)) {
              t.body.append(element("tr", {}, row.map((cell, i) => element("td", { text: i === header.length - 3 ? shorten(cell) : cell }))));
            }
            t.node.classList.add("textclassifier-results-scroll");
            nodes.push(
              element("h4", { text: "Rows where the labels disagree" }),
              resultsBar(`${disagreeRows.length} rows.`, [copyDisagree, button("Save CSV", { onClick: () => downloadCsv(`${fileBase}-disagreements.csv`, disagreeCsv()) })]),
              t.node,
            );
          }
          return nodes;
        }

        // ---- assemble
        setupColumns();
        showLabelSet(defaultLabelSet());
        selectionChanged();
        showModelState();
        loadSavedLabels();

        container.replaceChildren(
          ...intro,
          note("The model's labels are a starting point, not a finding. Before relying on them, compare them with " +
            "rows you have labelled yourself (“Existing labels to compare with” below)."),
          sectionHeading("Rows"),
          element("div", { className: "actions" }, [field("Table", tableSelect), textColumnHost]),
          element("div", { className: "actions" }, [keepHost, filterColumnHost, filterValueHost]),
          element("div", { className: "actions" }, [compareHost]),
          rowsStatus,
          sectionHeading("Labels"),
          element("div", { className: "actions" }, [field("Define labels", methodSelect), field("Label type", typeSelect)]),
          questionField,
          labelRowsHost,
          element("div", { className: "actions" }, [addLabelButton, saveLabelsButton, downloadLabelsButton, openLabelsButton, fileInput]),
          labelsStatus,
          sectionHeading("Model"),
          modelChoice,
          field("Model files address", urlInput),
          element("p", { className: "field-hint", text: `Reads ${model.maxTextTokens} of each row; longer text is cut off and marked in the results. ` +
            `Licence: ${model.licence}. ${model.credit}` }),
          loadButton, modelProgress, modelStatus,
          sectionHeading("Classify"),
          element("div", { className: "actions" }, [runButton, stopButton]),
          runProgress, runStatus,
          resultsHost,
        );
      },
    },
  };
}

function downloadText(filename, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = element("a", { attrs: { href: url, download: filename } });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

