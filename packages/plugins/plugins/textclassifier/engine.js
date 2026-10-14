// The Text Classifier's pure functions: which rows to classify, label sets,
// turning model scores into labels, comparison with existing labels, and the
// results table. No DOM and no model, so all of it runs under `node`.

export const NONE_LABEL = { name: "none", description: "none of the other labels apply" };
export const DEFAULT_THRESHOLD = 0.5;
// Separators accepted between several labels in one cell of an existing label column.
const LABEL_SEPARATOR = /\s*[;|]\s*/;

/**
 * The rows of `table` to classify.
 * Returns { items: [{ row, text, kept }], skippedEmpty, filteredOut }, where
 * `row` is the 1-based row number in the source table and `kept` the values of
 * `keepColumns`.
 */
export function rowsForSelection(table, { textColumn, keepColumns = [], filter = null, labelColumn = null } = {}) {
  const index = (name) => table.header.indexOf(name);
  const textIndex = index(textColumn);
  if (textIndex < 0) throw new Error(`Table ${table.source} has no column "${textColumn}".`);
  const keep = keepColumns.filter((c) => c !== textColumn).map((c) => [c, index(c)]).filter(([, i]) => i >= 0);
  const filterIndex = filter?.column ? index(filter.column) : -1;
  const labelIndex = labelColumn ? index(labelColumn) : -1;
  const items = [];
  let skippedEmpty = 0;
  let filteredOut = 0;
  table.rows.forEach((cells, i) => {
    if (filterIndex >= 0 && (cells[filterIndex] ?? "") !== filter.value) { filteredOut++; return; }
    const text = String(cells[textIndex] ?? "").trim();
    if (!text) { skippedEmpty++; return; }
    const item = { row: i + 1, text, kept: Object.fromEntries(keep.map(([c, j]) => [c, cells[j] ?? ""])) };
    if (labelIndex >= 0) item.existing = cells[labelIndex] ?? "";
    items.push(item);
  });
  return { items, skippedEmpty, filteredOut };
}

/** The distinct values of a column, most frequent first, for the row filter. */
export function columnValues(table, column, limit = 500) {
  const i = table.header.indexOf(column);
  if (i < 0) return [];
  const counts = new Map();
  for (const cells of table.rows) {
    const value = cells[i] ?? "";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

export function defaultLabelSet() {
  return {
    name: "themes",
    question: "Which theme is the speaker talking about?",
    type: "single",
    labels: [
      { name: "", description: "" },
      { ...NONE_LABEL },
    ],
  };
}

/**
 * Check a label set (from the editor or a loaded JSON file) and return a
 * clean copy. Throws an Error whose message can be shown to the person.
 */
export function normaliseLabelSet(raw) {
  if (!raw || typeof raw !== "object") throw new Error("A label set must be a JSON object.");
  const type = raw.type === "multi" ? "multi" : raw.type === "single" || raw.type == null ? "single" : null;
  if (!type) throw new Error(`Unknown label type "${raw.type}": use "single" or "multi".`);
  const question = String(raw.question ?? "").trim();
  if (!question && type === "single") throw new Error("Enter the question that frames the task.");
  if (!Array.isArray(raw.labels)) throw new Error("A label set needs a list of labels.");
  const labels = [];
  const seen = new Set();
  raw.labels.forEach((label, i) => {
    const name = String(label?.name ?? "").trim();
    const description = String(label?.description ?? "").trim();
    if (!name && !description) return; // an empty editor row
    if (!name) throw new Error(`Label ${i + 1} has a description but no name.`);
    if (seen.has(name.toLowerCase())) throw new Error(`The label name "${name}" is used twice.`);
    seen.add(name.toLowerCase());
    const out = { name, description };
    if (type === "multi") {
      const t = label.threshold == null || label.threshold === "" ? DEFAULT_THRESHOLD : Number(label.threshold);
      if (!(t >= 0 && t <= 1)) throw new Error(`The threshold for "${name}" must be between 0 and 1.`);
      out.threshold = t;
    }
    labels.push(out);
  });
  const minimum = type === "single" ? 2 : 1;
  if (labels.length < minimum) {
    throw new Error(type === "single" ? "One label per row needs at least two labels." : "Enter at least one label.");
  }
  return { name: String(raw.name ?? "").trim() || "labels", question, type, labels };
}

/** Normalised entropy confidence, as THX-01's Python code computes it: 1 - H(p)/log(k). */
export function confidence(probabilities) {
  const k = probabilities.length;
  if (k < 2) return 1;
  const h = -probabilities.reduce((sum, p) => sum + p * Math.log(Math.min(1, Math.max(p, 1e-12))), 0);
  return Math.min(1, Math.max(0, 1 - h / Math.log(k)));
}

/**
 * Model scores for one text -> { labels, confidence }.
 * One label per row: the most probable label. Any number: every label at or
 * above its threshold. `confidence` is only given for one label per row.
 */
export function assignLabels(scores, labelSet) {
  if (labelSet.type === "single") {
    const probs = labelSet.labels.map((l) => scores[l.name]);
    const best = probs.indexOf(Math.max(...probs));
    return { labels: [labelSet.labels[best].name], confidence: confidence(probs) };
  }
  return { labels: labelSet.labels.filter((l) => scores[l.name] >= l.threshold).map((l) => l.name), confidence: null };
}

/** An existing label cell to a list of label values. */
export const splitLabels = (cell) => String(cell ?? "").split(LABEL_SEPARATOR).map((s) => s.trim()).filter(Boolean);

const key = (s) => String(s).trim().toLowerCase();

/**
 * Compare assigned labels with an existing label column.
 * `rows`: [{ assigned: [names], existing: cell text }]. Rows whose existing cell
 * is empty are left out. Matching ignores case and surrounding spaces.
 *
 * Returns { compared, agreed, agreement, perLabel, confusion, unmatched, disagreements }:
 * - perLabel: [{ label, support, assigned, truePositive, precision, recall }]
 *   (precision/recall null when undefined)
 * - confusion (one label per row only): { labels, counts[existing][assigned] }
 * - unmatched: existing values that match no label name, with their counts
 * - disagreements: indexes into `rows`
 */
export function compareLabels(rows, labelSet) {
  const names = labelSet.labels.map((l) => l.name);
  const byKey = new Map(names.map((n) => [key(n), n]));
  const unmatched = new Map();
  const perLabel = new Map(names.map((n) => [n, { label: n, support: 0, assigned: 0, truePositive: 0 }]));
  const single = labelSet.type === "single";
  const confusion = single ? Object.fromEntries(names.map((n) => [n, Object.fromEntries(names.map((m) => [m, 0]))])) : null;
  const disagreements = [];
  let compared = 0;
  let agreed = 0;

  rows.forEach((row, index) => {
    const existingRaw = splitLabels(row.existing);
    if (!existingRaw.length) return;
    compared++;
    const existing = new Set();
    for (const value of existingRaw) {
      const name = byKey.get(key(value));
      if (name) existing.add(name);
      else unmatched.set(value, (unmatched.get(value) || 0) + 1);
    }
    const assigned = new Set(row.assigned);
    for (const name of names) {
      const stats = perLabel.get(name);
      if (existing.has(name)) stats.support++;
      if (assigned.has(name)) stats.assigned++;
      if (existing.has(name) && assigned.has(name)) stats.truePositive++;
    }
    const same = existing.size === assigned.size && [...existing].every((n) => assigned.has(n));
    if (same) agreed++;
    else disagreements.push(index);
    if (single && existing.size === 1 && assigned.size === 1) confusion[[...existing][0]][[...assigned][0]]++;
  });

  return {
    compared,
    agreed,
    agreement: compared ? agreed / compared : null,
    perLabel: [...perLabel.values()].map((s) => ({
      ...s,
      precision: s.assigned ? s.truePositive / s.assigned : null,
      recall: s.support ? s.truePositive / s.support : null,
    })),
    confusion: single ? { labels: names, counts: confusion } : null,
    unmatched: [...unmatched].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })),
    disagreements,
  };
}

/** Whether a label is the "none" label the panel adds for one label per row. */
export const isNoneLabel = (label) => label.name.trim().toLowerCase() === NONE_LABEL.name;

/**
 * Switch a label set (as edited, not yet checked) between "single" and "multi".
 * "none" is an option only when every row must get exactly one label: as a
 * yes/no question it asks nothing. So it is removed for "multi" and put back
 * for "single" if it is missing.
 */
export function withLabelType(labelSet, type) {
  let labels = labelSet.labels.filter((l) => type === "single" || !isNoneLabel(l));
  if (type === "single" && !labels.some(isNoneLabel)) labels = [...labels, { ...NONE_LABEL }];
  return { ...labelSet, type, labels };
}

/** Rows assigned each label, in label order. */
export function labelCounts(assignments, labelSet) {
  const counts = new Map(labelSet.labels.map((l) => [l.name, 0]));
  for (const a of assignments) for (const name of a.labels) counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count }));
}

const round = (value, places = 4) => (value == null ? "" : String(Number(value.toFixed(places))));

/**
 * The results as a CSV-ready table: { header, rows } with string cells.
 * `results[i]` is the model result for `items[i]` ({ scores, truncated }), or
 * null when the run stopped before reaching it; those rows are left out.
 */
export function resultsTable(items, results, labelSet, { keepColumns = [], textColumn = "text" } = {}) {
  const single = labelSet.type === "single";
  const header = [
    "row", ...keepColumns.filter((c) => c !== textColumn), textColumn,
    single ? "label" : "labels",
    ...labelSet.labels.map((l) => `p_${l.name}`),
    ...(single ? ["confidence"] : []),
    "truncated",
  ];
  const rows = [];
  items.forEach((item, i) => {
    const result = results[i];
    if (!result) return;
    const { labels, confidence: conf } = assignLabels(result.scores, labelSet);
    rows.push([
      String(item.row),
      ...keepColumns.filter((c) => c !== textColumn).map((c) => item.kept[c] ?? ""),
      item.text,
      labels.join("; "),
      ...labelSet.labels.map((l) => round(result.scores[l.name])),
      ...(single ? [round(conf)] : []),
      result.truncated ? "true" : "false",
    ]);
  });
  return { header, rows };
}

/** A plain-text record of a run's settings, so it can be repeated. */
export function settingsRecord({ table, textColumn, keepColumns, filter, labelSet, model, backend, rowsClassified, date }) {
  const lines = [
    "Text Classifier settings",
    `Date: ${date}`,
    `Table: ${table}`,
    `Text column: ${textColumn}`,
    `Columns kept: ${keepColumns.join(", ") || "(none)"}`,
    `Row filter: ${filter?.column ? `${filter.column} = ${filter.value}` : "(none)"}`,
    `Rows classified: ${rowsClassified}`,
    `Model: ${model}`,
    `Backend: ${backend}`,
    `Label type: ${labelSet.type === "single" ? "one label per row" : "any number of labels per row"}`,
    ...(labelSet.type === "single" ? [`Question: ${labelSet.question}`] : []),
    "Labels:",
    ...labelSet.labels.map((l) => `  ${l.name}${l.threshold != null ? ` (threshold ${l.threshold})` : ""}: ${l.description}`),
  ];
  return lines.join("\n") + "\n";
}
