// The "inspect the crate, merge onto whatever config already exists" step,
// factored out so both the build-time hook (index.js) and the standalone
// "Configure tables…" action share exactly one code path rather than two
// that could drift apart.
import { inspectCrate, mergeDiscovered, discoverExpandedProperties } from "roctable/lib/inspect.js";
import { defaultConfig } from "roctable/lib/config.js";

// LDAC's own convention for "this entity's text content": ldac:mainText,
// falling back to indexableText when a type has no mainText property at
// all. A person configuring tables for the first time shouldn't have to
// already know that to get a useful default — this seeds load_text on
// whichever candidate the type actually has, the first time (and only the
// first time) that property is seen.
const MAIN_TEXT_TIER_1 = ["ldac:mainText", "mainText"];
const MAIN_TEXT_TIER_2 = ["ldac:indexableText", "indexableText"];

// "First time seen" has to mean "wasn't in the config that existed before
// this call" — not "looks like the default shape after merging", since a
// person deliberately declining the property (include:false, and nothing
// else) is byte-for-byte the same shape mergeDiscovered gives a genuinely
// new one. Checking presence in the pre-merge config is the only way to
// tell "never decided" from "decided, and decided false" apart.
function propertyAlreadyKnown(existingConfig, type, propName) {
  if (!existingConfig) return false;
  const entry = existingConfig.tables?.[type] || existingConfig.potential_tables?.[type];
  return !!entry?.properties && propName in entry.properties;
}

function applyMainTextDefaults(config, existingConfig) {
  for (const bucket of [config.tables, config.potential_tables]) {
    for (const [type, target] of Object.entries(bucket || {})) {
      const properties = target.properties || {};
      const candidate = MAIN_TEXT_TIER_1.find((name) => name in properties)
        || MAIN_TEXT_TIER_2.find((name) => name in properties);
      if (!candidate) continue;
      if (!propertyAlreadyKnown(existingConfig, type, candidate)) {
        properties[candidate] = { include: true, load_text: true };
      }
    }
  }
}

// roctable's own discoverExpandedProperties (lib/inspect.js) only walks
// config.tables — a type still sitting in potential_tables (not yet ticked
// as a selected table in the tree editor) never gets an expanded property's
// sub-properties discovered, no matter how many times a build runs, since
// the function silently skips it rather than erroring. But the tree editor
// lets a person check "expand" on a potential table's property before
// deciding whether to select the table at all — a reasonable thing to want
// to preview — so this has to work for both buckets. Rather than
// reimplementing that walk (crate-entity iteration, one-hop dereferencing,
// STRUCTURAL_PROPS filtering), run the same trusted function twice with the
// two buckets swapped, so potential_tables gets identical treatment via the
// exact same code path tables already gets.
function discoverExpandedPropertiesForAllTables(crate, config) {
  const afterTables = discoverExpandedProperties(crate, config);
  const swapped = { ...afterTables, tables: afterTables.potential_tables, potential_tables: afterTables.tables };
  const afterBoth = discoverExpandedProperties(crate, swapped);
  return { ...afterBoth, tables: afterBoth.potential_tables, potential_tables: afterBoth.tables };
}

// crate: an ro-crate ROCrate instance (from ctx.crate mid-build, or
// loadCrateFromJson(existingCrateJson) for the standalone action).
// existingConfig: whatever config already exists (folder/upload), or null.
export function discoverConfig(crate, existingConfig) {
  const discovered = inspectCrate(crate);
  let config = mergeDiscovered(existingConfig || defaultConfig(), discovered);
  applyMainTextDefaults(config, existingConfig);
  config = discoverExpandedPropertiesForAllTables(crate, config);
  return config;
}
