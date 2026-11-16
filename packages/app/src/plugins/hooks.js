// The hook bus and the hook-name contract (SPEC.md §4.1/§4.2).
//
// The names below are the contract collection2crate-plugins keys its handlers to. That
// package deliberately does NOT import this file — it uses the literal
// strings — so renaming one here does not break loudly in the plugins; the
// tap simply never fires. Changing a name is therefore a coordinated edit
// across both repos (and collection2crate-plugins' hooks.test.mjs carries its own copy of
// this list to assert against).

export const HOOKS = Object.freeze({
  C2C_LOADED: "c2c:loaded",
  FOLDER_PICKED: "folder:picked",
  PROFILE_SELECTED: "profile:selected",
  FILES_PREPARE: "files:prepare",
  FILES_WRITE: "files:write",
  METADATA_MERGE: "metadata:merge",
  CRATE_PREPARE: "crate:prepare",
  CRATE_BUILD: "crate:build",
  CRATE_VALIDATE: "crate:validate",
  CRATE_WRITE: "crate:write",
});

export const HOOK_NAMES = Object.freeze(Object.values(HOOKS));

// The builder band. A crate:build tap at or below this priority is a builder:
// it assembles ctx.crate. Taps above it annotate the crate a builder produced
// and assume it already exists — what the old separate crate:built stage used
// to guarantee. Exactly one builder runs per build; pipeline.js's
// resolveBuilder() decides which.
export const BUILDER_PRIORITY = 10;

const DEFAULT_PRIORITY = 10;

/**
 * A small in-memory registry: hook name -> array of handler entries, each
 * sorted by priority. One registration primitive, one invocation primitive.
 */
export function createHookBus() {
  /** @type {Map<string, Array<object>>} */
  const registry = new Map();

  function on(hookName, handler, options = {}) {
    if (typeof handler !== "function") {
      throw new Error(`Hook "${hookName}": handler must be a function.`);
    }
    const entry = {
      hookName,
      handler,
      priority: Number.isFinite(options.priority) ? options.priority : DEFAULT_PRIORITY,
      pluginName: options.pluginName || "(anonymous)",
      // Progress is declared, not inferred: a tap with no weight gets no
      // slice of the main bar (SPEC.md §4.6 / SPEC-UI.md).
      weight: Number.isFinite(options.weight) ? options.weight : 0,
      activeWhen: typeof options.activeWhen === "function" ? options.activeWhen : null,
    };
    const entries = registry.get(hookName) || [];
    entries.push(entry);
    // Stable sort, so equal priorities keep registration order.
    entries.sort((a, b) => a.priority - b.priority);
    registry.set(hookName, entries);
    return entry;
  }

  /** The handler entries for a hook, in run order. */
  function handlers(hookName) {
    return [...(registry.get(hookName) || [])];
  }

  /**
   * Run every handler for a hook, sequentially and awaited — never in
   * parallel. Handlers mutate a shared ctx; ordering is priority's job.
   */
  async function emit(hookName, ctx, { onEntry, skip = null } = {}) {
    for (const entry of handlers(hookName)) {
      // A plugin the pipeline stood down for this build (a builder that lost
      // the band — see resolveBuilder) is skipped on every stage, not just
      // the one it lost.
      if (skip?.has(entry.pluginName)) continue;
      // The pipeline uses this to hand the tap about to run its slice of the
      // progress bar; nothing else needs it.
      if (typeof onEntry === "function") onEntry(entry);
      await entry.handler(ctx);
    }
    return ctx;
  }

  function clear() {
    registry.clear();
  }

  return { on, emit, handlers, clear, registry };
}

/**
 * Register every plugin's hooks onto the bus.
 *
 * Accepts both tap shapes: a bare function, and the
 * { priority, weight, activeWhen, handler } object every plugin in
 * collection2crate-plugins uses. A bare function takes the default priority and no weight.
 */
export function registerAllPlugins(bus, plugins = []) {
  let count = 0;
  for (const plugin of plugins) {
    if (!plugin?.hooks) continue;
    for (const [hookName, tap] of Object.entries(plugin.hooks)) {
      if (typeof tap === "function") {
        bus.on(hookName, tap, { pluginName: plugin.name });
      } else if (tap && typeof tap.handler === "function") {
        bus.on(hookName, tap.handler, {
          priority: tap.priority,
          weight: tap.weight,
          activeWhen: tap.activeWhen,
          pluginName: plugin.name,
        });
      } else {
        throw new Error(
          `Plugin "${plugin.name}" taps "${hookName}" with neither a function nor a { handler } object.`
        );
      }
      count++;
    }
  }
  return count;
}

/**
 * Emit a hook, saying first which plugins are registered for it and in what
 * order — and saying so even when none are, because that is the confirmation
 * the hook point itself exists and fired, rather than a report of what ran.
 * Every pipeline call site uses this instead of emit() directly.
 */
export async function announceAndEmit(bus, hookName, ctx, options = {}) {
  if (typeof ctx?.log !== "function") {
    throw new Error(`announceAndEmit("${hookName}"): ctx must carry a log function.`);
  }
  const entries = bus.handlers(hookName);
  const skip = options.skip || null;
  if (entries.length) {
    const order = entries
      .map((e) => `${e.pluginName}(${e.priority})${skip?.has(e.pluginName) ? " stood down" : ""}`)
      .join(" → ");
    ctx.log(`${hookName}: ${entries.length} handler(s) — ${order}`, "muted");
  } else {
    ctx.log(`${hookName}: no handlers registered.`, "muted");
  }
  return await bus.emit(hookName, ctx, options);
}
