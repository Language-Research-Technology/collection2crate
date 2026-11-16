// Always-on: writes ro-crate-metadata.json. No optionSchema — matches the
// current unconditional behavior (gated only by the overwrite/file-exists
// check every output plugin already respects).
//
// Hook names are literal strings (a stable collection2crate contract, see
// this repo's README) rather than an imported HOOKS constant, and the core
// collection2crate functions this plugin needs (crate.js/fs_helpers.js) are
// injected via createPlugin(deps) rather than imported by relative path —
// that's what keeps this package free of any runtime dependency back on
// collection2crate.
import { progressFor } from "../../src/_progress.js";

let crateToJsonString, writeFile, fileExists;

const JSON_FILE = "ro-crate-metadata.json";

export function createPlugin(deps) {
  ({ crateToJsonString, writeFile, fileExists } = deps);
  return plugin;
}

const plugin = {
  name: "ro-crate-json-output",
  outputPaths: [{ path: JSON_FILE, kind: "file" }],
  hooks: {
    "crate:write": {
      priority: 20,
      weight: 1,
      handler: async (ctx) => {
        const { dirHandle, options, crate, log } = ctx;
        // One indivisible step, so start()/done() and no report() in between:
        // the main bar crosses this tap's slice and the secondary bar never
        // appears, which is what it should do for work with no sub-steps.
        const progress = progressFor(ctx);
        progress.start(`Writing ${JSON_FILE}…`);
        try {
          if (options.overwrite || !(await fileExists(dirHandle, JSON_FILE))) {
            await writeFile(dirHandle, JSON_FILE, crateToJsonString(crate));
            log(`Wrote ${JSON_FILE}.`, "ok");
          } else {
            log(`${JSON_FILE} exists and overwrite is off — skipped.`, "warn");
          }
        } finally {
          progress.done();
        }
      },
    },
  },
};
