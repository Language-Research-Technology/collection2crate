// CORE — File System Access API wrappers (SPEC.md §6.2). Browser-only: every
// function here needs a real FileSystemDirectoryHandle. The module itself
// loads fine under Node (nothing runs at import time), so importing the
// generated plugin registry in a Node one-liner doesn't blow up — calling one
// of these without a handle does, which is the honest failure.
//
// Nothing leaves the machine: all reads and writes go through these.

/** Ask for (or confirm) permission on a handle. */
export async function verifyPermission(handle, readWrite = true) {
  if (!handle) return false;
  const options = { mode: readWrite ? "readwrite" : "read" };
  if ((await handle.queryPermission?.(options)) === "granted") return true;
  return (await handle.requestPermission?.(options)) === "granted";
}

function splitPath(path) {
  return String(path || "").split("/").filter((part) => part && part !== ".");
}

/** Walk to the directory holding `path`, optionally creating it. */
export async function resolveParentDirectory(dirHandle, path, { create = false } = {}) {
  const parts = splitPath(path);
  const fileName = parts.pop();
  let current = dirHandle;
  for (const part of parts) {
    try {
      current = await current.getDirectoryHandle(part, { create });
    } catch {
      return { parent: null, fileName };
    }
  }
  return { parent: current, fileName };
}

export async function getFileHandleAtPath(dirHandle, path) {
  const { parent, fileName } = await resolveParentDirectory(dirHandle, path);
  if (!parent || !fileName) return null;
  try {
    return await parent.getFileHandle(fileName);
  } catch {
    return null;
  }
}

export async function getDirectoryHandleAtPath(dirHandle, path, { create = false } = {}) {
  let current = dirHandle;
  for (const part of splitPath(path)) {
    try {
      current = await current.getDirectoryHandle(part, { create });
    } catch {
      return null;
    }
  }
  return current;
}

/**
 * Whether a folder-relative path can be reached through the File System Access
 * API at all, and if not, why.
 *
 * Chromium applies a portable-filename filter to every name crossing the API:
 * a leading or trailing "~", a trailing "." or space, and the Windows device
 * names (CON, NUL, aux.txt, …) are refused with a TypeError, before any
 * lookup. Worse for a scan, such an entry is also silently omitted from
 * `entries()` — no error, no empty directory, it simply is not listed. So a
 * folder the browser cannot name is indistinguishable, from inside the walk,
 * from a folder that was deleted; only asking for it by name tells them apart.
 *
 * @returns {Promise<"ok"|"refused"|"missing"|"unknown">}
 *   "ok" — reachable; "refused" — a segment's name is one the browser will not
 *   accept, so the scan can never see it; "missing" — nameable, but not there.
 */
export async function probePath(dirHandle, path) {
  if (!dirHandle) return "unknown";
  const parts = splitPath(path);
  if (!parts.length) return "unknown";
  const last = parts.pop();
  let current = dirHandle;
  for (const part of parts) {
    try {
      current = await current.getDirectoryHandle(part);
    } catch (e) {
      if (e?.name === "TypeError") return "refused";
      if (e?.name === "NotFoundError") return "missing";
      if (e?.name === "TypeMismatchError") return "missing";
      return "unknown";
    }
  }
  // The leaf may be either kind; only its name's acceptability is in question.
  try {
    await current.getFileHandle(last);
    return "ok";
  } catch (e) {
    if (e?.name === "TypeError") return "refused";
    if (e?.name === "TypeMismatchError") return "ok"; // exists, as a directory
    if (e?.name !== "NotFoundError") return "unknown";
  }
  try {
    await current.getDirectoryHandle(last);
    return "ok";
  } catch (e) {
    if (e?.name === "TypeError") return "refused";
    return "missing";
  }
}

export async function fileExists(dirHandle, path) {
  return !!(await getFileHandleAtPath(dirHandle, path));
}

export async function pathExists(dirHandle, path) {
  if (await fileExists(dirHandle, path)) return true;
  return !!(await getDirectoryHandleAtPath(dirHandle, path));
}

/** The File behind a path, or null — the shape pickNewestCrateSource wants. */
export async function statFile(dirHandle, path) {
  const handle = await getFileHandleAtPath(dirHandle, path);
  if (!handle) return null;
  try {
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function readFileTextFromDirectory(dirHandle, path) {
  const file = await statFile(dirHandle, path);
  return file ? await file.text() : null;
}

export async function readFileBytes(dirHandle, path) {
  const file = await statFile(dirHandle, path);
  return file ? await file.arrayBuffer() : null;
}

export async function readJsonFromFolder(dirHandle, path) {
  const text = await readFileTextFromDirectory(dirHandle, path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeToHandle(fileHandle, contents) {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(contents);
  } finally {
    await writable.close();
  }
}

/** Write one file directly inside `dirHandle`. */
export async function writeFile(dirHandle, name, contents) {
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  await writeToHandle(fileHandle, contents);
  return fileHandle;
}

/** Write to a nested path, creating every intermediate directory. */
export async function writeFileAtPath(dirHandle, path, contents) {
  const { parent, fileName } = await resolveParentDirectory(dirHandle, path, { create: true });
  if (!parent || !fileName) throw new Error(`Cannot write to "${path}".`);
  const fileHandle = await parent.getFileHandle(fileName, { create: true });
  await writeToHandle(fileHandle, contents);
  return fileHandle;
}

/** Remove a file or a whole directory subtree. Missing paths are a no-op. */
export async function removePath(dirHandle, path) {
  const parts = splitPath(path);
  const name = parts.pop();
  if (!name) return false;
  const parent = parts.length
    ? await getDirectoryHandleAtPath(dirHandle, parts.join("/"))
    : dirHandle;
  if (!parent) return false;
  try {
    await parent.removeEntry(name, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Copy a file into `_backups/<timestamp>/` before it is overwritten. */
export async function backupFile(dirHandle, name, stamp) {
  const file = await statFile(dirHandle, name);
  if (!file) return null;
  const target = `_backups/${stamp}/${name}`;
  await writeFileAtPath(dirHandle, target, await file.arrayBuffer());
  return target;
}

/**
 * Recursively scan a folder into a flat file list.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {object} [options]
 * @param {Set<string>|string[]} [options.excludeTopLevel] names to skip at the root
 * @param {function} [options.onProgress] called with the running file count
 */
export async function walkDirectory(dirHandle, { excludeTopLevel = [], onProgress = null } = {}) {
  const skip = excludeTopLevel instanceof Set ? excludeTopLevel : new Set(excludeTopLevel);
  const files = [];

  async function walk(handle, prefix, depth) {
    for await (const [name, entry] of handle.entries()) {
      if (depth === 0 && skip.has(name)) continue;
      if (name.startsWith(".")) continue;
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === "directory") {
        await walk(entry, relativePath, depth + 1);
      } else {
        let file = null;
        try {
          file = await entry.getFile();
        } catch {
          // Unreadable file: record what we know rather than abandoning the scan.
        }
        files.push({
          name,
          relativePath,
          handle: entry,
          size: file?.size,
          lastModified: file?.lastModified,
        });
        if (onProgress && files.length % 50 === 0) onProgress(files.length);
      }
    }
  }

  await walk(dirHandle, "", 0);
  if (onProgress) onProgress(files.length);
  return files;
}
