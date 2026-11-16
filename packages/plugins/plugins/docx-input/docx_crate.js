// Builds an RO-Crate from a folder of structured .docx files, entirely in
// the browser via the File System Access API.
//
// This is a browser-native port of corpus-tools-person-centred-collections-docx's
// build-ro-crate.js: the parsing/entity-building logic (chapter structure from
// Heading 1/2/3 styles, image/caption/photo/SOUND FILE text conventions,
// embedded-image extraction) mirrors that script closely so the two stay
// behaviourally in sync, but the directory-walking and file I/O is
// reimplemented against FileSystemDirectoryHandle instead of Node's `fs`,
// since that layer can't be shared as-is between a Node CLI and a browser
// bundle. See that repo's README for the authoring conventions this parser
// relies on.
//
// Folder layout expected under `rootHandle` (same as the CLI):
//   <Collection name>/
//     Some Document.docx
//     media/
//       photo.jpg
//     subfolder/
//       Another Document.docx
//       media/
//         clip.mp3
//
// Referenced/embedded media is written into `rootHandle`'s own
// `ro-crate-preview_files/` subfolder (wiped and recreated on each call, and
// named to match its multipage-output sibling `ro-crate-preview_html/`) so
// the crate's file @ids resolve relative to the crate root, mirroring the
// CLI's output/files/.
//
// The root Dataset has exactly two members: #derivedContent, whose hasPart is
// one RepositoryCollection per top-level folder (the parsed Chapter/
// DocumentPart structure this file has always built), and #sourceDocuments,
// whose hasPart is one SourceDocumentGroup per top-level folder holding that
// folder's original .docx files verbatim (also copied into
// ro-crate-preview_files/, at their own original relative path) — kept for
// completeness/download rather than discarded after parsing.
// structured-docs's generated site only ever navigates into #derivedContent;
// #sourceDocuments has no page of its own.

import mammoth from "mammoth";
import * as cheerio from "cheerio";
import { ROCrate } from "ro-crate";

// writeFileAtPath is a collection2crate core function (fs_helpers.js),
// injected once via configure() rather than imported by relative path — see
// docx-input/index.js's createPlugin(deps) and this repo's README.
let writeFileAtPath, fileExists;
export function configure(deps) {
  ({ writeFileAtPath, fileExists } = deps);
}

// Where copied/embedded media and source .docx files land, relative to the
// crate root. Distinct from ro-crate-static-site's own generated-output
// folders (ro-crate-preview.html, ro-crate-preview_html/) only in that this
// one is populated by this file rather than the renderer, but named to match
// them rather than the older bare "files" this replaced.
const OUTPUT_FILES_DIR_NAME = "ro-crate-preview_files";

const CONTROL_AND_GENERATED_NAMES = new Set([
  OUTPUT_FILES_DIR_NAME,
  "ro-crate-metadata.json",
  "ro-crate-metadata.xlsx",
  "ro-crate-preview.html",
  "ro-crate-preview_html",
  "config.json",
]);

/* ---------- config ---------- */

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateAndNormalizeConfig(config) {
  const defaults = {
    name: "Person-Centred Collections",
    description: "RO-Crate generated from docx files.",
    datePublished: "today",
    creators: [],
    license: "",
  };

  const normalized = {
    rootDataset: {
      ...defaults,
      ...(config && isPlainObject(config.rootDataset) ? config.rootDataset : {}),
    },
    metadataLicence: config && isPlainObject(config.metadataLicence) ? config.metadataLicence : null,
  };

  const { rootDataset } = normalized;

  if (typeof rootDataset.name !== "string" || !rootDataset.name.trim()) {
    rootDataset.name = defaults.name;
  } else {
    rootDataset.name = rootDataset.name.trim();
  }

  if (typeof rootDataset.description !== "string" || !rootDataset.description.trim()) {
    rootDataset.description = defaults.description;
  } else {
    rootDataset.description = rootDataset.description.trim();
  }

  if (typeof rootDataset.datePublished !== "string" || !rootDataset.datePublished.trim()) {
    rootDataset.datePublished = defaults.datePublished;
  } else {
    rootDataset.datePublished = rootDataset.datePublished.trim();
    if (rootDataset.datePublished !== "today" && !/^\d{4}-\d{2}-\d{2}$/.test(rootDataset.datePublished)) {
      rootDataset.datePublished = defaults.datePublished;
    }
  }

  // The profile/Describe form writes a singular "creator" key (one ref, or
  // an array of refs, each shaped { "@id", "@type", name } — same
  // entity-ref convention collectDescribeValues() uses everywhere else),
  // not this function's own internal "creators" (plural) shape — bridge it
  // rather than silently dropping Describe-entered creators.
  if (!Array.isArray(rootDataset.creators) || rootDataset.creators.length === 0) {
    const raw = rootDataset.creator;
    rootDataset.creators = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  }

  return normalized;
}

function normalizeIdSegment(value) {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Exported so the Build panel can predict a top-level folder's collection id
// (used to populate the "Home page" picker) without re-parsing the crate.
export function normalizeIdFromPath(pathValue) {
  return (pathValue || "").replace(/\.docx$/i, "").replace(/\//g, "-").replace(/\s+/g, "_");
}

function applyRootDatasetCreators(crate, creators) {
  if (!Array.isArray(creators) || creators.length === 0) return;

  const creatorRefs = [];
  const seenIds = new Set();

  creators.forEach((creator, index) => {
    let creatorName = "";
    let creatorId = "";

    if (typeof creator === "string") {
      creatorName = creator.trim();
    } else if (creator && typeof creator === "object") {
      creatorName = String(creator.name || "").trim();
      creatorId = String(creator["@id"] || creator.id || "").trim();
    }
    if (!creatorName) return;

    if (!creatorId) {
      const idSegment = normalizeIdSegment(creatorName) || String(index + 1);
      creatorId = `#creator-${idSegment}`;
    }

    if (!seenIds.has(creatorId)) {
      crate.addEntity({ "@id": creatorId, "@type": "Person", name: creatorName });
      seenIds.add(creatorId);
    }
    creatorRefs.push({ "@id": creatorId });
  });

  if (creatorRefs.length > 0) crate.rootDataset.creator = creatorRefs;
}

function applyRootDatasetLicense(crate, licenseConfig) {
  if (!licenseConfig) return;

  if (typeof licenseConfig === "string") {
    const licenseId = licenseConfig.trim();
    if (licenseId) crate.rootDataset.license = { "@id": licenseId };
    return;
  }

  if (typeof licenseConfig === "object") {
    const licenseId = String(licenseConfig["@id"] || licenseConfig.id || licenseConfig.url || "").trim();
    const licenseName = String(licenseConfig.name || "").trim();
    if (!licenseId && !licenseName) return;

    if (licenseId) {
      if (licenseName) crate.addEntity({ "@id": licenseId, "@type": "CreativeWork", name: licenseName });
      crate.rootDataset.license = { "@id": licenseId };
      return;
    }
    crate.rootDataset.license = licenseName;
  }
}

function addContextPrefix(crate, prefix, iri) {
  if (!crate || !prefix || !iri) return;
  const context = crate["@context"];
  if (!Array.isArray(context)) {
    crate["@context"] = [context, { [prefix]: iri }].filter(Boolean);
    return;
  }
  const objectContext = context.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  if (objectContext) { objectContext[prefix] = iri; return; }
  context.push({ [prefix]: iri });
}

/* ---------- text/markup helpers ---------- */

function normalizeInlineText(text) { return (text || "").replace(/\s+/g, " ").trim(); }
function preserveLineBreaksFromHtml(html) { return (html || "").replace(/<br\s*\/?>/gi, "<br />"); }
function isNotesDocx(name) { return /\bnotes?\b/i.test(name.replace(/\.docx$/i, "")); }

function parseImageLine(imageLine) {
  if (!imageLine) return { hasImage: false, imageToken: "", inlineCaption: "" };
  const trimmed = imageLine.trim();
  const imageMatch = trimmed.match(/\S+\.(jpg|jpeg|png|gif|tif|tiff|webp|bmp|mov|mp4)\b/i);
  if (!imageMatch) return { hasImage: false, imageToken: "", inlineCaption: "" };
  const imageToken = imageMatch[0];
  const inlineCaption = trimmed.slice(imageMatch.index + imageToken.length).trim();
  return { hasImage: true, imageToken, inlineCaption };
}

function parseSoundLine(line) {
  const match = (line || "").trim().match(/^SOUND FILE:\s*(.+)$/i);
  if (!match) return { hasSound: false, mediaToken: "" };
  return { hasSound: true, mediaToken: match[1].trim() };
}

function splitCaptionAndPhoto(rawCaption) {
  const text = (rawCaption || "").trim();
  if (!text) return { captionText: "", photoText: "" };
  const normalized = text.replace(/\s+(Photo\s*:)/gi, "\n$1");
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const captionParts = [];
  const photoParts = [];
  for (const line of lines) {
    if (/^caption\s*:/i.test(line)) { captionParts.push(line.replace(/^caption\s*:/i, "").trim()); continue; }
    if (/^photo\s*:/i.test(line)) { photoParts.push(line.replace(/^photo\s*:/i, "").trim()); continue; }
    if (photoParts.length > 0) photoParts.push(line); else captionParts.push(line);
  }
  return { captionText: captionParts.join("\n").trim(), photoText: photoParts.join("\n").trim() };
}

function formatCaptionForDisplay(rawCaption) {
  const { captionText, photoText } = splitCaptionAndPhoto(rawCaption);
  const parts = [];
  if (captionText) parts.push(`Caption: ${captionText}`);
  if (photoText) parts.push(`Photo: ${photoText}`);
  return parts.length > 0 ? parts.join("\n") : (rawCaption || "").trim();
}

function toImageMediaEntry(imageSection) {
  const { imageToken, imagePath, caption } = imageSection;
  const sectionEntry = {};
  const { captionText, photoText } = splitCaptionAndPhoto(caption);
  if (imagePath) { sectionEntry.image = { "@id": imagePath }; sectionEntry.filePart = { "@id": imagePath }; }
  else if (imageToken) sectionEntry["custom:imageReference"] = imageToken;
  if (captionText) sectionEntry.caption = captionText;
  if (photoText) sectionEntry.creditText = photoText;
  return Object.keys(sectionEntry).length === 0 ? null : sectionEntry;
}

function ensureFileEntity(crate, seenIds, entityId, name, encodingFormat, sameAsId) {
  if (!entityId || seenIds.has(entityId)) return;
  const entity = { "@id": entityId, "@type": "File", name };
  if (encodingFormat) entity.encodingFormat = encodingFormat;
  if (sameAsId) entity.sameAs = { "@id": sameAsId };
  crate.addEntity(entity);
  seenIds.add(entityId);
}

const CONTENT_TYPE_EXTENSIONS = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/bmp": "bmp",
  "image/tiff": "tiff", "image/webp": "webp", "image/x-emf": "emf", "image/x-wmf": "wmf",
  "image/svg+xml": "svg",
};

function extensionForContentType(contentType) {
  if (CONTENT_TYPE_EXTENSIONS[contentType]) return CONTENT_TYPE_EXTENSIONS[contentType];
  const subtype = (contentType || "").split("/")[1];
  const cleaned = subtype ? subtype.replace(/[^a-z0-9]/gi, "").toLowerCase() : "";
  return cleaned || "bin";
}

const ENCODING_FORMATS = {
  jpg: "image/jpeg", jpeg: "image/jpeg", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
  aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac", png: "image/png", gif: "image/gif",
  tif: "image/tiff", tiff: "image/tiff", webp: "image/webp", bmp: "image/bmp",
  mov: "video/quicktime", mp4: "video/mp4",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function getEncodingFormat(pathValue) {
  const ext = (pathValue.split(".").pop() || "").toLowerCase();
  return ENCODING_FORMATS[ext] || "application/octet-stream";
}

function renderChapterContentBlock(chapter, { includeHeading = true } = {}) {
  const { heading, text, tableRows, soundSections, imageSections } = chapter;
  const sectionLines = [];
  if (includeHeading && heading) sectionLines.push(`## ${heading}`);
  if (text) sectionLines.push(text);
  if (tableRows && tableRows.length > 0) for (const row of tableRows) sectionLines.push(`- ${row.text}`);
  for (const soundSection of soundSections || []) {
    sectionLines.push(soundSection.mediaPath
      ? `[Sound: ${soundSection.mediaToken}](${soundSection.mediaPath})`
      : `[Sound: ${soundSection.mediaToken}]`);
  }
  for (const imageSection of imageSections || []) {
    const { imageToken, imagePath, caption } = imageSection;
    const captionDisplay = formatCaptionForDisplay(caption);
    if (imagePath) sectionLines.push(`![${captionDisplay || heading || "Image"}](${imagePath})`);
    else if (imageToken) sectionLines.push(`[Image: ${imageToken}]`);
    if (captionDisplay) sectionLines.push(captionDisplay);
  }
  return sectionLines.length > 0 ? sectionLines.join("\n\n") : "";
}

function toStructuredDocumentPartBody(chapters) {
  return chapters.map((chapter) => renderChapterContentBlock(chapter)).filter(Boolean).join("\n\n---\n\n");
}

function buildGroupedMediaParts(crate, mediaEntitiesAdded, idPrefix, source) {
  const mediaParts = [];

  for (const soundSection of source.soundSections || []) {
    const soundEntityId = soundSection.mediaToken;
    ensureFileEntity(crate, mediaEntitiesAdded, soundEntityId, soundSection.mediaToken,
      soundSection.mediaPath ? getEncodingFormat(soundSection.mediaPath) : undefined, soundSection.mediaPath || undefined);
    if (soundSection.mediaPath) {
      ensureFileEntity(crate, mediaEntitiesAdded, soundSection.mediaPath,
        soundSection.mediaPath.split("/").pop(), getEncodingFormat(soundSection.mediaPath));
    }
    mediaParts.push({ audio: { "@id": soundEntityId } });
  }

  for (const imageSection of source.imageSections || []) {
    const { imagePath } = imageSection;
    if (imagePath) {
      ensureFileEntity(crate, mediaEntitiesAdded, imagePath, imagePath.split("/").pop(), getEncodingFormat(imagePath));
    }
    const sectionEntry = toImageMediaEntry(imageSection);
    if (sectionEntry) mediaParts.push(sectionEntry);
  }

  if (mediaParts.length === 0) return [];

  const groupedRefs = [];
  mediaParts.forEach((section, sectionIndex) => {
    const mediaPartId = `${idPrefix}-media-${sectionIndex + 1}`;
    let mediaPartType = "CreativeWork";
    if (section.audio || section.mediaReference) mediaPartType = ["CreativeWork", "AudioObject"];
    else if (section.image || section["custom:imageReference"]) mediaPartType = ["CreativeWork", "ImageObject"];

    const mediaPartEntity = { "@id": mediaPartId, "@type": mediaPartType };
    if (section.audio) mediaPartEntity.audio = section.audio;
    if (section.image) mediaPartEntity.image = section.image;
    if (section.filePart) mediaPartEntity.hasPart = [section.filePart];
    if (section["custom:imageReference"]) mediaPartEntity["custom:imageReference"] = section["custom:imageReference"];
    if (section.caption) mediaPartEntity.caption = section.caption;
    if (section.creditText) mediaPartEntity.creditText = section.creditText;

    crate.addEntity(mediaPartEntity);
    groupedRefs.push({ "@id": mediaPartId });
  });
  return groupedRefs;
}

/* ---------- directory walking (FileSystemDirectoryHandle) ---------- */

export async function getSubDirectoryHandles(dirHandle) {
  const subDirs = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "directory" && !CONTROL_AND_GENERATED_NAMES.has(entry.name) && !entry.name.startsWith(".")) {
      subDirs.push(entry);
    }
  }
  return subDirs;
}

// Recursively finds .docx file handles under `dirHandle`, returning
// { handle, relativePath } where relativePath is relative to `subDirHandle`
// (the collection folder), "/"-joined.
async function findDocxFilesInDir(dirHandle, prefix = "") {
  const found = [];
  for await (const entry of dirHandle.values()) {
    if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      if (entry.name === "media") continue;
      found.push(...await findDocxFilesInDir(entry, relativePath));
    } else if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".docx")) {
      found.push({ handle: entry, relativePath });
    }
  }
  return found;
}

async function buildMediaLookup(docxDirHandle) {
  const mediaLookup = new Map();
  let mediaDirHandle;
  try {
    mediaDirHandle = await docxDirHandle.getDirectoryHandle("media", { create: false });
  } catch {
    return mediaLookup;
  }
  for await (const entry of mediaDirHandle.values()) {
    if (entry.kind !== "file") continue;
    const lowerName = entry.name.toLowerCase();
    const lowerNoExt = lowerName.replace(/\.[^.]+$/, "");
    mediaLookup.set(lowerName, entry);
    mediaLookup.set(lowerNoExt, entry);
  }
  return mediaLookup;
}

// Media is collected while parsing and written later, by writeExtractedMedia()
// at crate:write — the crate has to name these files, but nothing needs them on
// disk until the crate itself is written out. Keyed by path, so a media file
// referenced from several chapters is carried once.
let collectedMedia = null;

function collectMedia(targetRelativePath, bytes) {
  collectedMedia?.set(targetRelativePath, bytes);
  return `${OUTPUT_FILES_DIR_NAME}/${targetRelativePath}`;
}

async function copyMediaToOutputFiles(fileHandle, targetRelativePath) {
  const file = await fileHandle.getFile();
  return collectMedia(targetRelativePath, await file.arrayBuffer());
}

async function findImageReference(imageToken, mediaLookup, collectionRelPath) {
  if (!imageToken) return "";
  const normalized = imageToken.trim().toLowerCase();
  if (!normalized) return "";

  const tokenNoExt = normalized.replace(/\.[^.]+$/, "");
  const fileHandle = mediaLookup.get(normalized) || mediaLookup.get(tokenNoExt);
  if (!fileHandle) return "";

  return copyMediaToOutputFiles(fileHandle, `${collectionRelPath}/media/${fileHandle.name}`);
}

function collectEmbeddedImage(collectionRelPath, docxBaseName, buffer, extension, index) {
  const docxBaseNormalized = normalizeIdSegment(docxBaseName) || "doc";
  return collectMedia(`${collectionRelPath}/media/embedded-${docxBaseNormalized}-${index}.${extension}`, buffer);
}

/**
 * Write the media collected by buildCrateFromDocxFolder into
 * ro-crate-preview_files/, replacing whatever was there.
 *
 * Separate from the build so the extraction can happen while the crate is
 * assembled — the crate has to name these files — and the folder is only
 * touched when the crate itself is written (crate:write).
 *
 * With `overwrite` on (the default), the directory is wiped first: a media
 * file whose source document was renamed or deleted should not survive into
 * the next build. With it off, nothing existing is touched at all — neither
 * wiped nor replaced — and only media with no file already in place is
 * written, which is the same promise the other writers make.
 *
 * @param {FileSystemDirectoryHandle} rootHandle  the picked folder
 * @param {Array<{path: string, bytes: ArrayBuffer}>} media
 * @param {{overwrite?: boolean}} [options]
 * @returns {Promise<{written: number, skipped: number}>}
 */
export async function writeExtractedMedia(rootHandle, media = [], { overwrite = true } = {}) {
  if (!media.length) return { written: 0, skipped: 0 };
  if (overwrite) {
    try {
      await rootHandle.removeEntry(OUTPUT_FILES_DIR_NAME, { recursive: true });
    } catch {
      // no pre-existing ro-crate-preview_files/ to remove — fine.
    }
  }
  const filesDirHandle = await rootHandle.getDirectoryHandle(OUTPUT_FILES_DIR_NAME, { create: true });
  let written = 0;
  let skipped = 0;
  for (const { path, bytes } of media) {
    if (!overwrite && await fileExists(filesDirHandle, path)) {
      skipped++;
      continue;
    }
    await writeFileAtPath(filesDirHandle, path, bytes);
    written++;
  }
  return { written, skipped };
}

/* ---------- docx parsing (mirrors build-ro-crate.js's parseStructuredChapters) ---------- */

async function parseStructuredChapters(fileHandle, mediaLookup, collectionRelPath) {
  let embeddedImageIndex = 0;
  const docxBaseName = fileHandle.name.replace(/\.docx$/i, "");
  const convertImage = mammoth.images.imgElement(async (element) => {
    embeddedImageIndex += 1;
    const buffer = await element.readAsArrayBuffer();
    const extension = extensionForContentType(element.contentType);
    const outputRelativePath = collectEmbeddedImage(
      collectionRelPath, docxBaseName, buffer, extension, embeddedImageIndex
    );
    return { src: outputRelativePath };
  });

  const file = await fileHandle.getFile();
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer }, { convertImage });
  const $ = cheerio.load(result.value || "");
  const root = $("body").length ? $("body") : $.root();

  const chapters = [];
  let currentChapter = null;
  let chapterAllowsImmediateHeadingTable = false;

  const pushCurrentChapter = () => {
    if (!currentChapter) return;
    chapters.push({
      heading: currentChapter.heading,
      headingLevel: currentChapter.headingLevel,
      text: currentChapter.textLines.join("\n\n").trim(),
      tableRows: currentChapter.tableRows.filter((row) =>
        row.text || row.plainText || (row.soundSections?.length) || (row.imageSections?.length)),
      soundSections: currentChapter.soundSections.filter((section) => section.mediaToken),
      imageSections: currentChapter.imageSections.filter((section) => section.imageToken || section.imagePath || section.caption),
    });
    currentChapter = null;
  };

  const startChapter = (headingText, headingLevel) => {
    pushCurrentChapter();
    currentChapter = { heading: headingText, headingLevel, textLines: [], tableRows: [], soundSections: [], imageSections: [] };
    chapterAllowsImmediateHeadingTable = headingLevel === 2 || headingLevel === 3;
  };

  const appendCaptionLine = (line) => {
    if (!currentChapter || currentChapter.imageSections.length === 0) return;
    const lastSection = currentChapter.imageSections[currentChapter.imageSections.length - 1];
    lastSection.caption = lastSection.caption ? `${lastSection.caption}\n${line}` : line;
  };

  for (const node of root.find("h1, h2, h3, p, li, table").toArray()) {
    const tag = (node.tagName || "").toLowerCase();

    if (tag === "h1" || tag === "h2" || tag === "h3") {
      const headingText = normalizeInlineText($(node).text());
      if (headingText) startChapter(headingText, tag === "h1" ? 1 : tag === "h2" ? 2 : 3);
      continue;
    }

    if (tag !== "table" && $(node).parents("table").length > 0) continue;

    if ((tag !== "p" && tag !== "li") || !currentChapter) {
      if (tag === "table" && currentChapter) {
        if (!chapterAllowsImmediateHeadingTable) continue;

        const rows = $(node).find("tr").toArray();
        for (const rowNode of rows) {
          const cell = $(rowNode).find("td").first();
          const hasEmbeddedImage = cell.find("img").length > 0;
          const cellForText = cell.clone();
          const imageMetadata = { imageToken: "", captionLines: [], photoLines: [] };

          cellForText.find("img").remove();
          for (const blockNode of cellForText.find("p, li").toArray()) {
            const block = $(blockNode);
            const blockText = normalizeInlineText(block.text());
            if (!blockText) continue;

            const imageInfo = parseImageLine(blockText);
            if (imageInfo.hasImage) {
              imageMetadata.imageToken = imageMetadata.imageToken || imageInfo.imageToken;
              if (imageInfo.inlineCaption) imageMetadata.captionLines.push(imageInfo.inlineCaption);
              block.remove();
              continue;
            }
            if (/^caption\s*[:;]/i.test(blockText)) {
              imageMetadata.captionLines.push(blockText.replace(/^caption\s*[:;]/i, "").trim());
              block.remove();
              continue;
            }
            if (/^photo\s*[:;]/i.test(blockText)) {
              imageMetadata.photoLines.push(blockText.replace(/^photo\s*[:;]/i, "").trim());
              block.remove();
            }
          }
          for (const emptyNode of cellForText.find("p, li, div").toArray()) {
            if (!normalizeInlineText($(emptyNode).text())) $(emptyNode).remove();
          }

          const rowText = normalizeInlineText(cellForText.text());
          const rowHtml = preserveLineBreaksFromHtml(cellForText.html() || "")
            .replace(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, "").trim();
          const soundInfo = parseSoundLine(rowText);
          const imageCaption = [
            ...imageMetadata.captionLines.filter(Boolean).map((line) => `Caption: ${line}`),
            ...imageMetadata.photoLines.filter(Boolean).map((line) => `Photo: ${line}`),
          ].join("\n");

          if (!rowText && !rowHtml && !imageMetadata.imageToken && !hasEmbeddedImage) continue;

          const rowSoundSections = [];
          const rowImageSections = [];
          if (soundInfo.hasSound) {
            rowSoundSections.push({
              mediaToken: soundInfo.mediaToken,
              mediaPath: await findImageReference(soundInfo.mediaToken, mediaLookup, collectionRelPath),
            });
          }
          if (imageMetadata.imageToken) {
            rowImageSections.push({
              imageToken: imageMetadata.imageToken,
              imagePath: await findImageReference(imageMetadata.imageToken, mediaLookup, collectionRelPath),
              caption: imageCaption,
            });
          } else if (hasEmbeddedImage) {
            rowImageSections.push({ imageToken: "", imagePath: cell.find("img").first().attr("src") || "", caption: imageCaption });
          }

          currentChapter.tableRows.push({
            text: rowHtml || rowText, plainText: rowText,
            soundSections: rowSoundSections, imageSections: rowImageSections,
          });
        }
        chapterAllowsImmediateHeadingTable = false;
      }
      continue;
    }

    const paragraphText = normalizeInlineText($(node).text());
    const paragraphHtml = $(node).html() || "";
    const paragraphContent = preserveLineBreaksFromHtml(paragraphHtml);
    const chapterLine = tag === "li" ? `<li>${paragraphContent}</li>` : `<p>${paragraphContent}</p>`;
    const hasEmbeddedImage = $(node).find("img").length > 0;
    const imageInfo = parseImageLine(paragraphText);
    const soundInfo = parseSoundLine(paragraphText);

    if (soundInfo.hasSound) {
      currentChapter.soundSections.push({
        mediaToken: soundInfo.mediaToken,
        mediaPath: await findImageReference(soundInfo.mediaToken, mediaLookup, collectionRelPath),
      });
      continue;
    }
    if (imageInfo.hasImage) {
      const lastImageSection = currentChapter.imageSections[currentChapter.imageSections.length - 1];
      const followsEmbeddedImage = lastImageSection && !lastImageSection.imageToken && lastImageSection.imagePath;

      if (followsEmbeddedImage) {
        // A typed filename line directly after a pasted/embedded image is
        // almost always just a redundant label for that same photo, not a
        // second one — fold any caption text into the embedded image's
        // entry instead of creating a duplicate.
        if (imageInfo.inlineCaption) {
          lastImageSection.caption = lastImageSection.caption
            ? `${lastImageSection.caption}\n${imageInfo.inlineCaption}`
            : imageInfo.inlineCaption;
        }
        continue;
      }

      currentChapter.imageSections.push({
        imageToken: imageInfo.imageToken,
        imagePath: await findImageReference(imageInfo.imageToken, mediaLookup, collectionRelPath),
        caption: imageInfo.inlineCaption,
      });
      continue;
    }
    if (hasEmbeddedImage) {
      currentChapter.imageSections.push({ imageToken: "", imagePath: $(node).find("img").first().attr("src") || "", caption: paragraphText });
      continue;
    }
    if (!paragraphText) continue;

    chapterAllowsImmediateHeadingTable = false;
    if (currentChapter.imageSections.length === 0) currentChapter.textLines.push(chapterLine);
    else appendCaptionLine(paragraphContent);
  }

  pushCurrentChapter();
  return chapters;
}

/* ---------- top-level orchestration ---------- */

// Builds an RO-Crate from `rootHandle` (a FileSystemDirectoryHandle whose
// direct sub-directories are Collections of structured .docx files), writing
// referenced/embedded media into `rootHandle/ro-crate-preview_files/...`.
// `config` is the raw rootDataset config (see docx-tools README).
// `onProgress(message)` is called with human-readable progress lines,
// mirroring the CLI's console.log. Returns { crate, collectionCount,
// documentPartCount }, or null if no collection sub-directories were found.
export async function buildCrateFromDocxFolder(rootHandle, config, onProgress = () => {}) {
  const validatedConfig = validateAndNormalizeConfig(config);

  collectedMedia = new Map();

  let subDirs = await getSubDirectoryHandles(rootHandle);
  if (subDirs.length === 0) return null;

  // Custom display order/labels (ro-crate-html-output's collectionLabelsBuilder
  // option) are applied only when rendering the HTML preview, not here — the
  // crate itself always uses each folder's own name and filesystem order.
  subDirs = subDirs.slice().sort((a, b) => a.name.localeCompare(b.name));

  const crate = new ROCrate({ array: true, link: true });
  addContextPrefix(crate, "bibo", "http://purl.org/ontology/bibo/");
  addContextPrefix(crate, "custom", "arcp://name,custom/terms#");

  const today = new Date().toISOString().split("T")[0];
  crate.rootDataset.name = validatedConfig.rootDataset.name;
  crate.rootDataset.description = validatedConfig.rootDataset.description;
  crate.rootDataset.datePublished =
    validatedConfig.rootDataset.datePublished === "today" || !validatedConfig.rootDataset.datePublished
      ? today : validatedConfig.rootDataset.datePublished;
  if (validatedConfig.rootDataset["@type"]) crate.rootDataset["@type"] = validatedConfig.rootDataset["@type"];
  if (validatedConfig.rootDataset.conformsTo) crate.rootDataset.conformsTo = validatedConfig.rootDataset.conformsTo;
  applyRootDatasetCreators(crate, validatedConfig.rootDataset.creators);
  applyRootDatasetLicense(crate, validatedConfig.rootDataset.license);
  if (validatedConfig.metadataLicence?.["@id"]) {
    crate.descriptor.license = { "@id": validatedConfig.metadataLicence["@id"] };
    crate.addEntity(validatedConfig.metadataLicence);
  }

  const rootHasPart = [];
  const sourceDocumentsHasPart = [];
  const mediaEntitiesAdded = new Set();
  let documentPartCount = 0;

  for (const subDirHandle of subDirs) {
    const collectionId = `#${normalizeIdFromPath(subDirHandle.name)}`;
    const docxFiles = (await findDocxFilesInDir(subDirHandle))
      .filter(({ handle }) => !isNotesDocx(handle.name));

    onProgress(`Collection: ${subDirHandle.name}/ (${docxFiles.length} documentPart(s))`);
    const collectionHasPart = [];
    const sourceGroupHasPart = [];

    for (const { handle: fileHandle, relativePath } of docxFiles) {
      const documentPartId = `#${normalizeIdFromPath(`${subDirHandle.name}-${relativePath}`)}`;
      const fallbackName = fileHandle.name.replace(/\.docx$/i, "");

      // The doc's own directory (for a nested docx, its containing subfolder,
      // not necessarily subDirHandle itself) is where its media/ sibling lives.
      const docxDirParts = relativePath.split("/").slice(0, -1);
      let docxDirHandle = subDirHandle;
      for (const part of docxDirParts) docxDirHandle = await docxDirHandle.getDirectoryHandle(part, { create: false });
      const mediaLookup = await buildMediaLookup(docxDirHandle);
      const collectionRelPath = [subDirHandle.name, ...docxDirParts].join("/");

      // The original .docx itself, copied verbatim into
      // ro-crate-preview_files/ at its own original relative path (so a
      // topic with same-named files in two
      // subfolders can't collide) and recorded as a File entity — kept
      // alongside the parsed content rather than discarded, under a
      // sourceDocuments collection that mirrors this topic grouping. See
      // buildCrateFromDocxFolder's closing section for how the per-topic
      // groups are gathered under #sourceDocuments.
      const sourceDocPath = await copyMediaToOutputFiles(fileHandle, `${collectionRelPath}/${fileHandle.name}`);
      ensureFileEntity(crate, mediaEntitiesAdded, sourceDocPath, fileHandle.name, getEncodingFormat(fileHandle.name));
      sourceGroupHasPart.push({ "@id": sourceDocPath });

      onProgress(`  Parsing: ${subDirHandle.name}/${relativePath}`);
      let chapters = [];
      try {
        chapters = await parseStructuredChapters(fileHandle, mediaLookup, collectionRelPath);
        if (chapters.length === 0) {
          onProgress(`  Warning: no Heading 1/2 styles found in ${relativePath}; no Chapter entities created.`);
        }
      } catch (err) {
        onProgress(`  Warning: could not parse ${relativePath}: ${err.message}`);
      }

      const heading1Chapter = chapters.find((chapter) => chapter.headingLevel === 1);
      const documentPartName = heading1Chapter?.heading || fallbackName;
      const documentPartChapters = chapters.filter((chapter) => chapter.headingLevel !== 1);

      const introContentBlock = heading1Chapter ? renderChapterContentBlock(heading1Chapter, { includeHeading: false }) : "";
      const restContentBlock = toStructuredDocumentPartBody(documentPartChapters);
      const documentPartBody = [introContentBlock, restContentBlock].filter(Boolean).join("\n\n---\n\n");

      const introMediaParts = heading1Chapter
        ? buildGroupedMediaParts(crate, mediaEntitiesAdded, `${documentPartId}-intro`, heading1Chapter)
        : [];

      const documentPartHasPart = [...introMediaParts];
      const chapterRecords = [];
      let currentH2ChapterId = "";

      documentPartChapters.forEach((chapter, index) => {
        const chapterId = `${documentPartId}-chapter-${index + 1}`;
        const hasTableRows = (chapter.tableRows || []).length > 0;
        const parentChapterId = chapter.headingLevel === 3 && hasTableRows && currentH2ChapterId ? currentH2ChapterId : "";
        chapterRecords.push({ chapter, chapterId, position: index + 1, parentChapterId });
        if (chapter.headingLevel === 2) currentH2ChapterId = chapterId;
      });

      const chapterEntityById = new Map();

      for (const record of chapterRecords) {
        const { chapter, chapterId, position } = record;
        const chapterEntity = { "@id": chapterId, "@type": ["bibo:Chapter"], position, name: chapter.heading, text: chapter.text };

        const tableRowParts = [];
        (chapter.tableRows || []).forEach((row, rowIndex) => {
          const rowId = `${chapterId}-row-${rowIndex + 1}`;
          // A table row is a content block inside a chapter, not a document in
          // its own right — it has no heading, so it is not a bibo:DocumentPart.
          const rowEntity = { "@id": rowId, "@type": "custom:TableRow", position: rowIndex + 1, text: row.text };
          const groupedRowMediaParts = buildGroupedMediaParts(crate, mediaEntitiesAdded, rowId, row);
          if (groupedRowMediaParts.length > 0) rowEntity.hasPart = groupedRowMediaParts;
          crate.addEntity(rowEntity);
          tableRowParts.push({ "@id": rowId });
        });

        const groupedMediaParts = buildGroupedMediaParts(crate, mediaEntitiesAdded, chapterId, chapter);
        if (groupedMediaParts.length > 0) chapterEntity.hasPart = [...tableRowParts, ...groupedMediaParts];
        else if (tableRowParts.length > 0) chapterEntity.hasPart = tableRowParts;

        chapterEntityById.set(chapterId, chapterEntity);
      }

      for (const record of chapterRecords) {
        if (!record.parentChapterId) continue;
        const parentChapter = chapterEntityById.get(record.parentChapterId);
        if (!parentChapter) continue;
        if (!Array.isArray(parentChapter.hasPart)) parentChapter.hasPart = [];
        parentChapter.hasPart.push({ "@id": record.chapterId });
      }

      for (const record of chapterRecords) {
        const chapterEntity = chapterEntityById.get(record.chapterId);
        if (!chapterEntity) continue;
        crate.addEntity(chapterEntity);
        if (!record.parentChapterId) documentPartHasPart.push({ "@id": record.chapterId });
      }

      crate.addEntity({
        "@id": documentPartId, "@type": "bibo:DocumentPart",
        name: documentPartName, text: documentPartBody, hasPart: documentPartHasPart,
      });
      documentPartCount += 1;
      collectionHasPart.push({ "@id": documentPartId });
    }

    crate.addEntity({ "@id": collectionId, "@type": "RepositoryCollection", name: subDirHandle.name, hasPart: collectionHasPart });
    rootHasPart.push({ "@id": collectionId });

    if (sourceGroupHasPart.length > 0) {
      const sourceGroupId = `#sourceDocuments-${normalizeIdFromPath(subDirHandle.name)}`;
      crate.addEntity({ "@id": sourceGroupId, "@type": "custom:SourceDocumentGroup", name: subDirHandle.name, hasPart: sourceGroupHasPart });
      sourceDocumentsHasPart.push({ "@id": sourceGroupId });
    }
  }

  // The generated site (rocss-templates' structured-docs templates)
  // only ever navigates into #derivedContent — sourceDocuments exists in the
  // crate for completeness/download but has no page of its own and is never
  // linked to, so wrapping the per-topic RepositoryCollections one level
  // deeper here doesn't change what a visitor sees or reaches.
  const derivedContentId = "#derivedContent";
  crate.addEntity({ "@id": derivedContentId, "@type": "custom:DerivedContentCollection", name: "Derived Content", hasPart: rootHasPart });

  const rootMembers = [{ "@id": derivedContentId }];
  if (sourceDocumentsHasPart.length > 0) {
    const sourceDocumentsId = "#sourceDocuments";
    crate.addEntity({ "@id": sourceDocumentsId, "@type": "custom:SourceDocumentsCollection", name: "Source Documents", hasPart: sourceDocumentsHasPart });
    rootMembers.push({ "@id": sourceDocumentsId });
  }
  crate.rootDataset.hasPart = rootMembers;

  const media = [...collectedMedia].map(([path, bytes]) => ({ path, bytes }));
  collectedMedia = null;
  return { crate, collectionCount: subDirs.length, documentPartCount, media };
}

// Quick pre-flight check for the UI: does this folder look like a structured
// docx tree at all? Returns { docxCount, hasHeadingStyles } without doing a
// full parse/build, so the caller can warn before committing to a build.
export async function scanDocxFolder(rootHandle) {
  const subDirs = await getSubDirectoryHandles(rootHandle);
  let docxCount = 0;
  let hasHeadingStyles = false;

  for (const subDirHandle of subDirs) {
    const docxFiles = (await findDocxFilesInDir(subDirHandle)).filter(({ handle }) => !isNotesDocx(handle.name));
    docxCount += docxFiles.length;
    if (hasHeadingStyles || docxFiles.length === 0) continue;

    const { handle: fileHandle } = docxFiles[0];
    try {
      const file = await fileHandle.getFile();
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer });
      if (/<h[123][ >]/i.test(result.value || "")) hasHeadingStyles = true;
    } catch {
      // Sampling failure isn't fatal here — the real parse will report it.
    }
  }

  return { docxCount, hasHeadingStyles };
}
