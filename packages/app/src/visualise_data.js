// The data behind the Visualise page: which output directories can be read,
// and what the panels get when one is chosen (SPEC.md §6.4).
//
// Isomorphic apart from the two functions that take a directory handle — the
// parsing is pure and tested, because a misread CSV is a chart of the wrong
// numbers rather than an error.

import { getDirectoryHandleAtPath, readFileTextFromDirectory } from "./fs_helpers.js";

/** Extensions that hold columns; everything a chart can use comes from these. */
const TABLE_EXTENSIONS = new Set([".csv", ".tsv"]);

/** Extensions that hold running text, one document per line. */
const TEXT_EXTENSIONS = new Set([".cha", ".txt", ".md", ".log"]);

const extensionOf = (name) => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
};

export const isSupportedFile = (name) => {
  const ext = extensionOf(name);
  return TABLE_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext);
};

/**
 * The output directories worth offering: declared by a plugin, present in the
 * folder, and holding something readable.
 *
 * Offering directories rather than files is the point — a corpus build writes
 * hundreds of files whose names change every time, and the folders they land
 * in do not (SPEC-PLUGINS.md).
 *
 * @returns {Promise<Array<{path: string, files: Array<{path, name, ext}>, count: number}>>}
 */
export async function scanOutputDirectories(dirHandle, outputPaths) {
  const directories = [...new Set((outputPaths || [])
    .filter((entry) => entry.kind === "dir")
    .map((entry) => entry.path))].sort();

  const found = [];
  for (const path of directories) {
    const handle = await getDirectoryHandleAtPath(dirHandle, path);
    if (!handle) continue;
    const files = [];
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind !== "file" || !isSupportedFile(name)) continue;
      files.push({ path: `${path}/${name}`, name, ext: extensionOf(name) });
    }
    // A declared output holding only HTML or images is not a dead option in
    // the picker; it simply isn't one.
    if (files.length) found.push({ path, files: files.sort((a, b) => a.path.localeCompare(b.path)), count: files.length });
  }
  return found;
}

/** Rows and a header from delimited text, quotes and embedded newlines included. */
export function parseDelimited(text, separator = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === separator) { row.push(field); field = ""; continue; }
    if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (char === "\r") continue;
    field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const [head = [], ...body] = rows.filter((cells) => cells.some((cell) => cell !== ""));
  const header = head.map((name, index) => name.trim() || `column ${index + 1}`);
  return { header, rows: body.map((cells) => header.map((_, i) => cells[i] ?? "")) };
}

/**
 * One document per row: the `text` column if the table has one, every cell
 * joined if it doesn't — a table with no obvious text column is still
 * searchable, just bluntly.
 */
export function documentsFromTable(source, { header, rows }) {
  const lower = header.map((name) => name.trim().toLowerCase());
  const textColumn = lower.indexOf("text");
  const speakerColumn = lower.findIndex((name) => name === "speakerid" || name === "speaker");
  const documents = [];
  rows.forEach((cells, index) => {
    const text = (textColumn >= 0 ? cells[textColumn] : cells.join(" ")) || "";
    if (!text.trim()) return;
    documents.push({
      id: `${source}#${index}`,
      source,
      speaker: speakerColumn >= 0 ? cells[speakerColumn] || "" : "",
      text,
    });
  });
  return documents;
}

// CHAT transcripts: "*CHI:\tutterance". Everything else — the @-prefixed
// header block, %-prefixed dependent tiers — is metadata about the recording,
// not anybody's words, and searching it would report matches nobody said.
export function documentsFromChat(source, text) {
  const documents = [];
  let index = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\*([^:]+):\s*(.*)$/.exec(line.trim());
    if (!match || !match[2].trim()) { index++; continue; }
    documents.push({ id: `${source}#${index}`, source, speaker: match[1].trim(), text: match[2].trim() });
    index++;
  }
  return documents;
}

export function documentsFromText(source, text) {
  const documents = [];
  String(text).split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed) documents.push({ id: `${source}#${index}`, source, speaker: "", text: trimmed });
  });
  return documents;
}

/**
 * Read every supported file in one output directory.
 *
 * Returns both views of it: `documents` (one per line, what the text panels
 * read) and `tables` (header and rows, what a chart reads). A CSV produces
 * both from a single parse; anything else produces documents only, having no
 * columns to offer.
 *
 * `readText` is injected so this stays testable without File System Access.
 */
export async function loadDirectory(files, readText, log = () => {}) {
  const documents = [];
  const tables = [];
  for (const file of files) {
    let text;
    try {
      text = await readText(file.path);
    } catch (e) {
      log(`Could not read ${file.path}: ${e.message}`, "warn");
      continue;
    }
    if (text === null || text === undefined) { log(`Skipped ${file.path}: could not be read.`, "warn"); continue; }

    if (TABLE_EXTENSIONS.has(file.ext)) {
      const table = parseDelimited(text, file.ext === ".tsv" ? "\t" : ",");
      if (table.header.length) tables.push({ source: file.path, ...table });
      documents.push(...documentsFromTable(file.path, table));
    } else if (file.ext === ".cha") {
      documents.push(...documentsFromChat(file.path, text));
    } else {
      documents.push(...documentsFromText(file.path, text));
    }
  }
  return { documents, tables };
}

/** The reader `loadDirectory` wants, bound to a picked folder. */
export const readerFor = (dirHandle) => (path) => readFileTextFromDirectory(dirHandle, path);
