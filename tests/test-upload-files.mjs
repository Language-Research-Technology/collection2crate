// Seam: what a file option that takes a folder hands a plugin
// (src/upload_files.js) — the files by path, which one is the main file, and
// how a dropped folder is walked. Files are stand-ins with a name and, for a
// picked folder, the webkitRelativePath a browser gives them; drops use fake
// FileSystemEntry objects with the browser's callback API.

import assert from "node:assert/strict";
import {
  buildUploadValue, describeUpload, entriesFromPickedFiles, filesFromDataTransfer, pickMainEntry, uploadFilesMap,
} from "../src/upload_files.js";

const file = (name, webkitRelativePath = "") => ({ name, webkitRelativePath, text: async () => name });
const ACCEPT = ".json,.css,.html,application/json,text/css,text/html";

/* ---------- picked files and folders ---------- */

{
  const picked = entriesFromPickedFiles([
    file("config.json", "birds/config.json"),
    file("root.html", "birds/templates/root.html"),
  ]);
  assert.deepEqual(picked.map((e) => e.path), ["config.json", "templates/root.html"],
    "A picked folder's own name is left out of the paths");
  assert.deepEqual(entriesFromPickedFiles([file("a.json")]).map((e) => e.path), ["a.json"],
    "Loose picked files are keyed by name");
}

{
  const a = file("style.css");
  const b = file("style.css");
  const map = uploadFilesMap([{ file: a, path: "css/style.css" }, { file: b, path: "other/style.css" }]);
  assert.equal(map.get("css/style.css"), a);
  assert.equal(map.get("other/style.css"), b);
  assert.equal(map.get("style.css"), a, "A bare name goes to the first file with it");
}

/* ---------- the main file ---------- */

{
  const entries = [
    { file: file("root.html"), path: "templates/root.html" },
    { file: file("style.css"), path: "style.css" },
    { file: file("labels.json"), path: "data/labels.json" },
    { file: file("site-config.json"), path: "site-config.json" },
    { file: file("config.json"), path: "nested/config.json" },
    { file: file(".DS_Store"), path: ".DS_Store" },
  ];
  assert.equal(pickMainEntry(entries, { accept: ACCEPT, prefer: "config" }).path, "site-config.json",
    "The first accepted extension, named for the option, nearest the top");
  assert.equal(pickMainEntry(entries, { accept: ACCEPT }).path, "site-config.json",
    "Without a name hint, the shallowest file of that extension");
  assert.equal(pickMainEntry(entries.filter((e) => !e.path.endsWith(".json")), { accept: ACCEPT }).path, "style.css",
    "The next extension when none has the first");
  assert.equal(pickMainEntry([{ file: file(".hidden.json"), path: ".hidden.json" }], { accept: ACCEPT }).path, ".hidden.json",
    "Hidden files are only passed over when there is something else");
}

{
  assert.equal(buildUploadValue([], { accept: ACCEPT }), null, "Nothing uploaded is no value");
  const cfg = file("config.json");
  const value = buildUploadValue([
    { file: file("root.html"), path: "birds/templates/root.html" },
    { file: cfg, path: "birds/config.json" },
  ], { accept: ACCEPT, prefer: "config", folder: "site" });
  assert.equal(value.file, cfg);
  assert.equal(value.name, "config.json");
  assert.equal(value.path, "birds/config.json", "The main file's path, so its relative references resolve from its folder");
  assert.equal(value.fileCount, 2);
  assert.ok(value.siblingFiles instanceof Map);
  assert.ok(value.siblingFiles.get("birds/templates/root.html"));
  assert.equal(describeUpload(value), "✓ birds/config.json (folder site, 2 files)");
  assert.equal(describeUpload(buildUploadValue([{ file: cfg, path: "config.json" }], { accept: ACCEPT })), "✓ config.json");
  assert.equal(describeUpload(null), "");
}

/* ---------- drops ---------- */

const fileEntry = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(file(name)) });
const dirEntry = (name, children) => ({
  isFile: false, isDirectory: true, name,
  createReader: () => {
    // Two batches, then the empty one that ends a directory, as Chrome does.
    const batches = [children.slice(0, 1), children.slice(1), []];
    return { readEntries: (ok) => ok(batches.shift() || []) };
  },
});
const transfer = (entries) => ({
  items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })),
  files: [],
});

{
  const dropped = await filesFromDataTransfer(transfer([
    dirEntry("site", [fileEntry("config.json"), dirEntry("templates", [fileEntry("root.html"), fileEntry("item.html")])]),
  ]));
  assert.equal(dropped.folder, "site", "A single dropped folder is reported like a chosen one");
  assert.deepEqual(dropped.entries.map((e) => e.path).sort(), ["config.json", "templates/item.html", "templates/root.html"],
    "…with its name left out of the paths, every batch read, subfolders walked");
}

{
  const dropped = await filesFromDataTransfer(transfer([fileEntry("config.json"), dirEntry("templates", [fileEntry("root.html")])]));
  assert.equal(dropped.folder, null);
  assert.deepEqual(dropped.entries.map((e) => e.path).sort(), ["config.json", "templates/root.html"],
    "Several dropped items keep their own names in the paths");
}

{
  const f = file("config.json");
  const dropped = await filesFromDataTransfer({ items: [], files: [f] });
  assert.deepEqual(dropped.entries, [{ file: f, path: "config.json" }], "A browser without entries still gives the files");
}

console.log("test-upload-files: all tests passed (picked files and folders, keying by path and name, main-file choice, upload value and label, dropped folders and files)");
