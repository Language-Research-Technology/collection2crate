// Writes ro-crate-metadata.xlsx, gated by the "Generate ro-crate-metadata.xlsx"
// Settings toggle (settingsSchema, not optionSchema — it stays in the
// Settings modal, its current location; only the fields explicitly asked to
// move to Build options — placename/Austlang lookups — changed location).
//
// Hook names are literal strings and core collection2crate functions arrive
// via createPlugin(deps) — see this repo's README.
import { progressFor } from "../../src/_progress.js";

let crateToXlsxBytes, writeFile, fileExists;

const XLSX_FILE = "ro-crate-metadata.xlsx";

export function createPlugin(deps) {
  ({ crateToXlsxBytes, writeFile, fileExists } = deps);
  return plugin;
}

const plugin = {
  name: "ro-crate-xlsx-output",
  outputPaths: [{ path: XLSX_FILE, kind: "file" }],
  settingsSchema: {
    key: "makeXlsx", label: "Generate ro-crate-metadata.xlsx", default: true,
  },
  hooks: {
    "crate:write": {
      priority: 30,
      weight: 2,
      activeWhen: (ctx) => !!ctx.options.makeXlsx,
      handler: async (ctx) => {
        const { dirHandle, options, crate, log } = ctx;
        if (!options.makeXlsx) return;
        const progress = progressFor(ctx);
        progress.start(`Writing ${XLSX_FILE}…`);
        try {
          if (options.overwrite || !(await fileExists(dirHandle, XLSX_FILE))) {
            const bytes = await crateToXlsxBytes(crate);
            await writeFile(dirHandle, XLSX_FILE, bytes);
            log(`Wrote ${XLSX_FILE}.`, "ok");
          } else {
            log(`${XLSX_FILE} exists and overwrite is off — skipped.`, "warn");
          }
        } finally {
          progress.done();
        }
      },
    },
  },
};
