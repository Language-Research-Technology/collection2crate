// The pipeline: the mandatory steps, the build-hook emission order, and the
// weighted progress the hook contract promises plugins (SPEC.md §4.4).
//
// Isomorphic — nothing here touches the DOM or the File System Access API, so
// tests/test-hooks.mjs can drive the whole thing against synthetic plugins.

import { HOOKS, BUILDER_PRIORITY, announceAndEmit } from "./hooks.js";

/** The stages runPipeline knows about, in the order it emits them. */
export const PIPELINE_STAGES = Object.freeze([
  HOOKS.FILES_PREPARE,
  HOOKS.FILES_WRITE,
  HOOKS.METADATA_MERGE,
  HOOKS.CRATE_PREPARE,
  HOOKS.CRATE_BUILD,
  HOOKS.CRATE_VALIDATE,
  HOOKS.CRATE_WRITE,
]);

/**
 * A tap is "active" for this run when it has no activeWhen, or its
 * activeWhen(ctx) passes. A throwing activeWhen counts as inactive rather
 * than failing the build before it starts.
 */
export function isTapActive(entry, ctx) {
  if (!entry.activeWhen) return true;
  try {
    return !!entry.activeWhen(ctx);
  } catch {
    return false;
  }
}

/**
 * Which plugin assembles the crate this build.
 *
 * A builder is a crate:build tap in the builder band (priority <=
 * BUILDER_PRIORITY) — there is no separate kind of plugin and no input-mode
 * setting to dispatch on. Of the builders whose activeWhen(ctx) passes, the
 * lowest priority wins; the rest stand down *entirely*, every tap on every
 * stage, which is what lets the baseline builder's folder scan sit in
 * files:prepare without a specialised builder having to know it exists.
 *
 * Returns the winning entry (or null, when no builder is active at all) and
 * the set of plugin names to skip for this run.
 */
export function resolveBuilder(bus, ctx) {
  // handlers() is priority-sorted, so the first active one is the winner.
  const band = bus.handlers(HOOKS.CRATE_BUILD).filter((entry) => entry.priority <= BUILDER_PRIORITY);
  const builder = band.find((entry) => isTapActive(entry, ctx)) || null;
  const standDown = new Set(band.map((entry) => entry.pluginName));
  if (builder) standDown.delete(builder.pluginName);
  return { builder, standDown };
}

/**
 * Sum weight across every tap that will actually run, and give each an
 * ordered [start, end] slice of the main bar. Taps with no weight get a
 * zero-width slice — they still run, they just don't move the bar. A plugin
 * that stood down gets no slice, because none of its taps will run.
 */
export function planProgress(bus, stages, ctx, skip = null) {
  const active = [];
  for (const stage of stages) {
    for (const entry of bus.handlers(stage)) {
      if (skip?.has(entry.pluginName)) continue;
      if (isTapActive(entry, ctx)) active.push(entry);
    }
  }
  const total = active.reduce((sum, entry) => sum + (entry.weight || 0), 0);
  const slices = new Map();
  let cursor = 0;
  for (const entry of active) {
    const span = total > 0 ? ((entry.weight || 0) / total) * 100 : 0;
    slices.set(entry, { start: cursor, end: cursor + span });
    cursor += span;
  }
  return { slices, totalWeight: total, activeCount: active.length };
}

/**
 * Build ctx.progress. The pipeline swaps the live slice before each handler
 * runs (handlers are sequential, so only one tap is ever live), and the
 * handler reports a fraction local to its own slice.
 *
 * The secondary bar is not a separate call: it appears by itself the first
 * time a tap reports more than once before done(), which is exactly the
 * "granular, multi-item step" case it exists for.
 */
export function createProgress(ui = {}) {
  const onMain = ui.onMain || (() => {});
  const onSub = ui.onSub || (() => {});
  const onSubHide = ui.onSubHide || (() => {});
  const onComplete = ui.onComplete || (() => {});
  const onFail = ui.onFail || (() => {});

  let slice = { start: 0, end: 0 };
  let reportCount = 0;
  let subShown = false;

  const progress = {
    /** @internal — the pipeline's own handle on the live slice. */
    _enter(nextSlice) {
      slice = nextSlice || { start: 0, end: 0 };
      reportCount = 0;
      subShown = false;
    },
    start(label) {
      reportCount = 0;
      subShown = false;
      onMain(slice.start, label);
    },
    report(fraction, label) {
      const f = Math.min(1, Math.max(0, Number(fraction) || 0));
      reportCount++;
      onMain(slice.start + (slice.end - slice.start) * f, label);
      if (reportCount > 1) {
        subShown = true;
        onSub(f, label);
      }
    },
    done() {
      onMain(slice.end);
      if (subShown) onSubHide();
      reportCount = 0;
      subShown = false;
    },
    complete() {
      onMain(100);
      onSubHide();
      onComplete();
    },
    fail(error) {
      onSubHide();
      onFail(error);
    },
  };
  return progress;
}

/**
 * Run the pipeline.
 *
 * @param {object} ctx                    the shared context object
 * @param {object} args
 * @param {object} args.bus               the hook bus
 * @param {string[]} [args.stages]        subset of PIPELINE_STAGES to run
 * @param {object} [args.progressUi]      host callbacks for createProgress()
 * @param {function} [args.collectTypeCounts]
 */
export async function runPipeline(ctx, {
  bus,
  stages = PIPELINE_STAGES,
  progressUi = null,
  collectTypeCounts = null,
} = {}) {
  const runStages = stages.filter((stage) => PIPELINE_STAGES.includes(stage));
  const progress = ctx.progress || createProgress(progressUi || {});
  ctx.progress = progress;

  // Who builds the crate, and who therefore doesn't run at all this time.
  const { builder, standDown } = resolveBuilder(bus, ctx);
  ctx.builder = builder?.pluginName || null;
  if (builder) {
    const stoodDown = standDown.size ? ` (${[...standDown].join(", ")} stood down)` : "";
    ctx.log(`Builder: ${ctx.builder}${stoodDown}`, "muted");
  } else if (runStages.includes(HOOKS.CRATE_BUILD)) {
    throw new Error(
      "No builder is active for this build — nothing would assemble the crate. A builder is a " +
      "crate:build tap at priority " + BUILDER_PRIORITY + " or lower; check the profile's enabled " +
      "options, and that a builder plugin is in this deployment's PLUGINS selection."
    );
  }

  const { slices } = planProgress(bus, runStages, ctx, standDown);
  const onEntry = (entry) => progress._enter?.(slices.get(entry) || { start: 0, end: 0 });

  try {
    for (const stage of runStages) {
      await announceAndEmit(bus, stage, ctx, { onEntry, skip: standDown });

      if (stage === HOOKS.CRATE_BUILD) {
        // A builder that ran and produced nothing is a failed build, not a
        // build to carry into validation with an empty hand.
        if (!ctx.crate) {
          throw new Error(`crate:build finished with no crate — ${ctx.builder} built nothing.`);
        }
        if (collectTypeCounts) {
          const graph = ctx.crate.getGraph();
          ctx.entities = graph.length;
          ctx.typeCounts = collectTypeCounts(graph);
          ctx.log(`Crate holds ${ctx.entities} entity(ies).`, "muted");
        }
      }
    }
    progress.complete();
    return ctx;
  } catch (error) {
    progress.fail(error);
    throw error;
  }
}

