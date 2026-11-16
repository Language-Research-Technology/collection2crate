// Identifies subject languages by filename against a bundled, offline copy
// of the AUSTLANG data pack. The actual matching logic + the ~730kB data
// pack (matcher.js + austlang-data.json, both in this folder) is
// dynamically imported only when this plugin's option is on, so it stays
// out of the main bundle regardless of whether the plugin file itself is
// statically imported into the registry.
// Hook names are literal strings and core collection2crate functions arrive
// via createPlugin(deps) — see this repo's README.
import { progressFor } from "../../src/_progress.js";

let addLanguageEntities;

export function createPlugin(deps) {
  ({ addLanguageEntities } = deps);
  return plugin;
}

// rdf:Property definitions for the custom fields matcher.js's shapeMatch()
// writes onto matched Language entities (custom:austlangCode/iso639-3/
// glottologCode) — plugin-exclusive, so they're only added to the crate
// when this plugin actually identified at least one language, not
// unconditionally for every build regardless of whether AUSTLANG ran.
const LANGUAGE_PROPERTY_DEFINITIONS = [
  { "@id": "arcp://name,custom/terms#austlangCode", "@type": "rdf:Property", name: "Austlang Code", description: "The AUSTLANG code for a language." },
  { "@id": "arcp://name,custom/terms#iso639-3", "@type": "rdf:Property", name: "ISO 639-3", description: "The ISO 639-3 code for a language." },
  { "@id": "arcp://name,custom/terms#glottologCode", "@type": "rdf:Property", name: "Glottolog Code", description: "The Glottolog code for a language." },
];

const plugin = {
  name: "austlang",
  optionSchema: {
    key: "enableLanguageLookups", label: "Identify subject languages (AUSTLANG, by filename)", default: false,
    hint: "Matches filenames against a bundled copy of the AUSTLANG data pack — fully offline, no network.",
    children: [
      { key: "includeAlternateNames", label: "Match Austlang alternate names", default: false,
        hint: "More matches, more false positives." },
    ],
  },
  hooks: {
    "files:prepare": {
      priority: 10,
      weight: 4,
      activeWhen: (ctx) => !!ctx.options.enableLanguageLookups,
      handler: async (ctx) => {
        if (!ctx.options.enableLanguageLookups) return;
        const { identifyAllLanguages } = await import("./matcher.js");
        const progress = progressFor(ctx);
        progress.start("Identifying subject languages…");
        try {
          ctx.langById = await identifyAllLanguages(
            ctx.filesWithMeta, ctx.options.includeAlternateNames, ctx.log, progress.report,
          );
        } finally {
          // done() in a finally so a thrown match still snaps the bar to the
          // end of this tap's slice rather than leaving it stuck mid-step.
          progress.done();
        }
      },
    },
    "crate:build": {
      priority: 30,
      weight: 1,
      activeWhen: (ctx) => !!ctx.options.enableLanguageLookups,
      handler: (ctx) => {
        if (!ctx.langById) return;
        const n = addLanguageEntities(ctx.crate, ctx.filesWithMeta, ctx.langById);
        if (n) for (const p of LANGUAGE_PROPERTY_DEFINITIONS) ctx.crate.addEntity(p);
        ctx.log(`Identified ${n} unique language(s).`, n ? "ok" : "muted");
      },
    },
  },
};
