// The plots panel's pure seams: table rows, plot config validation, the
// Vega specs it generates and the map projection.
//
// DOM stays untested, as the rest of the UI does. What is tested is the half
// that can be wrong while looking right. Split out of the package's former
// visualisation.test.mjs, one file per panel.
//
//   npm test -w collection2crate-plugins -- plots.test.mjs
import assert from "node:assert/strict";
import { BUILDER_NAMES, createDefaultConfig, dataLayer, datasetsForConfig, embedOptions, generatePlotSpecs, layoutSpan, mapRowsFromColumns, tableToRows, validatePlotsConfig } from "./model.js";
import { projectMapPoints } from "./map.js";
import { libraryPin } from "./index.js";
import * as vega from "vega";
import { compile as compileVegaLite } from "vega-lite";

let failures = 0;
const asyncChecks = [];
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};
const checkAsync = (label, fn) => {
  asyncChecks.push((async () => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
  })());
};

check("converts table rows to unique object keys", () => {
  assert.deepEqual(tableToRows({ header: ["name", "name", ""], rows: [["Ada", "Lovelace", "x"]] }), [
    { name: "Ada", "name (2)": "Lovelace", "column 3": "x" },
  ]);
  assert.deepEqual(tableToRows({ header: ["name"], rows: [] }), []);
});

check("blank cells become null so the plots library counts them as missing", () => {
  assert.deepEqual(tableToRows({ header: ["a", "b", "c"], rows: [["", "  ", "0"], ["x"]] }), [
    { a: null, b: null, c: "0" },
    { a: "x", b: null, c: null },
  ]);
});

check("creates named datasets from loaded tables and validates config shape", () => {
  const tables = [
    { source: "_outputs/roctable/People.csv", header: ["name"], rows: [["Ada"]] },
    { source: "_outputs/roctable/Places.csv", header: ["place"], rows: [["Sydney"]] },
  ];
  const config = createDefaultConfig(tables);
  assert.deepEqual(Object.keys(config.plots.datasets), ["People", "Places"]);
  assert.deepEqual(datasetsForConfig(tables.slice(0, 1), config).missing.map(({ name }) => name), ["Places"]);
  config.futureOption = { preserved: true };
  assert.deepEqual(validatePlotsConfig(config).futureOption, { preserved: true });
});

checkAsync("generates table-backed builder specs and merges plot embed options", async () => {
  const table = { source: "people.csv", header: ["name", "group"], rows: [["Ada", "A"], ["Lin", "B"]] };
  const config = createDefaultConfig([table]);
  const datasetName = Object.keys(config.plots.datasets)[0];
  config.plots.globalConfig = { actions: false, renderer: "svg" };
  config.plots.plotList.push({
    dataset: { name: datasetName },
    makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group", title: "People" } },
    generatedSpec: {}, customSpec: {}, config: { renderer: "canvas" }, plotCardSpan: 2,
  });
  const { plots, missing } = await generatePlotSpecs(config, [table]);
  assert.deepEqual(missing, []);
  assert.equal(plots[0].spec.data.values[0].name, "Ada");
  assert.deepEqual(embedOptions(config, config.plots.plotList[0]), { actions: false, renderer: "canvas" });
  assert.equal(layoutSpan(config.plots.plotList[0]), 2);
});

checkAsync("multiple plots can reuse one configured dataset", async () => {
  const table = { source: "people.csv", header: ["name", "group"], rows: [["Ada", "A"], ["Lin", "B"]] };
  const config = createDefaultConfig([table]);
  const datasetName = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push(
    { dataset: { name: datasetName }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group" } }, customSpec: {}, config: {} },
    { dataset: { name: datasetName }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "name" } }, customSpec: {}, config: {} },
  );
  const { plots, missing } = await generatePlotSpecs(config, [table]);
  assert.deepEqual(missing, []);
  assert.equal(plots.length, 2);
  assert.deepEqual(plots.map((result) => result.spec.data.values), [
    [{ name: "Ada", group: "A" }, { name: "Lin", group: "B" }],
    [{ name: "Ada", group: "A" }, { name: "Lin", group: "B" }],
  ]);
  assert.deepEqual(plots.map((result) => result.plot.dataset.name), [datasetName, datasetName]);
});

checkAsync("a value-to-color palette becomes the color scale without mutating config", async () => {
  const table = { source: "people.csv", header: ["name", "sex"], rows: [["Ada", "Female"], ["Lin", "Male"]] };
  const config = createDefaultConfig([table]);
  const datasetName = Object.keys(config.plots.datasets)[0];
  const palette = { Female: "#ff69b4", Male: "#1e90ff" };
  config.plots.plotList.push({
    dataset: { name: datasetName },
    makeSpec: { plotFunction: "barPlotCount", args: { xVar: "name", colorVar: "sex", palette } },
    customSpec: {}, config: {},
  });
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.equal(plots[0].error, null);
  assert.deepEqual(dataLayer(plots[0].spec).encoding.color.scale, { domain: ["Female", "Male"], range: ["#ff69b4", "#1e90ff"] });
  assert.deepEqual(config.plots.plotList[0].makeSpec.args.palette, palette);
});

checkAsync("bar and box plot category order reaches the plotted layer", async () => {
  const table = { source: "people.csv", header: ["group", "age"], rows: [["A", "30"], ["B", "40"], ["C", "50"]] };
  const config = createDefaultConfig([table]);
  const name = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push(
    { dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group", sort: "descending" } } },
    { dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group", sort: ["C", "A"] } } },
    { dataset: { name }, makeSpec: { plotFunction: "boxPlot", args: { xVar: "group", yVar: "age", yType: "quantitative", sort: ["B"] } } },
  );
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.deepEqual(plots.map((result) => result.error), [null, null, null]);
  assert.deepEqual(dataLayer(plots[0].spec).encoding.x.sort, { op: "count", field: "group", order: "descending" });
  assert.deepEqual(dataLayer(plots[1].spec).encoding.x.sort, ["C", "A"]);
  assert.deepEqual(dataLayer(plots[2].spec).encoding.x.sort, ["B"]);
});

checkAsync("hiding invalid values filters blank cells from the plotted layer and keeps the warning layer", async () => {
  const table = { source: "people.csv", header: ["group"], rows: [["A"], [""]] };
  const config = createDefaultConfig([table]);
  const name = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push(
    { dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group", invalidValues: "hide" } } },
    { dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group" } } },
  );
  const { plots } = await generatePlotSpecs(config, [table]);
  const [hidden, shown] = plots.map((result) => result.spec);
  assert.deepEqual(hidden.data.values[1], { group: null });
  const [filter] = dataLayer(hidden).transform;
  assert.match(filter.filter, /group/, "the plotted layer filters on the X field");
  assert.ok(!(dataLayer(shown).transform || []).some((step) => step.filter), "the default shows missing values");
  for (const spec of [hidden, shown]) {
    assert.ok(spec.layer.some((layer) => layer.description === "_missing_values_warning"));
  }
});

checkAsync("generated specs run in Vega for column names that are not identifiers, like roctable's @id", async () => {
  const table = { source: "objects.csv", header: ["@type", "speaker age", "schema:year"], rows: [["Person", "30", "1978"], ["", "41", ""]] };
  const config = createDefaultConfig([table]);
  const name = Object.keys(config.plots.datasets)[0];
  for (const invalidValues of ["show", "hide"]) {
    config.plots.plotList.push(
      { dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "@type", invalidValues } } },
      { dataset: { name }, makeSpec: { plotFunction: "scatterPlot", args: { xVar: "speaker age", yVar: "schema:year", colorVar: "@type", invalidValues } } },
    );
  }
  const { plots } = await generatePlotSpecs(config, [table]);
  for (const result of plots) {
    assert.equal(result.error, null);
    const view = new vega.View(vega.parse(compileVegaLite(result.spec).spec), { renderer: "none" });
    await view.runAsync();
  }
});

checkAsync("bar plots of percentages render in every bar layout, with and without a color field", async () => {
  const table = { source: "people.csv", header: ["group", "sex"], rows: [["A", "F"], ["A", "M"], ["B", "F"], ["B", ""]] };
  const config = createDefaultConfig([table]);
  const name = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push({ dataset: { name }, makeSpec: { plotFunction: "barPlotPercent", args: { xVar: "group" } } });
  for (const stackBars of [undefined, "stack", "side_by_side", "stack_and_normalize"]) {
    config.plots.plotList.push({ dataset: { name }, makeSpec: { plotFunction: "barPlotPercent", args: { xVar: "group", colorVar: "sex", stackBars } } });
  }
  config.plots.plotList.push({ dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group", colorVar: "sex", stackBars: "side_by_side" } } });
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.ok(BUILDER_NAMES.includes("barPlotPercent"));
  for (const result of plots) {
    assert.equal(result.error, null);
    await new vega.View(vega.parse(compileVegaLite(result.spec).spec), { renderer: "none" }).runAsync();
  }
});

checkAsync("histograms report a missing type or date bin size, and ignore dropped bin options", async () => {
  const table = { source: "people.csv", header: ["born", "age"], rows: [["1978-03-01", "30"], ["1991-01-01", "41"]] };
  const config = createDefaultConfig([table]);
  const name = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push(
    { dataset: { name }, makeSpec: { plotFunction: "histogramPlot", args: { xVar: "age" } } },
    { dataset: { name }, makeSpec: { plotFunction: "histogramPlot", args: { xVar: "born", xType: "temporal" } } },
    { dataset: { name }, makeSpec: { plotFunction: "histogramPlot", args: { xVar: "born", xType: "temporal", xTimeUnit: "year", step: 5 } } },
    { dataset: { name }, makeSpec: { plotFunction: "histogramPlot", args: { xVar: "age", xType: "quantitative", maxbins: 10, nice: true } } },
  );
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.match(plots[0].error, /quantitative or temporal/);
  assert.match(plots[1].error, /time unit/);
  assert.equal(plots[2].error, null);
  assert.equal(plots[3].error, null);
  assert.match(plots[3].warnings.join(" "), /maxbins, nice no longer apply/);
  for (const result of plots.slice(2)) await new vega.View(vega.parse(compileVegaLite(result.spec).spec), { renderer: "none" }).runAsync();
});

checkAsync("custom specs bind the selected in-memory dataset without mutating config", async () => {
  const table = { source: "people.csv", header: ["name"], rows: [["Ada"]] };
  const config = createDefaultConfig([table]);
  const datasetName = Object.keys(config.plots.datasets)[0];
  const customSpec = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", data: { name: datasetName }, mark: "bar", encoding: { x: { field: "name", type: "nominal" } } };
  config.plots.plotList.push({ dataset: { name: datasetName }, makeSpec: { plotFunction: "barPlotCount", args: {} }, customSpec, config: {} });
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.deepEqual(plots[0].spec.data.values, [{ name: "Ada" }]);
  assert.deepEqual(customSpec.data, { name: datasetName });
});

checkAsync("unknown builder entries are preserved and reported per plot", async () => {
  const table = { source: "data.csv", header: ["x"], rows: [["a"]] };
  const config = createDefaultConfig([table]);
  const datasetName = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push({ dataset: { name: datasetName }, makeSpec: { plotFunction: "futurePlot", args: {} } });
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.match(plots[0].error, /unavailable/);
  assert.equal(validatePlotsConfig(config).plots.plotList[0].makeSpec.plotFunction, "futurePlot");
  assert.ok(BUILDER_NAMES.includes("plotMapHeatmap"));
});

check("the panel's library label shows the pinned ro-crate-plots commit", () => {
  assert.equal(libraryPin("github:Language-Research-Technology/ro-crate-plots#d53c3e0bdafdb7ce5eaead455f01a8bd0e5bfe3c"), "d53c3e0");
  assert.equal(libraryPin("github:Language-Research-Technology/ro-crate-plots#main"), "main");
  assert.equal(libraryPin("file:../ro-crate-plots"), "file:../ro-crate-plots");
  assert.match(libraryPin(), /^[0-9a-f]{7}$/, "package.json pins a commit");
});

check("projects map coordinates to image points", () => {
  assert.deepEqual(
    projectMapPoints([{ lat: 0, lon: 0, weight: 3 }], 2, 1, 1, 0, 0, 256),
    [{ x: 256, y: 256, weight: 3 }],
  );
});

check("maps selected source columns to map coordinates and reports invalid rows", () => {
  assert.deepEqual(mapRowsFromColumns([
    { lat_col: "-33.8", lon_col: "151.2", count: "4" },
    { lat_col: "unknown", lon_col: "0", count: "2" },
    { lat_col: null, lon_col: "", count: "1" },
  ], { latitudeField: "lat_col", longitudeField: "lon_col", weightField: "count" }), {
    data: [{ lat: -33.8, lon: 151.2, weight: 4 }],
    invalidCoordinates: 2,
  });
});

await Promise.all(asyncChecks);

if (failures) {
  console.error(`\nplots.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
