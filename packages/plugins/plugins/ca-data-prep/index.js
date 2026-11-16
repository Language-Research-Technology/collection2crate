import {
  buildRoCrateMetadata,
  processTranscriptText,
  extractTranscriptText,
  selectTranscriptFiles,
  transcriptBaseName,
  transcriptMediaType,
  buildSpeakerPersonEntities,
  toCsv,
} from "./process.js";

// Hook names are literal strings and writeFileAtPath (fs_helpers.js) arrives
// via createPlugin(deps) — see this repo's README.
import { countedProgress } from "../../src/_progress.js";
import { outputsInCrateOption, includeOutputs, removeOutputEntities } from "../../src/_crate_outputs.js";
import {
  GRAMMAR_CONFIG_DIR, grammarPath, grammarFingerprint, listSavedGrammars, loadSavedGrammar,
} from "../../src/_transcript_grammar.js";

let writeFileAtPath, fileExists, readFileTextFromDirectory, mergeCrateInto;

export function createPlugin(deps) {
  ({ writeFileAtPath, fileExists, readFileTextFromDirectory, mergeCrateInto } = deps);
  return plugin;
}

/**
 * The saved grammar this run parses with, or null for the built-in
 * convention. Loaded once per run and kept on ctx, so chat-export — which
 * parses the same documents — reads them the same way, and so crate:build can
 * tell whether the grammar has changed since.
 *
 * A grammar that was chosen but can't be read fails the run: quietly falling
 * back to the built-in convention would produce a CSV from rules the person
 * didn't ask for.
 */
export async function resolveTranscriptGrammar(ctx, readText = readFileTextFromDirectory) {
  const name = String(ctx.options?.transcriptGrammar || "").trim();
  if (!name) return null;
  // Process starts from a fresh ctx, so anything already here was loaded
  // earlier in this same run.
  if (ctx.transcriptGrammar?.name === name) return ctx.transcriptGrammar;
  if (!ctx.dirHandle) throw new Error(`Transcript grammar "${name}" was chosen, but no folder is open to read it from.`);
  const grammar = await loadSavedGrammar(ctx.dirHandle, name, readText);
  ctx.transcriptGrammar = { name, grammar, fingerprint: grammarFingerprint(grammar), path: grammarPath(name) };
  return ctx.transcriptGrammar;
}

export function addCsvFilesToCrate(crate, documentRecords) {
  for (const doc of documentRecords) {
    const csvId = `${doc.csvDirName}/${doc.csvName}`;
    const objectId = `#${doc.baseName}`;
    const hasObject = crate.hasEntity(objectId);
    crate.addEntity({
      "@id": csvId,
      "@type": "File",
      name: doc.csvName,
      encodingFormat: "text/csv",
      ...(hasObject ? { isPartOf: { "@id": objectId } } : {}),
      ...(doc.docxId ? { annotationOf: { "@id": doc.docxId } } : {}),
    });

    if (hasObject) {
      const parts = crate.getProperty(objectId, "hasPart");
      const nextParts = Array.isArray(parts) ? parts : (parts ? [parts] : []);
      if (!nextParts.some((part) => part && part["@id"] === csvId)) nextParts.push({ "@id": csvId });
      crate.setProperty(objectId, "hasPart", nextParts);
      const mainText = crate.getProperty(objectId, "ldac:mainText");
      if (!mainText || (mainText["@id"] || mainText) !== csvId) crate.setProperty(objectId, "ldac:mainText", { "@id": csvId });
    }
  }
}

// Generated files go under _outputs/, named for what they are rather than for
// this plugin — a folder of CSVs reads as a folder of CSVs to whoever opens it.
// Each directory is still declared individually below: _outputs/ itself is
// shared with the other writing plugins, so claiming it whole would hand this
// plugin's "delete output before rebuilding" sweep somebody else's files. No
// _config/ counterpart of its own: the grammar it can parse with lives in
// _config/transcript-grammar/, which the transcript-grammar plugin owns.
const CSV_DIR = "_outputs/csv";
// The option that says whether the CSVs are described in the crate. The logs
// in LOG_DIR never are; they record how a document was read.
export const OUTPUTS_OPTION_KEY = "transcriptOutputsInCrate";
const LOG_DIR = "_outputs/logs";

export async function readDocxFileBytesFromDirHandle(dirHandle, relativePath) {
  if (!dirHandle || !relativePath) return null;
  const parts = String(relativePath).replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return null;
  let dir = dirHandle;
  for (const part of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part, { create: false });
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: false });
  return await (await fileHandle.getFile()).arrayBuffer();
}

const plugin = {
  name: "ca-data-prep",
  outputPaths: [
    { path: CSV_DIR, kind: "dir" },
    { path: LOG_DIR, kind: "dir" },
  ],
  optionSchema: {
    key: "processTranscriptDocuments",
    label: "Process plain transcript documents (.docx, .txt)",
    default: false,
    hint: "Runs the CAAT/AmAus transcript parser over .docx and .txt files in the generic folder build, writing cleaned CSV/log outputs and transcript metadata.",
    children: [
      {
        key: "transcriptGrammar",
        type: "select",
        label: "Transcript grammar",
        placeholder: "— the built-in convention —",
        hint: `Parse with a grammar saved in ${GRAMMAR_CONFIG_DIR}/ (see "Define a transcript grammar…") instead of the built-in Speakers:/PRELIMINARIES convention.`,
        // Offered choices depend on the folder, so the host asks for them.
        choices: async ({ dirHandle }) => listSavedGrammars(dirHandle),
      },
      outputsInCrateOption(OUTPUTS_OPTION_KEY, "the transcript CSV files"),
    ],
  },
  hooks: {
    "files:prepare": {
      priority: 30,
      weight: 5,
      activeWhen: (ctx) => !!ctx.options.processTranscriptDocuments,
      handler: async (ctx) => {
        if (!ctx.options.processTranscriptDocuments) return;
        const files = selectTranscriptFiles(ctx.filesWithMeta || ctx.files || [], (message) => ctx.log(message, "warn"));
        if (!files.length) return;

        // Before the loop, so a missing or broken grammar fails the run once,
        // up front, rather than once per document.
        const chosen = await resolveTranscriptGrammar(ctx);
        if (chosen) ctx.log(`Parsing transcripts with the grammar "${chosen.name}" (${chosen.path}).`, "muted");

        const documentRecords = [];
        let nonConformingTotal = 0;
        const tick = countedProgress(ctx, files.length, "Processing transcript documents…");
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          const filePath = file.relativePath || file.fileName || file.name || "";
          let buffer = file.arrayBuffer ? await file.arrayBuffer() : null;
          if (!buffer && ctx.dirHandle && filePath) {
            buffer = await readDocxFileBytesFromDirHandle(ctx.dirHandle, filePath);
          }
          if (!buffer) {
            ctx.log(`Skipped transcript processing for ${filePath || file.fileName || file.name || "unknown transcript"}: file bytes were unavailable.`, "warn");
            // Skipped files still count towards the bar — otherwise a folder
            // where half the transcripts are unreadable leaves it short.
            tick(index);
            continue;
          }
          const text = await extractTranscriptText(buffer, file.fileName || file.name);
          const result = await processTranscriptText(text, {
            ...(ctx.options || {}),
            grammar: chosen?.grammar || null,
            grammarName: chosen?.name || "",
          });
          const baseName = transcriptBaseName(file.fileName || file.name);

          // Document-level warnings (section order, and the like) are few and
          // worth reading here. Per-line non-conformance is not: a transcript
          // whose turn numbers all lack a period would file one warning per
          // turn and bury everything else, so the build log gets a count and
          // the log file gets the lines.
          for (const warning of result.warnings || []) ctx.log(warning, "warn");
          const nonConforming = result.nonConforming || { speakers: [], body: [], total: 0 };
          nonConformingTotal += nonConforming.total;
          if (nonConforming.total) {
            ctx.log(
              `${file.fileName || file.name}: ${nonConforming.total} non-conforming line(s) — ` +
              `${nonConforming.speakers.length} in the speaker block, ${nonConforming.body.length} in the body. ` +
              `See ${LOG_DIR}/${baseName}.log.txt`,
              "warn",
            );
          }
          const csvText = toCsv(result.rows, result.extraColumns);
          const csvDirName = CSV_DIR;
          const logDirName = LOG_DIR;

          const speakerRefs = Array.from(result.speakerMap.entries()).map(([speakerID, details]) => ({
            "@id": details.optionalCode || `#${speakerID}`,
          }));

          documentRecords.push({
            baseName,
            // docxName/docxId name the source file, .txt or .docx alike.
            docxName: file.fileName || file.name,
            sourceEncodingFormat: transcriptMediaType(file.fileName || file.name),
            csvName: `${baseName}.csv`,
            csvDirName,
            logDirName,
            sourcePath: file.relativePath,
            objectId: `#${baseName}`,
            docxId: file.relativePath,
            csvId: `${csvDirName}/${baseName}.csv`,
            annotationId: `#annotation-${baseName}`,
            speakerRefs,
            persons: buildSpeakerPersonEntities(result.speakerMap),
            csvText,
            logText: `${result.log}\n`,
            fileCount: 1,
          });
          tick(index, `Processed ${file.fileName || file.name}`);
        }

        tick.done();
        ctx.caDataPrep = {
          files,
          documentRecords,
          nonConformingTotal,
          // What these records were parsed with — crate:build checks it
          // against the folder before describing them.
          grammar: chosen ? { name: chosen.name, fingerprint: chosen.fingerprint } : null,
        };
        ctx.log(`Prepared transcript processing for ${files.length} transcript file(s).`, "muted");
        if (nonConformingTotal) {
          ctx.log(
            `${nonConformingTotal} non-conforming line(s) across ${files.length} transcript(s) — ` +
            `each document's lines are listed in ${LOG_DIR}/.`,
            "warn",
          );
        }
      },
    },

    // The CSVs and logs are files derived from the folder's own, so they are
    // written at files:write — in the Process step, where the person asked for
    // the processing — rather than waiting for a build. The crate entities
    // describing them are a separate job, below, since no crate exists yet.
    "files:write": {
      priority: 10,
      weight: 2,
      activeWhen: (ctx) => !!ctx.options.processTranscriptDocuments,
      handler: async (ctx) => {
        if (!ctx.options.processTranscriptDocuments || !ctx.caDataPrep) return;
        const { documentRecords } = ctx.caDataPrep;
        if (!documentRecords.length) return;

        // The overwrite setting is the person's answer to "may this build
        // replace what is already in my folder", and applies to derived files
        // as much as to the crate's own.
        const overwrite = ctx.options.overwrite !== false;
        const write = async (path, text) => {
          if (!overwrite && await fileExists(ctx.dirHandle, path)) {
            ctx.log(`${path} exists and overwrite is off — skipped.`, "warn");
            return 0;
          }
          await writeFileAtPath(ctx.dirHandle, path, text);
          return 1;
        };

        const writeTick = countedProgress(ctx, documentRecords.length, "Writing transcript CSV and log files…");
        let written = 0;
        for (let i = 0; i < documentRecords.length; i++) {
          const document = documentRecords[i];
          written += await write(`${document.csvDirName}/${document.baseName}.csv`, document.csvText);
          written += await write(`${document.logDirName}/${document.baseName}.log.txt`, document.logText);
          writeTick(i, `Wrote ${document.baseName}.csv`);
        }
        writeTick.done();
        ctx.log(`Wrote ${written} transcript CSV and log file(s).`, written ? "ok" : "warn");
      },
    },

    "crate:build": {
      priority: 50,
      weight: 1,
      activeWhen: (ctx) => !!ctx.options.processTranscriptDocuments,
      handler: async (ctx) => {
        if (!ctx.options.processTranscriptDocuments || !ctx.caDataPrep) return;
        const { files, documentRecords } = ctx.caDataPrep;
        if (!documentRecords.length) return;
        await warnIfGrammarChanged(ctx);

        // Pass the selected profile's own conformsTo (already assembled into
        // ctx.config.rootDataset) so the transcript crate reflects whichever
        // profile the user picked, not buildRoCrateMetadata's own default.
        const selectedConformsTo = ctx.config?.rootDataset?.conformsTo?.["@id"];
        const withOutputs = includeOutputs(ctx.options, OUTPUTS_OPTION_KEY);
        const transcriptCrate = buildRoCrateMetadata(
          (ctx.dirHandle && ctx.dirHandle.name) || "Transcript Collection", documentRecords, selectedConformsTo,
          { includeOutputs: withOutputs },
        );
        if (withOutputs) addCsvFilesToCrate(transcriptCrate, documentRecords);
        else if (ctx.crate) {
          // An earlier build may have described them; the crate carries on
          // from that one, so take them out rather than just not adding them.
          const removed = removeOutputEntities(ctx.crate, [CSV_DIR]);
          if (removed) ctx.log(`Left the transcript CSVs out of the crate (removed ${removed} entit(ies) from an earlier build).`, "muted");
        }
        if (!ctx.crate) {
          // A host that doesn't seed a crate (older collection2crate).
          ctx.crate = transcriptCrate;
        } else {
          // collection2crate seeds ctx.crate for every run and fails a build
          // that swaps it out (its SPEC.md §4.4), so the transcript crate
          // lands in that object, existing values winning.
          if (!ctx.existingCrate) {
            // A first build keeps its old shape — the transcript crate, not
            // the generic scan's entities for the folder's other files — by
            // clearing the scan's work out of the seeded crate first.
            // Deliberately temporary: which outputs go into the crate is
            // meant to become a choice in the UI.
            const removed = clearFolderScan(ctx.crate);
            ctx.log(`First build: replaced ${removed} folder-scan entit(ies) with the transcript crate.`, "muted");
          }
          const { added, enriched } = mergeCrateInto(ctx.crate, transcriptCrate);
          ctx.log(`Added ${added} transcript entit(ies) to the crate; filled in ${enriched} it already had.`, "muted");
        }
        ctx.sourceCount = files.length;
        ctx.log(`Built transcript crate from ${files.length} transcript file(s).`, "ok");
      },
    },
  },
};

const STRUCTURAL_TYPES = new Set(["File", "RepositoryObject", "RepositoryCollection"]);
const MEMBERSHIP_PROPS = ["hasPart", "hasMember", "pcdm:hasMember"];

const refIdsOf = (value) => (Array.isArray(value) ? value : [value])
  .map((v) => (v && typeof v === "object" ? v["@id"] : null))
  .filter(Boolean);

/**
 * Take a folder scan's work back out of a crate, in place: every File /
 * RepositoryObject / RepositoryCollection entity bar the root, the root's
 * membership lists, and then anything left that nothing points at any more
 * (the scan's language and property-definition entities). The root's own
 * values — the Describe form's, and the entities they link to — stay.
 *
 * @returns {number} how many entities were removed
 */
export function clearFolderScan(crate) {
  const rootId = crate.rootId;
  const descriptorId = crate.metadataFileEntity?.["@id"] || "ro-crate-metadata.json";
  const keep = (id) => id === rootId || id === descriptorId;
  let removed = 0;

  for (const entity of [...crate.getGraph()]) {
    const id = entity["@id"];
    if (keep(id)) continue;
    const types = (Array.isArray(entity["@type"]) ? entity["@type"] : [entity["@type"]]).map(String);
    if (types.some((t) => STRUCTURAL_TYPES.has(t))) {
      crate.deleteEntity(id);
      removed++;
    }
  }
  // ro-crate's entity proxy refuses to delete a property that isn't there.
  for (const prop of MEMBERSHIP_PROPS) {
    if (crate.rootDataset[prop] !== undefined) delete crate.rootDataset[prop];
  }

  // Sweep orphans until nothing changes: deleting one can orphan another.
  for (let changed = true; changed;) {
    changed = false;
    const referenced = new Set();
    for (const entity of crate.getGraph()) {
      for (const [key, value] of Object.entries(entity)) {
        if (key !== "@id") refIdsOf(value).forEach((id) => referenced.add(id));
      }
    }
    for (const entity of [...crate.getGraph()]) {
      const id = entity["@id"];
      if (keep(id) || referenced.has(id)) continue;
      crate.deleteEntity(id);
      removed++;
      changed = true;
    }
  }
  return removed;
}

// Build describes what Process wrote. If the grammar Process parsed with has
// been re-saved or swapped since, those CSVs are out of date — say so, rather
// than building a crate over them in silence. (Changing the *choice* of
// grammar already sends the person back to Process; this catches the file
// changing under a choice that stayed the same.)
export async function warnIfGrammarChanged(ctx, readText = readFileTextFromDirectory) {
  const used = ctx.caDataPrep?.grammar || null;
  const name = String(ctx.options?.transcriptGrammar || "").trim();
  if (!used && !name) return false;
  if (!used || used.name !== name) {
    ctx.log(`The transcript CSVs were parsed with ${used ? `the grammar "${used.name}"` : "the built-in convention"}, but ${name ? `"${name}"` : "the built-in convention"} is chosen now — run Process again.`, "warn");
    return true;
  }
  let current;
  try {
    current = await loadSavedGrammar(ctx.dirHandle, name, readText);
  } catch (e) {
    ctx.log(`Could not re-read the transcript grammar: ${e.message}`, "warn");
    return true;
  }
  if (grammarFingerprint(current) !== used.fingerprint) {
    ctx.log(`${grammarPath(name)} has changed since Process parsed the transcripts with it — run Process again to update the CSVs.`, "warn");
    return true;
  }
  return false;
}
