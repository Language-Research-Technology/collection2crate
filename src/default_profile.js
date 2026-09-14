// The bundled schema.org default profile (SPEC.md §5.1).
//
// There is no un-profiled path and no ad-hoc fallback config, but a profile is
// never demanded of the user either: with none chosen, this applies. It is
// bundled rather than fetched because a fallback that can fail to load is not
// a fallback — this works offline, survives a GitHub rate limit, and can't 404.
//
// The profile crate is ~1.6 MB (~261 kB gzipped), so both files are pulled in
// behind a dynamic import and land in their own chunk, downloaded only when a
// build actually runs without a chosen profile.

export const DEFAULT_PROFILE_NAME = "schema.org (default)";

// tools.collection2crate.buildOptions is OUR extension, not upstream's: the
// vendored profile has no such block and upstream has no reason to carry a key
// only this app reads. So it is overlaid here onto an otherwise unmodified copy
// of the dependency's file — pushing it upstream would put our concern in their
// repo, and forking the profile would cost the offline guarantee bundling exists
// for. It names makeHtml and nothing else, which is what makes the default's
// behaviour describable exactly: JSON plus a preview, no merge, no language
// lookups, no template fetch.
export const DEFAULT_BUILD_OPTIONS = Object.freeze({
  enabledOptionKeys: ["makeHtml"],
  plugins: ["makeHtml"],
});

let cached = null;

// The two runtimes disagree about JSON imports, and this module has to satisfy
// both — it is bundled for the browser and imported directly by the Node test
// suite.
//
//   Node requires `with { type: "json" }` and throws ERR_IMPORT_ATTRIBUTE_MISSING
//   without it. Vite compiles a .json import into an ordinary JS module, so the
//   attribute makes the browser reject it outright ("Expected a JSON module
//   script but the server responded with a MIME type of text/javascript").
//
// So each file is loaded by a literal, attribute-free import — the form Vite
// understands, and the one that puts the profile crate in its own chunk — with
// a Node fallback behind it. The fallback's specifier is a variable behind
// @vite-ignore on purpose: that is what stops Rollup resolving it as well and
// emitting a second 1.2 MB copy of the same file.
const PROFILE_CRATE_JSON = "ro-crate-masp/profiles/schema-org/profile-crate/ro-crate-metadata.json";
const MODE_FILE_JSON = "ro-crate-masp/profiles/schema-org/profile-crate/crate-o-mode.json";

async function importForNode(specifier, browserFormFailed) {
  try {
    return (await import(/* @vite-ignore */ specifier, { with: { type: "json" } })).default;
  } catch {
    // Neither form worked: report the browser one, which is the failure that
    // matters wherever this actually ships.
    throw browserFormFailed;
  }
}

/** Load the bundled default, with this app's buildOptions overlay applied. */
export async function loadDefaultProfileFiles() {
  if (cached) return cached;

  const [profileJson, modeJson] = await Promise.all([
    import("ro-crate-masp/profiles/schema-org/profile-crate/ro-crate-metadata.json")
      .then((m) => m.default)
      .catch((e) => importForNode(PROFILE_CRATE_JSON, e)),
    import("ro-crate-masp/profiles/schema-org/profile-crate/crate-o-mode.json")
      .then((m) => m.default)
      .catch((e) => importForNode(MODE_FILE_JSON, e)),
  ]);

  cached = {
    profileJson,
    modeJson: overlayBuildOptions(modeJson),
    name: DEFAULT_PROFILE_NAME,
    source: "bundled",
  };
  return cached;
}

/**
 * Copy the mode file with tools.collection2crate.buildOptions added.
 * Never mutates the imported module object — it is shared across the session.
 */
export function overlayBuildOptions(modeJson) {
  return {
    ...modeJson,
    tools: {
      ...(modeJson?.tools || {}),
      collection2crate: {
        url: "",
        version: "0.0.1",
        ...(modeJson?.tools?.collection2crate || {}),
        buildOptions: { ...DEFAULT_BUILD_OPTIONS },
      },
    },
  };
}

/** The loaded, ready-to-use default profile (a selectedProfileData). */
export async function loadDefaultProfile() {
  const { loadProfile } = await import("./masp.js");
  return await loadProfile(await loadDefaultProfileFiles());
}
