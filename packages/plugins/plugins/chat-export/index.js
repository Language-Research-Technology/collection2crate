import { extractTranscriptText, processTranscriptText, selectTranscriptFiles, transcriptBaseName } from "../ca-data-prep/process.js";
import { countedProgress } from "../../src/_progress.js";
import { outputsInCrateOption, includeOutputs, removeOutputEntities, replaceDotSlashIds } from "../../src/_crate_outputs.js";

// Generated files go under _outputs/, named for what they are rather than for
// this plugin, the same as ca-data-prep's csv/ and logs/. The directory is
// declared as this plugin's own output below; _outputs/ itself is shared, so
// nothing claims it whole. No _config/ counterpart — nothing here is
// configurable.
const OUTPUT_DIR = "_outputs/chat";
export const OUTPUTS_OPTION_KEY = "chatOutputsInCrate";

let writeFileAtPath, fileExists, readFileTextFromDirectory;

export function createPlugin(deps) {
  ({ writeFileAtPath, fileExists, readFileTextFromDirectory } = deps);
  return plugin;
}

export function deriveSpeakerGroup(speakerText) {
  const cleaned = String(speakerText || "").trim();
  if (!cleaned) return "";

  const withoutCode = cleaned.replace(/\s*#\S+\s*$/, "").trim();
  const match = withoutCode.match(/^(.*?)(?:\s*\(([^()]+)\))\s*$/);
  if (!match) return "";

  return match[2]?.trim() || "";
}

export function formatChatParticipants(speakerMap, defaultRole = "Participant") {
  const entries = [];

  for (const [speakerID, details] of speakerMap.entries()) {
    const speakerCode = String(speakerID).trim();
    const role = details.role || defaultRole;
    entries.push(`${speakerCode} ${role}`);
  }

  return `@Participants: ${entries.join(", ")}`;
}

export function formatChatIdLine(languageIso, corpusId, speakerCode, extra = {}) {
  const fields = [
    languageIso || "",
    corpusId || "",
    speakerCode || "",
    extra.age || "",
    extra.sex || "",
    extra.group || "",
    extra.ethnicity || "",
    extra.role || "",
    extra.education || "",
    extra.custom || "",
  ];

  return `@ID: ${fields.join("|")}|`;
}

export async function generateChatText(text, config = {}) {
  const result = await processTranscriptText(text, {
    headerRows: config.headerRows ?? 0,
    footerRows: config.footerRows ?? 0,
    // The same grammar ca-data-prep parses with, when one is chosen, so the
    // CHAT file and the CSV read each document the same way.
    grammar: config.grammar || null,
    grammarName: config.grammarName || "",
  });

  const speakerCodeByResolved = new Map();
  const participantEntries = [];

  for (const [speakerID, details] of result.speakerMap.entries()) {
    const resolvedSpeakerCode = String(details.optionalCode || speakerID).replace(/^#/, "");
    speakerCodeByResolved.set(String(details.optionalCode || speakerID), String(speakerID));
    const speakerCode = String(speakerID).trim();
    const role = details.role || "Participant";
    const group = (details.affiliation || deriveSpeakerGroup(details.name || details.label || speakerID)).replace(/^\((.*)\)$/, "$1");
    participantEntries.push({ speakerCode, role, group, resolvedSpeakerCode });
  }

  const languageIso = String(config.languageIso || "").trim();
  const corpusId = String(config.corpusId || "").trim();
  const lines = [formatChatParticipants(result.speakerMap)];

  for (const speaker of participantEntries) {
    lines.push(formatChatIdLine(languageIso, corpusId, speaker.speakerCode, {
      group: speaker.group,
      role: speaker.role,
    }));
  }

  lines.push("@Begin");
  for (const row of result.rows) {
    const resolvedCode = speakerCodeByResolved.get(String(row.speakerID)) || String(row.speakerID).replace(/^#/, "");
    const cleanedText = String(row.text || "").replace(/\s+/g, " ").trim();
    if (!cleanedText) continue;
    lines.push(`*${resolvedCode}: ${cleanedText}`);
  }
  lines.push("@End");

  return `${lines.join("\n")}\n`;
}

const plugin = {
  name: "chat-export",
  generateChatText,
  outputPaths: [{ path: OUTPUT_DIR, kind: "dir" }],
  optionSchema: {
    key: "generateChatFiles",
    label: "Generate CHAT (.cha) outputs",
    default: false,
    hint: "Creates one CHAT transcript per .docx or .txt transcript, using the transcript speaker metadata and any parenthetical group name from the source.",
    children: [outputsInCrateOption(OUTPUTS_OPTION_KEY, "the CHAT files")],
  },
  hooks: {
    "files:prepare": {
      priority: 40,
      weight: 4,
      activeWhen: (ctx) => !!ctx.options.generateChatFiles,
      handler: async (ctx) => {
        if (!ctx.options.generateChatFiles) return;
        // ca-data-prep reports a skipped same-named file when it runs too;
        // saying so twice would read as two problems.
        const warn = ctx.options.processTranscriptDocuments ? undefined : (message) => ctx.log(message, "warn");
        const files = selectTranscriptFiles(ctx.filesWithMeta || ctx.files || [], warn);
        if (!files.length) return;

        const { resolveTranscriptGrammar } = await import("../ca-data-prep/index.js");
        const chosen = await resolveTranscriptGrammar(ctx, readFileTextFromDirectory);

        const documentRecords = [];
        const tick = countedProgress(ctx, files.length, "Generating CHAT transcripts…");
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          const filePath = file.relativePath || file.fileName || file.name || "";
          let buffer = file.arrayBuffer ? await file.arrayBuffer() : null;
          if (!buffer && ctx.dirHandle && filePath) {
            const { readDocxFileBytesFromDirHandle } = await import("../ca-data-prep/index.js");
            buffer = await readDocxFileBytesFromDirHandle(ctx.dirHandle, filePath);
          }
          if (!buffer) { tick(index); continue; }

          const text = await extractTranscriptText(buffer, file.fileName || file.name);
          const baseName = transcriptBaseName(file.fileName || file.name) || "document";
          const chatText = await generateChatText(text, {
            languageIso: ctx.options.languageIso || "",
            corpusId: ctx.dirHandle && ctx.dirHandle.name ? ctx.dirHandle.name : baseName,
            headerRows: ctx.options.headerRows || 0,
            footerRows: ctx.options.footerRows || 0,
            grammar: chosen?.grammar || null,
            grammarName: chosen?.name || "",
          });

          documentRecords.push({
            baseName,
            docxName: file.fileName || file.name,
            chatDirName: OUTPUT_DIR,
            sourcePath: filePath,
            chatText,
            chatName: `${baseName}.cha`,
          });
          tick(index, `Generated ${baseName}.cha`);
        }
        tick.done();

        ctx.chatExport = { files, documentRecords };
        ctx.log(`Prepared CHAT export for ${documentRecords.length} transcript file(s).`, "muted");
      },
    },

    // CHAT files are derived from the folder's own transcript files, so they are
    // written at files:write — during Process, where they were asked for —
    // rather than waiting for a build. The entities describing them are added
    // at crate:build below, the first point where a crate exists.
    "files:write": {
      priority: 20,
      weight: 2,
      activeWhen: (ctx) => !!ctx.options.generateChatFiles,
      handler: async (ctx) => {
        if (!ctx.options.generateChatFiles || !ctx.chatExport) return;
        const { documentRecords } = ctx.chatExport;
        if (!documentRecords.length) return;

        // The overwrite setting covers derived files too, not just the
        // crate's own output.
        const overwrite = ctx.options.overwrite !== false;
        const total = documentRecords.length;
        const writeTick = countedProgress(ctx, total, "Writing CHAT files…");
        let written = 0;
        for (let i = 0; i < total; i++) {
          const doc = documentRecords[i];
          const path = `${doc.chatDirName}/${doc.chatName}`;
          if (!overwrite && await fileExists(ctx.dirHandle, path)) {
            ctx.log(`${path} exists and overwrite is off — skipped.`, "warn");
          } else {
            await writeFileAtPath(ctx.dirHandle, path, doc.chatText);
            written++;
          }
          writeTick(i, `Wrote ${doc.chatName}`);
        }
        writeTick.done();
        ctx.log(`Wrote ${written} CHAT file(s).`, written ? "ok" : "warn");
      },
    },

    "crate:build": {
      priority: 60,
      weight: 1,
      activeWhen: (ctx) => !!ctx.options.generateChatFiles,
      handler: (ctx) => {
        if (!ctx.options.generateChatFiles || !ctx.chatExport) return;
        const { documentRecords } = ctx.chatExport;
        if (!documentRecords.length || !ctx.crate) return;
        if (!includeOutputs(ctx.options, OUTPUTS_OPTION_KEY)) {
          // Taken out as well as not added: the crate may carry entities an
          // earlier build added for these files.
          const removed = removeOutputEntities(ctx.crate, [OUTPUT_DIR]);
          ctx.log(`Left the CHAT files out of the crate${removed ? ` (removed ${removed} entit(ies) from an earlier build)` : ""}.`, "muted");
          return;
        }
        const fixed = replaceDotSlashIds(ctx.crate, documentRecords.map(chatFileId));
        if (fixed) ctx.log(`Renamed ${fixed} CHAT file entit(ies) an earlier build gave a "./" id.`, "muted");
        addChatFilesToCrate(ctx.crate, documentRecords);
        ctx.log(`Described ${documentRecords.length} CHAT file(s) in the crate.`, "muted");
      },
    },
  },
};

// Registers each .cha as a File entity so it's actually part of the RO-Crate,
// not just a file sitting next to it. ca-data-prep runs before chat-export
// (priority 50 vs 60 on crate:build — see this repo's README) and, when it
// processes the same source file, will already have added a RepositoryObject
// at "#<baseName>" with the docx/csv as hasPart — chat-export
// computes that same id independently (both derive baseName from the source
// source filename the same way) so it can add the .cha into that object's
// hasPart alongside them. If ca-data-prep didn't run this build (chat export
// used on its own), there's no such object to join, so the File entity is
// just added standalone.
//
// The @id is folder-relative with no "./" in front, like ca-data-prep's CSVs:
// a crate loaded later resolves "_outputs/chat/x.cha" to the file, and
// reported "./_outputs/chat/x.cha" as not existing.
export const chatFileId = (doc) => `${doc.chatDirName}/${doc.chatName}`;

export function addChatFilesToCrate(crate, documentRecords) {
  for (const doc of documentRecords) {
    const chatId = chatFileId(doc);
    const objectId = `#${doc.baseName}`;
    const hasObject = crate.hasEntity(objectId);
    crate.addEntity({
      "@id": chatId,
      "@type": "File",
      name: doc.chatName,
      encodingFormat: "text/plain",
      ...(hasObject ? { isPartOf: { "@id": objectId } } : {}),
    });
    if (hasObject) {
      const parts = crate.getProperty(objectId, "hasPart");
      const nextParts = Array.isArray(parts) ? parts : (parts ? [parts] : []);
      if (!nextParts.some((part) => part && part["@id"] === chatId)) nextParts.push({ "@id": chatId });
      crate.setProperty(objectId, "hasPart", nextParts);
    }
  }
}
