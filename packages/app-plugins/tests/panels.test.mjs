// Every visualisation panel in REGISTRY honours the panel contract: a label,
// a hint and a render function, and no build hooks.
//
// DOM stays untested, as the rest of the UI does. What is tested is the half
// that can be wrong while looking right. Split out of the package's former
// visualisation.test.mjs, one file per panel.
//
//   npm test -w collection2crate-plugins -- panels.test.mjs
import assert from "node:assert/strict";
import { REGISTRY } from "../index.js";

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

const deps = new Proxy({}, { get: () => () => {} });
for (const [name, factory] of Object.entries(REGISTRY)) {
  const plugin = factory(deps);
  if (!plugin.visualisation) continue;
  check(`${name}: its panel declares label, hint and render`, () => {
    const { label, hint, render } = plugin.visualisation;
    assert.equal(typeof label, "string", "a panel needs a label for the sidebar");
    assert.ok(label.length, "the label is empty");
    assert.equal(typeof hint, "string", "a panel needs a one-line hint");
    assert.equal(typeof render, "function", "a panel needs render(container, ctx)");
  });
  check(`${name}: declares no hooks — it runs during no build`, () => {
    assert.equal(Object.keys(plugin.hooks || {}).length, 0);
  });
}

await Promise.all(asyncChecks);

if (failures) {
  console.error(`\npanels.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
