// CORE — the folder's existing crate (SPEC.md §4.4a): which file holds it,
// how its File entities line up with the folder, and the crate a build starts
// from.
//
// Isomorphic apart from pickNewestCrateSource/loadExistingCrate, which take a
// directory handle; everything else takes plain data, so tests drive it under
// Node. Lives in the core rather than a plugin so a deployment's PLUGINS
// selection can't switch it off.

import { ROCrate } from "ro-crate";
import { deleteEntity, applyRootDataset } from "./crate.js";
import { statFile } from "./fs_helpers.js";

// The core's two outputs, in tie-break order: the build writes both in the
// same run, so equal timestamps are the normal case after a build, and the
// JSON is the one the build serialised directly. additional-ro-crate-metadata.xlsx
// is deliberately absent — it belongs to the xlsx-crate-input merge plugin.
export const CRATE_SOURCES = Object.freeze([
  { name: "ro-crate-metadata.json", kind: "json" },
  { name: "ro-crate-metadata.xlsx", kind: "xlsx" },
]);

/**
 * The newest of CRATE_SOURCES present in the folder, or null.
 * `stat` is injectable for tests; it resolves a name to a File-like
 * `{ lastModified, text(), arrayBuffer() }` or null.
 */
export async function pickNewestCrateSource(dirHandle, stat = statFile) {
  if (!dirHandle) return null;
  let best = null;
  for (const candidate of CRATE_SOURCES) {
    const file = await stat(dirHandle, candidate.name);
    if (!file) continue;
    // Strictly newer only, so a tie keeps the earlier (JSON) entry.
    if (!best || file.lastModified > best.lastModified) {
      best = { ...candidate, file, lastModified: file.lastModified };
    }
  }
  return best;
}

/** The crate JSON behind a source, whichever form it is stored in. */
export async function readCrateJsonFromSource(source) {
  if (!source) return null;
  if (source.kind === "json") {
    const text = await source.file.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`${source.name} is not valid JSON: ${e.message}`);
    }
  }
  // ro-crate-excel's clean entry point — the package index pulls in
  // Node-only modules (see crate.js's crateToXlsxBytes).
  const { default: Workbook } = await import("ro-crate-excel/lib/workbook.js");
  const workbook = new Workbook();
  await workbook.loadExcelFromBuffer(await source.file.arrayBuffer());
  if (!workbook.crate) throw new Error(`${source.name} did not parse as an RO-Crate`);
  return workbook.crate.toJSON();
}

/**
 * Load the folder's existing crate. Resolves to
 * `{ json, sourceName, label }`, or null when the folder has none (or none
 * that reads). A spreadsheet that won't parse falls back to the JSON beside it.
 */
export async function loadExistingCrate(dirHandle, log = () => {}, stat = statFile) {
  const source = await pickNewestCrateSource(dirHandle, stat);
  if (!source) return null;
  const labelFor = (s) => `${s.name} (modified ${new Date(s.lastModified).toLocaleString()})`;
  try {
    return { json: await readCrateJsonFromSource(source), sourceName: source.name, label: labelFor(source) };
  } catch (e) {
    log(`Could not read ${source.name}: ${e.message}`, "warn");
    if (source.kind === "json") return null;
    const jsonName = CRATE_SOURCES[0].name;
    const file = await stat(dirHandle, jsonName);
    if (!file) return null;
    const fallback = { ...CRATE_SOURCES[0], file, lastModified: file.lastModified };
    try {
      return { json: await readCrateJsonFromSource(fallback), sourceName: jsonName, label: labelFor(fallback) };
    } catch (e2) {
      log(`Could not read ${jsonName} either: ${e2.message}`, "warn");
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Reconciling File entities with the folder
// ---------------------------------------------------------------------------

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// A File entity describes something in the folder only when its @id is a
// relative path. Absolute URLs (http:, arcp:, …) and fragments point
// elsewhere, so they are never "missing".
function isLocalPath(id) {
  return typeof id === "string" && id !== "" && !id.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(id);
}

function safeDecode(id) {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/** Every File entity in the crate whose @id is a folder-relative path. */
export function localFileIds(json) {
  return (json?.["@graph"] || [])
    .filter((e) => asArray(e["@type"]).map(String).includes("File") && isLocalPath(e["@id"]))
    .map((e) => e["@id"]);
}

/**
 * Sort the crate's File entities and the folder's files into matched, new
 * and missing (SPEC.md §4.4a).
 *
 * @param {object|null} json          the existing crate
 * @param {string[]} filePaths        relative paths the folder scan found
 * @param {object} [opts]
 * @param {(path: string) => boolean} [opts.isExcluded]  paths the scan skips on
 *   purpose (core outputs, declared plugin output). An entity under one of
 *   them isn't missing — the scan was never going to find it.
 * @returns {{ matched: string[], newFiles: string[], missingFiles: string[] }}
 *   newFiles are paths; missingFiles are entity @ids; both sorted
 */
export function reconcileFiles(json, filePaths, { isExcluded = () => false } = {}) {
  const paths = [...new Set(filePaths || [])];
  if (!json) return { matched: [], newFiles: [], missingFiles: [] };

  // An @id may be percent-encoded (a space as %20); match either spelling.
  const byPath = new Map();
  for (const id of localFileIds(json)) {
    byPath.set(id, id);
    byPath.set(safeDecode(id), id);
  }

  const matched = [];
  const newFiles = [];
  const seenIds = new Set();
  for (const path of paths) {
    const id = byPath.get(path);
    if (id) {
      matched.push(path);
      seenIds.add(id);
    } else {
      newFiles.push(path);
    }
  }

  const missingFiles = localFileIds(json).filter(
    (id) => !seenIds.has(id) && !isExcluded(safeDecode(id))
  );
  const byPathOrder = (a, b) => a.localeCompare(b);
  return { matched, newFiles: newFiles.sort(byPathOrder), missingFiles: missingFiles.sort(byPathOrder) };
}

/**
 * The full decision lists for a reconcile result (SPEC.md §4.4a).
 *
 * The defaults are "add every new file, remove every missing entity", so the
 * user's choices are recorded as departures from them — `ignore` (new paths
 * not to add) and `keep` (missing entities not to remove) — and resolved here
 * against the current result, dropping anything that no longer applies.
 *
 * @param {{ newFiles: string[], missingFiles: string[] }} result
 * @param {{ ignore?: string[], keep?: string[] }} [choices]
 * @returns {{ ignore: string[], keep: string[], remove: string[] }}
 */
export function resolveDecisions(result, choices = {}) {
  const newSet = new Set(result?.newFiles || []);
  const missingSet = new Set(result?.missingFiles || []);
  const ignore = asArray(choices?.ignore).filter((p) => newSet.has(p));
  const keep = asArray(choices?.keep).filter((id) => missingSet.has(id));
  const keepSet = new Set(keep);
  const remove = (result?.missingFiles || []).filter((id) => !keepSet.has(id));
  return { ignore, keep, remove };
}

/** Drop ignored files from a scan result (anything with a relativePath). */
export function withoutIgnored(files, ignore) {
  const skip = new Set(asArray(ignore));
  if (!skip.size) return files;
  return (files || []).filter((f) => !skip.has(f.relativePath ?? f.id));
}

// ---------------------------------------------------------------------------
// Seeding a build
// ---------------------------------------------------------------------------

/**
 * The crate a build starts from: `ctx.existingCrate` minus the entities the
 * user chose to remove, or null when the folder has no crate. A fresh
 * ROCrate every call, so a failed build never leaves the loaded JSON
 * half-edited.
 */
export function seedFromExisting(ctx) {
  const json = ctx?.existingCrate;
  if (!json) return null;
  const crate = new ROCrate(structuredClone(json), { array: true, link: true });
  const removed = [];
  for (const id of asArray(ctx.fileDecisions?.remove)) {
    if (!crate.getEntity(id)) continue;
    deleteEntity(crate, id);
    removed.push(id);
  }
  const log = typeof ctx.log === "function" ? ctx.log : () => {};
  // The Describe form was pre-filled from this crate's root and is what the
  // user left it as, so its values replace the root's — whichever builder
  // runs next.
  if (ctx.config) applyRootDataset(crate, ctx.config);
  log(
    `Starting from the existing crate (${crate.getGraph().length} entities)` +
      (removed.length ? `, ${removed.length} missing file entit${removed.length === 1 ? "y" : "ies"} removed.` : "."),
    "muted"
  );
  const kept = asArray(ctx.fileDecisions?.keep);
  if (kept.length) {
    log(`Keeping ${kept.length} file entit${kept.length === 1 ? "y" : "ies"} with no file in the folder: ${kept.join(", ")}`, "warn");
  }
  return crate;
}
