// The chart panel's pure seam: the geometry and scale of a bar chart.
//
// DOM stays untested, as the rest of the UI does. What is tested is the half
// that can be wrong while looking right. Split out of the package's former
// visualisation.test.mjs, one file per panel.
//
//   npm test -w collection2crate-plugins -- chart.test.mjs
import assert from "node:assert/strict";
import { chartGeometry } from "./index.js";

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

const rows = [
  { name: "one", value: "10" },
  { name: "two", value: "20" },
  { name: "three", value: "n/a" },
];

check("skips non-numeric values and counts them", () => {
  const g = chartGeometry(rows, { xColumn: "name", yColumn: "value" });
  assert.equal(g.points.length, 2);
  assert.equal(g.skipped, 1, "the panel reports this rather than plotting a zero");
});

check("the scale always includes zero", () => {
  const g = chartGeometry([{ x: "a", y: "10" }, { x: "b", y: "12" }], { xColumn: "x", yColumn: "y" });
  assert.equal(g.scale.min, 0, "a floating baseline makes bar lengths meaningless");
  assert.equal(g.scale.max, 12);
});

check("the tallest value sits at the top of the plot, zero at the bottom", () => {
  const g = chartGeometry(rows, { xColumn: "name", yColumn: "value" });
  assert.equal(Math.round(g.scale.y(20)), g.plot.margin.top, "the maximum touches the top margin");
  assert.equal(Math.round(g.scale.y(0)), g.plot.margin.top + g.plot.innerHeight, "zero sits on the axis");
});

check("negative values keep zero inside the plot", () => {
  const g = chartGeometry([{ x: "a", y: "-5" }, { x: "b", y: "5" }], { xColumn: "x", yColumn: "y" });
  const zero = g.scale.y(0);
  assert.ok(zero > g.plot.margin.top && zero < g.plot.margin.top + g.plot.innerHeight,
    "the baseline is between the extremes, not off the chart");
});

check("ticks span the scale and are labelled", () => {
  const g = chartGeometry(rows, { xColumn: "name", yColumn: "value" });
  assert.equal(g.ticks[0].value, 0);
  assert.equal(g.ticks[g.ticks.length - 1].value, 20);
  assert.equal(g.ticks[g.ticks.length - 1].label, "20");
});

check("thousands are abbreviated in tick labels", () => {
  const g = chartGeometry([{ x: "a", y: "4000" }], { xColumn: "x", yColumn: "y" });
  assert.equal(g.ticks[g.ticks.length - 1].label, "4k");
});

check("numbers written with separators still count", () => {
  const g = chartGeometry([{ x: "a", y: "1,200" }], { xColumn: "x", yColumn: "y" });
  assert.equal(g.points[0].value, 1200);
  assert.equal(g.skipped, 0);
});

check("an empty table yields no points and no division by zero", () => {
  const g = chartGeometry([], { xColumn: "x", yColumn: "y" });
  assert.equal(g.points.length, 0);
  assert.ok(Number.isFinite(g.step), `step was ${g.step}`);
});

await Promise.all(asyncChecks);

if (failures) {
  console.error(`\nchart.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
