// Seam: the hook-bus engine — registration order, priority, sequencing, the
// shared ctx, both tap shapes, announceAndEmit's logging, and the HOOKS
// constants against collection2crate-plugins' documented contract.
//
// Deliberately NOT tested here: any real plugin from collection2crate-plugins. Testing what
// a plugin does is that repo's job (SPEC.md §9.1); what this suite proves is
// that the machinery every plugin runs through behaves as the contract says.
// Every plugin object below is synthetic and defined inline.

import assert from "node:assert/strict";
import { createHookBus, registerAllPlugins, announceAndEmit, HOOKS, HOOK_NAMES, BUILDER_PRIORITY }
  from "../src/plugins/hooks.js";
import { planProgress, createProgress, isTapActive, PIPELINE_STAGES, runPipeline, resolveBuilder }
  from "../src/plugins/pipeline.js";

const collectingCtx = (extra = {}) => {
  const lines = [];
  return { lines, log: (message, level = "info") => lines.push(`${level}:${message}`), options: {}, ...extra };
};

/* ---------- the HOOKS constants are the contract collection2crate-plugins keys to ---------- */

// Duplicated from collection2crate-plugins' README rather than imported: that package has no
// runtime dependency on this repo, so accepting a contract change from either
// side has to be a deliberate edit here.
const CONTRACT_HOOK_NAMES = [
  "c2c:loaded", "folder:picked", "profile:selected",
  "files:prepare", "files:write", "metadata:merge", "crate:prepare",
  "crate:build", "crate:validate", "crate:write",
];

assert.deepEqual(
  [...HOOK_NAMES].sort(),
  [...CONTRACT_HOOK_NAMES].sort(),
  "HOOKS must name exactly the hooks collection2crate-plugins keys its taps to — a name only this side knows is a tap that never fires"
);
assert.equal(HOOKS.CRATE_BUILD, "crate:build",
  "The old crate:build/crate:built pair is one crate:build stage ordered by priority");
assert.equal(HOOKS.FILES_PREPARE, "files:prepare",
  "files:analyze was renamed to files:prepare in the current contract");
assert.equal(HOOKS.CRATE_PREPARE, "crate:prepare",
  "config:prepare was renamed to crate:prepare in the current contract");
assert.equal(HOOKS.CRATE_WRITE, "crate:write",
  "output:write was renamed to crate:write in the current contract");

// files:write sits directly after files:prepare: a plugin that derives files
// from the ones on disk writes them there, with its inputs prepared and no
// crate in the picture yet. The order is the contract, not an implementation
// detail — a tap that writes before files:prepare has nothing to write from.
{
  const order = PIPELINE_STAGES.indexOf(HOOKS.FILES_WRITE);
  assert.equal(order, PIPELINE_STAGES.indexOf(HOOKS.FILES_PREPARE) + 1,
    "files:write runs immediately after files:prepare");
  assert.ok(order < PIPELINE_STAGES.indexOf(HOOKS.CRATE_BUILD),
    "files:write runs before anything assembles a crate");
}

// crate:prepare closes the file half rather than opening it: the crate's own
// metadata is settled once the files have been processed and any spreadsheet
// metadata merged, and is the last thing Process does before a build reads it.
{
  const prepare = PIPELINE_STAGES.indexOf(HOOKS.CRATE_PREPARE);
  assert.ok(prepare > PIPELINE_STAGES.indexOf(HOOKS.METADATA_MERGE),
    "crate:prepare runs after the file stages and the metadata merge");
  assert.equal(prepare, PIPELINE_STAGES.indexOf(HOOKS.CRATE_BUILD) - 1,
    "crate:prepare is the last stage before crate:build");
}
assert.ok(BUILDER_PRIORITY <= 10,
  "The builder band must end at priority 10 or lower, because annotating crate:build taps start at 20 assuming ctx.crate already exists");

/* ---------- registration order: priority first, registration order for ties ---------- */

{
  const bus = createHookBus();
  const order = [];
  const plugins = [
    { name: "late", hooks: { "crate:build": { priority: 80, handler: () => order.push("late") } } },
    { name: "early", hooks: { "crate:build": { priority: 20, handler: () => order.push("early") } } },
    { name: "tie-a", hooks: { "crate:build": { priority: 50, handler: () => order.push("tie-a") } } },
    { name: "tie-b", hooks: { "crate:build": { priority: 50, handler: () => order.push("tie-b") } } },
  ];
  const registered = registerAllPlugins(bus, plugins);

  assert.equal(registered, 4, "registerAllPlugins should report one registration per tap");
  assert.deepEqual(
    bus.handlers("crate:build").map((entry) => entry.pluginName),
    ["early", "tie-a", "tie-b", "late"],
    "Handlers run in ascending priority, and a shared priority falls back to registration order (the sort is stable)"
  );

  await bus.emit("crate:build", collectingCtx());
  assert.deepEqual(order, ["early", "tie-a", "tie-b", "late"],
    "emit() should invoke handlers in the same order handlers() reports");
}

/* ---------- both tap shapes register, and a bare function gets no bar slice ---------- */

{
  const bus = createHookBus();
  registerAllPlugins(bus, [
    { name: "bare", hooks: { "crate:write": () => {} } },
    { name: "object", hooks: { "crate:write": { priority: 5, weight: 4, handler: () => {} } } },
  ]);
  const entries = bus.handlers("crate:write");

  assert.equal(entries.length, 2, "Both a bare function and a {priority, handler} object are valid tap shapes");
  const bare = entries.find((entry) => entry.pluginName === "bare");
  assert.equal(bare.priority, 10, "A bare function takes the default priority of 10");
  assert.equal(bare.weight, 0,
    "A tap declared as a bare function gets no weight, so it never takes a slice of the progress bar");
  assert.equal(entries[0].pluginName, "object",
    "An explicit lower priority runs ahead of a defaulted one regardless of registration order");

  assert.throws(
    () => registerAllPlugins(createHookBus(), [{ name: "broken", hooks: { "crate:write": { priority: 1 } } }]),
    /neither a function nor/,
    "A tap with no handler is a registration-time error, not a silent no-op at build time"
  );
}

/* ---------- handlers run sequentially and awaited, never in parallel ---------- */

{
  const bus = createHookBus();
  const events = [];
  const slow = (name, ms) => async () => {
    events.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    events.push(`${name}:end`);
  };
  registerAllPlugins(bus, [
    { name: "first", hooks: { "files:prepare": { priority: 10, handler: slow("first", 20) } } },
    { name: "second", hooks: { "files:prepare": { priority: 20, handler: slow("second", 1) } } },
  ]);

  await bus.emit("files:prepare", collectingCtx());
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"],
    "Each handler is awaited before the next starts — they mutate a shared crate, so overlapping them would race");
}

/* ---------- the same ctx object reaches every handler, unchanged ---------- */

{
  const bus = createHookBus();
  const seen = [];
  registerAllPlugins(bus, [
    { name: "writer", hooks: { "crate:build": { priority: 10, handler: (ctx) => { ctx.stamp = "written"; seen.push(ctx); } } } },
    { name: "reader", hooks: { "crate:build": { priority: 20, handler: (ctx) => seen.push(ctx) } } },
  ]);

  const ctx = collectingCtx();
  await bus.emit("crate:build", ctx);
  assert.equal(seen.length, 2, "Both handlers should have run");
  assert.ok(seen[0] === ctx && seen[1] === ctx,
    "Every handler receives the identical ctx object, not a copy — that is how one tap's output reaches the next");
  assert.equal(ctx.stamp, "written", "A handler's mutation of ctx survives into the caller");
}

/* ---------- announceAndEmit says what is registered, and says so when nothing is ---------- */

{
  const bus = createHookBus();
  registerAllPlugins(bus, [
    { name: "beta", hooks: { "crate:write": { priority: 30, handler: () => {} } } },
    { name: "alpha", hooks: { "crate:write": { priority: 10, handler: () => {} } } },
  ]);

  const ctx = collectingCtx();
  await announceAndEmit(bus, "crate:write", ctx);
  const announcement = ctx.lines.find((line) => line.includes("crate:write"));
  assert.ok(announcement, "announceAndEmit logs before it emits");
  assert.ok(announcement.indexOf("alpha") < announcement.indexOf("beta"),
    "The announcement lists registered plugins in run order, so a build traces its own actual shape");

  const emptyCtx = collectingCtx();
  await announceAndEmit(bus, "metadata:merge", emptyCtx);
  assert.ok(
    emptyCtx.lines.some((line) => line.includes("metadata:merge") && line.includes("no handlers")),
    "A hook with no handlers still logs, as confirmation the hook point exists and fired — not merely a report of what ran"
  );

  await assert.rejects(
    () => announceAndEmit(bus, "crate:write", { options: {} }),
    /must carry a log function/,
    "announceAndEmit requires ctx.log, since announcing is the whole point of using it over emit"
  );
}

/* ---------- progress is declared and weighted, never inferred ---------- */

{
  const bus = createHookBus();
  registerAllPlugins(bus, [
    { name: "always", hooks: { "files:prepare": { priority: 10, weight: 1, handler: () => {} } } },
    { name: "conditional", hooks: { "files:prepare": { priority: 20, weight: 3, activeWhen: (ctx) => ctx.options.on, handler: () => {} } } },
    { name: "silent", hooks: { "files:prepare": { priority: 30, handler: () => {} } } },
  ]);

  const off = planProgress(bus, ["files:prepare"], { options: { on: false } });
  assert.equal(off.totalWeight, 1,
    "A tap whose activeWhen fails contributes no weight, so the bar is scaled to the work that will actually happen");
  assert.equal(off.activeCount, 2, "An inactive tap is excluded from the plan entirely");

  const on = planProgress(bus, ["files:prepare"], { options: { on: true } });
  assert.equal(on.totalWeight, 4, "Turning the conditional tap on adds its weight to the total");
  const slices = [...on.slices.values()];
  assert.deepEqual(slices.map((s) => Math.round(s.end)), [25, 100, 100],
    "Each tap gets an ordered slice proportional to its weight; a zero-weight tap gets a zero-width slice at the end");
  assert.equal(slices[0].start, 0, "Slices are ordered and start at zero");

  assert.equal(isTapActive({ activeWhen: () => { throw new Error("boom"); } }, {}), false,
    "A throwing activeWhen counts as inactive rather than failing the build before it starts");
}

/* ---------- the secondary bar appears only for a granular, multi-item step ---------- */

{
  const seen = { sub: 0, subHidden: 0, main: [] };
  const progress = createProgress({
    onMain: (percent) => seen.main.push(Math.round(percent)),
    onSub: () => seen.sub++,
    onSubHide: () => seen.subHidden++,
  });

  progress._enter({ start: 0, end: 50 });
  progress.start("single step");
  progress.done();
  assert.equal(seen.sub, 0,
    "A tap that only brackets start()/done() around one label never raises the secondary bar");
  assert.equal(seen.main.at(-1), 50, "done() snaps the main bar to the end of the tap's slice");

  progress._enter({ start: 50, end: 100 });
  progress.start("many items");
  progress.report(0.5, "1/2");
  assert.equal(seen.sub, 0, "The first report on its own is not yet a multi-item step");
  progress.report(1, "2/2");
  assert.equal(seen.sub, 1,
    "The secondary bar appears by itself on the second report before done() — that is the granular-step signal");
  assert.equal(seen.main.at(-1), 100, "report() scales its local fraction into the tap's slice of the main bar");
  progress.done();
  assert.equal(seen.subHidden, 1, "done() fades the secondary bar once it has been shown");
}

/* ---------- the pipeline: stage order, the builder band, standing down ---------- */

// A builder is an ordinary plugin whose crate:build tap sits in the builder
// band and assembles ctx.crate. The lowest-priority active one wins; every tap
// of a builder that lost is skipped for the whole build.
const builderPlugin = (name, { priority, activeWhen = null, order }) => ({
  name,
  hooks: {
    "files:prepare": { priority: 0, handler: (ctx) => {
      order.push(`${name}:scan`);
      ctx.filesWithMeta = [{ id: "a.txt" }];
    } },
    "crate:build": {
      priority, activeWhen,
      handler: (ctx) => { order.push(`${name}:build`); ctx.crate = { getGraph: () => [{ "@type": "File" }] }; },
    },
  },
});

{
  const bus = createHookBus();
  const order = [];
  registerAllPlugins(bus, [
    builderPlugin("baseline-builder", { priority: 10, order }),
    { name: "plugin", hooks: { "crate:build": { priority: 20, handler: (ctx) => {
      order.push("plugin");
      assert.ok(ctx.crate, "A crate:build tap at priority 20 can assume ctx.crate already exists");
    } } } },
  ]);

  const ctx = collectingCtx();
  await runPipeline(ctx, { bus, collectTypeCounts: (graph) => ({ File: graph.length }) });

  assert.deepEqual(order, ["baseline-builder:scan", "baseline-builder:build", "plugin"],
    "The builder's files:prepare tap runs before the taps that read ctx.filesWithMeta, and its crate:build tap before every annotating tap");
  assert.equal(ctx.builder, "baseline-builder", "The pipeline records which plugin built the crate");
  assert.equal(ctx.entities, 1, "The pipeline records entity stats from the built crate");
  assert.deepEqual(ctx.typeCounts, { File: 1 }, "The pipeline records type counts from the built crate");

  const emitted = ctx.lines.join("\n");
  for (const stage of PIPELINE_STAGES) {
    assert.ok(emitted.includes(stage), `The pipeline announces ${stage}, whether or not anything taps it`);
  }
}

/* ---------- one builder per build: the lowest active priority wins ---------- */

{
  const bus = createHookBus();
  const order = [];
  registerAllPlugins(bus, [
    builderPlugin("baseline-builder", { priority: 10, order }),
    builderPlugin("special-builder", { priority: 5, activeWhen: (ctx) => !!ctx.options.special, order }),
  ]);

  const fallbackCtx = collectingCtx();
  const { builder, standDown } = resolveBuilder(bus, fallbackCtx);
  assert.equal(builder.pluginName, "baseline-builder",
    "With the gated builder switched off, the ungated one wins the band");
  assert.deepEqual([...standDown], ["special-builder"], "The builder that lost stands down");

  await runPipeline(fallbackCtx, { bus });
  assert.deepEqual(order, ["baseline-builder:scan", "baseline-builder:build"],
    "A builder that stood down runs none of its taps, on any stage");

  order.length = 0;
  const specialCtx = collectingCtx({ options: { special: true } });
  await runPipeline(specialCtx, { bus });
  assert.equal(specialCtx.builder, "special-builder",
    "A gated builder at a lower priority takes the band when its option is on");
  assert.deepEqual(order, ["special-builder:scan", "special-builder:build"],
    "The baseline builder stands down whole — its folder scan included — when another builder wins");
  assert.ok(specialCtx.lines.join("\n").includes("baseline-builder stood down"),
    "The build log says which builder ran and which stood down");
}

/* ---------- a build with no builder, and a builder that builds nothing ---------- */

{
  const ctx = collectingCtx();
  await assert.rejects(
    () => runPipeline(ctx, { bus: createHookBus(), stages: ["crate:build"] }),
    /No builder is active/,
    "A build whose profile and plugin selection leave no builder fails loudly rather than writing an empty crate"
  );
}

{
  const bus = createHookBus();
  registerAllPlugins(bus, [
    { name: "empty-handed", hooks: { "crate:build": { priority: 10, handler: () => {} } } },
  ]);
  await assert.rejects(
    () => runPipeline(collectingCtx(), { bus, stages: ["crate:build"] }),
    /built nothing/,
    "A builder that leaves no ctx.crate fails the build rather than carrying on into validation"
  );
}

console.log(
  `test-hooks: all tests passed (${HOOK_NAMES.length} hook names, ${PIPELINE_STAGES.length} pipeline stages, ` +
  "priority ordering, sequential awaiting, shared ctx, announceAndEmit, weighted progress, builder resolution)"
);
