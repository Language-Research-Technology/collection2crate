// Seam: the profile contract — the bundled default loads and behaves exactly
// as SPEC.md §5.1 describes it, the Describe schema is introspected rather
// than written into the app, the layout comes from the mode file, and
// validation always returns a definite answer.

import assert from "node:assert/strict";
import {
  loadDefaultProfile, loadDefaultProfileFiles, overlayBuildOptions,
  DEFAULT_PROFILE_NAME, DEFAULT_BUILD_OPTIONS,
} from "../src/default_profile.js";
import {
  profileToConfig, resolvePropertyGroups, validateBuiltCrate, buildDescribeSchema, STRUCTURAL_PROPERTIES,
  profileFilePaths, profileNamesFromTree, PROFILE_CRATE_FILE, MODE_FILE_NAMES,
  resolveBuildOptions, uploadKeyFor, normaliseFileProperties, loadProfile,
} from "../src/masp.js";
import { buildFileMetadata, buildCrate } from "../src/crate.js";

const noLog = () => {};
const profile = await loadDefaultProfile();

/* ---------- the bundled default loads, offline, from the dependency ---------- */

{
  const files = await loadDefaultProfileFiles();
  assert.equal(files.source, "bundled",
    "The default comes from the ro-crate-masp dependency, not from a fetch — a fallback that can fail to load is not a fallback");
  assert.ok(Array.isArray(files.profileJson["@graph"]),
    "The bundled profile crate is real RO-Crate JSON-LD");
  assert.equal(profile.name, DEFAULT_PROFILE_NAME, "The loaded profile identifies itself as the default");
  assert.deepEqual(profile.rootTypes, ["Dataset"],
    "The default's root dataset type is Dataset — setEditorHints is what makes getRootDatasetTypes report the subject dataset rather than the metadata descriptor");
}

/* ---------- this app's buildOptions overlay, not upstream's ---------- */

{
  const { modeJson: vendored } = await import(
    "ro-crate-masp/profiles/schema-org/profile-crate/crate-o-mode.json",
    { with: { type: "json" } }
  ).then((m) => ({ modeJson: m.default }));

  assert.equal(vendored?.tools?.collection2crate, undefined,
    "The vendored mode file carries no collection2crate block — upstream has no reason to hold a key only this app reads");
  assert.deepEqual(profile.buildOptions, { ...DEFAULT_BUILD_OPTIONS },
    "The overlay supplies the buildOptions the default needs, without modifying the dependency's file");
  assert.deepEqual(profile.buildOptions.enabledOptionKeys, ["makeHtml"],
    "The default enables makeHtml and nothing else: JSON plus a preview, no merge, no language lookups, no template fetch");

  const overlaid = overlayBuildOptions(vendored);
  assert.equal(vendored.tools?.collection2crate, undefined,
    "overlayBuildOptions copies rather than mutating the imported module object, which is shared for the session");
  assert.deepEqual(overlaid.propertyGroups, vendored.propertyGroups,
    "Everything else in the mode file passes through the overlay unmodified");
}

/* ---------- the Describe form is introspected from the profile ---------- */

{
  const fields = profile.describeFields;
  assert.deepEqual(
    fields.map((field) => field.key),
    ["conformsTo", "name", "description", "datePublished", "license"],
    "Building under the default asks for exactly five fields — nothing about the form is written into the app"
  );

  const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
  assert.equal(byKey.datePublished.control, "date", "A Date-typed property renders as a date input");
  assert.equal(byKey.license.control, "url", "A URL-typed property renders as a url input");
  assert.equal(byKey.name.control, "text", "A Text-typed property renders as a text input");
  assert.equal(byKey.conformsTo.control, "select",
    "A property with an enumerated value list renders as a select, not a free-text field that would mint an empty entity");
  assert.ok(byKey.conformsTo.values.length >= 1,
    "The select's choices come from the profile's own ItemList range");
  assert.ok(byKey.name.required, "A property with minCount > 0 is marked required in the form schema");

  // Structural properties are never rendered, even when a profile declares
  // them: the requirement they express is satisfied by the folder scan, and
  // rendering them as entity-ref fields mints empty objects in the preview.
  for (const field of fields) {
    assert.ok(!STRUCTURAL_PROPERTIES.has(field.key),
      `"${field.key}" is structural and must be dropped from the Describe schema`);
  }
  const withStructural = buildDescribeSchema(profile.validator, "Dataset", profile.workflow);
  assert.ok(!withStructural.some((field) => ["hasPart", "pcdm:hasMember"].includes(field.key)),
    "hasPart and pcdm:hasMember stay out of the schema however the form is rebuilt");
}

/* ---------- the layout comes from the mode file, never invented ---------- */

{
  const groups = resolvePropertyGroups(profile);
  assert.equal(groups.length, 6,
    "The preview is laid out by the profile's own six property groups");
  assert.deepEqual(groups[0].name, "About", "Group order is the mode file's, not re-sorted here");
  assert.ok(groups.every((group) => Array.isArray(group.inputs)),
    "Every group carries the property URIs it renders — that is what the preview needs and what the app must not guess");
  assert.deepEqual(resolvePropertyGroups({ workflow: {} }), [],
    "A profile with no propertyGroups resolves to none, so the preview throws rather than fetching a default layout");
}

/* ---------- profileToConfig hands buildCrate the profile's own shape ---------- */

{
  const config = profileToConfig(profile, { name: ["A collection"] });
  assert.deepEqual(config.rootDataset.type, ["Dataset"], "The root dataset type comes from the mode file");
  assert.deepEqual(config.rootDataset.name, ["A collection"], "Describe values are merged onto the root dataset");
  assert.deepEqual(config.fileProperties, {},
    "The default declares no fileProperties, so nothing custom is written onto each File");
  assert.equal(config.propertyGroups.length, 6, "The config carries the profile's layout through to the preview");
}

/* ---------- validation always returns a definite ok and an errors array ---------- */

{
  const files = buildFileMetadata([{ name: "a.txt", relativePath: "Songs/a.txt" }]);

  const complete = buildCrate(files, profileToConfig(profile, {
    name: ["A collection"],
    description: ["Something to validate."],
    datePublished: ["2026-01-01"],
    license: ["https://creativecommons.org/licenses/by/4.0/"],
  }), noLog);
  const passing = await validateBuiltCrate(profile.validator, complete);
  assert.equal(typeof passing.ok, "boolean", "validateBuiltCrate always reports a definite ok");
  assert.ok(Array.isArray(passing.errors), "validateBuiltCrate always reports an errors array");
  assert.equal(passing.ok, true,
    "A crate with every required Describe field filled in conforms to the bundled default");

  const incomplete = buildCrate(files, profileToConfig(profile, { name: ["Nothing else filled in"] }), noLog);
  const failing = await validateBuiltCrate(profile.validator, incomplete);
  assert.equal(failing.ok, false, "A crate missing required properties does not pass validation");
  assert.ok(failing.errors.length > 0, "A failing validation lists its issues, so the crate can still be written and inspected");
  assert.ok(
    failing.errors.every((error) => typeof error.message === "string" && error.message.length),
    "Every reported issue carries a message"
  );
  assert.ok(
    failing.errors.some((error) => /Property "/.test(error.message)),
    "Top-level errors are cardinality-phrased and name no field, so the per-property detail from results.rules is appended to say which one"
  );

  const noProfile = await validateBuiltCrate(null, complete);
  assert.deepEqual(
    { ok: noProfile.ok, errors: noProfile.errors },
    { ok: true, errors: [] },
    "With no validator at all the result is still definite rather than undefined"
  );

  const broken = await validateBuiltCrate(
    { validateCrate: () => { throw new Error("validator exploded"); } },
    complete
  );
  assert.equal(broken.ok, false, "A validator that throws reports a failure rather than propagating the exception");
  assert.match(broken.errors[0].message, /validator exploded/,
    "The thrown message is surfaced, because a build that cannot be validated should say why");
}

/* ---------- buildOptions gating: hidden means off ---------- */

// Stands in for the composed plugin + core option schema.
const OPTION_SCHEMA = [
  { key: "makeHtml", label: "Generate preview", default: true, children: [
    { key: "templateRepoFolder", type: "select", label: "Template" },
    { key: "styledPreview", label: "Upload template files", default: false, children: [
      { key: "configFile", type: "file", label: "Config (JSON)" },
    ] },
  ] },
  { key: "merge", label: "Merge a spreadsheet", default: false, children: [
    { key: "mergeFile", type: "file", label: "Spreadsheet" },
    { key: "doPlaceLookups", label: "Placename lookups", default: true },
  ] },
  { key: "enableLanguageLookups", label: "AUSTLANG", default: false },
];
const SETTINGS = { topLevelFolderType: "object", overwrite: true, makeXlsx: true };

{
  const profileOptions = {
    enabledOptionKeys: ["makeHtml", "templateRepoFolder", "merge", "mergeFile"],
    plugins: ["merge"],
    templateRepoFolder: "language-resources",
  };
  const { options } = resolveBuildOptions(OPTION_SCHEMA, profileOptions, SETTINGS);

  assert.equal(options.merge, true,
    "An option key named in `plugins` starts switched on");
  assert.equal(options.makeHtml, false,
    "An option the profile allows but does not name in `plugins` starts off, even though its own schema default is true");
  assert.equal(options.enableLanguageLookups, false,
    "An option the profile never names is forced to its off value — hidden and not-running are the same decision");
  assert.equal(options.templateRepoFolder, "language-resources",
    "Any other key in buildOptions pre-fills that option's value");
  assert.equal(options.styledPreview, false,
    "A child key is listed separately and is not implied by its parent being enabled");
  assert.equal(options.doPlaceLookups, false,
    "A child whose schema default is true is still off when the profile did not name it");
  assert.equal(options.configFile, null,
    "A file option the profile did not name resolves to no file rather than to false");
  assert.equal(options.mergeUpload, null,
    "An enabled file option starts with no file chosen");
  assert.equal(uploadKeyFor("mergeFile"), "mergeUpload",
    "A file option writes its chosen File to <base>Upload, which is the key the plugins read");
  assert.equal(uploadKeyFor("crate2tablesConfigUpload"), "crate2tablesConfigUpload",
    "A key already ending in Upload is left alone");
}

{
  // A profile with no block at all offers nothing — the absent block reads as
  // an empty allow-list, not as "no opinion", so an upstream profile authored
  // for crate-o stays conservative here rather than switching everything on.
  const { options } = resolveBuildOptions(OPTION_SCHEMA, null, SETTINGS);
  for (const key of ["makeHtml", "merge", "enableLanguageLookups", "doPlaceLookups"]) {
    assert.equal(options[key], false,
      `"${key}" must be off for a profile with no buildOptions block, whatever its schema default`);
  }
  assert.equal(options.overwrite, true,
    "Settings are not gated by the profile — they are machine and user preferences");
}

{
  // Core settings stay the person's, except where a profile must set one for
  // its own run (how a folder is read is not among them any more — that is an
  // ordinary plugin option now, §4.5).
  const persisted = resolveBuildOptions(OPTION_SCHEMA, { enabledOptionKeys: [] }, SETTINGS).options;
  assert.equal(persisted.topLevelFolderType, "object",
    "With no opinion from the profile, a setting keeps the value the person chose");

  const overridden = resolveBuildOptions(
    OPTION_SCHEMA, { enabledOptionKeys: [], topLevelFolderType: "collection" }, SETTINGS
  ).options;
  assert.equal(overridden.topLevelFolderType, "collection",
    "A profile that names a core setting pre-fills it for its own run");
}

/* ---------- fileProperties, in either shape a profile writes it ---------- */

{
  const definition = { "@id": "arcp://name,custom/terms#participant", "@type": "rdf:Property", name: "Participant" };

  assert.deepEqual(
    normaliseFileProperties([{ key: "custom:participant", definition }]),
    { "custom:participant": definition },
    "The array-of-{key, definition} form every repository profile uses is read into the keyed form the rest of the app expects"
  );
  assert.deepEqual(
    normaliseFileProperties({ "custom:participant": definition }),
    { "custom:participant": definition },
    "The keyed form SPEC.md §5.2 describes passes through unchanged"
  );
  assert.deepEqual(normaliseFileProperties(undefined), {},
    "A profile declaring no file properties yields none, not undefined");
}

/* ---------- a profile whose options are under the old name says so ---------- */

{
  assert.equal(profile.configNote, null,
    "A profile whose options this app can read has nothing to explain");

  const legacy = await loadProfile({
    profileJson: (await loadDefaultProfileFiles()).profileJson,
    modeJson: { rootDataset: { type: ["Dataset"] }, tools: { chaos2crate: { buildOptions: { enabledOptionKeys: ["makeHtml"] } } } },
    name: "legacy",
  });
  assert.equal(legacy.buildOptions, null,
    "Options under the app's former name are not read — the contract is tools.collection2crate");
  assert.match(legacy.configNote, /tools\.chaos2crate/,
    "But an unmigrated profile is named in a note, because 'the profile said nothing' and 'the profile said it under a name this app no longer reads' look identical from the Build panel");

  const silent = await loadProfile({
    profileJson: (await loadDefaultProfileFiles()).profileJson,
    modeJson: { rootDataset: { type: ["Dataset"] } },
    name: "silent",
  });
  assert.equal(silent.configNote, null,
    "A profile that genuinely declares no build options gets no warning — offering nothing is the correct, documented outcome there");
}

/* ---------- the profile repository's own layout ---------- */

// This is the one part of the profile contract with no local example to check
// against, so it is pinned here: a wrong path shows up as a 404 at runtime and
// nowhere else.
{
  const paths = profileFilePaths("ldac");
  assert.equal(paths.profileCrate, "ldac/profile-crate/ro-crate-metadata.json",
    "A profile folder sits at the root of the profile repository — there is no 'profiles/' directory above it");
  assert.equal(PROFILE_CRATE_FILE, "profile-crate/ro-crate-metadata.json",
    "Within a profile folder, the profile crate is under profile-crate/");
  assert.deepEqual(
    paths.modeFiles,
    ["ldac/profile-crate/tool-config.json", "ldac/profile-crate/crate-o-mode.json"],
    "The mode file is tried under both known names, repository-style first — c2c-masp-profiles calls it tool-config.json, the bundled default keeps the dependency's crate-o-mode.json"
  );
  assert.ok(!MODE_FILE_NAMES.some((name) => name.startsWith("profiles/")),
    "No mode-file path carries a repository-root prefix");

  // A tree shaped like the real repository: five profiles at the root,
  // alongside the packaging files that also live there.
  const tree = [
    { path: "README.md", type: "blob" },
    { path: "package.json", type: "blob" },
    { path: "validate-profile.js", type: "blob" },
    { path: "node_modules", type: "tree" },
    { path: "ldac", type: "tree" },
    { path: "ldac/profile-crate", type: "tree" },
    { path: "ldac/profile-crate/ro-crate-metadata.json", type: "blob" },
    { path: "ldac/profile-crate/tool-config.json", type: "blob" },
    { path: "birds/profile-crate/ro-crate-metadata.json", type: "blob" },
    { path: "birds/profile-crate/tool-config.json", type: "blob" },
    { path: "node_modules/some-dep/profile-crate/ro-crate-metadata.json", type: "blob" },
  ];
  assert.deepEqual(
    profileNamesFromTree(tree).map((p) => p.name),
    ["birds", "ldac"],
    "Profiles are found by the one file every profile must have, so the repository's own README, package.json and folders are not offered as profiles"
  );
  assert.deepEqual(profileNamesFromTree([]), [],
    "An empty tree lists no profiles rather than throwing");
}

console.log(
  `test-default-profile: all tests passed (${DEFAULT_PROFILE_NAME}, ` +
  `${profile.describeFields.length} Describe fields, ${resolvePropertyGroups(profile).length} property groups, ` +
  "buildOptions overlay + gating, structural properties excluded, definite validation, profile-repo layout)"
);
