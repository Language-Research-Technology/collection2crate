// The baseline builder: scans every file in the picked folder and builds
// RepositoryObject/RepositoryCollection/File entities from it (crate.js's
// buildFileMetadata + buildCrate).
//
// This is an ordinary plugin — there is no separate input-plugin registry and
// no input mode. What makes it a *builder* is that it taps crate:build inside
// the builder band (priority <= 10) and produces ctx.crate; annotating taps start
// at 20 and assume ctx.crate already exists. At most one builder runs per
// build: the active one with the lowest priority wins, and every tap of a
// builder that lost is skipped for that build — which is what lets this
// plugin's files:prepare scan sit alongside a specialised builder's taps
// without either having to know the other exists.
//
// It carries no option of its own, so it is always active and therefore the
// fallback: it builds unless a gated builder with a lower priority (e.g.
// docx-input at 5) is switched on for the run.
//
// Core collection2crate functions arrive via createPlugin(deps) — see this repo's
// README.
let buildFileMetadata, buildCrate;

export function createPlugin(deps) {
  ({ buildFileMetadata, buildCrate } = deps);
  return plugin;
}

// The flat file list every files:prepare tap reads. Priority 0 puts it below
// the annotating taps (austlang at 10, file-format-identify at 20, …), which
// is what guarantees ctx.filesWithMeta exists before any of them run. A
// builder that reads the folder some other way simply doesn't produce one —
// and, having won the band, this tap never runs.
function scanFiles(ctx) {
  ctx.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  ctx.filesWithMeta = buildFileMetadata(ctx.files);
  ctx.log(`Scanned ${ctx.filesWithMeta.length} file(s).`, "info");
  ctx.sourceCount = ctx.filesWithMeta.length;
}

// When the folder already has a crate, the pipeline has seeded ctx.crate with
// it before this runs (collection2crate SPEC.md §4.4a), and the user has
// already said which new files to add and which missing ones to drop — the
// ignored ones never reached ctx.files. So this only adds the scan to
// whatever crate is there: buildCrate() adds into ctx.crate and hands back
// the same object, or creates one when the folder had none.
async function buildFromFolder(ctx) {
  ctx.crate = buildCrate(ctx.filesWithMeta, ctx.config, ctx.log, {
    crate: ctx.crate || null,
    topLevelFolderType: ctx.options.topLevelFolderType,
    // ctx.xlsxCrate is set at crate:prepare, before this runs: a spreadsheet
    // already describes the entries and what belongs to what, so the folder
    // scan shouldn't invent a parallel structure alongside it.
    structureFromMetadata: !!ctx.xlsxCrate,
  });
}

const plugin = {
  name: "generic-input",
  hooks: {
    "files:prepare": {
      priority: 0,
      weight: 1,
      handler: scanFiles,
    },
    "crate:build": {
      priority: 10,
      weight: 3,
      handler: buildFromFolder,
    },
  },
};
