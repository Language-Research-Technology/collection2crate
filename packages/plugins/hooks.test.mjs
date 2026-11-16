// Contract test for the hook layer: every plugin in REGISTRY taps only hooks
// collection2crate actually emits, in the object form the pipeline
// expects, with a priority that is explicit and unambiguous within its stage.
//
// It exists because the failure mode here is silent. A tap keyed to a hook
// name collection2crate no longer emits doesn't throw — it just never fires, and
// the build quietly produces less than it should (README, "Hook names are
// literal strings"). Same for a tap left as a bare function after the move to
// { priority, weight, activeWhen, handler }: nothing errors, it just never
// gets a slice of the progress bar.
//
//   node hooks.test.mjs
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import { REGISTRY } from "./index.js";
import { progressFor, countedProgress } from "./src/_progress.js";

// collection2crate's src/plugins/hooks.js owns this list; it is duplicated rather
// than imported on purpose — this package has no runtime dependency on
// collection2crate (README). Updating it here is the deliberate act of accepting
// a contract change from the other side.
const HOOKS = new Set([
  "c2c:loaded", "folder:picked", "profile:selected",
  "files:prepare", "files:write", "metadata:merge", "crate:prepare",
  "crate:build", "crate:validate", "crate:write",
]);

// Every deps key any plugin destructures, stubbed. createPlugin() only
// assigns from it, so a no-op function is enough to construct the plugin
// object and inspect its hooks.
const noop = () => {};
const deps = new Proxy({}, {
  get: (_t, key) => (key === "loadMasp" ? async () => ({ validateBuiltCrate: noop }) : noop),
  has: () => true,
});

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

console.log("Hook contract");
const byStage = new Map();

for (const [name, factory] of Object.entries(REGISTRY)) {
  const plugin = factory(deps);

  check(`${name}: factory returns a plugin named "${name}"`, () => {
    assert.equal(plugin.name, name, `REGISTRY key and plugin.name disagree`);
  });

  for (const [hook, tap] of Object.entries(plugin.hooks || {})) {
    check(`${name}: "${hook}" is a hook collection2crate emits`, () => {
      assert.ok(HOOKS.has(hook), `unknown hook "${hook}" — a tap keyed to it never fires`);
    });

    check(`${name}: "${hook}" uses the { priority, handler } form`, () => {
      assert.equal(typeof tap, "object", "tap is still a bare function");
      assert.equal(typeof tap.handler, "function", "tap has no handler");
      assert.equal(typeof tap.priority, "number", "tap has no explicit priority");
      assert.ok(tap.priority >= 0 && tap.priority <= 100, `priority ${tap.priority} is outside 0–100`);
      if ("weight" in tap) assert.ok(typeof tap.weight === "number" && tap.weight >= 0, "weight must be a non-negative number");
      if ("activeWhen" in tap) assert.equal(typeof tap.activeWhen, "function", "activeWhen must be a function");
    });

    // A weighted tap claims a slice of the bar; a conditional one that
    // forgets activeWhen claims that slice on every build and leaves a gap
    // the bar jumps across when it returns early.
    check(`${name}: "${hook}" weight and activeWhen agree`, () => {
      if (!tap.weight) return;
      const src = tap.handler.toString();
      const guardsOnOption = /if\s*\(!\s*(ctx\.)?options\?*\.|if\s*\(!\s*ctx\.selectedProfileData/.test(src);
      if (guardsOnOption) assert.ok(tap.activeWhen, "handler returns early on an option but the tap has no activeWhen");
    });

    // activeWhen runs before the build, against a ctx that may be missing
    // anything the handler itself would populate — it must not throw.
    check(`${name}: "${hook}" activeWhen survives a bare ctx`, () => {
      if (!tap.activeWhen) return;
      assert.equal(typeof tap.activeWhen({ options: {} }), "boolean", "activeWhen should return a boolean");
    });

    if (!byStage.has(hook)) byStage.set(hook, []);
    byStage.get(hook).push([name, tap.priority]);
  }
}

console.log("\nStage ordering");
for (const [hook, taps] of [...byStage].sort()) {
  check(`${hook}: priorities are unique`, () => {
    const seen = new Map();
    for (const [name, prio] of taps) {
      assert.ok(!seen.has(prio), `${name} and ${seen.get(prio)} both sit at ${prio} — order falls back to registration`);
      seen.set(prio, name);
    }
  });
  const order = [...taps].sort((a, b) => a[1] - b[1]).map(([n, p]) => `${n} ${p}`).join(" · ");
  console.log(`       ${hook}: ${order}`);
}

// The builder band. A crate:build tap at priority <= 10 is a builder: it
// assembles ctx.crate, and collection2crate runs exactly one of them per build —
// the active one with the lowest priority, every tap of the others skipped.
// Taps above 10 annotate the crate a builder produced, so they assume it
// already exists.
console.log("\nBuilders");

const BUILDER_BAND = 10;
const builders = [];
for (const [name, factory] of Object.entries(REGISTRY)) {
  const plugin = factory(deps);
  const tap = plugin.hooks?.["crate:build"];
  if (tap && typeof tap === "object" && tap.priority <= BUILDER_BAND) builders.push([name, tap]);
}

check("at least one builder ships in the registry", () => {
  assert.ok(builders.length, "nothing taps crate:build in the builder band — no build could produce a crate");
});

for (const [name, tap] of builders) {
  check(`${name}: its builder tap assembles ctx.crate`, () => {
    assert.match(tap.handler.toString(), /ctx\.crate\s*=|buildFromFolder|buildCrate\(/,
      "a tap in the builder band that never assigns ctx.crate leaves the build with nothing to validate");
  });
}

// Exactly one builder may be unconditional: it is the fallback that runs when
// no gated builder is switched on. Two of them would mean the higher-priority
// one could never run, which is an authoring mistake rather than a choice.
check("exactly one builder is unconditional, and it sorts last in the band", () => {
  const unconditional = builders.filter(([, tap]) => !tap.activeWhen);
  assert.equal(unconditional.length, 1,
    `${unconditional.length} builders have no activeWhen (${unconditional.map(([n]) => n).join(", ") || "none"}) — exactly one fallback is expected`);
  const fallback = unconditional[0];
  for (const [name, tap] of builders) {
    if (name === fallback[0]) continue;
    assert.ok(tap.priority < fallback[1].priority,
      `${name} sits at ${tap.priority}, at or after the ${fallback[0]} fallback at ${fallback[1].priority} — it could never win the band`);
  }
});

// A folder with an existing crate: collection2crate seeds ctx.crate before
// crate:build, and a builder — or any tap that used to replace the crate —
// has to add to that object. collection2crate fails a build whose seeded
// crate was swapped out (its SPEC.md §4.4), so these check the plugins keep it.
console.log("\nSeeded crates are added to, not replaced");

const seededDeps = (overrides) => new Proxy({}, {
  get: (_t, key) => (key in overrides ? overrides[key] : noop),
  has: () => true,
});
const quietCtx = (extra) => ({ log: noop, options: {}, config: {}, ...extra });

{
  let passedCrate;
  const plugin = REGISTRY["generic-input"](seededDeps({
    buildCrate: (_files, _config, _log, opts) => { passedCrate = opts.crate; return opts.crate || { fresh: true }; },
  }));
  const seed = { seeded: true };
  const ctx = quietCtx({ crate: seed, filesWithMeta: [] });
  await plugin.hooks["crate:build"].handler(ctx);
  check("generic-input: hands the seeded crate to buildCrate and keeps it", () => {
    assert.equal(passedCrate, seed);
    assert.equal(ctx.crate, seed);
  });
  const fresh = quietCtx({ crate: null, filesWithMeta: [] });
  await plugin.hooks["crate:build"].handler(fresh);
  check("generic-input: creates a crate when nothing was seeded", () => {
    assert.deepEqual(fresh.crate, { fresh: true });
  });
}

{
  const merges = [];
  const plugin = REGISTRY["ca-data-prep"](seededDeps({
    mergeCrateInto: (target, source) => { merges.push({ target, source }); return { added: 1, enriched: 0 }; },
  }));
  const record = {
    baseName: "interview", objectId: "#interview", annotationId: "#interview-annotation",
    docxId: "transcripts/interview.docx", docxName: "interview.docx",
    csvDirName: "_outputs/csv", csvName: "interview.csv", csvId: "_outputs/csv/interview.csv",
    speakerRefs: [], persons: [],
  };
  const caCtx = (extra) => quietCtx({
    options: { processTranscriptDocuments: true, transcriptOutputsInCrate: true },
    caDataPrep: { files: [{}], documentRecords: [record] },
    ...extra,
  });

  const seed = { seeded: true };
  const seeded = caCtx({ crate: seed, existingCrate: { "@graph": [] } });
  await plugin.hooks["crate:build"].handler(seeded);
  check("ca-data-prep: with an existing crate, merges the transcript crate into it", () => {
    assert.equal(seeded.crate, seed, "ctx.crate was replaced");
    assert.equal(merges.length, 1);
    assert.equal(merges[0].target, seed);
    assert.ok(merges[0].source.getEntity("#interview"), "the transcript crate carries the document");
  });

  // A first build: collection2crate seeded an empty crate and generic-input
  // scanned into it. The scan's entities go; the Describe form's stay.
  const scanned = new ROCrate({ array: true, link: true });
  scanned.rootDataset.name = ["From the Describe form"];
  scanned.rootDataset.author = [{ "@id": "#ann", "@type": "Person", name: "Ann" }];
  scanned.rootDataset.hasPart = [{ "@id": "#folder" }, { "@id": "notes.txt" }];
  scanned.addEntity({ "@id": "#folder", "@type": "RepositoryObject", hasPart: [{ "@id": "audio/a.wav" }] });
  scanned.addEntity({ "@id": "audio/a.wav", "@type": "File", inLanguage: { "@id": "#lang" } });
  scanned.addEntity({ "@id": "notes.txt", "@type": "File" });
  scanned.addEntity({ "@id": "#lang", "@type": "Language", name: "Some language" });
  const first = caCtx({ crate: scanned });
  await plugin.hooks["crate:build"].handler(first);
  check("ca-data-prep: on a first build, clears the scan out of the seeded crate and merges into it", () => {
    assert.equal(first.crate, scanned, "ctx.crate was replaced");
    const ids = scanned.getGraph().map((e) => e["@id"]).sort();
    assert.deepEqual(ids, ["#ann", "./", "ro-crate-metadata.json"],
      "scan entities and the orphans they leave are gone; the form's linked entity stays");
    assert.deepEqual(scanned.rootDataset.name, ["From the Describe form"]);
    assert.equal(scanned.rootDataset.hasPart, undefined, "the root no longer lists the scan's members");
    assert.equal(merges.length, 2);
    assert.equal(merges[1].target, scanned);
  });

  const legacy = caCtx({ crate: null });
  await plugin.hooks["crate:build"].handler(legacy);
  check("ca-data-prep: with a host that seeds nothing, the transcript crate is the crate", () => {
    assert.ok(legacy.crate.getEntity("#interview"));
    assert.equal(merges.length, 2, "nothing merged");
  });
}

console.log("\nProgress helper");
check("progressFor: no-ops when the host has no ctx.progress", () => {
  const p = progressFor({});
  p.start("x"); p.report(0.5, "x"); p.done();
});
check("progressFor: forwards to the host and clamps the fraction", () => {
  const seen = [];
  const p = progressFor({ progress: { start: (l) => seen.push(["start", l]), report: (f) => seen.push(["report", f]), done: () => seen.push(["done"]) } });
  p.start("x"); p.report(2); p.report(-1); p.report(NaN); p.report(0.25); p.done();
  assert.deepEqual(seen, [["start", "x"], ["report", 1], ["report", 0], ["report", 0], ["report", 0.25], ["done"]]);
});
check("countedProgress: reports 1 on the last item and survives an empty list", () => {
  const seen = [];
  const tick = countedProgress({ progress: { start: noop, report: (f) => seen.push(f), done: noop } }, 4);
  tick(0); tick(3); tick.done();
  assert.deepEqual(seen, [0.25, 1]);
  countedProgress({ progress: { start: noop, report: (f) => seen.push(f), done: noop } }, 0)(0);
  assert.equal(seen.at(-1), 1, "a zero-length loop should report complete, not divide by zero");
});

console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
