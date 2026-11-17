import { button, checkbox, element, field, select } from "../../../src/_panel.js";
import { BUILDER_NAMES, validatePlotsConfig } from "../model.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
const jsonText = (value) => JSON.stringify(value ?? {}, null, 2);
const parseJson = (text, label) => {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label}: ${error.message}`); }
};

const commonFields = [
  ["title", "Title", "text"], ["subtitle", "Subtitle", "text"],
];
const xFields = [
  ["xVar", "X field", "column"], ["xType", "X field type", "field-type"],
  ["xTitle", "X-axis title", "text"], ["xLabels", "X-axis labels (JSON)", "json"],
  ["xTimeUnit", "X-axis time unit", "time-unit"], ["xTooltipTitle", "X tooltip title", "text"],
  ["xTooltipTimeUnit", "X tooltip time unit", "time-unit"],
];
const yFields = [
  ["yVar", "Y field", "column"], ["yType", "Y field type", "field-type"],
  ["yTitle", "Y-axis title", "text"], ["yLabels", "Y-axis labels (JSON)", "json"],
  ["yTimeUnit", "Y-axis time unit", "time-unit"], ["yTooltipTitle", "Y tooltip title", "text"],
  ["yTooltipTimeUnit", "Y tooltip time unit", "time-unit"],
];
const colorFields = [
  ["colorVar", "Color field", "column"], ["colorType", "Color field type", "field-type"],
  ["colorTitle", "Color legend title", "text"], ["colorLabels", "Color labels (JSON)", "json"],
  ["colorTooltipTitle", "Color tooltip title", "text"], ["palette", "Palette (name or JSON)", "json-or-text"],
];
// Only scatterPlot takes Y time units; boxPlot and histogramPlot ignore them.
const yFieldsWithoutTimeUnits = yFields.filter(([key]) => key !== "yTimeUnit" && key !== "yTooltipTimeUnit");
const invalidValuesField = ["invalidValues", "Missing or invalid values", "invalid-values"];
// Bar plots of counts and of percentages share their arguments; ro-crate-plots draws X as nominal.
const barFields = [
  ...xFields.filter(([key]) => key !== "xType"),
  ["yTitle", "Y-axis title", "text"], ["yLabels", "Y-axis labels (JSON)", "json"], ["yTooltipTitle", "Y tooltip title", "text"],
  ["sort", "Bar order", "sort-count"], ...colorFields,
];
/** stackBars choices per bar builder; only meaningful with a color field, which splits each bar. */
const STACK_BARS_CHOICES = {
  barPlotCount: {
    fallback: "stack",
    choices: [["stack", "Stack"], ["side_by_side", "Side by side"]],
    tooltip: [
      "How bars are split by the color field:",
      "Stack: one bar per X value, counting its rows. Colors split the bar into sub-counts for each color value.",
      "Side by side: a separate bar for each color value within each X value, counting its rows.",
    ],
  },
  barPlotPercent: {
    fallback: "stack_and_normalize",
    choices: [["stack_and_normalize", "Stack and normalize"], ["stack", "Stack"], ["side_by_side", "Side by side"]],
    tooltip: [
      "How bars are split by the color field:",
      "Stack and normalize: every bar reaches 100%, showing the color shares within each X value (colors sum to 100% within each bar).",
      "Stack: each bar's height is the proportion of its X value in the entire data (all bars sum to 100%). " +
        "Colors show the proportion of each color value within the bar (colors sum to 100% within each bar).",
      "Side by side: a separate bar for each color value, showing its proportion within the X value " +
        "(bars sum to 100% within each X value).",
    ],
  },
};
const BUILDER_FIELDS = {
  barPlotCount: [...barFields, ["stackBars", "Bar layout", "stack-bars"], invalidValuesField, ...commonFields],
  barPlotPercent: [...barFields, ["stackBars", "Bar layout", "stack-bars"], invalidValuesField, ...commonFields],
  scatterPlot: [...xFields, ...yFields, ...colorFields, invalidValuesField, ...commonFields],
  boxPlot: [...xFields, ...yFieldsWithoutTimeUnits, ["sort", "Category order", "sort-order"], ...colorFields, invalidValuesField, ...commonFields],
  histogramPlot: [
    ...xFields,
    ...yFieldsWithoutTimeUnits.filter(([key]) => key !== "yVar" && key !== "yType"),
    // ro-crate-plots dropped maxbins, minstep and nice; saved values stay in the JSON.
    ["step", "Bin step", "number"],
    ...colorFields, invalidValuesField, ...commonFields,
  ],
  plotMapHeatmap: [
    ["latitudeField", "Latitude column", "column"], ["longitudeField", "Longitude column", "column"],
    ["weightField", "Weight column (optional)", "column"], ["bandwidth", "Bandwidth (number or JSON pair)", "json-or-number"],
    ["nContours", "Contour count", "number"], ["opacity", "Heatmap opacity", "number"],
    ["palette", "Palette", "text"], ["zoom", "Map zoom (optional)", "number"],
    ["targetSizePx", "Map image size (px)", "number"], ["provider", "Map provider (JSON)", "json"],
    ...commonFields,
  ],
};

/** The section of a plot card a builder argument belongs to, so each variable's controls sit together. */
function argumentGroup(builder, key) {
  if (builder === "plotMapHeatmap") {
    if (["latitudeField", "longitudeField", "weightField"].includes(key)) return "Location columns";
    if (["bandwidth", "nContours", "opacity", "palette"].includes(key)) return "Heatmap";
    if (["zoom", "targetSizePx", "provider"].includes(key)) return "Base map";
    return "Other";
  }
  if (key === "sort") return builder === "barPlotCount" || builder === "barPlotPercent" ? "X axis" : "Other";
  if (key === "stackBars") return "Color";
  if (/^x[A-Z]/.test(key)) return "X axis";
  if (/^y[A-Z]/.test(key)) return "Y axis";
  if (/^color[A-Z]/.test(key) || key === "palette") return "Color";
  if (["maxbins", "minstep", "step", "nice"].includes(key)) return "Bins";
  return "Other";
}

const GROUP_SYMBOLS = {
  "X axis": "↔", "Y axis": "↕", Color: "●", Bins: "▥", Other: "⋯",
  "Location columns": "⌖", Heatmap: "◍", "Base map": "▦", "Vega Embed options for this plot": "⚙",
};

/** A section heading with a small symbol to scan by; the symbol is hidden from screen readers. */
function groupLegend(name) {
  const symbol = GROUP_SYMBOLS[name];
  return element("legend", {}, [
    ...(symbol ? [element("span", { className: "plots-editor-group-symbol", text: symbol, attrs: { "aria-hidden": "true" } })] : []),
    element("span", { text: name }),
  ]);
}

/** "X-axis title" reads as "Axis title" once it sits under an X axis heading. */
function groupedLabel(label, group) {
  const prefix = { "X axis": /^X[ -]/, "Y axis": /^Y[ -]/, Color: /^Color /i }[group];
  if (!prefix || !prefix.test(label)) return label;
  const rest = label.replace(prefix, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Readable names for the builders; the config keeps the function names. */
const PLOT_TYPE_LABELS = {
  barPlotCount: "Bar plot (counts)", barPlotPercent: "Bar plot (percentages)", scatterPlot: "Scatter plot", boxPlot: "Box plot",
  histogramPlot: "Histogram", plotMapHeatmap: "Map heatmap",
};
const plotTypeOption = (name) => element("option", { text: PLOT_TYPE_LABELS[name] || name, attrs: { value: name } });

// Time units Vega-Lite 6 accepts (vega-lite/src/timeunit.ts, https://vega.github.io/vega-lite/docs/timeunit.html).
// The "binned…" units, for data binned before plotting, are left out; a saved one is kept as Custom.
const TIME_UNIT_PARTS = ["year", "quarter", "month", "week", "dayofyear", "day", "date", "hours", "minutes", "seconds", "milliseconds"];
const TIME_UNIT_PART_LABELS = {
  year: "year", quarter: "quarter", month: "month", week: "week", day: "day of week", dayofyear: "day of year",
  date: "day of month", hours: "hours", minutes: "minutes", seconds: "seconds", milliseconds: "milliseconds",
};
const SINGLE_TIME_UNITS = ["year", "quarter", "month", "week", "day", "dayofyear", "date", "hours", "minutes", "seconds", "milliseconds"];
const MULTI_TIME_UNITS = [
  "yearquarter", "yearquartermonth", "yearmonth", "yearmonthdate", "yearmonthdatehours", "yearmonthdatehoursminutes",
  "yearmonthdatehoursminutesseconds", "yearweek", "yearweekday", "yearweekdayhours", "yearweekdayhoursminutes",
  "yearweekdayhoursminutesseconds", "yeardayofyear", "quartermonth", "monthdate", "monthdatehours", "monthdatehoursminutes",
  "monthdatehoursminutesseconds", "weekday", "weekdayhours", "weekdayhoursminutes", "weekdayhoursminutesseconds",
  "dayhours", "dayhoursminutes", "dayhoursminutesseconds", "hoursminutes", "hoursminutesseconds", "minutesseconds",
  "secondsmilliseconds",
];
const LOCAL_TIME_UNITS = [...SINGLE_TIME_UNITS, ...MULTI_TIME_UNITS];
const TIME_UNITS = new Set([...LOCAL_TIME_UNITS, ...LOCAL_TIME_UNITS.map((unit) => `utc${unit}`)]);
// Parts in the order Vega-Lite joins them into a unit name, e.g. year + dayofyear -> "yeardayofyear".
const TIME_UNIT_ORDER = ["year", "quarter", "month", "week", "day", "dayofyear", "date", "hours", "minutes", "seconds", "milliseconds"];
const LOCAL_UNIT_PARTS = LOCAL_TIME_UNITS.map((unit) => new Set(timeUnitParts(unit)));

/** "yearmonthdate" -> ["year", "month", "date"]; null for a name that is not made of parts. */
function timeUnitParts(unit) {
  let rest = String(unit).replace(/^utc/, "");
  const parts = [];
  while (rest) {
    const part = TIME_UNIT_PARTS.find((name) => rest.startsWith(name));
    if (!part) return null;
    parts.push(part);
    rest = rest.slice(part.length);
  }
  return parts;
}

/** "yearmonthdate" -> "Year + month + day of month"; utc units add "(UTC)". */
function timeUnitLabel(unit) {
  const parts = timeUnitParts(unit);
  if (!parts) return String(unit);
  const text = parts.map((part) => TIME_UNIT_PART_LABELS[part]).join(" + ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${String(unit).startsWith("utc") ? " (UTC)" : ""}`;
}

let timeUnitOutsideClick = false;
/**
 * A dropdown of time-unit parts as checkboxes; ticking parts builds a Vega-Lite unit
 * such as "yearmonth". Parts that cannot lead to a valid unit are disabled, and an
 * incomplete combination is reported but not saved. A value outside the list (an
 * object, or a "binned…" unit) is kept until a part is ticked.
 */
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function timeUnitPicker({ label, value, defaultLabel, onChange, inherit }) {
  if (!timeUnitOutsideClick) {
    timeUnitOutsideClick = true;
    document.addEventListener("pointerdown", (event) => {
      for (const open of document.querySelectorAll(".plots-editor-timeunit[open]")) {
        if (!open.contains(event.target)) open.open = false;
      }
    });
  }
  const custom = value !== undefined && value !== "" && !(typeof value === "string" && TIME_UNITS.has(value));
  const parts = new Set(custom || !value ? [] : timeUnitParts(value));
  let utc = typeof value === "string" && value.startsWith("utc");
  let keepCustom = custom;
  let saved = custom || !value ? "" : value;
  const originalValue = value;
  // A tooltip picker with no unit of its own follows the axis unit (ro-crate-plots falls back to it),
  // and shows the axis unit's parts ticked so what you see is what the tooltip uses.
  let inheriting = Boolean(inherit) && !custom && !value;
  const inheritedUnit = () => {
    const unit = inherit?.();
    return typeof unit === "string" && TIME_UNITS.has(unit) ? unit : "";
  };
  const shown = () => {
    if (!inheriting) return { parts, utc };
    const unit = inheritedUnit();
    return { parts: new Set(unit ? timeUnitParts(unit) : []), utc: unit.startsWith("utc") };
  };

  const unitFor = () => (parts.size ? `${utc ? "utc" : ""}${TIME_UNIT_ORDER.filter((part) => parts.has(part)).join("")}` : "");
  const reachable = (candidate) => LOCAL_UNIT_PARTS.some((unit) => [...candidate].every((part) => unit.has(part)));
  const summaryText = element("span", { className: "plots-editor-timeunit-value" });
  const status = element("p", { className: "plots-editor-timeunit-status", attrs: { role: "status" } });
  /** Leave the axis unit behind: start this picker's own unit from what was shown. */
  function stopInheriting() {
    if (!inheriting) return;
    const current = shown();
    parts.clear();
    for (const part of current.parts) parts.add(part);
    utc = current.utc;
    inheriting = false;
  }
  /** Back to following the axis once this unit is empty or the same as the axis one. */
  function maybeInherit() {
    if (!inherit || keepCustom) return;
    if (!parts.size || unitFor() === inheritedUnit()) {
      parts.clear();
      inheriting = true;
    }
  }
  const boxes = TIME_UNIT_ORDER.map((part) => {
    const box = checkbox(capitalize(TIME_UNIT_PART_LABELS[part]));
    box.input.addEventListener("change", () => {
      stopInheriting();
      if (box.input.checked) parts.add(part); else parts.delete(part);
      update(true);
    });
    return { part, box };
  });
  const utcBox = checkbox("UTC (ignore the viewer's time zone)", { checked: utc });
  utcBox.input.addEventListener("change", () => { stopInheriting(); utc = utcBox.input.checked; update(true); });
  const clear = button(inherit ? "Same as axis" : "Clear", {
    title: inherit ? "Use the axis time unit in the tooltip" : "Untick every part",
    onClick: () => { parts.clear(); update(true); },
  });
  clear.classList.add("plots-editor-timeunit-clear");

  function update(changed) {
    if (changed) keepCustom = false;
    const unit = unitFor();
    const complete = !parts.size || TIME_UNITS.has(unit);
    if (changed && complete) maybeInherit();
    const nextValue = inheriting ? "" : unitFor();
    if (changed && complete && nextValue !== saved) {
      saved = nextValue;
      onChange(nextValue);
    }
    const display = shown();
    for (const { part, box } of boxes) {
      box.input.checked = display.parts.has(part);
      box.input.disabled = !display.parts.has(part) && !reachable(new Set([...display.parts, part]));
    }
    utcBox.input.checked = display.utc;
    clear.disabled = inherit ? inheriting : !parts.size;
    node.classList.toggle("inheriting", inheriting);
    if (keepCustom) {
      summaryText.textContent = `Custom: ${typeof originalValue === "string" ? originalValue : JSON.stringify(originalValue)}`;
      status.textContent = "Kept unchanged. Tick parts to replace it.";
    } else if (inheriting) {
      summaryText.textContent = defaultLabel();
      status.textContent = "Same as the axis time unit. Tick or untick parts to use a different one in the tooltip.";
    } else if (!parts.size) {
      summaryText.textContent = defaultLabel();
      status.textContent = "Tick one part, or several to combine them.";
    } else if (complete) {
      summaryText.textContent = timeUnitLabel(unit);
      status.textContent = `Vega-Lite unit: ${unit}`;
    } else {
      // The smallest valid unit containing the ticked parts says what is missing.
      const target = LOCAL_UNIT_PARTS.filter((candidate) => [...parts].every((part) => candidate.has(part)))
        .sort((a, b) => a.size - b.size)[0];
      const missing = target ? TIME_UNIT_ORDER.filter((part) => target.has(part) && !parts.has(part)).map((part) => capitalize(TIME_UNIT_PART_LABELS[part])) : [];
      summaryText.textContent = `${capitalize(TIME_UNIT_ORDER.filter((part) => parts.has(part)).map((part) => TIME_UNIT_PART_LABELS[part]).join(" + "))} (incomplete)`;
      status.textContent = `Not a Vega-Lite unit yet${missing.length ? `: also tick ${missing.join(" + ")}` : ""}. The plot keeps ${saved ? timeUnitLabel(saved) : inherit ? "the axis unit" : "no time unit"} until then.`;
    }
    node.classList.toggle("incomplete", !keepCustom && !complete);
  }

  const node = element("details", { className: "plots-editor-timeunit" }, [
    element("summary", { attrs: { "aria-label": `${label}: choose time unit parts` } }, [summaryText]),
    element("div", { className: "plots-editor-timeunit-panel" }, [
      element("div", { className: "plots-editor-timeunit-parts" }, boxes.map(({ box }) => box.node)),
      utcBox.node, status, element("div", { className: "actions" }, [clear]),
    ]),
  ]);
  update(false);
  return { node, refresh: () => update(false) };
}

const LABEL_SOURCES = { xLabels: "xVar", yLabels: "yVar", colorLabels: "colorVar" };
const INVALID_VALUE_CHOICES = [
  { value: "show", label: "Show and flag" },
  { value: "hide", label: "Hide" },
];
// Themes bundled with vega-embed 7 (vega-themes 3).
const VEGA_THEMES = [
  ["dark", "Dark"], ["excel", "Excel"], ["fivethirtyeight", "FiveThirtyEight"], ["ggplot2", "ggplot2"],
  ["googlecharts", "Google Charts"], ["latimes", "Los Angeles Times"], ["powerbi", "Power BI"], ["quartz", "Quartz"],
  ["urbaninstitute", "Urban Institute"], ["vox", "Vox"], ["carbonwhite", "Carbon (white)"], ["carbong10", "Carbon (gray 10)"],
  ["carbong90", "Carbon (gray 90, dark)"], ["carbong100", "Carbon (gray 100, dark)"],
];
// Per-plot Vega Embed overrides, matching the global options; other saved keys are kept as they are.
const EMBED_CONTROLS = [
  ["theme", "Theme", [{ value: "", label: "Inherit global" }, ...VEGA_THEMES.map(([value, label]) => ({ value, label }))]],
  ["actions", "Action links", [{ value: "", label: "Inherit global" }, { value: "true", label: "Show" }, { value: "false", label: "Hide" }]],
];

/** What ro-crate-plots uses when a field is left empty, mirroring lib/plots.js and lib/mapplots.js. */
function defaultPlaceholders(builder, args) {
  const text = (value) => (value === undefined || value === null ? "" : String(value));
  const x = text(args.xVar);
  const y = text(args.yVar);
  const color = text(args.colorVar);
  const xTitle = text(args.xTitle) || x;
  const colorTitle = text(args.colorTitle) || color;
  const counted = builder === "barPlotCount" || builder === "histogramPlot";
  const stackBars = args.stackBars || STACK_BARS_CHOICES[builder]?.fallback;
  // Mirrors the Y titles ro-crate-plots generates for bar plots with and without a color field.
  let yTitle = counted ? `Count of ${xTitle || "the X field"}` : y;
  if (builder === "barPlotCount" && color && stackBars === "side_by_side") yTitle = `Count of ${colorTitle}`;
  if (builder === "barPlotPercent") {
    yTitle = !color ? `Percent of ${xTitle || "the X field"}`
      : stackBars === "stack_and_normalize" ? "None"
        : stackBars === "side_by_side" ? `Percent of ${colorTitle}` : `Percent of ${xTitle || "the X field"}`;
  }
  return {
    title: "No title", subtitle: "No subtitle",
    xTitle: x, xTooltipTitle: xTitle, xTimeUnit: "None", xTooltipTimeUnit: text(args.xTimeUnit) || "None",
    yTitle, yTooltipTitle: text(args.yTitle) || yTitle, yTimeUnit: "None", yTooltipTimeUnit: text(args.yTimeUnit) || "None",
    colorTitle: color, colorTooltipTitle: colorTitle,
    palette: builder === "plotMapHeatmap" ? "turbo" : "Default colors",
    // A temporal histogram steps in its time unit, e.g. 5 years per bin.
    step: args.xType === "temporal" ? `1 (${args.xTimeUnit ? timeUnitLabel(args.xTimeUnit).toLowerCase() : "time unit"} per bin)` : "Auto",
    bandwidth: "Auto (-1)", nContours: "10", opacity: "0.5", zoom: "Auto", targetSizePx: "300",
    provider: "OpenStreetMap (default)",
    xType: builder === "scatterPlot" ? "quantitative" : "",
    yType: builder === "scatterPlot" ? "quantitative" : "",
    invalidValues: "show",
  };
}

const TIME_UNIT_AXES = { xTimeUnit: "x", xTooltipTimeUnit: "x", yTimeUnit: "y", yTooltipTimeUnit: "y" };

/** Time units only mean something on a temporal axis; one already set stays visible so it can be cleared. */
function showTimeUnit(builder, args, key) {
  const axis = TIME_UNIT_AXES[key];
  if (!axis) return true;
  if (args[key] !== undefined && args[key] !== "") return true;
  // Bar plots take no xType and always draw their X field as nominal.
  const type = (builder === "barPlotCount" || builder === "barPlotPercent") && axis === "x"
    ? "nominal"
    : args[`${axis}Type`] || defaultPlaceholders(builder, args)[`${axis}Type`];
  return type === "temporal";
}

const hasValue = (value) => value !== undefined && value !== null && value !== ""
  && !(Array.isArray(value) && !value.length)
  && !(typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);

/** The categorical field a box plot sorts, mirroring boxPlot's choice of which axis is nominal. */
function boxPlotCategoryField(args) {
  const continuous = (type) => type === "quantitative" || type === "temporal";
  if (continuous(args.xType)) return args.yVar;
  if (continuous(args.yType)) return args.xVar;
  if (args.xType === "nominal") return args.xVar;
  if (args.yType === "nominal") return args.yVar;
  return undefined;
}

const advanced = (summary, control) => element("details", { className: "plots-editor-advanced" }, [
  element("summary", { text: summary }), control,
]);

let helpOutsideClick = false;
let helpCount = 0;

/**
 * A field whose label ends in a small ⓘ button explaining the control. The
 * help shows on hover or keyboard focus; a click pins it open, since touch
 * screens have no hover. Lines shaped "Term: text" get the term in bold.
 */
function helpField(labelText, control, lines) {
  if (!helpOutsideClick) {
    helpOutsideClick = true;
    document.addEventListener("pointerdown", (event) => {
      for (const open of document.querySelectorAll(".plots-editor-help.open")) {
        if (!open.contains(event.target)) open.classList.remove("open");
      }
    });
  }
  const id = `plots-editor-help-${++helpCount}`;
  const tip = element("div", { className: "plots-editor-help-tip", attrs: { id, role: "tooltip" } }, lines.map((line) => {
    const [, term, rest] = line.match(/^([^:]+): (.+)$/s) || [];
    return term ? element("p", {}, [element("strong", { text: term }), document.createTextNode(`: ${rest}`)]) : element("p", { text: line });
  }));
  const toggle = element("button", {
    className: "plots-editor-help-toggle", text: "i",
    attrs: { type: "button", "aria-label": `About ${labelText}`, "aria-expanded": "false", "aria-describedby": id },
  });
  const help = element("span", { className: "plots-editor-help" }, [toggle, tip]);
  const setOpen = (open) => {
    help.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => setOpen(!help.classList.contains("open")));
  // Escape hides help that is showing without closing the editor; it returns on the next hover or focus.
  help.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || help.classList.contains("dismissed")) return;
    event.stopPropagation();
    setOpen(false);
    help.classList.add("dismissed");
  });
  const undismiss = () => help.classList.remove("dismissed");
  help.addEventListener("pointerleave", undismiss);
  help.addEventListener("focusout", undismiss);
  control.setAttribute("aria-describedby", id);
  return element("div", { className: "field" }, [
    element("span", { className: "field-label" }, [document.createTextNode(labelText), help]),
    control,
  ]);
}

/** Dropdowns for one plot's Vega Embed overrides; unknown keys are left untouched. */
function embedControls(card, sync) {
  return EMBED_CONTROLS.map(([key, label, options]) => {
    const current = card.embed[key];
    const currentValue = current === undefined ? "" : String(current);
    const known = options.some((option) => option.value === currentValue);
    const control = select(
      known ? options : [...options, { value: "__keep", label: `Custom: ${typeof current === "string" ? current : JSON.stringify(current)} (unchanged)` }],
      { value: known ? currentValue : "__keep" },
    );
    control.addEventListener("change", () => {
      if (control.value === "__keep") return;
      if (control.value === "") delete card.embed[key];
      else if (control.value === "true" || control.value === "false") card.embed[key] = control.value === "true";
      else card.embed[key] = control.value;
      sync();
    });
    return field(label, control);
  });
}

/** A list sub-editor's heading with a count badge, so a filled-in list reads as its own block. */
function subEditorHead(label) {
  const count = element("span", { className: "plots-editor-sub-count" });
  const node = element("div", { className: "plots-editor-sub-head" }, [element("strong", { text: label }), count]);
  return { node, setCount: (n) => { count.textContent = n ? String(n) : ""; } };
}

/** Value-to-label rows, e.g. Female -> F, so long values do not crowd the plot. */
function labelsEditor({ label, labels, getValues, onChange, kind = "text" }) {
  const entries = Object.entries(labels && typeof labels === "object" ? labels : {});
  const wrap = element("div", { className: `plots-editor-labels${kind === "color" ? "" : " plots-editor-value-labels"}` });
  const rows = element("div");
  const picker = element("select", { attrs: { "aria-label": `${label}: choose a value to label` } });
  const commit = () => onChange(Object.fromEntries(entries.filter(([, text]) => text !== "")));
  function refreshPicker() {
    const labelled = new Set(entries.map(([value]) => value));
    const available = getValues().filter((value) => !labelled.has(value));
    picker.replaceChildren(
      element("option", { text: available.length ? "Choose a value to add…" : "No more values", attrs: { value: "" } }),
      ...available.map((value) => element("option", { text: value, attrs: { value } })),
    );
    picker.value = "";
    picker.disabled = !available.length;
  }
  const head = subEditorHead(label);
  function renderRows(focusIndex) {
    head.setCount(entries.length);
    wrap.classList.toggle("has-entries", entries.length > 0);
    rows.replaceChildren(...entries.map((entry, index) => {
      const valueInput = element("input", { attrs: { type: "text", value: entry[0], readonly: true, "aria-label": `${label}: value ${index + 1}` } });
      const labelInput = element("input", { attrs: { type: "text", value: entry[1], placeholder: kind === "color" ? "#ff69b4" : "Label shown", "aria-label": `${kind === "color" ? "Color" : "Label"} for ${entry[0]}` } });
      let labelControl = labelInput;
      if (kind === "color") {
        const swatch = element("input", { attrs: { type: "color", value: HEX_COLOR.test(entry[1]) ? entry[1] : "#888888", "aria-label": `Pick a color for ${entry[0]}` } });
        swatch.addEventListener("input", () => { labelInput.value = swatch.value; entry[1] = swatch.value; commit(); });
        labelInput.addEventListener("change", () => {
          if (HEX_COLOR.test(labelInput.value.trim())) swatch.value = labelInput.value.trim();
        });
        labelControl = element("div", { className: "plots-editor-color-control" }, [swatch, labelInput]);
      }
      labelInput.addEventListener("change", () => { entry[1] = labelInput.value.trim(); commit(); });
      const remove = button("Remove", { onClick: () => { entries.splice(index, 1); commit(); renderRows(); } });
      if (index === focusIndex) queueMicrotask(() => labelInput.focus());
      return element("div", { className: "plots-editor-label-row" }, [valueInput, labelControl, remove]);
    }));
    refreshPicker();
  }
  // Choosing a value adds it. Arrow keys (or typing) on a closed dropdown change its value
  // with every keypress, so keyboard browsing only highlights, and Enter adds.
  let keyboardBrowsing = false;
  function addChosen() {
    keyboardBrowsing = false;
    if (!picker.value) return;
    entries.push([picker.value, ""]);
    renderRows(entries.length - 1);
  }
  picker.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addChosen();
    } else if (!event.altKey && (event.key.startsWith("Arrow") || ["Home", "End", "PageUp", "PageDown"].includes(event.key)
      || (event.key.length === 1 && event.key !== " "))) {
      keyboardBrowsing = true;
    }
  });
  picker.addEventListener("change", () => { if (!keyboardBrowsing) addChosen(); });
  picker.addEventListener("pointerdown", () => { keyboardBrowsing = false; refreshPicker(); });
  picker.addEventListener("focus", refreshPicker);
  // Leaving after browsing adds nothing, so the dropdown goes back to its prompt.
  picker.addEventListener("blur", () => { if (keyboardBrowsing) { keyboardBrowsing = false; picker.value = ""; } });
  wrap.append(
    head.node,
    element("p", { className: "field-hint", text: kind === "color"
      ? "Choose a value to add it, then pick its color or type it as hex (for example #ff69b4) or a color name."
      : "Choose a value to add it, then type the label to show on the plot, for example F for Female." }),
    rows, element("div", { className: "actions" }, [picker]),
  );
  renderRows();
  return wrap;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Ordered values shown first on a category axis, as draggable chips; values left
 * out keep their default order after them. Keyboard: Enter or Space places an
 * unordered value, arrow keys move an ordered one, Delete or Backspace unplaces it.
 */
function orderEditor({ values, getValues, onChange }) {
  const entries = Array.isArray(values) ? values.map(String) : [];
  const ordered = element("div", { className: "plots-editor-chips plots-editor-chips-ordered", attrs: { role: "list", "aria-label": "Values in order" } });
  const rest = element("div", { className: "plots-editor-chips plots-editor-chips-rest", attrs: { role: "list", "aria-label": "Other values, in default order" } });
  let dragged = null;
  let focusAfterRender = null;
  let knownValues = "";

  function commit(focusValue) {
    focusAfterRender = focusValue;
    onChange([...entries]);
    render();
  }
  /** Put value at index in the order, moving it if it is already placed. */
  function place(value, index) {
    const current = entries.indexOf(value);
    if (current >= 0) {
      entries.splice(current, 1);
      if (current < index) index--;
    }
    entries.splice(Math.max(0, Math.min(index, entries.length)), 0, value);
    commit(value);
  }
  function unplace(value) {
    const current = entries.indexOf(value);
    if (current < 0) return;
    entries.splice(current, 1);
    commit(value);
  }
  function clearDropMarks() {
    for (const node of ordered.querySelectorAll(".drop-before, .drop-after")) node.classList.remove("drop-before", "drop-after");
    ordered.classList.remove("drop-target");
    rest.classList.remove("drop-target");
  }

  function chip(value, index, available) {
    const placed = index >= 0;
    const node = element("span", {
      className: `plots-editor-chip${placed ? " placed" : ""}${placed && !available.has(value) ? " missing" : ""}`,
      attrs: {
        role: "listitem", tabindex: "0", draggable: "true", "data-value": value,
        title: placed
          ? `${available.has(value) ? "" : "Not in the current data. "}Drag to reorder, or back to Other values to remove`
          : "Drag into the order, or click to place it next",
        "aria-label": placed
          ? `${value}, position ${index + 1} of ${entries.length}. Arrow keys move it; Delete removes it from the order.`
          : `${value}, not ordered. Enter places it next.`,
      },
    }, [
      ...(placed ? [element("span", { className: "plots-editor-chip-position", text: String(index + 1), attrs: { "aria-hidden": "true" } })] : []),
      element("span", { text: value }),
    ]);
    node.addEventListener("dragstart", (event) => {
      dragged = value;
      event.dataTransfer?.setData("text/plain", value);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      node.classList.add("dragging");
    });
    node.addEventListener("dragend", () => { dragged = null; node.classList.remove("dragging"); clearDropMarks(); });
    if (placed) {
      const before = (event) => {
        const rect = node.getBoundingClientRect?.();
        return !rect || !rect.width || event.clientX < rect.left + rect.width / 2;
      };
      node.addEventListener("dragover", (event) => {
        if (dragged === null) return;
        event.preventDefault();
        event.stopPropagation();
        clearDropMarks();
        node.classList.add(before(event) ? "drop-before" : "drop-after");
      });
      node.addEventListener("drop", (event) => {
        if (dragged === null) return;
        event.preventDefault();
        event.stopPropagation();
        const value = dragged;
        clearDropMarks();
        place(value, before(event) ? index : index + 1);
      });
      node.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); if (index > 0) place(value, index - 1); }
        else if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); if (index < entries.length - 1) place(value, index + 2); }
        else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); unplace(value); }
      });
    } else {
      node.addEventListener("click", () => place(value, entries.length));
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); place(value, entries.length); }
      });
    }
    return node;
  }

  function render() {
    const all = getValues();
    knownValues = all.join("\u0000");
    const available = new Set(all);
    const placed = new Set(entries);
    ordered.replaceChildren(...(entries.length
      ? entries.map((value, index) => chip(value, index, available))
      : [element("span", { className: "plots-editor-chips-empty", text: "Drag values here to put them first" })]));
    const others = all.filter((value) => !placed.has(value));
    rest.replaceChildren(...(others.length
      ? others.map((value) => chip(value, -1, available))
      : [element("span", { className: "plots-editor-chips-empty", text: all.length ? "Every value is ordered" : "Choose a field to see its values" })]));
    orderAll.disabled = !others.length;
    clear.disabled = !entries.length;
    if (focusAfterRender !== null && focusAfterRender !== undefined) {
      const target = [...ordered.children, ...rest.children].find((node) => node.dataset?.value === focusAfterRender);
      focusAfterRender = null;
      target?.focus();
    }
  }

  // Dropping on the order area's free space appends; dropping on Other values unplaces.
  ordered.addEventListener("dragover", (event) => { if (dragged === null) return; event.preventDefault(); ordered.classList.add("drop-target"); });
  ordered.addEventListener("dragleave", (event) => { if (!ordered.contains(event.relatedTarget)) ordered.classList.remove("drop-target"); });
  ordered.addEventListener("drop", (event) => {
    if (dragged === null) return;
    event.preventDefault();
    const value = dragged;
    clearDropMarks();
    place(value, entries.length);
  });
  rest.addEventListener("dragover", (event) => { if (dragged === null || !entries.includes(dragged)) return; event.preventDefault(); rest.classList.add("drop-target"); });
  rest.addEventListener("dragleave", (event) => { if (!rest.contains(event.relatedTarget)) rest.classList.remove("drop-target"); });
  rest.addEventListener("drop", (event) => {
    if (dragged === null) return;
    event.preventDefault();
    const value = dragged;
    clearDropMarks();
    unplace(value);
  });

  const orderAll = button("Order all", {
    title: "Add every remaining value to the end of the order",
    onClick: () => {
      const placed = new Set(entries);
      entries.push(...getValues().filter((value) => !placed.has(value)));
      commit(null);
    },
  });
  const clear = button("Clear", { title: "Return every value to the default order", onClick: () => { entries.length = 0; commit(null); } });
  const wrap = element("div", { className: "plots-editor-order" }, [
    element("p", { className: "field-hint", text: "Drag values into the order; values left out follow in their default order. Click a value to add it at the end." }),
    element("span", { className: "plots-editor-chips-caption", text: "Order" }), ordered,
    element("span", { className: "plots-editor-chips-caption", text: "Other values" }), rest,
    element("div", { className: "actions" }, [orderAll, clear]),
  ]);
  // The field may change while the editor is open; pick up its values when the user returns here.
  const refreshIfChanged = () => { if (dragged === null && getValues().join("\u0000") !== knownValues) render(); };
  wrap.addEventListener("pointerenter", refreshIfChanged);
  wrap.addEventListener("focusin", refreshIfChanged);
  render();
  return wrap;
}

/** Category order: library default, by count (bar plots only), or an explicit list. */
function sortEditor({ label, sort, byCount, getValues, onChange }) {
  const startMode = Array.isArray(sort) ? "custom"
    : byCount && (sort === "descending" || sort === "ascending") ? sort
      : sort === undefined ? "default" : "keep";
  const modes = [
    { value: "default", label: "Default order" },
    ...(byCount ? [
      { value: "descending", label: "Most frequent first" },
      { value: "ascending", label: "Least frequent first" },
    ] : []),
    { value: "custom", label: "Custom order" },
    ...(startMode === "keep" ? [{ value: "keep", label: "Custom (unchanged)" }] : []),
  ];
  const modeSelect = select(modes, { value: startMode });
  const body = element("div");
  const head = subEditorHead(label);
  const wrap = element("div", { className: "plots-editor-labels" }, [head.node, field("Order", modeSelect), body]);
  const mark = (value) => {
    head.setCount(Array.isArray(value) ? value.length : 0);
    wrap.classList.toggle("has-entries", value !== undefined && !(Array.isArray(value) && !value.length));
  };
  const renderBody = (mode) => {
    body.replaceChildren(...(mode === "custom"
      ? [orderEditor({
        values: Array.isArray(sort) ? sort : [],
        getValues,
        onChange: (values) => { const value = values.length ? values : undefined; mark(value); onChange(value); },
      })]
      : []));
  };
  modeSelect.addEventListener("change", () => {
    const mode = modeSelect.value;
    if (mode === "keep") return;
    sort = mode === "descending" || mode === "ascending" ? mode : undefined;
    mark(sort);
    onChange(sort);
    renderBody(mode);
  });
  renderBody(startMode);
  mark(sort);
  return wrap;
}

// Named color schemes built into Vega, grouped as in its documentation.
const VEGA_SCHEMES = [
  ["Categorical", ["accent", "category10", "category20", "category20b", "category20c", "dark2", "paired", "pastel1", "pastel2", "set1", "set2", "set3", "tableau10", "tableau20"]],
  ["Single hue", ["blues", "greens", "greys", "oranges", "purples", "reds"]],
  ["Multi hue", ["bluegreen", "bluepurple", "goldgreen", "goldorange", "goldred", "greenblue", "orangered", "purplebluegreen", "purpleblue", "purplered", "redpurple", "yellowgreenblue", "yellowgreen", "yelloworangebrown", "yelloworangered", "darkblue", "darkgold", "darkgreen", "darkmulti", "darkred", "lightgreyred", "lightgreyteal", "lightmulti", "lightorange", "lighttealblue"]],
  ["Diverging", ["blueorange", "brownbluegreen", "purplegreen", "pinkyellowgreen", "purpleorange", "redblue", "redgrey", "redyellowblue", "redyellowgreen", "spectral"]],
  ["Perceptual", ["viridis", "magma", "inferno", "plasma", "cividis", "turbo", "rainbow", "sinebow"]],
];

/** Palette choice: default, a named Vega scheme, or a color per data value. */
function paletteEditor({ palette, getValues, onChange, allowCustom }) {
  const isMap = palette !== null && typeof palette === "object" && !Array.isArray(palette);
  const startMode = Array.isArray(palette) ? "list" : isMap ? "custom" : typeof palette === "string" && palette ? "named" : "default";
  const modes = [
    { value: "default", label: "Default colors" },
    { value: "named", label: "Named palette" },
    ...(allowCustom ? [{ value: "custom", label: "Color per value" }] : []),
    ...(startMode === "list" ? [{ value: "list", label: "Color list (unchanged)" }] : []),
  ];
  const modeSelect = select(modes, { value: startMode });
  const body = element("div");
  const head = subEditorHead("Palette");
  const wrap = element("div", { className: "plots-editor-labels" }, [head.node, field("Colors", modeSelect), body]);
  const mark = (value) => wrap.classList.toggle("has-entries", value !== undefined && value !== "");
  mark(palette);
  const notify = onChange;
  onChange = (value) => { mark(value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length ? undefined : value); notify(value); };

  function renderBody(mode) {
    body.replaceChildren();
    if (mode === "named") {
      const known = VEGA_SCHEMES.some(([, names]) => names.includes(palette));
      const schemeSelect = element("select", { attrs: { "aria-label": "Named palette" } }, [
        element("option", { text: "Choose a palette…", attrs: { value: "" } }),
        ...(typeof palette === "string" && palette && !known ? [element("option", { text: palette, attrs: { value: palette } })] : []),
        ...VEGA_SCHEMES.map(([group, names]) => element("optgroup", { attrs: { label: group } },
          names.map((name) => element("option", { text: name, attrs: { value: name } })))),
      ]);
      schemeSelect.value = typeof palette === "string" ? palette : "";
      schemeSelect.addEventListener("change", () => onChange(schemeSelect.value || undefined));
      body.append(field("Palette", schemeSelect));
    } else if (mode === "custom") {
      body.append(labelsEditor({
        label: "Color for each value", labels: isMap ? palette : {}, getValues, kind: "color", onChange,
      }));
    }
  }

  modeSelect.addEventListener("change", () => {
    if (modeSelect.value === "list") return;
    onChange(undefined);
    palette = undefined;
    renderBody(modeSelect.value);
  });
  renderBody(startMode);
  return wrap;
}

function uniqueDatasetName(source, used) {
  const leaf = String(source).split("/").pop() || "dataset";
  const base = leaf.replace(/\.[^.]*$/, "") || "dataset";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base} ${suffix++}`;
  used.add(candidate);
  return candidate;
}

function createEditorState(config) {
  const plots = config.plots;
  return {
    base: clone(config),
    globalOptions: clone(plots.globalConfig || {}),
    datasets: Object.entries(plots.datasets).map(([name, value]) => ({
      name,
      originalName: name,
      descriptor: typeof value === "string" ? { path: value } : clone(value),
      source: typeof value === "string" ? value : value?.source || value?.path || "",
    })),
    cards: plots.plotList.map((plot) => ({
      original: clone(plot),
      mode: plot.customSpec && Object.keys(plot.customSpec).length ? "custom" : "builder",
      name: plot.dataset?.name || "",
      title: typeof plot.makeSpec?.args?.title === "string"
        ? plot.makeSpec.args.title
        : typeof plot.customSpec?.title === "string" ? plot.customSpec.title : "",
      titleEdited: false,
      collapsed: true, // saved plots start collapsed so Add plot stays within reach
      span: Number(plot.plotCardSpan ?? plot.span ?? 1),
      argsText: jsonText(plot.makeSpec?.args),
      customText: jsonText(plot.customSpec),
      embed: clone(plot.config || {}),
      builder: plot.makeSpec?.plotFunction || "barPlotCount",
    })),
    error: "",
  };
}

// Distinct hues, readable with white text in light and dark themes, to tell plot cards apart at a glance.

const PLOT_HUES = ["#2563eb", "#0f766e", "#c2410c", "#7c3aed", "#be123c", "#4d7c0f", "#a16207", "#0e7490"];
const plotHues = new WeakMap();
let nextPlotHue = 0;
/** A card keeps its hue when reordered, so a moved plot is still recognisable. */
function hueFor(card) {
  if (!plotHues.has(card)) plotHues.set(card, PLOT_HUES[nextPlotHue++ % PLOT_HUES.length]);
  return plotHues.get(card);
}

function ensureStyle() {
  if (document.getElementById("plots-editor-style")) return;
  const style = element("style", { attrs: { id: "plots-editor-style" } });
  style.textContent = `
.modal-panel.plots-config-modal { width: min(980px, 96vw); }
/* No scrolling of its own: the host's modal body scrolls, so there is one scroll bar. */
.plots-editor-scroll { min-width: 0; }
.plots-editor-section { margin: 0 0 18px; }
.plots-editor-section > h3 { margin: 0 0 8px; font-size: 15px; }
.plots-editor-intro { margin: 0 0 10px; }
/* Menu items sit under the "Show the action menu" checkbox they depend on. */
.plots-editor-action-items { display: flex; flex-wrap: wrap; gap: 2px 16px; margin: 2px 0 4px 26px; padding-left: 10px; border-left: 2px solid var(--border); }
.plots-editor-action-items .field { margin-bottom: 2px; }
.plots-editor-action-items.disabled { opacity: .5; }
.plots-editor-png-scale { margin: 6px 0 4px 26px; padding-left: 10px; border-left: 2px solid var(--border); max-width: 34rem; }
.plots-editor-png-scale .field { margin-bottom: 2px; max-width: 14rem; }
/* Setup rows: quiet, one line each until opened. */
.plots-editor-setup { margin: 0 0 8px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--accent-soft); background: color-mix(in srgb, var(--text) 4%, var(--panel)); font-size: 13px; }
.plots-editor-setup > summary { display: flex; gap: 8px; align-items: center; margin: 0 -12px; padding: 8px 12px; cursor: pointer; list-style: none; border-radius: var(--radius-sm); }
.plots-editor-setup > summary::-webkit-details-marker { display: none; }
/* A chevron that turns down when open shows the panel can be collapsed and expanded. */
.plots-editor-setup > summary::before { content: ""; flex: none; width: 7px; height: 7px; margin: 0 3px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(-45deg); transition: transform .15s ease; }
.plots-editor-setup[open] > summary::before { transform: rotate(45deg); }
.plots-editor-setup > summary:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.plots-editor-setup > summary:hover::before { border-color: var(--text); }
.plots-editor-setup-title { font-size: 14px; font-weight: 700; color: var(--text); white-space: nowrap; }
.plots-editor-setup[open] > summary { padding-bottom: 4px; }
.plots-editor-setup[open] { padding-bottom: 10px; }
.plots-editor-setup .field { margin-bottom: 6px; }
.plots-editor-setup .field-label { font-size: 12px; }
.plots-editor-plots { margin-top: 18px; }
.plots-editor-plots > h3 { display: flex; align-items: center; gap: 8px; font-size: 17px; }
/* The Add a plot panel echoes a plot card's outline, dashed, as a placeholder for the next one. */
.plots-editor-add { margin: 16px 0 4px; padding: 10px 12px 12px; border: 1px dashed var(--border); border-radius: var(--radius-sm); transition: border-color .15s ease; }
.plots-editor-add:hover, .plots-editor-add:focus-within { border-color: var(--accent); }
.plots-editor-add-title { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.plots-editor-add-row { display: grid; grid-template-columns: minmax(10rem, 1fr) minmax(10rem, 1fr) auto; gap: 10px; align-items: end; }
.plots-editor-add-row > .field { margin-bottom: 0; min-width: 0; }
.plots-editor-add-row > .field > select { width: 100%; box-sizing: border-box; }
.plots-editor-add .field-hint { margin: 8px 0 0; }
@media (max-width: 600px) { .plots-editor-add-row { grid-template-columns: 1fr; } }
.plots-editor-plots-count:not(:empty) { padding: 0 8px; border-radius: 999px; background: var(--accent-soft); color: var(--muted); font-size: 12px; font-weight: 600; }
.plots-editor-plot { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; margin: 8px 0; }
.plots-editor-dataset { display: grid; grid-template-columns: minmax(9rem, 1fr) minmax(12rem, 2fr) auto; gap: 8px; align-items: end; padding: 2px 0; }
.plots-editor-plot { padding: 0 10px 10px; margin: 18px 0; border-left: 6px solid var(--plot-hue, var(--accent)); box-shadow: 0 1px 4px rgb(0 0 0 / 0.08); }
.plots-editor-plot-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 -10px 10px; padding: 8px 10px; background: var(--accent-soft); background: color-mix(in srgb, var(--plot-hue) 14%, var(--panel)); border-bottom: 2px solid var(--plot-hue); }
.plots-editor-plot-number { min-width: 1.9em; padding: 1px 7px; border-radius: 999px; background: var(--plot-hue); color: #fff; font-size: 13px; font-weight: 700; text-align: center; }
.plots-editor-plot-toolbar > .plots-editor-plot-title { flex: 1 1 12rem; margin: 0; font-size: 15px; }
.plots-editor-plot-toolbar { cursor: pointer; border-top-right-radius: var(--radius-sm); }
/* Collapsed cards end at the bar, so it rounds its bottom corner too. */
.plots-editor-plot.collapsed > .plots-editor-plot-toolbar { border-bottom-right-radius: var(--radius-sm); }
.plots-editor-plot-toolbar .button { cursor: pointer; }
/* Chevron toggle, matching the setup panels: right when collapsed, down when open. */
.plots-editor-plot-toggle { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; cursor: pointer; }
.plots-editor-plot-toggle::before { content: ""; width: 8px; height: 8px; border-right: 2px solid var(--text); border-bottom: 2px solid var(--text); transform: rotate(45deg); margin-top: -4px; transition: transform .15s ease, margin .15s ease; }
.plots-editor-plot.collapsed .plots-editor-plot-toggle::before { transform: rotate(-45deg); margin: 0 0 0 -3px; }
.plots-editor-plot-toggle:hover { border-color: var(--plot-hue); background: var(--panel); }
.plots-editor-plot.collapsed { padding-bottom: 0; }
/* A plot (or Add a plot) opened from the panel glows briefly in its own colour, then settles to its usual shadow. */
.plots-editor-plot.flash, .plots-editor-add.flash { animation: plots-editor-flash 1.6s ease-out; }
@keyframes plots-editor-flash { from { box-shadow: 0 0 0 4px color-mix(in srgb, var(--plot-hue, var(--accent)) 45%, transparent); } }
@media (prefers-reduced-motion: reduce) { .plots-editor-plot.flash, .plots-editor-add.flash { animation-duration: 0.01s; } }
.plots-editor-plot.collapsed > .plots-editor-plot-toolbar { margin-bottom: 0; border-bottom-color: transparent; }
.plots-editor-plot.collapsed > .plots-editor-plot-body { display: none; }
.plots-editor-plot-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
.plots-editor-plot-buttons > .button { padding: 5px 12px; font-weight: 600; }
.plots-editor-plot-buttons > .button.danger:hover:not(:disabled) { border-color: var(--err); background: var(--err); color: #fff; }
[data-theme="dark"] .plots-editor-plot-buttons > .button.danger:hover:not(:disabled) { color: #101319; }
.plots-editor-plot-head { display: grid; grid-template-columns: minmax(10rem, 2fr) minmax(10rem, 1fr) minmax(10rem, 1fr) auto; gap: 8px; align-items: end; }
.plots-editor-json { width: 100%; min-height: 8rem; font: 12px/1.4 var(--mono); }
.plots-editor-plot-title { margin: 0 0 8px; font-size: 14px; }
.plots-editor-advanced { margin: 8px 0; }
.plots-editor-advanced > summary { cursor: pointer; font-size: 13px; }
/* Sections are shaded panels, not outlined boxes, so they stand apart without adding lines. */
.plots-editor-group { border: 0; border-radius: var(--radius-sm); margin: 8px 0; padding: 8px 10px; min-width: 0; background: var(--accent-soft); background: color-mix(in srgb, var(--text) 5%, var(--panel)); }
/* Floating the legend keeps it inside the panel instead of on its top edge. */
.plots-editor-group > legend { float: left; width: 100%; padding: 0; margin: 0 0 6px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--text); }
.plots-editor-group > legend + * { clear: both; }
.plots-editor-group-symbol { display: inline-block; width: 1.3em; margin-right: 4px; text-align: center; color: var(--plot-hue, var(--muted)); font-size: 14px; letter-spacing: 0; }
.plots-editor-group-inputs { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: 8px; align-items: end; }
.plots-editor-group-inputs > .field { min-width: 0; margin-bottom: 0; }
.plots-editor-group-inputs > .field > :is(input, select) { width: 100%; box-sizing: border-box; }
/* Sub-editors (value labels, palette, order) rank below their section's legend and above field labels. */
/* List sub-editors (labels, colors, order, palette) are inset cards on the panel background, so a
   filled-in list stands apart from the section's plain fields; the stripe turns solid once set. */
/* Customisations sit apart from the main fields: a gap, a divider, then cards side by side where there is room. */
.plots-editor-group-editors { display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: 10px; align-items: start; margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--border); }
.plots-editor-group-editors:empty { display: none; }
.plots-editor-group-editors > .plots-editor-labels { margin: 0; }
/* Value labels need room to read both the value and its replacement, so their card takes the whole row. */
.plots-editor-group-editors > .plots-editor-value-labels { grid-column: 1 / -1; }
.plots-editor-value-labels > * { max-width: 48rem; }
.plots-editor-group .plots-editor-labels { margin: 10px 0 2px; padding: 8px 12px 10px; border: 1px solid var(--border); border-left: 3px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); }
.plots-editor-group .plots-editor-labels.has-entries { border-left-color: var(--plot-hue, var(--accent)); box-shadow: 0 1px 3px rgb(0 0 0 / 0.06); }
/* The colour-per-value list inside the palette card is part of that card, not a card of its own. */
.plots-editor-group .plots-editor-labels .plots-editor-labels { margin: 6px 0 0; padding: 0; border: 0; background: none; box-shadow: none; }
.plots-editor-sub-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.plots-editor-sub-head > strong { font-size: 14px; font-weight: 600; color: var(--text); }
.plots-editor-sub-count:not(:empty) { min-width: 1.6em; padding: 0 7px; border-radius: 999px; background: color-mix(in srgb, var(--plot-hue, var(--accent)) 16%, var(--panel)); color: var(--text); font-size: 12px; font-weight: 600; text-align: center; }
.plots-editor-labels .field-hint { font-size: 12px; margin: 0 0 6px; }
/* Once a list has entries the how-to hint has done its job. */
.plots-editor-labels.has-entries > .field-hint { display: none; }
.plots-editor-label-row + .plots-editor-label-row { border-top: 1px solid var(--border); padding-top: 4px; }
.plots-editor-labels { margin: 10px 0; }
.plots-editor-label-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; margin: 4px 0; }
.plots-editor-help { position: relative; display: inline-block; margin-left: 5px; vertical-align: 1px; }
/* Quiet until wanted: a small muted circle that takes its plot's colour (the accent outside a plot) on hover,
   focus, or when pinned open, nudged toward the text colour so it stays legible on either theme. */
.plots-editor-help-toggle { display: block; width: 14px; height: 14px; padding: 0; border: 1px solid currentColor; border-radius: 50%; background: transparent; color: var(--muted); font: italic 700 10px/12px Georgia, "Times New Roman", serif; text-align: center; cursor: help; opacity: .75; }
.plots-editor-help-toggle:hover, .plots-editor-help-toggle:focus-visible, .plots-editor-help.open > .plots-editor-help-toggle { color: var(--accent); color: color-mix(in srgb, var(--plot-hue, var(--accent)) 80%, var(--text)); opacity: 1; }
.plots-editor-help-tip { display: none; position: absolute; z-index: 6; top: calc(100% + 6px); left: -10px; width: max-content; max-width: min(26rem, 80vw); padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); box-shadow: 0 6px 18px rgb(0 0 0 / 0.15); color: var(--text); font-size: 13px; font-weight: 400; line-height: 1.4; white-space: normal; }
/* Bridges the gap below the icon so the help stays open while the pointer moves onto it. */
.plots-editor-help-tip::before { content: ""; position: absolute; left: 0; right: 0; top: -8px; height: 8px; }
.plots-editor-help-tip p { margin: 0; }
.plots-editor-help-tip p + p { margin-top: 4px; }
.plots-editor-help:hover > .plots-editor-help-tip, .plots-editor-help:focus-within > .plots-editor-help-tip, .plots-editor-help.open > .plots-editor-help-tip { display: block; }
.plots-editor-help.dismissed > .plots-editor-help-tip { display: none; }
.plots-editor-timeunit { position: relative; }
.plots-editor-timeunit > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); cursor: pointer; list-style: none; font-size: 14px; }
.plots-editor-timeunit > summary::-webkit-details-marker { display: none; }
.plots-editor-timeunit > summary::after { content: ""; flex: none; width: 6px; height: 6px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(45deg); margin-top: -3px; }
.plots-editor-timeunit-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plots-editor-timeunit.incomplete > summary { border-color: var(--err); }
/* Following the axis unit: ticks and label are shown, but quieter than a unit of its own. */
.plots-editor-timeunit.inheriting > summary { color: var(--muted); }
.plots-editor-timeunit.inheriting .plots-editor-timeunit-parts input:checked, .plots-editor-timeunit.inheriting .field.inline input[type="checkbox"]:checked { opacity: .6; }
.plots-editor-timeunit-panel { position: absolute; z-index: 5; top: calc(100% + 4px); left: 0; min-width: 16rem; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); box-shadow: 0 6px 18px rgb(0 0 0 / 0.15); }
.plots-editor-timeunit-parts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 12px; margin-bottom: 6px; }
.plots-editor-timeunit-panel .field { margin-bottom: 2px; }
.plots-editor-timeunit-panel .field.inline .field-label { font-size: 13px; }
/* A muted red: clearly a reset, without the alarm of a delete button. */
.plots-editor-timeunit-clear { padding: 4px 14px; font-size: 13px; color: var(--err); color: color-mix(in srgb, var(--err) 70%, var(--muted)); }
.plots-editor-timeunit-clear:hover:not(:disabled) { color: var(--err); border-color: var(--err); }
.plots-editor-timeunit-status { margin: 6px 0; font-size: 12px; color: var(--muted); }
.plots-editor-timeunit.incomplete .plots-editor-timeunit-status { color: var(--err); }
.plots-editor-chips-caption { display: block; margin: 6px 0 3px; font-size: 12px; color: var(--muted); }
.plots-editor-chips { display: flex; flex-wrap: wrap; gap: 6px; min-height: 2.2rem; align-items: center; padding: 6px; border-radius: var(--radius-sm); border: 1px dashed transparent; }
.plots-editor-chips-ordered { border-color: var(--border); background: var(--panel); }
.plots-editor-chips.drop-target { border-color: var(--plot-hue, var(--accent)); border-style: solid; }
.plots-editor-chips-empty { font-size: 12px; color: var(--muted); font-style: italic; }
.plots-editor-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border: 1px dashed var(--border); border-radius: 999px; background: var(--panel); color: var(--muted); font-size: 13px; cursor: grab; user-select: none; }
.plots-editor-chip:hover { border-color: var(--plot-hue, var(--accent)); color: var(--text); }
.plots-editor-chip.placed { border: 1px solid var(--plot-hue, var(--accent)); color: var(--text); padding-left: 4px; }
.plots-editor-chip.missing { border-style: dashed; opacity: .7; }
.plots-editor-chip-position { min-width: 1.4em; padding: 0 5px; border-radius: 999px; background: var(--plot-hue, var(--accent)); color: #fff; font-size: 11px; font-weight: 700; text-align: center; }
.plots-editor-chip.dragging { opacity: .4; }
.plots-editor-chip.drop-before { box-shadow: -4px 0 0 -1px var(--plot-hue, var(--accent)); }
.plots-editor-chip.drop-after { box-shadow: 4px 0 0 -1px var(--plot-hue, var(--accent)); }
.plots-editor-chip:focus-visible { outline: 2px solid var(--plot-hue, var(--accent)); outline-offset: 2px; }
.plots-editor-color-control { display: flex; gap: 6px; align-items: center; }
.plots-editor-color-control input[type="color"] { width: 2.5rem; padding: 0; flex: none; }
.plots-editor-error { color: var(--err); min-height: 1.2em; }
@media (max-width: 700px) { .plots-editor-plot-head, .plots-editor-dataset { grid-template-columns: 1fr 1fr; } }
`;
  document.head.append(style);
}

/**
 * Edit a plots config; null means the modal was cancelled. focus opens the
 * editor at one place: a plotList index for that plot's settings, or "add"
 * for the Add a plot section.
 */
export async function openPlotsConfigEditor({ config, tables, openModal, focus }) {
  ensureStyle();
  nextPlotHue = 0; // each opening colours plots by their saved order
  const state = createEditorState(config);
  const focused = typeof focus === "number" ? state.cards[focus] : undefined;
  if (focused) Object.assign(focused, { collapsed: false, focusOnOpen: true });
  let focusAdd = focus === "add";
  const tableSources = [...new Set((tables || []).map((table) => table.source))];

  while (true) {
    let saveConfig = () => undefined;
    const outcome = await openModal({
      title: "Configure plots",
      modalClassName: "plots-config-modal",
      onMount(body) {
        const scroll = element("div", { className: "plots-editor-scroll" });
        const intro = element("p", { className: "field-hint plots-editor-intro", text: "Bind loaded tables to dataset names, then add and order plots. Open the advanced sections to edit every builder argument and Vega option as JSON." });
        const error = element("p", { className: "plots-editor-error", attrs: { role: "alert" }, text: state.error });
        const sections = element("div");
        // Setup sections are collapsible panels, so the plots stay the focus.
        const setupSection = (title) => element("details", { className: "plots-editor-setup" }, [
          element("summary", {}, [element("span", { className: "plots-editor-setup-title", text: title })]),
        ]);
        const globalSection = setupSection("Global Vega Embed options");
        const datasets = setupSection("Datasets");
        datasets.open = true;
        const plots = element("section", { className: "plots-editor-section plots-editor-plots" });
        scroll.append(intro, error, sections);
        body.append(scroll);

        const originalActions = state.globalOptions.actions;
        const actionOptions = originalActions && typeof originalActions === "object" ? originalActions : {};
        const exportOptions = actionOptions.export && typeof actionOptions.export === "object"
          ? actionOptions.export : {};
        // The action menu and its items, named as vega-embed's "…" menu shows them.
        const actionEnabled = checkbox("Show the action menu (the “…” button on each plot)", { checked: originalActions !== false });
        const exportPng = checkbox("Save as PNG", { checked: actionOptions.export !== false && exportOptions.png !== false });
        const exportSvg = checkbox("Save as SVG", { checked: actionOptions.export !== false && exportOptions.svg !== false });
        const sourceAction = checkbox("View Source", { checked: actionOptions.source !== false });
        const compiledAction = checkbox("View Compiled Vega", { checked: actionOptions.compiled === true });
        const editorAction = checkbox("Open in Vega Editor", { checked: actionOptions.editor !== false });
        const actionItems = [exportPng, exportSvg, sourceAction, compiledAction, editorAction];
        // Global options are limited to the theme and action links; other saved Vega Embed
        // options (renderer, tooltip, …) have no control here but are kept as they are.
        const savedTheme = typeof state.globalOptions.theme === "string" ? state.globalOptions.theme : "";
        const themeSelect = select([
          { value: "", label: "Default (Vega)" },
          ...VEGA_THEMES.map(([value, label]) => ({ value, label })),
          ...(savedTheme && !VEGA_THEMES.some(([value]) => value === savedTheme) ? [{ value: savedTheme, label: `${savedTheme} (not available)` }] : []),
        ], { value: savedTheme });
        const actionDetails = element("div", { className: "plots-editor-action-items" }, actionItems.map((item) => item.node));
        // PNG size: vega-embed's scaleFactor, saved for PNG only (a number would also resize SVG).
        const savedScale = state.globalOptions.scaleFactor;
        const savedPngScale = typeof savedScale === "number" ? savedScale : savedScale?.png;
        const knownScale = savedPngScale === undefined || [1, 2, 3, 4].includes(savedPngScale);
        const pngScale = select([
          { value: "", label: "1× (same as on screen)" },
          { value: "2", label: "2×" }, { value: "3", label: "3×" }, { value: "4", label: "4×" },
          ...(knownScale ? [] : [{ value: "__keep", label: `Custom: ${JSON.stringify(savedPngScale)} (unchanged)` }]),
        ], { value: knownScale ? (savedPngScale > 1 ? String(savedPngScale) : "") : "__keep" });
        pngScale.setAttribute("aria-label", "PNG size");
        const pngScaleField = element("div", { className: "plots-editor-png-scale" }, [
          field("PNG size", pngScale),
          element("p", { className: "field-hint", text: "Save as PNG makes an image this many times the plot's on-screen width and height. 2× or more gives sharper images for slides and print, in larger files. SVG is unaffected; it stays sharp at any size." }),
        ]);
        const updateActionAvailability = () => {
          const on = actionEnabled.input.checked;
          for (const item of actionItems) item.input.disabled = !on;
          actionDetails.classList.toggle("disabled", !on);
          // style, not hidden: the host's .field rule sets display and would override the attribute.
          pngScaleField.style.display = on && exportPng.input.checked ? "" : "none";
        };
        // The menu and its items stay consistent: an empty menu turns off, and turning
        // the menu on with nothing ticked brings back the usual items.
        actionEnabled.input.addEventListener("change", () => {
          if (actionEnabled.input.checked && !actionItems.some((item) => item.input.checked)) {
            for (const item of [exportPng, exportSvg, sourceAction, editorAction]) item.input.checked = true;
          }
          updateActionAvailability();
        });
        for (const item of actionItems) {
          item.input.addEventListener("change", () => {
            if (!actionItems.some((other) => other.input.checked)) actionEnabled.input.checked = false;
            updateActionAvailability();
          });
        }
        updateActionAvailability();
        globalSection.append(
          element("div", { className: "actions" }, [field("Theme", themeSelect)]),
          actionEnabled.node,
          actionDetails,
          pngScaleField,
        );

        const datasetList = element("div");
        datasets.append(datasetList);

        function renderDatasets() {
          datasetList.replaceChildren();
          for (const [index, dataset] of state.datasets.entries()) {
            const nameInput = element("input", { attrs: { type: "text", value: dataset.name, "aria-label": "Dataset name" } });
            const sourceSelect = element("select", { attrs: { "aria-label": `Table for ${dataset.name}` } });
            const available = [...new Set([...tableSources, ...(dataset.source && !tableSources.includes(dataset.source) ? [dataset.source] : [])])];
            sourceSelect.append(...available.map((source) => element("option", { text: source, attrs: { value: source } })));
            sourceSelect.value = dataset.source;
            nameInput.addEventListener("change", () => {
              const priorName = dataset.name;
              const nextName = nameInput.value.trim();
              if (!nextName) return;
              dataset.name = nextName;
              for (const card of state.cards) if (card.name === priorName) card.name = nextName;
              renderDatasets();
              renderPlots();
            });
            sourceSelect.addEventListener("change", () => { dataset.source = sourceSelect.value; renderPlots(); });
            const remove = button("Remove", {
              title: `Remove dataset ${dataset.name}`,
              onClick: () => {
                if (state.cards.some((card) => card.name === dataset.name)) {
                  state.error = `Remove plots using '${dataset.name}' before removing this dataset.`;
                  error.textContent = state.error;
                  return;
                }
                state.datasets.splice(index, 1);
                renderDatasets();
                renderPlots();
              },
            });
            remove.classList.add("subtle");
            datasetList.append(element("div", { className: "plots-editor-dataset" }, [
              field("Dataset name", nameInput), field("Loaded table", sourceSelect), remove,
            ]));
          }
          const addSource = selectTableSource();
          const addDataset = button("Add dataset", {
            onClick: () => {
              const source = addSource.value;
              if (!source || state.datasets.some((dataset) => dataset.source === source)) return;
              const used = new Set(state.datasets.map((dataset) => dataset.name));
              const name = uniqueDatasetName(source, used);
              state.datasets.push({ name, originalName: name, source, descriptor: {} });
              renderDatasets();
              renderPlots();
            },
          });
          datasetList.append(element("div", { className: "actions" }, [addSource, addDataset]));
        }

        function selectTableSource() {
          return element("select", { attrs: { "aria-label": "Select loaded table" } }, tableSources.map((source) => element("option", { text: source, attrs: { value: source } })));
        }

        function renderPlots() {
          plots.replaceChildren(element("h3", {}, [
            element("span", { text: "Plots" }),
            element("span", { className: "plots-editor-plots-count", text: state.cards.length ? String(state.cards.length) : "" }),
          ]));
          state.cards.forEach((card, index) => {
            const cardNode = element("article", { className: "plots-editor-plot" });
            cardNode.style.setProperty("--plot-hue", hueFor(card));
            const titleInput = element("input", { attrs: { type: "text", value: card.title, placeholder: "No title", "aria-label": `Plot ${index + 1} title` } });
            const datasetSelect = element("select", { attrs: { "aria-label": `Dataset for plot ${index + 1}` } });
            datasetSelect.append(...state.datasets.map((dataset) => element("option", { text: dataset.name, attrs: { value: dataset.name } })));
            datasetSelect.value = card.name;
            const builderSelect = element("select", { attrs: { "aria-label": `Builder for plot ${index + 1}` } });
            builderSelect.append(
              ...BUILDER_NAMES.map(plotTypeOption),
              element("option", { text: "Custom Vega / Vega-Lite spec", attrs: { value: "custom" } }),
            );
            if (card.mode === "builder" && !BUILDER_NAMES.includes(card.builder)) {
              builderSelect.append(element("option", { text: `${card.builder} (not available)`, attrs: { value: card.builder } }));
            }
            builderSelect.value = card.mode === "custom" ? "custom" : card.builder;
            const spanSelect = element("select", { attrs: { "aria-label": `Width for plot ${index + 1}` } }, [1, 2, 3].map((width) => element("option", { text: `${width} column${width === 1 ? "" : "s"}`, attrs: { value: width } })));
            spanSelect.value = String(card.span);
            const plotHeading = () => card.title.trim() || `Plot ${index + 1}`;
            const heading = element("h4", { className: "plots-editor-plot-title", text: plotHeading() });
            titleInput.addEventListener("input", () => {
              card.title = titleInput.value;
              card.titleEdited = true;
              heading.textContent = plotHeading();
            });
            datasetSelect.addEventListener("change", () => { card.name = datasetSelect.value; renderPlots(); });
            builderSelect.addEventListener("change", () => {
              card.mode = builderSelect.value === "custom" ? "custom" : "builder";
              if (card.mode === "builder") card.builder = builderSelect.value;
              renderPlots();
            });
            spanSelect.addEventListener("change", () => { card.span = Number(spanSelect.value); });

            const moveUp = button("↑ Move up", { title: "Move this plot earlier in the panel", onClick: () => movePlot(index, -1) });
            const moveDown = button("↓ Move down", { title: "Move this plot later in the panel", onClick: () => movePlot(index, 1) });
            const remove = button("✕ Remove plot", { title: "Remove this plot (Cancel discards all unsaved edits)", onClick: () => { state.cards.splice(index, 1); renderPlots(); } });
            remove.classList.add("danger");
            moveUp.disabled = index === 0;
            moveDown.disabled = index === state.cards.length - 1;
            const bodyId = `plots-editor-plot-body-${index}`;
            const toggle = element("button", {
              className: "plots-editor-plot-toggle",
              attrs: { type: "button", "aria-controls": bodyId },
            });
            const setCollapsed = (collapsed) => {
              card.collapsed = collapsed;
              cardNode.classList.toggle("collapsed", collapsed);
              toggle.setAttribute("aria-expanded", String(!collapsed));
              toggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} plot ${index + 1} settings`);
              toggle.title = collapsed ? "Show this plot's settings" : "Hide this plot's settings";
            };
            toggle.addEventListener("click", () => setCollapsed(!card.collapsed));
            const toolbar = element("div", { className: "plots-editor-plot-toolbar" }, [
              toggle,
              element("span", { className: "plots-editor-plot-number", text: String(index + 1), attrs: { title: `Plot ${index + 1} of ${state.cards.length}`, "aria-label": `Plot ${index + 1} of ${state.cards.length}` } }),
              heading,
              element("div", { className: "plots-editor-plot-buttons", attrs: { role: "group", "aria-label": `Plot ${index + 1} actions` } }, [moveUp, moveDown, remove]),
            ]);
            const head = element("div", { className: "plots-editor-plot-head" }, [
              field("Title", titleInput), field("Dataset", datasetSelect),
              field("Plot type", builderSelect), field("Card width", spanSelect),
            ]);
            // Clicking the bar itself (not its buttons) also expands or collapses the card.
            toolbar.addEventListener("click", (event) => {
              if (event.target.closest?.("button")) return;
              setCollapsed(!card.collapsed);
            });
            cardNode.append(toolbar, head);

            if (card.mode === "custom") {
              const customText = element("textarea", { className: "plots-editor-json", attrs: { "aria-label": `Custom spec JSON for plot ${index + 1}`, spellcheck: "false" } });
              customText.value = card.customText;
              customText.addEventListener("input", () => { card.customText = customText.value; });
              cardNode.append(field("Custom Vega or Vega-Lite specification", customText));
            } else {
              const argsText = element("textarea", { className: "plots-editor-json", attrs: { "aria-label": `Builder arguments JSON for plot ${index + 1}`, spellcheck: "false" } });
              argsText.value = card.argsText;
              const groups = new Map();
              function groupFor(key) {
                const name = argumentGroup(card.builder, key);
                if (!groups.has(name)) {
                  const inputs = element("div", { className: "plots-editor-group-inputs" });
                  const editors = element("div", { className: "plots-editor-group-editors" });
                  const node = element("fieldset", { className: "plots-editor-group" }, [groupLegend(name), inputs, editors]);
                  groups.set(name, { name, node, inputs, editors });
                }
                return groups.get(name);
              }
              function currentArgs() {
                const parsed = parseJson(card.argsText, `Plot ${index + 1} builder arguments`);
                return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed : {};
              }
              function currentTable() {
                const descriptor = state.datasets.find((dataset) => dataset.name === card.name);
                return tables.find((table) => table.source === descriptor?.source);
              }
              function fieldChoices() {
                return currentTable()?.header || [];
              }
              function distinctValues(column) {
                const table = currentTable();
                const position = table && column ? table.header.indexOf(column) : -1;
                if (position < 0) return [];
                return [...new Set(table.rows.map((row) => String(row[position] ?? "")).filter(Boolean))].slice(0, 200);
              }
              function setLabels(key, labels) {
                let args;
                try { args = currentArgs(); }
                catch (error) { state.error = error.message; return; }
                if (Object.keys(labels).length) args[key] = labels;
                else delete args[key];
                card.argsText = jsonText(args);
                argsText.value = card.argsText;
              }
              function setArgValue(key, value) {
                let args;
                try { args = currentArgs(); }
                catch (error) { state.error = error.message; return; }
                const empty = value === undefined || value === ""
                  || (value !== null && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);
                if (empty) delete args[key];
                else args[key] = value;
                card.argsText = jsonText(args);
                argsText.value = card.argsText;
              }
              function updateArgument(key, kind, raw) {
                let args;
                try { args = currentArgs(); }
                catch (error) { state.error = error.message; return; }
                if (raw === "__keep") return;
                if (raw === "") delete args[key];
                else if (kind === "number") {
                  const value = Number(raw);
                  if (!Number.isFinite(value)) return;
                  args[key] = value;
                } else if (kind === "boolean") args[key] = raw === "true";
                else if (kind === "json" || kind === "json-or-number") {
                  try { args[key] = JSON.parse(raw); }
                  catch (error) { state.error = `${key}: ${error.message}`; return; }
                } else if (kind === "json-or-text") {
                  try { args[key] = JSON.parse(raw); } catch { args[key] = raw; }
                } else args[key] = raw;
                card.argsText = jsonText(args);
                argsText.value = card.argsText;
                refreshPlaceholders();
                refreshTimeUnits();
                refreshDependents();
              }
              const args = currentArgs();
              const placeholderInputs = new Map();
              const timeUnitFields = new Map();
              // List editors that only make sense once their field is chosen.
              const dependentEditors = [];
              function refreshDependents() {
                let current;
                try { current = currentArgs(); }
                catch { return; }
                for (const { node, show } of dependentEditors) node.style.display = show(current) ? "" : "none";
                // A section whose editors are all hidden drops its divider and gap too.
                for (const container of new Set(dependentEditors.map((editor) => editor.container))) {
                  container.style.display = [...container.children].some((child) => child.style.display !== "none") ? "" : "none";
                }
              }
              const timeUnitSelects = new Map();
              /** An empty tooltip time unit falls back to the axis one in ro-crate-plots. */
              function timeUnitDefaultLabel(key, current) {
                const axisKey = key.replace("Tooltip", "");
                if (axisKey === key) return "None";
                const axisUnit = current[axisKey];
                return typeof axisUnit === "string" && axisUnit ? `Same as axis (${timeUnitLabel(axisUnit)})` : "Same as axis (none)";
              }
              function refreshTimeUnits() {
                let current;
                try { current = currentArgs(); }
                catch { return; }
                // style, not the hidden attribute: the host's .field rule sets display and would override it.
                for (const [key, node] of timeUnitFields) node.style.display = showTimeUnit(card.builder, current, key) ? "" : "none";
              }
              function refreshPlaceholders() {
                let current;
                try { current = currentArgs(); }
                catch { return; }
                const defaults = defaultPlaceholders(card.builder, current);
                for (const [key, input] of placeholderInputs) input.placeholder = defaults[key] ?? "";
                for (const picker of timeUnitSelects.values()) picker.refresh();
              }
              for (const [key, label, kind] of BUILDER_FIELDS[card.builder] || []) {
                if (key === "title") continue;
                const group = groupFor(key);
                const shortLabel = groupedLabel(label, group.name);
                if (key === "palette") {
                  const editor = paletteEditor({
                    palette: args.palette,
                    allowCustom: card.builder !== "plotMapHeatmap",
                    getValues: () => { try { return distinctValues(currentArgs().colorVar); } catch { return []; } },
                    onChange: (value) => setArgValue("palette", value),
                  });
                  group.editors.append(editor);
                  // Map heatmaps colour by density, not by a field, so their palette always applies.
                  if (card.builder !== "plotMapHeatmap") dependentEditors.push({ node: editor, container: group.editors, show: (current) => hasValue(current.colorVar) || hasValue(current.palette) });
                  continue;
                }
                if (key === "sort") {
                  const categoryField = () => {
                    const current = currentArgs();
                    return card.builder === "boxPlot" ? boxPlotCategoryField(current) : current.xVar;
                  };
                  const editor = sortEditor({
                    label,
                    sort: args.sort,
                    byCount: kind === "sort-count",
                    getValues: () => { try { return distinctValues(categoryField()); } catch { return []; } },
                    onChange: (value) => setArgValue("sort", value),
                  });
                  group.editors.append(editor);
                  dependentEditors.push({
                    node: editor, container: group.editors,
                    show: (current) => hasValue(card.builder === "boxPlot" ? boxPlotCategoryField(current) : current.xVar) || hasValue(current.sort),
                  });
                  continue;
                }
                if (LABEL_SOURCES[key]) {
                  const editor = labelsEditor({
                    label: shortLabel.replace(" (JSON)", ""),
                    labels: args[key],
                    getValues: () => { try { return distinctValues(currentArgs()[LABEL_SOURCES[key]]); } catch { return []; } },
                    onChange: (labels) => setLabels(key, labels),
                  });
                  group.editors.append(editor);
                  dependentEditors.push({ node: editor, container: group.editors, show: (current) => hasValue(current[LABEL_SOURCES[key]]) || hasValue(current[key]) });
                  continue;
                }
                let control;
                let help;
                const raw = args[key] === undefined ? "" : typeof args[key] === "object" ? jsonText(args[key]) : String(args[key]);
                if (kind === "column" || kind === "field-type") {
                  control = element("select", { attrs: { "aria-label": label } });
                  const fallback = defaultPlaceholders(card.builder, args)[key];
                  control.append(element("option", { text: fallback ? `Default (${fallback})` : "(not set)", attrs: { value: "" } }));
                  // A histogram bins numbers or dates, so only those types are offered for its X field.
                  const types = card.builder === "histogramPlot" && key === "xType"
                    ? ["quantitative", "temporal"] : ["quantitative", "temporal", "ordinal", "nominal"];
                  const values = kind === "column" ? fieldChoices() : types;
                  control.append(...values.map((value) => element("option", { text: value, attrs: { value } })));
                  if (kind === "field-type" && raw && !types.includes(raw)) {
                    control.append(element("option", { text: `${raw} (not usable here)`, attrs: { value: raw } }));
                  }
                  control.value = raw;
                } else if (kind === "stack-bars") {
                  const { fallback, choices, tooltip } = STACK_BARS_CHOICES[card.builder];
                  const known = !raw || choices.some(([value]) => value === raw);
                  control = select([
                    { value: "", label: `Default (${choices.find(([value]) => value === fallback)[1]})` },
                    ...choices.map(([value, text]) => ({ value, label: text })),
                    ...(known ? [] : [{ value: "__keep", label: `Custom: ${raw} (unchanged)` }]),
                  ], { value: known ? raw : "__keep" });
                  control.setAttribute("aria-label", label);
                  help = tooltip;
                } else if (kind === "invalid-values") {
                  const known = INVALID_VALUE_CHOICES.some((choice) => choice.value === raw);
                  control = select([
                    { value: "", label: "Default (show and flag)" },
                    ...INVALID_VALUE_CHOICES,
                    ...(raw && !known ? [{ value: raw, label: `${raw} (not recognised)` }] : []),
                  ], { value: raw });
                  control.setAttribute("aria-label", label);
                  help = [
                    "What to do with rows whose X, Y, or color value is blank or cannot be read as the specified field type (e.g., a letter in a quantitative field):",
                    "Show and flag: keep the rows; missing values appear as their own category, in grey where possible. " +
                      "Where numbers or dates are summarised (e.g., grouped into bins in a histogram, or into a box plot's quartiles), invalid values are always left out.",
                    "Hide: leave the rows out of the plot.",
                    "Either way, a red note above the plot gives the number of such rows.",
                  ];
                } else if (kind === "time-unit") {
                  // Not wrapped in a <label>: a click inside would be forwarded to its first checkbox.
                  const picker = timeUnitPicker({
                    label,
                    value: args[key],
                    defaultLabel: () => { try { return timeUnitDefaultLabel(key, currentArgs()); } catch { return "None"; } },
                    onChange: (unit) => updateArgument(key, kind, unit),
                    // Tooltip units fall back to the axis unit when left empty.
                    inherit: key.includes("Tooltip")
                      ? () => { try { return currentArgs()[key.replace("Tooltip", "")]; } catch { return ""; } }
                      : undefined,
                  });
                  timeUnitSelects.set(key, picker);
                  const fieldNode = element("div", { className: "field" }, [element("span", { className: "field-label", text: shortLabel }), picker.node]);
                  timeUnitFields.set(key, fieldNode);
                  group.inputs.append(fieldNode);
                  continue;
                } else if (kind === "boolean") {
                  control = element("select", { attrs: { "aria-label": label } }, [
                    element("option", { text: "Default", attrs: { value: "" } }),
                    element("option", { text: "On", attrs: { value: "true" } }),
                    element("option", { text: "Off", attrs: { value: "false" } }),
                  ]);
                  control.value = raw;
                } else {
                  control = element("input", { attrs: { type: kind === "number" ? "number" : "text", value: raw, "aria-label": label } });
                  placeholderInputs.set(key, control);
                }
                control.addEventListener("change", () => updateArgument(key, kind, control.value));
                const fieldNode = help ? helpField(shortLabel, control, help) : field(shortLabel, control);
                if (TIME_UNIT_AXES[key]) timeUnitFields.set(key, fieldNode);
                // Bar layout only splits bars once a color field is chosen.
                if (key === "stackBars") dependentEditors.push({ node: fieldNode, container: group.inputs, show: (current) => hasValue(current.colorVar) || hasValue(current.stackBars) });
                group.inputs.append(fieldNode);
              }
              refreshPlaceholders();
              refreshTimeUnits();
              refreshDependents();
              argsText.addEventListener("change", () => {
                card.argsText = argsText.value;
                try { parseJson(card.argsText, `Plot ${index + 1} builder arguments`); renderPlots(); }
                catch (error) { state.error = error.message; }
              });
              // "Other" holds plot-wide settings, so it closes the card's sections whatever order they were met in.
              const ordered = [...groups.values()].sort((a, b) => (a.name === "Other") - (b.name === "Other"));
              cardNode.append(...ordered.map((group) => group.node), advanced("All builder arguments (JSON)", argsText));
            }
            const embedJson = element("textarea", { className: "plots-editor-json", attrs: { "aria-label": `Vega Embed options JSON for plot ${index + 1}`, spellcheck: "false" } });
            embedJson.value = jsonText(card.embed);
            embedJson.addEventListener("change", () => {
              try {
                const parsed = parseJson(embedJson.value, `Plot ${index + 1} embed options`);
                if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`Plot ${index + 1} embed options must be a JSON object.`);
                card.embed = parsed;
                renderPlots();
              } catch (error) {
                state.error = error.message;
              }
            });
            cardNode.append(element("fieldset", { className: "plots-editor-group" }, [
              groupLegend("Vega Embed options for this plot"),
              element("div", { className: "plots-editor-group-inputs" }, embedControls(card, () => { embedJson.value = jsonText(card.embed); })),
              advanced("Vega Embed options (JSON)", embedJson),
            ]));
            // Everything below the header bar is the collapsible body.
            const cardBody = element("div", { className: "plots-editor-plot-body", attrs: { id: bodyId } });
            cardBody.append(...[...cardNode.childNodes].filter((node) => node !== toolbar));
            cardNode.append(cardBody);
            setCollapsed(Boolean(card.collapsed));
            plots.append(cardNode);
            if (card.scrollIntoView) {
              delete card.scrollIntoView;
              queueMicrotask(() => cardNode.scrollIntoView?.({ block: "nearest", behavior: "smooth" }));
            }
            // Opened from a plot in the panel: bring its card to the top, put the cursor in its
            // title, and flash it so it is clear which plot this is. Waits a frame for the modal to mount.
            if (card.focusOnOpen) {
              delete card.focusOnOpen;
              requestAnimationFrame(() => {
                cardNode.scrollIntoView?.({ block: "start", behavior: "smooth" });
                titleInput.focus({ preventScroll: true });
                cardNode.classList.add("flash");
                cardNode.addEventListener("animationend", () => cardNode.classList.remove("flash"), { once: true });
              });
            }
          });

          const addType = element("select", { attrs: { "aria-label": "New plot type" } }, BUILDER_NAMES.map(plotTypeOption));
          const lastBuilder = [...state.cards].reverse().find((card) => card.mode === "builder" && BUILDER_NAMES.includes(card.builder))?.builder;
          if (lastBuilder) addType.value = lastBuilder;
          const addDatasetSelect = element("select", { attrs: { "aria-label": "Dataset for new plot" } }, state.datasets.map((dataset) => element("option", {
            text: dataset.name,
            attrs: { value: dataset.name },
          })));
          addDatasetSelect.value = state.cards.at(-1)?.name || state.datasets[0]?.name || "";
          const addPlotButton = button("＋ Add plot", {
            primary: true,
            onClick: () => {
              const dataset = addDatasetSelect.value;
              if (!dataset) {
                state.error = "Add a dataset before adding a plot.";
                error.textContent = state.error;
                return;
              }
              state.cards.push({
                original: { dataset: { name: dataset }, makeSpec: { plotFunction: addType.value, args: {} }, generatedSpec: {}, customSpec: {}, config: {}, plotCardSpan: 1 },
                mode: "builder", builder: addType.value, name: dataset, title: "", span: 1,
                titleEdited: false, argsText: "{}", customText: "{}", embed: {},
                collapsed: false, scrollIntoView: true,
              });
              renderPlots();
            },
          });
          addPlotButton.disabled = !state.datasets.length;
          const addSection = element("section", { className: "plots-editor-add", attrs: { "aria-label": "Add a plot" } }, [
            element("h4", { className: "plots-editor-add-title", text: "Add a plot" }),
            element("div", { className: "plots-editor-add-row" }, [
              field("Plot type", addType),
              field("Dataset", addDatasetSelect),
              addPlotButton,
            ]),
            ...(state.datasets.length ? [] : [element("p", { className: "field-hint", text: "Add a dataset above first." })]),
          ]);
          plots.append(addSection);
          // Opened from the panel's Add a plot tile: same treatment as a plot opened from its card.
          if (focusAdd) {
            focusAdd = false;
            requestAnimationFrame(() => {
              addSection.scrollIntoView?.({ block: "center", behavior: "smooth" });
              addType.focus({ preventScroll: true });
              addSection.classList.add("flash");
              addSection.addEventListener("animationend", () => addSection.classList.remove("flash"), { once: true });
            });
          }
        }

        function movePlot(index, amount) {
          const target = index + amount;
          if (target < 0 || target >= state.cards.length) return;
          [state.cards[index], state.cards[target]] = [state.cards[target], state.cards[index]];
          renderPlots();
        }

        function collectConfig() {
          const next = clone(state.base);
          const globalConfig = clone(state.globalOptions);
          delete globalConfig.actions;
          if (actionEnabled.input.checked) {
            const priorExport = actionOptions.export && typeof actionOptions.export === "object"
              ? actionOptions.export : {};
            globalConfig.actions = {
              ...actionOptions,
              export: exportPng.input.checked || exportSvg.input.checked
                ? { ...priorExport, png: exportPng.input.checked, svg: exportSvg.input.checked }
                : false,
              source: sourceAction.input.checked,
              compiled: compiledAction.input.checked,
              editor: editorAction.input.checked,
            };
          } else globalConfig.actions = false;
          if (themeSelect.value) globalConfig.theme = themeSelect.value;
          else delete globalConfig.theme;
          if (pngScale.value !== "__keep") {
            // Keep any SVG part of the saved scaleFactor; a plain number used to cover both.
            const svgScale = typeof savedScale === "number" ? savedScale : savedScale?.svg;
            const scaleFactor = {
              ...(savedScale && typeof savedScale === "object" ? savedScale : {}),
              ...(svgScale !== undefined && svgScale !== 1 ? { svg: svgScale } : {}),
            };
            delete scaleFactor.png;
            if (pngScale.value) scaleFactor.png = Number(pngScale.value);
            if (Object.keys(scaleFactor).length) globalConfig.scaleFactor = scaleFactor;
            else delete globalConfig.scaleFactor;
          }
          next.plots.globalConfig = globalConfig;
          const datasets = {};
          for (const dataset of state.datasets) {
            if (!dataset.name) throw new Error("Every dataset needs a name.");
            if (Object.hasOwn(datasets, dataset.name)) throw new Error(`Dataset name '${dataset.name}' is duplicated.`);
            const descriptor = { ...clone(dataset.descriptor), source: dataset.source };
            datasets[dataset.name] = descriptor;
          }
          next.plots.datasets = datasets;
          next.plots.plotList = state.cards.map((card, index) => {
            const plot = clone(card.original);
            plot.dataset = { ...(plot.dataset || {}), name: card.name };
            plot.config = clone(card.embed);
            plot.plotCardSpan = card.span;
            plot.span = card.span;
            if (card.mode === "custom") {
              plot.customSpec = parseJson(card.customText, `Plot ${index + 1} custom spec`);
              if (!plot.customSpec || Array.isArray(plot.customSpec) || typeof plot.customSpec !== "object") {
                throw new Error(`Plot ${index + 1} custom spec must be a JSON object.`);
              }
              if (card.titleEdited) {
                if (card.title) plot.customSpec.title = card.title;
                else delete plot.customSpec.title;
              }
            } else {
              plot.makeSpec = { ...(plot.makeSpec || {}), plotFunction: card.builder, args: parseJson(card.argsText, `Plot ${index + 1} builder arguments`) };
              if (!plot.makeSpec.args || Array.isArray(plot.makeSpec.args) || typeof plot.makeSpec.args !== "object") {
                throw new Error(`Plot ${index + 1} builder arguments must be a JSON object.`);
              }
              if (card.titleEdited) {
                if (card.title) plot.makeSpec.args.title = card.title;
                else delete plot.makeSpec.args.title;
              }
              plot.customSpec = {};
            }
            return plot;
          });
          return validatePlotsConfig(next);
        }

        sections.append(globalSection, datasets, plots);
        renderDatasets();
        renderPlots();
        saveConfig = () => {
          try { return { config: collectConfig() }; }
          catch (error) { return { invalid: error.message }; }
        };
      },
      actions: [
        { label: "Cancel", value: null },
        { label: "Save configuration", primary: true, value: () => saveConfig() },
      ],
    });
    if (outcome === null) return null;
    if (outcome?.config) return outcome.config;
    if (outcome?.invalid) { state.error = outcome.invalid; continue; }
    return null;
  }
}