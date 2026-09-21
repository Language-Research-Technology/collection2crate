// Path and CSS url() rewriting for the blob-served preview (SPEC.md §11).
//
// The generated ro-crate-preview.html sits in the picked folder and refers to
// its stylesheets, images and linked files by relative path. The preview opens
// with no web server to hand those out, so every referenced asset is read
// through the directory handle, turned into a blob: URL, and substituted back
// into the markup — including inside CSS url() values, which a plain attribute
// rewrite would miss.
//
// Links to other *pages* can't be blob URLs baked in the same way: a blob's
// content is fixed when it is created, and preview pages link to each other in
// cycles (a collection page to its objects, each object back to the
// collection), so there is no order in which every URL is known before the
// content that names it. They are marked instead, and resolved on click by
// PAGE_NAVIGATION_SCRIPT below, which asks the app for that page's blob at the
// moment it is needed. Lazy resolution also means a preview of a thousand-page
// crate opens as fast as a preview of one.

import { getFileHandleAtPath } from "./fs_helpers.js";

const ATTRIBUTE_PATTERN = /\b(src|href|poster|data-src)\s*=\s*(["'])([^"']+)\2/gi;
const CSS_URL_PATTERN = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

/** The attribute a marked page link carries, and the hook the script reads. */
export const PAGE_LINK_ATTRIBUTE = "data-c2c-page";

/** The function a preview window calls back into for the next page's blob. */
export const PAGE_RESOLVER_NAME = "__c2cPreviewPage";

export const isPagePath = (path) => /\.x?html?$/i.test(path);

// Runs inside the preview window. Any click on a marked link asks the window
// that opened it to build that page — the opener holds the directory handle,
// and a blob: page shares its opener's origin, so the call is same-origin.
const PAGE_NAVIGATION_SCRIPT = `
<script>
document.addEventListener("click", async (event) => {
  const link = event.target.closest("[${PAGE_LINK_ATTRIBUTE}]");
  if (!link) return;
  event.preventDefault();
  const resolve = window.opener && window.opener.${PAGE_RESOLVER_NAME};
  if (!resolve) return;
  const url = await resolve(link.getAttribute("${PAGE_LINK_ATTRIBUTE}"));
  if (url) window.location.href = url;
});
</script>`;

/** True for anything already absolute, or not a file reference at all. */
export function isExternalReference(value) {
  return (
    !value ||
    value.startsWith("#") ||
    value.startsWith("data:") ||
    value.startsWith("blob:") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  );
}

function normalizeAndJoin(basePath, decoded) {
  const parts = [
    ...String(basePath || "").split("/").filter(Boolean),
    ...decoded.split("/"),
  ];
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

/** Normalise a relative reference against the directory the page lives in. */
export function resolveRelativePath(basePath, reference) {
  return normalizeAndJoin(basePath, decodeURI(reference.split("#")[0].split("?")[0]));
}

// Like resolveRelativePath, but keeps a literal '#'/'?' in the reference as
// part of the path rather than treating it as a fragment/query delimiter —
// crate filenames can contain either character (e.g. "115D#J~Y.PDF"), so a
// real file whose name has one must still be found. Only used via
// resolveFileHandle below, which tries this first and falls back to the
// fragment/query-stripping behaviour above when the literal path isn't a
// real file — that keeps a genuine fragment (e.g. "#top") or query string
// working exactly as before for everything that isn't a filename collision.
function resolveRelativePathLiteral(basePath, reference) {
  return normalizeAndJoin(basePath, decodeURI(reference));
}

/**
 * Resolve `reference` (against `basePath`) to the file it names, trying the
 * literal reference first and only falling back to stripping a '#'/'?'
 * suffix when that literal path isn't a real file in `dirHandle`. Returns
 * { handle, path } — handle is null when neither resolves to a file.
 */
async function resolveFileHandle(dirHandle, basePath, reference) {
  const literalPath = resolveRelativePathLiteral(basePath, reference);
  const literalHandle = await getFileHandleAtPath(dirHandle, literalPath);
  if (literalHandle) return { handle: literalHandle, path: literalPath };
  const path = resolveRelativePath(basePath, reference);
  const handle = await getFileHandleAtPath(dirHandle, path);
  return { handle, path };
}

/**
 * Build a blob: URL for a preview page with every local asset inlined as its
 * own blob.
 *
 * @returns {Promise<{url: string, revoke: function}>}
 */
export async function buildPreviewBlobUrl(dirHandle, htmlPath = "ro-crate-preview.html") {
  const baseDir = htmlPath.includes("/") ? htmlPath.slice(0, htmlPath.lastIndexOf("/")) : "";
  const created = [];

  const assetUrl = async (reference) => {
    if (isExternalReference(reference)) return null;
    const { handle, path } = await resolveFileHandle(dirHandle, baseDir, reference);
    if (!handle) return null;
    const file = await handle.getFile();
    if (/\.css$/i.test(path)) {
      const cssDir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const css = await rewriteCssUrls(await file.text(), cssDir, dirHandle, created);
      const url = URL.createObjectURL(new Blob([css], { type: "text/css" }));
      created.push(url);
      return url;
    }
    const url = URL.createObjectURL(file);
    created.push(url);
    return url;
  };

  const source = await readText(dirHandle, htmlPath);
  if (source === null) throw new Error(`No ${htmlPath} in this folder — build the crate first.`);

  const rewritten = await replaceAsync(source, ATTRIBUTE_PATTERN, async (match, attr, quote, value) => {
    if (isExternalReference(value)) return match;
    const { handle, path } = await resolveFileHandle(dirHandle, baseDir, value);
    // A link to another preview page keeps its human-readable path and is
    // resolved on click; everything else is inlined as a blob now.
    if (attr.toLowerCase() === "href" && isPagePath(path)) {
      if (handle) return `${attr}=${quote}#${quote} ${PAGE_LINK_ATTRIBUTE}=${quote}${path}${quote}`;
      return match;
    }
    const url = await assetUrl(value);
    return url ? `${attr}=${quote}${url}${quote}` : match;
  });

  const html = rewritten.includes(PAGE_LINK_ATTRIBUTE)
    ? injectScript(rewritten, PAGE_NAVIGATION_SCRIPT)
    : rewritten;

  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  created.push(url);
  return {
    url,
    revoke() {
      for (const created_url of created) URL.revokeObjectURL(created_url);
      created.length = 0;
    },
  };
}

/** Rewrite url() references inside a stylesheet to blob: URLs. */
export async function rewriteCssUrls(cssText, cssDir, dirHandle, created) {
  return await replaceAsync(cssText, CSS_URL_PATTERN, async (match, quote, value) => {
    if (isExternalReference(value)) return match;
    const { handle } = await resolveFileHandle(dirHandle, cssDir, value);
    if (!handle) return match;
    const url = URL.createObjectURL(await handle.getFile());
    created.push(url);
    return `url("${url}")`;
  });
}

/** Put the navigation script last in <body>, or at the end if there is none. */
function injectScript(html, script) {
  const close = html.lastIndexOf("</body>");
  if (close < 0) return html + script;
  return html.slice(0, close) + script + html.slice(close);
}

async function readText(dirHandle, path) {
  const handle = await getFileHandleAtPath(dirHandle, path);
  if (!handle) return null;
  return await (await handle.getFile()).text();
}

// String.replace can't await, so collect the replacements first and splice
// them in afterwards.
async function replaceAsync(text, pattern, replacer) {
  const matches = [...text.matchAll(pattern)];
  const replacements = await Promise.all(matches.map((m) => replacer(...m)));
  let out = "";
  let cursor = 0;
  matches.forEach((match, i) => {
    out += text.slice(cursor, match.index) + replacements[i];
    cursor = match.index + match[0].length;
  });
  return out + text.slice(cursor);
}
