#!/usr/bin/env node
// Generates src/plugins/index.js from the PLUGINS env var (SPEC.md §4.7a).
//
// Why generate rather than filter at runtime: Rollup can't tree-shake based on
// which keys of an already-imported registry get read, so excluding a plugin
// from the bundle has to mean never writing its `import` statement at all.
//
// Runs automatically before dev/build/test (package.json's predev/prebuild/
// pretest), so the generated file is always fresh; it is committed anyway so
// the repo reads correctly without running a script first. Treat its content
// as disposable — don't hand-edit it.

import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { REGISTRY } from "collection2crate-plugins";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_PATH = path.join(REPO_ROOT, "src", "plugins", "index.js");

const ALL = "all";

/** Parse one PLUGINS entry: "name", or "name=source". */
function parseEntry(raw) {
  const text = raw.trim();
  if (!text) return null;
  const eq = text.indexOf("=");
  if (eq < 0) return { name: text, source: null };
  return { name: text.slice(0, eq).trim(), source: text.slice(eq + 1).trim() };
}

function parseSelection(value, registry, label) {
  const text = (value ?? ALL).trim();
  if (!text || text.toLowerCase() === ALL) {
    return Object.keys(registry).map((name) => ({ name, source: null }));
  }
  const entries = text.split(",").map(parseEntry).filter(Boolean);

  const registryNames = Object.keys(registry);
  const bare = entries.filter((e) => !e.source);
  for (const entry of bare) {
    if (!registryNames.includes(entry.name)) {
      throw new Error(
        `${label}: "${entry.name}" is not in collection2crate-plugins' registry. ` +
        `Known: ${registryNames.join(", ")}. ` +
        `For a plugin from elsewhere use "${entry.name}=<package-or-path>".`
      );
    }
  }
  // Registry names keep the registry's own documented order (which doubles as
  // hook-execution order for a stage); custom entries are appended after, in
  // the order given, since nothing knows where else they belong.
  const selectedBare = registryNames.filter((name) => bare.some((e) => e.name === name));
  const custom = entries.filter((e) => e.source);
  return [
    ...selectedBare.map((name) => ({ name, source: null })),
    ...custom,
  ];
}

// The registry key and the plugin's own name are the same in collection2crate-plugins, and
// the module lives under that name. Ask the factory rather than assuming:
// it only assigns deps and returns its plugin object, so constructing one here
// is cheap and authoritative — and a third-party registry is free to key
// itself differently.
function moduleNameFor(entry, registry) {
  if (entry.source) return entry.name;
  const factory = registry?.[entry.name];
  if (typeof factory !== "function") return entry.name;
  try {
    const built = factory(STUB_DEPS);
    if (built?.name) return built.name;
  } catch {
    // A factory that needs more than a stub: fall back to the registry key.
  }
  return entry.name;
}

// Every deps key a factory might destructure, present and inert.
const STUB_DEPS = new Proxy({}, { get: () => () => {}, has: () => true });

/** The module specifier the generated file should import a plugin from. */
function specifierFor(entry, registryPackage) {
  if (!entry.source) return `${registryPackage}/plugins/${entry.moduleName || entry.name}/index.js`;
  if (entry.source.startsWith(".") || path.isAbsolute(entry.source)) {
    const absolute = path.resolve(REPO_ROOT, entry.source);
    // Written relative to src/plugins/ so the generated file is portable.
    let relative = path.relative(path.join(REPO_ROOT, "src", "plugins"), absolute);
    if (!relative.startsWith(".")) relative = `./${relative}`;
    return relative.split(path.sep).join("/");
  }
  return `${entry.source}/plugins/${entry.name}/index.js`;
}

/**
 * Import every custom entry now, before anything is written, so a bad path or
 * a missing createPlugin export fails here with a clear message rather than
 * obscurely inside Vite later.
 */
async function verifyCustomEntries(entries) {
  for (const entry of entries) {
    if (!entry.source) continue;
    const specifier = specifierFor(entry, "collection2crate-plugins");
    const resolvable = specifier.startsWith(".")
      ? pathToFileURL(path.resolve(REPO_ROOT, "src", "plugins", specifier)).href
      : specifier;
    let module;
    try {
      module = await import(resolvable);
    } catch (e) {
      throw new Error(`Plugin "${entry.name}" could not be imported from ${specifier}: ${e.message}`);
    }
    if (typeof module.createPlugin !== "function") {
      throw new Error(`Plugin "${entry.name}" (${specifier}) does not export createPlugin(deps).`);
    }
  }
}

const identifier = (name) => `create_${name.replace(/[^A-Za-z0-9]/g, "_")}`;

function render(pluginEntries) {
  const importLines = pluginEntries.map(
    (e) => `import { createPlugin as ${identifier(e.name)} } from ${JSON.stringify(specifierFor(e, "collection2crate-plugins"))};`
  );

  return `// GENERATED by scripts/select-plugins.mjs — do not hand-edit.
//
// Regenerate with \`npm run select-plugins\` (predev/prebuild/pretest already
// do). Which plugins appear here comes from the PLUGINS env var; see
// SPEC.md §4.7a.
//
//   PLUGINS=${pluginEntries.map((e) => e.name).join(",") || "(none)"}

import { buildDeps } from "./deps.js";
${importLines.join("\n")}

// One deps object, built once, handed to every factory (SPEC.md §4.7a).
const deps = buildDeps();

/**
 * Every plugin, builders included — array order is hook-execution order for
 * plugins sharing a stage at equal priority. A builder is not a separate kind
 * of plugin: it is one whose crate:build tap sits in the builder band
 * (priority <= BUILDER_PRIORITY) and assembles ctx.crate (SPEC.md §4.5).
 */
export const PLUGINS = [
${pluginEntries.map((e) => `  ${identifier(e.name)}(deps),`).join("\n")}
];

/** Every plugin's Build-panel option schema, in plugin order. */
export function composeOptionSchema() {
  return PLUGINS.map((plugin) => plugin.optionSchema).filter(Boolean);
}

/** Every plugin's Settings-modal schema, in plugin order. */
export function composeSettingsSchema() {
  return PLUGINS.map((plugin) => plugin.settingsSchema).filter(Boolean);
}

/**
 * Every plugin's Visualise panel, in plugin order.
 *
 * A panel is something a plugin offers, like an option schema — so leaving a
 * plugin out of the PLUGINS selection takes its panel with it (SPEC.md §6.4).
 */
export function composeVisualisationPanels() {
  return PLUGINS
    .filter((plugin) => plugin.visualisation?.render)
    .map((plugin) => ({ name: plugin.name, ...plugin.visualisation }));
}

/**
 * Every path a plugin may write into the picked folder, deduped by path.
 * Used to exclude a previous build's output from the folder scan, and by the
 * "Delete plugin output before rebuilding" setting.
 */
export function composeOutputPaths() {
  const byPath = new Map();
  for (const plugin of PLUGINS) {
    for (const entry of plugin.outputPaths || []) {
      if (entry?.path && !byPath.has(entry.path)) byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()];
}
`;
}

async function main() {
  const pluginEntries = parseSelection(process.env.PLUGINS, REGISTRY, "PLUGINS")
    .map((entry) => ({ ...entry, moduleName: moduleNameFor(entry, REGISTRY) }));

  await verifyCustomEntries(pluginEntries);
  await writeFile(OUTPUT_PATH, render(pluginEntries), "utf8");

  const names = pluginEntries.map((e) => e.name);
  console.log(`select-plugins: wrote src/plugins/index.js — ${names.length} plugin(s) [${names.join(", ")}]`);
}

main().catch((error) => {
  console.error(`select-plugins: ${error.message}`);
  process.exit(1);
});
