// The tabular chart: pick a table, a chart type and two columns, get an SVG.
//
// This was collection2crate's Visualise page itself until the page became a
// panel host. Moving it here makes it a panel like the other two — selectable,
// and leave-out-able from a deployment's PLUGINS (SPEC-PLUGINS.md).
//
// No chart library: axes, ticks and one mark per row, drawn by hand, themed
// through the app's CSS custom properties so it follows light and dark.

import { element, note, select } from "../../src/_panel.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 720;
const HEIGHT = 300;
const MARGIN = { top: 16, right: 16, bottom: 56, left: 64 };
const TICKS = 4;

const toNumber = (value) => {
  const n = Number(String(value ?? "").replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const formatTick = (value) =>
  (Math.abs(value) >= 1000 ? `${Math.round(value / 100) / 10}k` : String(Math.round(value * 100) / 100));

const truncate = (value, length) => (value.length > length ? `${value.slice(0, length - 1)}…` : value);

/**
 * Everything the drawing needs, worked out from the data alone.
 *
 * Separated from the SVG because this is the half that can be wrong without
 * looking wrong: a scale that clips the tallest bar, a baseline that isn't at
 * zero, a tick that rounds to a number nobody has. The drawing below only
 * places what this returns.
 *
 * `skipped` is the count of rows whose y value was not a number. They are left
 * out rather than coerced to zero — a column of "n/a" plotted as a floor of
 * zeroes is a chart that lies — and the panel reports the number.
 *
 * @returns {{points, skipped, scale, ticks, step, labelEvery, plot}}
 */
export function chartGeometry(rows, { xColumn, yColumn, width = WIDTH, height = HEIGHT } = {}) {
  const all = (rows || []).map((row) => ({
    label: String(row[xColumn] ?? ""),
    value: toNumber(row[yColumn]),
  }));
  const points = all.filter((point) => point.value !== null);
  const skipped = all.length - points.length;

  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;
  const values = points.map((point) => point.value);
  // Zero is always in view: a bar chart whose baseline floats is a bar chart
  // whose bars mean nothing.
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const y = (value) => MARGIN.top + innerHeight - ((value - min) / span) * innerHeight;

  return {
    points,
    skipped,
    plot: { width, height, innerWidth, innerHeight, margin: MARGIN },
    scale: { min, max, span, y },
    ticks: Array.from({ length: TICKS + 1 }, (_, i) => {
      const value = min + (span * i) / TICKS;
      return { value, y: y(value), label: formatTick(value) };
    }),
    step: points.length ? innerWidth / points.length : innerWidth,
    // A label under every mark goes unread; the table below carries them all.
    labelEvery: Math.max(1, Math.ceil(points.length / 12)),
  };
}

const svg = (name, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

const svgText = (x, y, content, attrs = {}) => {
  const node = svg("text", { x, y, fill: "var(--muted)", "font-size": 11, "font-family": "inherit", ...attrs });
  node.textContent = content;
  return node;
};

function drawChart(geometry, { type, xColumn, yColumn, caption }) {
  const { points, plot, scale, step, labelEvery } = geometry;
  const { margin, width, height } = plot;
  const root = svg("svg", {
    class: "chart-svg",
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${type} chart of ${yColumn} by ${xColumn}`,
  });

  for (const tick of geometry.ticks) {
    root.append(svg("line", {
      x1: margin.left, x2: width - margin.right, y1: tick.y, y2: tick.y,
      stroke: "var(--border)", "stroke-width": 1,
    }));
    root.append(svgText(margin.left - 8, tick.y + 4, tick.label, { "text-anchor": "end" }));
  }

  const describe = (node, point) => {
    const say = () => { caption.textContent = `${xColumn}: ${point.label} · ${yColumn}: ${point.value}`; };
    node.addEventListener("mouseenter", say);
    node.addEventListener("focus", say);
  };

  if (type === "bar") {
    const barWidth = Math.max(2, step - 2);
    points.forEach((point, index) => {
      const top = Math.min(scale.y(point.value), scale.y(0));
      const bar = svg("rect", {
        x: margin.left + index * step + 1, y: top, width: barWidth,
        height: Math.max(1, Math.abs(scale.y(point.value) - scale.y(0))),
        rx: 4, fill: "var(--accent)", tabindex: "0", role: "graphics-symbol",
        "aria-label": `${point.label}: ${point.value}`,
      });
      describe(bar, point);
      root.append(bar);
    });
  } else {
    const cx = (index) => margin.left + index * step + step / 2;
    if (type === "line") {
      root.append(svg("polyline", {
        points: points.map((point, index) => `${cx(index)},${scale.y(point.value)}`).join(" "),
        fill: "none", stroke: "var(--accent)", "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round",
      }));
    }
    points.forEach((point, index) => {
      const dot = svg("circle", {
        cx: cx(index), cy: scale.y(point.value), r: 5, fill: "var(--accent)",
        stroke: "var(--panel)", "stroke-width": 2, tabindex: "0",
        role: "graphics-symbol", "aria-label": `${point.label}: ${point.value}`,
      });
      // A hit area larger than the mark: a 10px dot is not a pointing target.
      const target = svg("circle", { cx: cx(index), cy: scale.y(point.value), r: 12, fill: "transparent" });
      describe(dot, point);
      describe(target, point);
      root.append(dot, target);
    });
  }

  points.forEach((point, index) => {
    if (index % labelEvery) return;
    const x = margin.left + index * step + step / 2;
    root.append(svgText(x, height - 32, truncate(point.label, 12), {
      "text-anchor": "end", transform: `rotate(-35 ${x} ${height - 32})`,
    }));
  });
  root.append(svgText(width / 2, height - 6, xColumn, { "text-anchor": "middle", "font-weight": "600" }));
  return root;
}

export function createPlugin() {
  return {
    name: "chart",
    visualisation: {
      label: "Chart",
      hint: "Plot one column against another from a tabular output.",
      render(container, { tables = [] }) {
        if (!tables.length) {
          container.replaceChildren(note(
            "No tabular output in this folder. Turn on a tabular output — “Export RO-Crate tables”, " +
            "or transcript processing for its CSVs — and build."
          ));
          return;
        }

        const tableSelect = select(tables.map((table, index) => ({ value: String(index), label: table.source })));
        const typeSelect = select([
          { value: "bar", label: "Bar" }, { value: "line", label: "Line" }, { value: "scatter", label: "Scatter" },
        ]);
        const xSelect = select([]);
        const ySelect = select([]);
        const chartHost = element("div", { className: "panel" });
        const status = element("p", { className: "field-hint" });
        const { body, node: tableNode } = { body: element("tbody"), node: element("div", { className: "table-scroll" }) };
        const preview = element("table", { className: "data-table mono" }, [element("thead"), body]);
        tableNode.append(preview);

        const current = () => tables[Number(tableSelect.value) || 0];

        function fillColumns() {
          const { header } = current();
          for (const node of [xSelect, ySelect]) {
            node.replaceChildren(...header.map((name) => element("option", { text: name, attrs: { value: name } })));
          }
          xSelect.value = header[0] || "";
          // Default the value axis to the first column that holds numbers —
          // otherwise every table opens on an empty chart the person has to fix.
          const numeric = header.find((name, index) =>
            current().rows.slice(0, 40).some((row) => toNumber(row[index]) !== null));
          ySelect.value = numeric || header[1] || header[0] || "";
        }

        function rowObjects() {
          const { header, rows } = current();
          return rows.map((row) => Object.fromEntries(header.map((name, index) => [name, row[index]])));
        }

        function renderPreview() {
          const { header, rows } = current();
          preview.querySelector("thead").replaceChildren(
            element("tr", {}, header.map((name) => element("th", { text: name }))));
          body.replaceChildren(...rows.slice(0, 200).map((row) =>
            element("tr", {}, row.map((cell) => element("td", { text: String(cell ?? "") })))));
        }

        function draw() {
          const xColumn = xSelect.value;
          const yColumn = ySelect.value;
          chartHost.replaceChildren();
          if (!xColumn || !yColumn) { chartHost.append(note("Choose two columns.")); return; }

          const geometry = chartGeometry(rowObjects(), { xColumn, yColumn });
          const skippedNote = geometry.skipped
            ? `${geometry.skipped} row(s) skipped — “${yColumn}” is not a number there.`
            : "";
          if (!geometry.points.length) {
            chartHost.append(note(`No numeric values in “${yColumn}” — choose another column for the value axis.`));
            status.textContent = skippedNote;
            return;
          }
          const caption = element("p", { className: "field-hint", attrs: { "aria-live": "polite" } });
          caption.textContent = `${geometry.points.length} row(s) · hover or focus a mark for its value`;
          chartHost.append(
            element("h3", { className: "section-heading", text: `${yColumn} by ${xColumn}` }),
            drawChart(geometry, { type: typeSelect.value, xColumn, yColumn, caption }),
            caption,
          );
          status.textContent = skippedNote;
        }

        tableSelect.addEventListener("change", () => { fillColumns(); renderPreview(); draw(); });
        for (const node of [typeSelect, xSelect, ySelect]) node.addEventListener("change", draw);

        container.replaceChildren(
          element("div", { className: "actions" }, [
            element("label", { className: "field" }, [element("span", { className: "field-label", text: "Table" }), tableSelect]),
            element("label", { className: "field" }, [element("span", { className: "field-label", text: "Chart" }), typeSelect]),
            element("label", { className: "field" }, [element("span", { className: "field-label", text: "Category / x" }), xSelect]),
            element("label", { className: "field" }, [element("span", { className: "field-label", text: "Value / y" }), ySelect]),
          ]),
          status,
          chartHost,
          tableNode,
        );

        fillColumns();
        renderPreview();
        draw();
      },
    },
  };
}
