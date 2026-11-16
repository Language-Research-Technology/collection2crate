// Files a `type: "file"` option was given — one or several picked files, a
// picked folder, or whatever was dropped on its drop zone — turned into the
// value a plugin reads from options[<key>Upload] (SPEC.md §5.4).
//
// Pure apart from filesFromDataTransfer(), which walks the browser's drop
// entries; everything else runs under Node for tests/test-upload-files.mjs.

const clean = (path) => String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
const baseName = (path) => clean(path).split("/").pop();
const isHidden = (path) => clean(path).split("/").some((part) => part.startsWith("."));

/**
 * `{ file, path }` for each file picked through an input. A folder input
 * reports each file's path under the folder ("templates/x/a.html" for the
 * folder "templates"); the folder's own name is dropped, so paths read as
 * they would from inside it — which is how a config inside it refers to them.
 */
export function entriesFromPickedFiles(files) {
  return [...(files || [])].map((file) => {
    const parts = clean(file.webkitRelativePath).split("/").filter(Boolean);
    return { file, path: parts.length > 1 ? parts.slice(1).join("/") : file.name };
  });
}

/**
 * Every uploaded file by its path, and by its bare name where that is
 * unambiguous enough to be useful: the first file with a name keeps it.
 */
export function uploadFilesMap(entries) {
  const map = new Map();
  for (const { file, path } of entries) {
    const key = clean(path) || file.name;
    if (!map.has(key)) map.set(key, file);
  }
  for (const { file, path } of entries) {
    const name = baseName(path) || file.name;
    if (!map.has(name)) map.set(name, file);
  }
  return map;
}

// ".json,.css,text/html" → [".json", ".css"]: the order a node lists its
// extensions in is the order it wants its main file chosen by.
const acceptedExtensions = (accept) => String(accept || "")
  .split(",").map((t) => t.trim().toLowerCase()).filter((t) => t.startsWith("."));

/**
 * The file the option is about, out of everything uploaded: the first
 * accepted extension that any visible file has; among those, one whose name
 * mentions `prefer` (the option key's stem, e.g. "config"), then the one
 * nearest the top, then by path.
 */
export function pickMainEntry(entries, { accept = "", prefer = "" } = {}) {
  const visible = entries.filter((e) => !isHidden(e.path));
  const pool = visible.length ? visible : entries;
  if (!pool.length) return null;
  const exts = acceptedExtensions(accept);
  let candidates = pool;
  for (const ext of exts) {
    const matching = pool.filter((e) => baseName(e.path).toLowerCase().endsWith(ext));
    if (matching.length) { candidates = matching; break; }
  }
  const hint = String(prefer || "").toLowerCase();
  const named = (e) => (hint && baseName(e.path).toLowerCase().includes(hint) ? 0 : 1);
  const depth = (e) => clean(e.path).split("/").length;
  return [...candidates].sort((a, b) =>
    named(a) - named(b)
    || depth(a) - depth(b)
    || clean(a.path).localeCompare(clean(b.path))
  )[0];
}

/**
 * The options value for an upload, or null for nothing.
 *
 * `{ name, file, path, siblingFiles, fileCount, folder }` — `file` is the main
 * file and `path` where it sits among the uploads (so a relative path in it
 * can be resolved from its own folder); `siblingFiles` is uploadFilesMap();
 * `folder` names the folder when one was chosen or dropped.
 */
export function buildUploadValue(entries, { accept = "", prefer = "", folder = null } = {}) {
  const list = (entries || []).filter((e) => e && e.file);
  if (!list.length) return null;
  const main = pickMainEntry(list, { accept, prefer });
  return {
    name: main.file.name,
    file: main.file,
    path: clean(main.path) || main.file.name,
    siblingFiles: uploadFilesMap(list),
    fileCount: list.length,
    folder,
  };
}

/** What the control says once something is chosen. */
export function describeUpload(value) {
  if (!value) return "";
  if (value.fileCount <= 1) return `✓ ${value.name}`;
  const where = value.folder ? `folder ${value.folder}` : `${value.fileCount} files`;
  return `✓ ${value.path} (${where}${value.folder ? `, ${value.fileCount} files` : ""})`;
}

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

const readAllEntries = async (reader) => {
  const out = [];
  // readEntries hands directories over in batches; an empty batch ends it.
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return out;
    out.push(...batch);
  }
};

const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    out.push({ file: await fileOf(entry), path: prefix ? `${prefix}/${entry.name}` : entry.name });
  } else if (entry.isDirectory) {
    const children = await readAllEntries(entry.createReader());
    for (const child of children) await walkEntry(child, prefix ? `${prefix}/${entry.name}` : entry.name, out);
  }
}

/**
 * `{ entries, folder }` for a drop: every file dropped, folders walked. A
 * single dropped folder is treated like a chosen one — its name is dropped
 * from the paths and reported as `folder`.
 */
export async function filesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer?.items || [])].filter((item) => item.kind === "file");
  const roots = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!roots.length) {
    return { entries: [...(dataTransfer?.files || [])].map((file) => ({ file, path: file.name })), folder: null };
  }
  const single = roots.length === 1 && roots[0].isDirectory ? roots[0] : null;
  const entries = [];
  if (single) {
    for (const child of await readAllEntries(single.createReader())) await walkEntry(child, "", entries);
  } else {
    for (const root of roots) await walkEntry(root, "", entries);
  }
  return { entries, folder: single ? single.name : null };
}
