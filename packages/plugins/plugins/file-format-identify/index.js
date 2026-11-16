// Identifies each file's format by content, using siegfried's own official
// WASM build (matcher.js + sf.wasm + wasm_exec.js, all in this folder — see
// matcher.js for details). Dynamically imported only when this plugin's
// option is on, so the ~8.8MB wasm binary stays out of the main bundle
// regardless of whether the plugin file itself is statically imported into
// the registry — same shape as the austlang plugin.
// Hook names are literal strings and core collection2crate functions arrive via
// createPlugin(deps) — see this repo's README.
import { progressFor } from "../../src/_progress.js";

let graphEntityById, coreDeps;

export function createPlugin(deps) {
  ({ graphEntityById } = deps);
  coreDeps = deps;
  return plugin;
}

// matcher.js needs getFileHandleAtPath too — configure() hands it
// coreDeps every time it's freshly imported, since a dynamic import() only
// re-runs module init once per module (cached after that), not once per
// call site. Same pattern as xlsx-crate-input's loadXlsxCrate().
async function loadMatcher() {
  const mod = await import("./matcher.js");
  mod.configure(coreDeps);
  return mod;
}

// rdf:Property definition for the PRONOM identifier matcher.js attaches to
// matched File entities — plugin-exclusive, so it's only added to the crate
// when this plugin actually identified at least one file, not
// unconditionally for every build regardless of whether it ran.
const FORMAT_PROPERTY_DEFINITIONS = [
  { "@id": "arcp://name,custom/terms#formatPuid", "@type": "rdf:Property", name: "PRONOM Format", description: "The PRONOM persistent format identifier (PUID) matched from the file's content." },
];

const PRONOM_URL_PREFIX = "https://www.nationalarchives.gov.uk/PRONOM/";

const plugin = {
  name: "file-format-identify",
  optionSchema: {
    key: "identifyFileFormats",
    label: "Identify file formats (PRONOM, by content)",
    default: false,
    hint: "Reads each file's bytes and matches them against the PRONOM signature registry — fully offline, no network.",
  },
  hooks: {
    "files:prepare": {
      priority: 20,
      weight: 6,
      activeWhen: (ctx) => !!ctx.options.identifyFileFormats,
      handler: async (ctx) => {
        if (!ctx.options.identifyFileFormats) return;
        const { identifyAllFormats } = await loadMatcher();
        const progress = progressFor(ctx);
        progress.start("Identifying file formats…");
        try {
          ctx.formatById = await identifyAllFormats(
            ctx.dirHandle, ctx.filesWithMeta, ctx.log, progress.report,
          );
        } finally {
          progress.done();
        }
      },
    },

    "crate:build": {
      priority: 40,
      weight: 1,
      activeWhen: (ctx) => !!ctx.options.identifyFileFormats,
      handler: (ctx) => {
        if (!ctx.formatById) return;
        let n = 0;
        for (const file of ctx.filesWithMeta) {
          const result = ctx.formatById.get(file.id);
          if (!result) continue;
          const entity = graphEntityById(ctx.crate, file.id);
          if (!entity) continue;
          // schema.org's own guidance for encodingFormat: a MIME type when
          // there is one, otherwise a link to a format registry entry — the
          // PRONOM URI is exactly that for formats DROID has no MIME type on
          // record for (mostly obsolete/legacy formats).
          entity.encodingFormat = result.mime || `${PRONOM_URL_PREFIX}${result.puid}`;
          entity["custom:formatPuid"] = `${PRONOM_URL_PREFIX}${result.puid}`;
          n++;
        }
        if (n) for (const p of FORMAT_PROPERTY_DEFINITIONS) ctx.crate.addEntity(p);
        ctx.log(`Identified ${n} file format(s).`, n ? "ok" : "muted");
      },
    },
  },
};
