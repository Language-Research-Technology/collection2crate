import { progressFor } from "../../src/_progress.js";

// A builder for corpora of structured Word documents: parses Heading 1/2/3-
// structured .docx files into Collections/DocumentParts/Chapters
// (docx_crate.js, in this folder) instead of generic-input's flat file scan.
//
// An ordinary plugin, gated by an ordinary option. What makes it a *builder*
// is that it taps crate:build inside the builder band (priority <= 10) and
// produces ctx.crate — adding to the one the pipeline seeded from an existing
// crate, when there is one. It sits at 5, below generic-input's 10, so when its option
// is on it wins the band: generic-input stands down for the whole build, its
// folder scan included, and the annotating taps at 20+ run against the crate
// this one produced. Nothing here knows generic-input exists; the priority is
// the whole of the arrangement.
//
// docx_crate.js pulls in mammoth + cheerio (heavy deps), so it's only
// dynamically imported here when the option is actually on — keeps it out of
// the main bundle and in its own chunk regardless of this plugin ever being
// used in a given session. It also needs one collection2crate core function
// (writeFileAtPath) — createPlugin(deps) holds onto deps and hands it to
// docx_crate.js's configure() once the dynamic import resolves, rather than
// importing fs_helpers.js directly (see this repo's README).
// Mirrors docx_crate.js's own (module-private) OUTPUT_FILES_DIR_NAME — kept
// as a literal here rather than imported, since importing docx_crate.js
// statically would defeat the whole point of dynamic-importing it below (it
// evaluates its mammoth/cheerio imports regardless of which export is used).
const OUTPUT_FILES_DIR_NAME = "ro-crate-preview_files";

export function createPlugin(deps) {
  return {
    name: "docx-input",
    optionSchema: {
      key: "docxInput",
      label: "Read the folder as structured Word documents",
      default: false,
      hint: "One sub-folder per collection, each holding .docx files whose Heading 1/2/3 styles become Collections and Chapters. Replaces the generic file scan for this build.",
    },
    // Written at crate:write below, which wipes and recreates the directory
    // each time; declaring it here is about scan-exclusion and the folder-wide
    // "delete plugin output" setting.
    outputPaths: [{ path: OUTPUT_FILES_DIR_NAME, kind: "dir" }],
    hooks: {
      "crate:build": {
        priority: 5,
        weight: 3,
        activeWhen: (ctx) => !!ctx.options.docxInput,
        handler: async (ctx) => {
          if (!ctx.options.docxInput) return;
          ctx.log("Parsing structured Word documents (Heading 1/2/3 → Collections/Chapters)…", "info");
          const { buildCrateFromDocxFolder, scanDocxFolder, configure } = await import("./docx_crate.js");
          configure(deps);

          const scan = await scanDocxFolder(ctx.dirHandle);
          if (scan.docxCount === 0) {
            throw new Error(
              "No .docx files found in this folder's sub-folders. Expected one folder per collection " +
              "directly inside the picked folder, each containing structured .docx files."
            );
          }
          if (!scan.hasHeadingStyles) {
            ctx.log(
              "Warning: none of the sampled .docx files use Word's Heading 1/2/3 paragraph styles — " +
              "structure (Collections/Chapters) may come out empty. See the README for the required authoring conventions.",
              "warn"
            );
          }

          const result = await buildCrateFromDocxFolder(ctx.dirHandle, ctx.config, (msg) => ctx.log(msg, "muted"));
          if (!result) {
            throw new Error(
              "No collection sub-folders with .docx files were found. Expected one folder per collection " +
              "directly inside the picked folder, each containing structured .docx files — see " +
              "corpus-tools-person-centred-collections-docx's README for the folder layout."
            );
          }
          // With an existing crate the pipeline has already seeded ctx.crate;
          // the parse lands in it (existing values win) rather than replacing
          // it (collection2crate SPEC.md §4.4a).
          if (ctx.crate) {
            const { added, enriched } = deps.mergeCrateInto(ctx.crate, result.crate);
            ctx.log(`Added ${added} entit(ies) to the existing crate; filled in ${enriched} it already had.`, "muted");
          } else {
            ctx.crate = result.crate;
          }
          ctx.sourceCount = result.documentPartCount;
          // The media the documents embed or reference is extracted here,
          // because the crate has to name it, but it isn't on disk until
          // crate:write — nothing reads those files before the crate they
          // belong to is written out.
          ctx.docxMedia = result.media || [];
          ctx.log(`Built crate: ${result.collectionCount} collection(s), ${result.documentPartCount} document(s).`, "ok");
          if (ctx.docxMedia.length) {
            ctx.log(`Extracted ${ctx.docxMedia.length} media file(s), to be written with the crate.`, "muted");
          }
        },
      },

      // Ahead of the crate's other written artefacts: the preview links to
      // these files, so they are on disk before anything points at them.
      "crate:write": {
        priority: 5,
        weight: 2,
        activeWhen: (ctx) => !!ctx.options.docxInput,
        handler: async (ctx) => {
          if (!ctx.options.docxInput || !ctx.docxMedia?.length) return;
          const { writeExtractedMedia } = await import("./docx_crate.js");
          const progress = progressFor(ctx);
          progress.start("Writing extracted media…");
          try {
            const { written, skipped } = await writeExtractedMedia(ctx.dirHandle, ctx.docxMedia, {
              overwrite: ctx.options.overwrite !== false,
            });
            ctx.log(`Wrote ${written} media file(s) to ${OUTPUT_FILES_DIR_NAME}/.`, written ? "ok" : "muted");
            if (skipped) {
              ctx.log(`${skipped} media file(s) already present and overwrite is off — skipped.`, "warn");
            }
          } finally {
            progress.done();
          }
        },
      },
    },
  };
}
