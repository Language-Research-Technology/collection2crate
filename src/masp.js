// CORE — profile fetch, load, introspection and validation.
//
// A thin wrapper over ro-crate-maps (installed as ro-crate-masp). Three
// upstream quirks shape this file, all documented in SPEC.md §5.6:
//
//   1. The package declares a `main` entry that doesn't exist in the repo, so
//      the validator is imported by internal path.
//   2. setEditorHints() is REQUIRED, not optional: without it
//      getRootDatasetTypes() returns the metadata *descriptor's* type rather
//      than the subject dataset's.
//   3. The validator has no passing path for URL-typed properties, so errors
//      naming one are annotated as a known limitation rather than presented
//      as data problems.
//
// Isomorphic: no DOM, no File System Access. It does use fetch() for remote
// profiles, which Node has had since 18.

import { ROCrate } from "ro-crate";
import { fetchGitHubJsonFile, fetchGitHubTree } from "./github.js";

export const MASP_PROFILES_REPO_OWNER = "Language-Research-Technology";
export const MASP_PROFILES_REPO_NAME = "c2c-masp-profiles";
export const MASP_PROFILES_REPO_REF = "main";

// A profile folder sits at the root of the profile repository, not under a
// "profiles/" directory (SPEC.md §5.2):
//
//   <profile-name>/profile-crate/ro-crate-metadata.json
//   <profile-name>/profile-crate/<mode file>
export const PROFILE_CRATE_FILE = "profile-crate/ro-crate-metadata.json";
// c2c-masp-profiles calls the mode file tool-config.json; the bundled default
// keeps the ro-crate-masp dependency's own crate-o-mode.json name (SPEC.md §5.2).
export const MODE_FILE_NAMES = ["profile-crate/tool-config.json", "profile-crate/crate-o-mode.json"];

// Structural properties are never rendered in the Describe form (SPEC.md §5.3):
// a profile is right to require that a collection have members, but that is
// satisfied by the folder scan, never by typing — and given a class range they
// would mint empty entities that then show up in the preview.
export const STRUCTURAL_PROPERTIES = new Set([
  "hasPart", "isPartOf", "hasMember", "memberOf",
  "pcdm:hasMember", "pcdm:memberOf", "pcdm:hasFile", "pcdm:fileOf",
]);

let validatorModulePromise = null;
async function loadValidatorModule() {
  if (!validatorModulePromise) {
    // Internal path, not the package root — see quirk 1 above.
    validatorModulePromise = import("ro-crate-masp/lib/masp-validator.js");
  }
  const mod = await validatorModulePromise;
  return mod?.MaspValidator ? mod : mod.default;
}

/**
 * Build the app's view of a profile from its two files.
 *
 * @param {object} args
 * @param {object} args.profileJson  profile-crate/ro-crate-metadata.json
 * @param {object} args.modeJson     the mode file (tool-config / crate-o-mode)
 * @param {string} args.name         profile folder name, for the log and UI
 * @param {string} [args.source]     "repository" | "bundled"
 * @returns {Promise<object>} selectedProfileData
 */
export async function loadProfile({ profileJson, modeJson, name, source = "repository" }) {
  const { MaspValidator } = await loadValidatorModule();
  const profileCrate = new ROCrate(profileJson, { array: true, link: true });
  const validator = new MaspValidator(profileCrate);
  // Required, not optional — see quirk 2 above.
  validator.setEditorHints(modeJson || {});
  validator.ensureParsed();

  const rootTypes = validator.getRootDatasetTypes();
  const describeFields = buildDescribeSchema(validator, rootTypes, modeJson);

  return {
    name,
    source,
    validator,
    // The mode file, under the key the HTML output plugin reads
    // (ctx.selectedProfileData.workflow.propertyGroups).
    workflow: modeJson || {},
    profileJson,
    rootTypes,
    describeFields,
    metadata: validator.getProfileMetadata(),
    buildOptions: modeJson?.tools?.collection2crate?.buildOptions || null,
    configNote: buildOptionsNote(modeJson),
  };
}

/**
 * Why a profile is offering nothing, when that is worth saying out loud.
 *
 * A profile with no buildOptions block offers no optional processing, on
 * purpose (SPEC.md §5.4) — but "the profile said nothing" and "the profile said
 * it under a name this app no longer reads" look identical from the Build
 * panel, and only one of them is a mistake. `chaos2crate` was this app's former
 * name, so a block under it is a profile that has not been migrated yet.
 */
function buildOptionsNote(modeJson) {
  const tools = modeJson?.tools || {};
  const buildOptions = tools.collection2crate?.buildOptions;
  if (!buildOptions) {
    const legacy = Object.keys(tools).filter((key) => key !== "collection2crate" && tools[key]?.buildOptions);
    if (legacy.length) {
      return `This profile declares build options under tools.${legacy[0]} — collection2crate reads tools.collection2crate, so none are offered. The profile needs migrating.`;
    }
    return null;
  }
  // Input modes are gone (§4.5): the plugin that reads the folder is chosen by
  // enabling its own option, so a profile still naming inputMode is asking for
  // something no longer there — and silently getting the generic folder scan.
  //
  // Only worth saying when the profile asked for something *other* than the
  // generic scan, because that is the only case where the build differs from
  // what the profile wanted. A profile naming "generic" (most of them, since it
  // was the default) loses nothing, and a warning there is alarm without cause.
  const namedMode = buildOptions.inputMode;
  if (namedMode && namedMode !== "generic") {
    return `This profile sets inputMode: ${JSON.stringify(namedMode)}, which collection2crate no longer reads — the plugin that builds the crate is chosen by enabling its own option (docx-input's is "docxInput"). This build uses the generic folder scan instead, which is not what the profile asked for.`;
  }
  return null;
}

/**
 * Introspect the profile's root class into a Describe field schema.
 * Nothing about the form is written into the app (SPEC.md §5.3).
 *
 * A root dataset may declare several types — "type": ["Dataset",
 * "RepositoryCollection"] is the shape every profile in the profile repository
 * uses — and the properties worth asking for are spread across them: the
 * collection class carries the real ones while Dataset alone carries none. So
 * the schema is the union over every declared type, deduplicated by property
 * name, in declaration order.
 */
export function buildDescribeSchema(validator, rootType, modeJson) {
  const types = (Array.isArray(rootType) ? rootType : [rootType]).filter(Boolean);
  if (!types.length) return [];
  const longText = new Set(modeJson?.longTextInputs || []);

  const definitions = [];
  const seen = new Set();
  for (const type of types) {
    for (const definition of validator.getDefinitionsForType(type) || []) {
      if (seen.has(definition.name)) continue;
      seen.add(definition.name);
      definitions.push(definition);
    }
  }

  return definitions
    .filter((definition) => !STRUCTURAL_PROPERTIES.has(definition.name))
    .map((definition) => {
      const types = Array.isArray(definition.type) ? definition.type : [definition.type];
      // getEditorValuesForProperty() misses an ItemList range (it reads a
      // .itemList key the rule doesn't carry), so a property with a
      // predefined value list comes back with none and would render as a
      // free-text entity field. Pull them straight off the rule instead.
      const values = definition.values?.length
        ? definition.values
        : enumeratedValues(validator, definition.id);
      return {
        key: definition.name,
        label: definition.name,
        help: definition.help || "",
        required: !!definition.required,
        multiple: !!definition.multiple,
        types,
        values,
        // Textarea selection comes from the profile, not from a guess at the
        // property's name: MASP's editor-definition shape has no multiline
        // hint and the tool has no business inferring one.
        control: pickControl(types, values, longText.has(definition.name)),
      };
    })
    // "Value" is structural (a PropertyValue-fixed slot), not user-editable.
    .filter((field) => field.control !== "none");
}

/** Predefined values declared by an ItemList range on a property rule. */
export function enumeratedValues(validator, propertyRuleId) {
  const rules = validator?.rules?.properties || {};
  const rule = rules[propertyRuleId] || Object.values(rules).find((r) => r.id === propertyRuleId);
  if (!rule) return [];
  const out = [];
  for (const range of [].concat(rule.rangeIncludes || [])) {
    if (!range || typeof range !== "object") continue;
    const rangeTypes = [].concat(range["@type"] || []);
    if (!rangeTypes.includes("ItemList")) continue;
    for (const item of [].concat(range.itemListElement || [])) {
      const value = typeof item === "object" && item !== null ? item["@id"] || item.name : item;
      if (value) out.push(value);
    }
  }
  return [...new Set(out)];
}

function pickControl(types, values, isLongText) {
  const names = types.map((t) => String(t));
  if (names.length === 1 && names[0] === "Value") return "none";
  if (values && values.length) return "select";
  if (names.includes("Date") || names.includes("DateTime")) return "date";
  if (names.includes("URL")) return "url";
  if (names.includes("Text") || names.includes("Number") || names.includes("Integer")) {
    return isLongText ? "textarea" : "text";
  }
  // A class range (Person, Organization, …): a text input whose value is
  // turned into a linked {@id, @type, name} entity on submit.
  return "entity";
}

/** Turn a loaded profile into the `ctx.config` buildCrate() consumes. */
export function profileToConfig(selectedProfileData, describeValues = {}) {
  const mode = selectedProfileData?.workflow || {};
  const rootDataset = {
    type: mode.rootDataset?.type || selectedProfileData?.rootTypes || ["Dataset"],
    ...(mode.rootDataset?.conformsTo ? { conformsTo: mode.rootDataset.conformsTo } : {}),
    ...describeValues,
  };
  return {
    rootDataset,
    metadataLicence: mode.metadataLicence || null,
    fileProperties: normaliseFileProperties(mode.fileProperties),
    propertyGroups: mode.propertyGroups || [],
    longTextInputs: mode.longTextInputs || [],
  };
}

/**
 * Canonicalise `fileProperties` to `{ key: definition }`.
 *
 * The profiles in the profile repository declare it as an array of
 * `{ key, definition }` pairs; SPEC.md §5.2 describes the keyed-object form.
 * Both say the same thing, so both are read here and the rest of the app —
 * crate.js in particular — only ever sees one shape.
 */
export function normaliseFileProperties(fileProperties) {
  if (!fileProperties) return {};
  if (!Array.isArray(fileProperties)) return fileProperties;
  const out = {};
  for (const entry of fileProperties) {
    if (!entry?.key) continue;
    out[entry.key] = entry.definition || entry;
  }
  return out;
}

/** The layout the preview is rendered with — from the mode file, never invented. */
export function resolvePropertyGroups(selectedProfileData) {
  return selectedProfileData?.workflow?.propertyGroups || [];
}

// ---------------------------------------------------------------------------
// Build options (SPEC.md §5.4)
// ---------------------------------------------------------------------------

/** The options key a `type: "file"` control writes its picked File into. */
export function uploadKeyFor(key) {
  if (key.endsWith("Upload")) return key;
  if (key.endsWith("File")) return `${key.slice(0, -"File".length)}Upload`;
  return `${key}Upload`;
}

/** Walk an option schema, parents before children. */
export function walkOptionSchema(nodes, visit, depth = 0) {
  for (const node of nodes || []) {
    if (!node) continue;
    visit(node, depth);
    walkOptionSchema(node.children, visit, depth + 1);
  }
}

const VALUELESS_TYPES = new Set(["file", "mappingBuilder", "collectionLabelsBuilder", "action"]);

function offValueFor(node) {
  if (VALUELESS_TYPES.has(node.type)) return null;
  if (node.type === "select" || node.type === "text") return "";
  return false;
}

/**
 * Resolve a profile's buildOptions block against the composed option schema.
 *
 * `enabledOptionKeys` is an allow-list, and hidden means off: an option the
 * profile did not name is not merely unrendered, it is forced to its off value
 * so the plugin behind it cannot run. Visibility and execution are the same
 * decision, which is what makes the profile the single source of truth for what
 * a build does. A profile with no buildOptions block at all therefore offers no
 * optional processing — the absent block reads as an empty allow-list, not as
 * "no opinion".
 *
 * `plugins` is an array of option keys that start switched on. Any other key in
 * buildOptions pre-fills that option's value, including core settings such as
 * `topLevelFolderType`, which a profile may need to set for its own run — the
 * person's own persisted setting is the fallback, not the override.
 *
 * How the folder is read is not a setting and not a pre-fill: a builder is an
 * ordinary plugin gated by an ordinary option (§4.5), so a profile that wants
 * one names that option in `enabledOptionKeys`/`plugins` like any other.
 *
 * Pure, so tests can hold it to the contract without a browser.
 *
 * @param {Array<object>} schema      composed option schema (plugin + core)
 * @param {object|null} buildOptions  tools.collection2crate.buildOptions
 * @param {object} [settings]         persisted settings, flattened in alongside
 * @returns {{options: object, visible: Set<string>}}
 */
export function resolveBuildOptions(schema, buildOptions, settings = {}) {
  const enabled = new Set(buildOptions?.enabledOptionKeys || []);
  const on = new Set(buildOptions?.plugins || []);
  const options = {};

  walkOptionSchema(schema, (node) => {
    if (!enabled.has(node.key)) {
      options[node.key] = offValueFor(node);
      if (node.type === "file") options[uploadKeyFor(node.key)] = null;
      return;
    }
    if (node.type === "file") {
      options[node.key] = null;
      options[uploadKeyFor(node.key)] = null;
    } else if (node.type === "select" || node.type === "text") {
      options[node.key] = buildOptions?.[node.key] ?? node.default ?? "";
    } else if (VALUELESS_TYPES.has(node.type)) {
      options[node.key] = null;
    } else {
      options[node.key] = on.has(node.key) ? true : !!(buildOptions?.[node.key] ?? false);
    }
  });

  // Settings are never gated — they are machine and user preferences, orthogonal
  // to the profile — but a profile may still pre-fill one for its own run.
  for (const [key, value] of Object.entries(settings)) {
    options[key] = key in (buildOptions || {}) && !enabled.has(key) ? buildOptions[key] : value;
  }

  return { options, visible: enabled };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const URL_LIMITATION_NOTE =
  "known ro-crate-masp limitation: it has no passing path for URL-typed properties";

/**
 * Run the profile's validator over a built crate.
 * Always returns a definite `ok` and an `errors` array, even when the
 * validator itself blows up — a failing crate is still written, with its
 * issues listed (SPEC.md §5.5).
 */
export async function validateBuiltCrate(validator, crate, onProgress) {
  if (!validator) return { ok: true, errors: [], skipped: true };
  let results;
  try {
    results = await validator.validateCrate(crate, { onProgress });
  } catch (e) {
    return { ok: false, errors: [{ message: `validator threw: ${e.message}` }], threw: true };
  }

  const detail = perPropertyDetail(results);
  const errors = (results?.error || []).map((entry) => {
    const extra = detail.get(entry.rule) || [];
    // Top-level errors are cardinality-phrased ("Expected at least 1
    // instances of X, found 0") and never name the field, so the per-property
    // lines from results.rules are appended to say which one.
    const message = extra.length ? `${entry.message} — ${extra.join("; ")}` : entry.message;
    return {
      message: annotateUrlLimitation(message),
      rule: entry.rule,
      entity: entry.entity,
      urlLimitation: mentionsUrlProperty(message),
    };
  });

  return { ok: errors.length === 0, errors, results };
}

// results.rules[ruleId][entityId].info[] is where the field-naming detail
// lives; the top-level error list has only the cardinality phrasing.
function perPropertyDetail(results) {
  const byRule = new Map();
  for (const [ruleId, entities] of Object.entries(results?.rules || {})) {
    const messages = [];
    for (const levels of Object.values(entities || {})) {
      for (const [level, entries] of Object.entries(levels || {})) {
        if (level === "success") continue;
        for (const entry of entries || []) if (entry?.message) messages.push(entry.message);
      }
    }
    if (messages.length) byRule.set(ruleId, [...new Set(messages)].slice(0, 5));
  }
  return byRule;
}

function mentionsUrlProperty(message) {
  return /\bURL\b/.test(String(message || ""));
}

function annotateUrlLimitation(message) {
  return mentionsUrlProperty(message) ? `${message} (${URL_LIMITATION_NOTE})` : message;
}

// ---------------------------------------------------------------------------
// The profile repository
// ---------------------------------------------------------------------------

/** Where a profile's two files live, given its folder name. */
export function profileFilePaths(profileName) {
  return {
    profileCrate: `${profileName}/${PROFILE_CRATE_FILE}`,
    modeFiles: MODE_FILE_NAMES.map((name) => `${profileName}/${name}`),
  };
}

/**
 * List the profiles in the profile repository.
 *
 * Found by looking for the one file every profile must have rather than by
 * listing directories: the repository root also holds package.json, a
 * validator script and whatever else accumulates, and "every top-level
 * directory is a profile" would break the first time one of those is a folder.
 * It reads the tree in a single request, which also keeps the unauthenticated
 * rate limit out of the way.
 */
export async function listProfiles(
  owner = MASP_PROFILES_REPO_OWNER,
  repo = MASP_PROFILES_REPO_NAME,
  ref = MASP_PROFILES_REPO_REF
) {
  return profileNamesFromTree(await fetchGitHubTree(owner, repo, ref));
}

/** The selection half of listProfiles(), separated so it can be tested offline. */
export function profileNamesFromTree(tree) {
  const names = [];
  for (const entry of tree || []) {
    if (entry.type !== "blob") continue;
    const parts = entry.path.split("/");
    if (parts.length !== 3) continue;
    if (`${parts[1]}/${parts[2]}` !== PROFILE_CRATE_FILE) continue;
    names.push(parts[0]);
  }
  return [...new Set(names)].sort().map((name) => ({ name, path: name }));
}

/**
 * Fetch one profile's two files from the profile repository.
 * The mode file's name differs by source, so both known names are tried.
 */
export async function fetchProfile(
  profileName,
  {
    owner = MASP_PROFILES_REPO_OWNER,
    repo = MASP_PROFILES_REPO_NAME,
    ref = MASP_PROFILES_REPO_REF,
  } = {}
) {
  const paths = profileFilePaths(profileName);
  const profileJson = await fetchGitHubJsonFile(owner, repo, ref, paths.profileCrate);

  let modeJson = null;
  let lastError = null;
  for (const candidate of paths.modeFiles) {
    try {
      modeJson = await fetchGitHubJsonFile(owner, repo, ref, candidate);
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!modeJson) {
    throw new Error(
      `Profile "${profileName}" has no mode file (tried ${MODE_FILE_NAMES.join(", ")}): ${lastError?.message}`
    );
  }
  return { profileJson, modeJson, name: profileName, source: "repository" };
}
