// Seam: the blob-served preview's reference rewriting (src/preview_assets.js).
//
// A preview opens from blob: URLs with no server behind it, so every reference
// in the page has to be resolved before it is shown — except links to other
// preview pages, which are marked and resolved on click (a blob's content is
// fixed at creation, and preview pages link to each other in cycles).
//
// The folder is faked with the three File System Access methods the code uses,
// which is enough to drive the real function under Node.
import assert from "node:assert/strict";

import {
  buildPreviewBlobUrl, isExternalReference, resolveRelativePath, isPagePath,
  PAGE_LINK_ATTRIBUTE, PAGE_RESOLVER_NAME,
} from "../src/preview_assets.js";

/* ---------- path resolution ---------- */

assert.equal(resolveRelativePath("", "media/photo.jpg"), "media/photo.jpg");
assert.equal(resolveRelativePath("ro-crate-preview_html", "../ro-crate-preview.html"),
  "ro-crate-preview.html", "A sub-page's link back up resolves against its own directory");
assert.equal(resolveRelativePath("pages", "./a/../b.html"), "pages/b.html",
  "'.' and '..' segments collapse");
assert.equal(resolveRelativePath("", "file%20name.csv"), "file name.csv",
  "Percent-encoding is decoded, since the folder holds the decoded name");
assert.equal(resolveRelativePath("", "data.csv#row3"), "data.csv",
  "A fragment is not part of the path");

for (const external of ["#section", "https://example.org/x", "data:text/plain,hi", "blob:abc", "mailto:a@b.c"]) {
  assert.ok(isExternalReference(external), `${external} is left alone`);
}
assert.ok(!isExternalReference("media/photo.jpg"), "A relative path is ours to resolve");

assert.ok(isPagePath("a.html") && isPagePath("b/c.HTM") && isPagePath("d.xhtml"), "Pages are html-ish");
assert.ok(!isPagePath("data.csv") && !isPagePath("notes.htmlx"), "Anything else is an asset");

/* ---------- rewriting a whole preview ---------- */

/** A folder of {path: text}, exposing just what fs_helpers reaches for. */
function fakeFolder(files) {
  const at = (prefix) => ({
    async getDirectoryHandle(name) {
      const next = prefix ? `${prefix}/${name}` : name;
      if (![...Object.keys(files)].some((p) => p.startsWith(`${next}/`))) throw new Error("no such dir");
      return at(next);
    },
    async getFileHandle(name) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!(path in files)) throw new Error("no such file");
      return { getFile: async () => new Blob([files[path]], { type: "text/plain" }) };
    },
  });
  return at("");
}

{
  const folder = fakeFolder({
    "ro-crate-preview.html": `<html><body>
      <link href="styles/main.css" rel="stylesheet">
      <img src="media/photo.jpg">
      <a href="ro-crate-preview_html/object-1.html">An object</a>
      <a href="data/table.csv">The data</a>
      <a href="https://example.org">Elsewhere</a>
      <a href="#top">Top</a>
      <a href="missing/page.html">Gone</a>
    </body></html>`,
    "styles/main.css": `body { background: url("../media/photo.jpg"); }`,
    "media/photo.jpg": "JPEGDATA",
    "data/table.csv": "a,b\n1,2\n",
    "ro-crate-preview_html/object-1.html": "<html><body>Object</body></html>",
  });

  const { url, revoke } = await buildPreviewBlobUrl(folder, "ro-crate-preview.html");
  const html = await (await fetch(url)).text();

  assert.match(html, /<img src="blob:/, "An image is inlined as a blob");
  assert.match(html, /<link href="blob:/, "A stylesheet is inlined as a blob");
  assert.match(html, /<a href="blob:[^"]*">The data<\/a>/,
    "A link to a data file is inlined too — clicking it opens the file itself");
  assert.match(html, new RegExp(`href="#" ${PAGE_LINK_ATTRIBUTE}="ro-crate-preview_html/object-1.html"`),
    "A link to another preview page is marked rather than inlined, because its blob cannot exist yet");
  assert.match(html, /href="https:\/\/example\.org"/, "An external link is untouched");
  assert.match(html, /href="#top"/, "A fragment link is untouched");
  assert.match(html, /href="missing\/page\.html"/,
    "A link to a page that isn't in the folder is left as it was, not marked as navigable");

  assert.match(html, new RegExp(`window\\.opener\\.${PAGE_RESOLVER_NAME}|${PAGE_RESOLVER_NAME}`),
    "The page carries the click handler that resolves marked links");
  assert.equal(html.split("addEventListener(\"click\"").length - 1, 1,
    "The navigation script is injected once");
  assert.ok(html.indexOf("<script>") > html.indexOf("<a href"), "It is injected at the end of the body");

  revoke();
}

{
  // Nothing to navigate to: no script, so a single-page preview stays inert.
  const folder = fakeFolder({ "ro-crate-preview.html": "<html><body><p>Just a page</p></body></html>" });
  const { url, revoke } = await buildPreviewBlobUrl(folder, "ro-crate-preview.html");
  const html = await (await fetch(url)).text();
  assert.ok(!html.includes("<script>"), "A preview with no page links gets no navigation script");
  revoke();
}

{
  await assert.rejects(
    () => buildPreviewBlobUrl(fakeFolder({}), "ro-crate-preview.html"),
    /No ro-crate-preview\.html in this folder/,
    "A folder with no preview says so rather than opening an empty window"
  );
}

console.log(
  "test-preview-links: all tests passed (path resolution, external references, asset inlining, " +
  "page links marked for click-time resolution, script injected once and only when needed)"
);
