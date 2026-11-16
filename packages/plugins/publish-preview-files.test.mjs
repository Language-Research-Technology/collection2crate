// "Publish subset only" (see publish-filter.test.mjs) strips unpublished
// entities from the in-memory crate before rendering the generated preview
// HTML, but never touched the actual files on disk — so a folder holding
// just the generated preview plus its files still exposed every file the
// crate ever had, published or not. copyPublishedFilesToPreviewFolder closes
// that gap by copying exactly the File entities that survived the filter
// into ro-crate-preview-files/, and rewriteToPreviewFilesFolder redirects the
// generated HTML's own links to those copies.
//
//   node publish-preview-files.test.mjs
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import {
  collectFilePaths, copyPublishedFilesToPreviewFolder, rewriteToPreviewFilesFolder, createPlugin,
} from "./plugins/ro-crate-html-output/index.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

/* ---------- collectFilePaths ---------- */

await check("only local File entities are collected", () => {
  const crate = new ROCrate({ array: true, link: true });
  crate.rootDataset["@id"] = "./";
  crate.rootDataset["@type"] = ["Dataset"];
  crate.addEntity({ "@id": "files/images/pic.jpg", "@type": "File", name: "pic.jpg" });
  crate.addEntity({ "@id": "115D#J~Y.PDF", "@type": "File", name: "115D#J~Y.PDF" });
  crate.addEntity({ "@id": "https://example.com/remote.jpg", "@type": "File", name: "remote.jpg" });
  crate.addEntity({ "@id": "#objectA1", "@type": "RepositoryObject", name: "Object A1" });

  const paths = collectFilePaths(crate);
  assert.deepEqual(new Set(paths), new Set(["files/images/pic.jpg", "115D#J~Y.PDF"]),
    "only File entities with a folder-relative @id are collected — not other entity types, and not an externally-hosted File");
});

/* ---------- copyPublishedFilesToPreviewFolder ---------- */

await check("copies published files that are actually on disk, warns about the rest, and wipes stale copies first", async () => {
  const crate = new ROCrate({ array: true, link: true });
  crate.rootDataset["@id"] = "./";
  crate.rootDataset["@type"] = ["Dataset"];
  crate.addEntity({ "@id": "files/pic.jpg", "@type": "File", name: "pic.jpg" });
  crate.addEntity({ "@id": "files/gone.jpg", "@type": "File", name: "gone.jpg" });

  const onDisk = new Map([["files/pic.jpg", "pic-bytes"]]);
  const written = new Map();
  const removedPaths = [];
  const logs = [];

  createPlugin({
    crateToPreviewHtml: async () => "", crateToMultiPageHtml: async () => ({ rootHtml: "", pages: [] }),
    writeFile: async () => {}, readJsonFromFolder: async () => null, fileExists: async () => false,
    readFileTextFromDirectory: async () => null, verifyPermission: async () => true,
    getFileHandleAtPath: async (dir, relPath) => (onDisk.has(relPath)
      ? { getFile: async () => ({ text: async () => onDisk.get(relPath) }) }
      : null),
    writeFileAtPath: async (dir, relPath, contents) => { written.set(relPath, contents); },
    bustCacheUrl: (u) => u, buildGitHubTreeUrl: () => "", fetchGitHubTextFile: async () => "", listGitHubFolder: async () => [],
  });

  const dirHandle = { removeEntry: async (name) => { removedPaths.push(name); } };
  const log = (msg, level) => logs.push({ msg, level });

  const assetMap = await copyPublishedFilesToPreviewFolder(crate, dirHandle, log);

  assert.deepEqual(removedPaths, ["ro-crate-preview-files"], "a stale copy from a previous build is wiped first");
  assert.equal(written.size, 1, "only the file that's actually on disk gets copied");
  assert.equal(await written.get("ro-crate-preview-files/files/pic.jpg").text(), "pic-bytes",
    "the real File object (not its content read separately) is handed to writeFileAtPath, exactly as a genuine copy would");
  assert.deepEqual([...assetMap], [["files/pic.jpg", "ro-crate-preview-files/files/pic.jpg"]]);
  assert.ok(logs.some((l) => l.level === "warn" && l.msg.includes("files/gone.jpg")),
    "a File entity with nothing on disk is warned about, not silently skipped");
});

/* ---------- rewriteToPreviewFilesFolder ---------- */

await check("redirects href/src and CSS url() references to their copies, leaving everything else untouched", () => {
  const assetMap = new Map([
    ["files/pic.jpg", "ro-crate-preview-files/files/pic.jpg"],
    ["115D#J~Y.PDF", "ro-crate-preview-files/115D#J~Y.PDF"],
    ["Images/B&W_photos/KEA1.jpg", "ro-crate-preview-files/Images/B&W_photos/KEA1.jpg"],
    ["100%.pdf", "ro-crate-preview-files/100%.pdf"],
  ]);

  assert.equal(
    rewriteToPreviewFilesFolder('<img src="files/pic.jpg">', assetMap),
    '<img src="ro-crate-preview-files/files/pic.jpg">'
  );

  assert.equal(
    rewriteToPreviewFilesFolder('<a href="files/pic.jpg?v=2">dl</a>', assetMap),
    '<a href="ro-crate-preview-files/files/pic.jpg?v=2">dl</a>',
    "a trailing query string on the original reference survives the swap"
  );

  assert.equal(
    rewriteToPreviewFilesFolder('<a href="115D#J~Y.PDF">open</a>', assetMap),
    '<a href="ro-crate-preview-files/115D%23J~Y.PDF">open</a>',
    "a literal '#' in the crate's own filename is matched as part of the path, not treated as a fragment delimiter — and is written back encoded, or the browser would read it as a fragment"
  );

  // What the renderer actually emits: the reserved characters percent-encoded
  // and the HTML-special ones escaped. Matching assetMap's raw paths against
  // the page literally missed every one of these, so their links kept pointing
  // outside ro-crate-preview-files/ and 404'd once deployed.
  assert.equal(
    rewriteToPreviewFilesFolder('<a href="115D%23J~Y.PDF">open</a>', assetMap),
    '<a href="ro-crate-preview-files/115D%23J~Y.PDF">open</a>',
    "a percent-encoded '#' is recognised as the filename it stands for"
  );

  assert.equal(
    rewriteToPreviewFilesFolder('<img src="Images/B&amp;W_photos/KEA1.jpg">', assetMap),
    '<img src="ro-crate-preview-files/Images/B&amp;W_photos/KEA1.jpg">',
    "an HTML-escaped '&' in a folder name is recognised, and stays escaped on the way out"
  );

  assert.equal(
    rewriteToPreviewFilesFolder('<a href="100%25.pdf">pct</a>', assetMap),
    '<a href="ro-crate-preview-files/100%25.pdf">pct</a>',
    "a filename containing a literal '%' round-trips rather than being double-encoded"
  );

  assert.equal(
    rewriteToPreviewFilesFolder('<a href="115D%23J~Y.PDF#page=3">open</a>', assetMap),
    '<a href="ro-crate-preview-files/115D%23J~Y.PDF#page=3">open</a>',
    "a real fragment after a filename that itself contains '#' survives the swap"
  );

  assert.equal(
    rewriteToPreviewFilesFolder("background-image: url('files/pic.jpg')", assetMap),
    "background-image: url('ro-crate-preview-files/files/pic.jpg')",
    "CSS url() references are rewritten too"
  );

  assert.equal(
    rewriteToPreviewFilesFolder('<a href="#objectA1">Object A1</a>', assetMap),
    '<a href="#objectA1">Object A1</a>',
    "an internal same-page anchor to another entity is left untouched"
  );

  assert.equal(
    rewriteToPreviewFilesFolder('<a href="ro-crate-preview_html/aa/bb/cc/dd/index.html">Next</a>', assetMap),
    '<a href="ro-crate-preview_html/aa/bb/cc/dd/index.html">Next</a>',
    "a link to another generated page is left untouched"
  );

  assert.equal(rewriteToPreviewFilesFolder("", assetMap), "");
  assert.equal(rewriteToPreviewFilesFolder('<img src="files/pic.jpg">', null), '<img src="files/pic.jpg">', "no map, no change");
});

console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
