// Merges metadata from an uploaded spreadsheet into matching crate entities
// (by @id) — mergeXlsxIntoCrate itself (./xlsx.js) is the crate-mutating
// primitive; this file owns the "when/how to gather options for it" logic
// that used to live inline in processFolder.
import { mergeXlsxIntoCrate } from "./xlsx.js";
import { progressFor } from "../../src/_progress.js";
import { resolveMergeConfig } from "../../src/_merge_config.js";

// Hook names are literal strings and core collection2crate functions arrive
// via createPlugin(deps) — see this repo's README. graphEntityById (needed
// by xlsx.js's mergeXlsxIntoCrate) is threaded through as an extra argument
// rather than injected separately, since it's only used inside that one call.
let readJsonFromFolder, graphEntityById;

export function createPlugin(deps) {
  ({ readJsonFromFolder, graphEntityById } = deps);
  return plugin;
}

const plugin = {
  name: "merge",
  optionSchema: {
    key: "merge", label: "Merge metadata from a spreadsheet", default: false,
    hint: "Reads an .xlsx and merges its columns into matching entities (by their @id) before generating outputs.",
    children: [
      { key: "mergeFile", type: "file", label: "Spreadsheet (XLSX)", binary: true,
        accept: ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        hint: "Rows are matched to entities by the @id column." },
      { key: "mergeMappingBuilder", type: "mappingBuilder", label: "Build mapping from spreadsheet columns…",
        hint: "Reads the column headers from the spreadsheet above and lets you set a target property (and type) for each one. You can also load an existing mapping config.json from inside that dialog." },
      { key: "doPlaceLookups", label: "Do placenames lookup", default: true,
        hint: "When on, merged Place entities try to look up coordinates and generate linked Geometry entities.",
        children: [
          { key: "placeExactOnly", label: "Exact place names only", default: false,
            hint: "Off: a place name the gazetteers don't know exactly takes the coordinates of the closest one starting with or containing it (\"Murray Upp\" → Murray Upper). On: only an exact name gets coordinates." },
        ] },
    ],
  },
  hooks: {
    "crate:build": {
      priority: 70,
      weight: 4,
      activeWhen: (ctx) => !!ctx.options.merge,
      handler: async (ctx) => {
        const { options, dirHandle, crate, log } = ctx;
        if (!options.merge) return;
        if (!options.mergeUpload) {
          log("Merge is on but no spreadsheet was selected — skipping merge.", "warn");
          return;
        }

        const { config: mergeConfig, source: mcSrc } = await resolveMergeConfig(options, dirHandle, readJsonFromFolder);
        log(`Merging ${options.mergeUpload.name} · mapping ${mcSrc}.`, "muted");
        const bytes = await options.mergeUpload.file.arrayBuffer();
        const effectiveMergeConfig = {
          ...mergeConfig,
          placeLookup: {
            ...(mergeConfig && typeof mergeConfig.placeLookup === "object" ? mergeConfig.placeLookup : {}),
            enabled: options.doPlaceLookups !== false,
            ...(options.placeExactOnly ? { exactOnly: true } : {}),
          },
        };
        if (options.doPlaceLookups === false) log("Placename lookup disabled by settings.", "muted");

        // The place-name prefetch inside mergeXlsxIntoCrate is the only part
        // of a merge long enough to be worth a bar of its own; the rest of the
        // work is in-memory and finishes between frames. start()/done() bracket
        // the whole tap either way, so a merge with lookups off still moves.
        const progress = progressFor(ctx);
        progress.start(`Merging ${options.mergeUpload.name}…`);
        try {
          await mergeXlsxIntoCrate(crate, bytes, effectiveMergeConfig, log, graphEntityById, progress.report);
        } finally {
          progress.done();
        }
      },
    },
  },
};
