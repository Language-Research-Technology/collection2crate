// Generates ro-crate-preview.html — resolves a template/config/css bundle
// (repo folder → uploaded file → local folder, in that precedence) and
// renders either a multipage or single-page preview. Owns the whole
// template-resolution helper cluster that used to live inline in main.js;
// only the shared GitHub-fetch primitives (also used for the profile list
// and template-repo folder dropdown) and generic FSA read/write helpers are
// imported from neutral modules rather than duplicated here.
//
// Core collection2crate functions (crate.js/fs_helpers.js/github.js) are used
// throughout this file's helpers below, so rather than threading them as an
// explicit parameter through every call site, createPlugin(deps) assigns
// them once into these module-level bindings before the plugin object is
// ever used — see this repo's README for the createPlugin(deps) contract.
import { resolveProfileGroups } from "./layout.js";
import { countedProgress, progressFor } from "../../src/_progress.js";

let crateToPreviewHtml, crateToMultiPageHtml;
let writeFile, writeFileAtPath, readJsonFromFolder, readFileTextFromDirectory, verifyPermission, fileExists, getFileHandleAtPath;
let bustCacheUrl, buildGitHubTreeUrl, fetchGitHubTextFile, listGitHubFolder;

export function createPlugin(deps) {
  ({ crateToPreviewHtml, crateToMultiPageHtml } = deps);
  ({ writeFile, writeFileAtPath, readJsonFromFolder, readFileTextFromDirectory, verifyPermission, fileExists, getFileHandleAtPath } = deps);
  ({ bustCacheUrl, buildGitHubTreeUrl, fetchGitHubTextFile, listGitHubFolder } = deps);
  return plugin;
}

const HTML_FILE = "ro-crate-preview.html";
const MULTIPAGE_DIR = "ro-crate-preview_html";
// Where "Publish subset only" copies the files that survived
// filterCrateToPublished, so a deployment of the generated preview alone
// (this folder + ro-crate-preview.html/ro-crate-preview_html/) never exposes
// a file that was filtered out — see copyPublishedFilesToPreviewFolder.
const PREVIEW_FILES_DIR = "ro-crate-preview-files";
const TEMPLATE_REPO_OWNER = "Language-Research-Technology";
const TEMPLATE_REPO_NAME = "rocss-templates";
const TEMPLATE_REPO_REF = "main";

// Applies the collectionLabelsBuilder option's name/order overrides directly
// to the shared crate object, for this HTML render only. Safe because this
// hook runs after ro-crate-json-output/ro-crate-xlsx-output (see
// src/plugins/index.js's registration order) — by the time this mutates
// `crate`, both metadata files have already been written from the
// unmodified names/order, so ro-crate-metadata.json/.xlsx never see this
// override, only the generated HTML does.
function applyCollectionLabelOverrides(crate, options) {
  const labels = options.collectionLabels;
  const order = options.collectionOrder;
  if (!labels && !order) return;

  const graph = crate.getJson()["@graph"] || [];
  const collectionNameToId = new Map();
  for (const entity of graph) {
    const types = Array.isArray(entity["@type"]) ? entity["@type"] : [entity["@type"]];
    const isCollection = types.includes("RepositoryCollection");
    const isSourceGroup = types.includes("custom:SourceDocumentGroup");
    if (!isCollection && !isSourceGroup) continue;
    const folderName = entity.name;
    if (isCollection) collectionNameToId.set(folderName, entity["@id"]);
    if (labels && labels[folderName]) {
      const live = crate.getEntity(entity["@id"]);
      if (live) live.name = labels[folderName];
    }
  }

  if (order) {
    const derivedContent = crate.getEntity("#derivedContent");
    if (derivedContent && Array.isArray(derivedContent.hasPart)) {
      const parts = derivedContent.hasPart;
      const idOrder = order.map((folderName) => collectionNameToId.get(folderName)).filter(Boolean);
      parts.sort((a, b) => {
        const ia = idOrder.indexOf(a["@id"]);
        const ib = idOrder.indexOf(b["@id"]);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    }
  }
}

function readPublishFlag(entity) {
  // A crate configured with { array: true } (see the module-level ROCrate
  // constructors in tests and main.js) always returns property values as
  // arrays, so a boolean custom:publish:true round-trips as [true].
  //
  // Namespaced like every other non-standard term this codebase adds
  // (custom:participant, custom:compiler, custom:possibleDuplicate, ...) —
  // a bare "publish" isn't a real property anywhere in these profiles, and
  // ro-crate-excel spreadsheets (see xlsx-crate-input) carry it as a
  // custom:publish column, typically on File entities rather than
  // RepositoryObject/Collection.
  let v = entity?.["custom:publish"];
  if (Array.isArray(v)) v = v[0];
  if (v === true || v === false) return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return undefined;
}

function contentChildRefs(entity) {
  const refs = new Set();
  // pcdm:hasMember is how buildCrate() (collection2crate's src/crate.js)
  // actually links the root dataset to its top-level collections/objects,
  // and how a RepositoryCollection lists its nested objects — hasPart is
  // only what a RepositoryObject uses for its own files (see that file's
  // own MEMBERSHIP_PROPS). Both must be checked at every level, or a real
  // crate's root (which carries no bare hasPart at all) yields zero
  // children and the whole subtree silently "kept 0 of 0".
  for (const prop of ["hasPart", "hasMember", "pcdm:hasMember"]) {
    const val = entity?.[prop];
    if (!val) continue;
    for (const ref of Array.isArray(val) ? val : [val]) {
      if (ref && ref["@id"]) refs.add(ref["@id"]);
    }
  }
  // Some crates (an ro-crate-excel spreadsheet is the common source) only
  // declare the reverse direction — a File's own isPartOf, rather than a
  // redundant hasPart entry on its parent — inconsistently even within the
  // same crate, e.g. some top-level objects list hasPart while others rely
  // solely on their files' isPartOf. Reading the live @reverse index (ro-crate
  // maintains it automatically, including through deleteEntity's cleanup) is
  // what makes such children still discoverable, regardless of which
  // direction the relationship was actually recorded in.
  const reverse = entity?.["@reverse"];
  for (const prop of ["isPartOf", "memberOf", "pcdm:memberOf"]) {
    const val = reverse?.[prop];
    if (!val) continue;
    for (const ref of Array.isArray(val) ? val : [val]) {
      if (ref && ref["@id"]) refs.add(ref["@id"]);
    }
  }
  return [...refs];
}

// Walks the rootDataset's hasPart/hasMember tree (collections → objects →
// files) and decides, for each non-root entity, whether it should survive a
// "publish subset only" build: its own custom:publish:true/false always
// wins, and otherwise it inherits the nearest ancestor's resolved value (so
// marking a RepositoryCollection custom:publish:true publishes everything
// under it, while an individual custom:publish:false inside it can still
// opt that one item out).
//
// A kept node also drags its ancestors along as structural shells, even when
// an ancestor's own resolved value is false — otherwise a File explicitly
// marked custom:publish:true inside an otherwise-unpublished
// collection/object (the common case — ro-crate-excel spreadsheets carry
// this column on the File sheet) would still get orphaned when that
// ancestor (and the root's link to it) is removed.
function resolvePublishSubset(crate) {
  const root = crate.rootDataset;
  const rootId = root["@id"];
  const visited = new Set();
  const parentOf = new Map();
  const keep = new Set();
  let sawPublishFlag = false;

  function visit(id, inherited, parentId) {
    if (visited.has(id)) return;
    visited.add(id);
    if (parentId !== undefined) parentOf.set(id, parentId);
    const entity = crate.getEntity(id);
    if (!entity) return;
    const own = readPublishFlag(entity);
    if (own !== undefined) sawPublishFlag = true;
    const effective = own !== undefined ? own : inherited;
    if (id !== rootId && effective === true) keep.add(id);
    for (const childId of contentChildRefs(entity)) visit(childId, effective, id);
  }

  visit(rootId, undefined, undefined);
  visited.delete(rootId);

  for (const id of [...keep]) {
    let cur = parentOf.get(id);
    while (cur !== undefined && cur !== rootId && !keep.has(cur)) {
      keep.add(cur);
      cur = parentOf.get(cur);
    }
  }

  return { visited, keep, sawPublishFlag };
}

// Mutates `crate` in place, removing every collection/object/file under the
// root that didn't resolve to published. Safe to call destructively here
// because this hook runs last among the crate:write writers (see the
// module doc comment above applyCollectionLabelOverrides) — the JSON/XLSX
// metadata files have already been written from the full crate by the time
// this runs, so only the generated HTML is affected.
export function filterCrateToPublished(crate, log) {
  const { visited, keep, sawPublishFlag } = resolvePublishSubset(crate);
  if (!sawPublishFlag) {
    log("Publish subset only: no collection/object/file in this crate has a custom:publish property set, so the generated preview will be empty. Mark at least one of them custom:publish:true.", "warn");
  }
  const toRemove = [...visited].filter((id) => !keep.has(id));
  for (const id of toRemove) crate.deleteEntity(id, { references: true });
  log(`Publish subset only: kept ${keep.size} of ${visited.size} collection/object/file entit${visited.size === 1 ? "y" : "ies"}.`, "muted");
}

// Every File entity still in `crate` (call after filterCrateToPublished, so
// this is exactly the set that survived the publish filter) whose @id is a
// folder-relative path rather than an external URL — mirrors the same
// absolute-URL guard collection2crate's src/existing_crate.js (isLocalPath)
// uses to tell a real on-disk file apart from a File entity that only records
// a remote reference and has nothing to copy.
export function collectFilePaths(crate) {
  const paths = [];
  const seen = new Set();
  for (const entity of crate.graph) {
    const id = entity?.["@id"];
    if (!id || seen.has(id)) continue;
    const types = Array.isArray(entity["@type"]) ? entity["@type"] : [entity["@type"]];
    if (!types.includes("File")) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(id)) continue;
    seen.add(id);
    paths.push(id);
  }
  return paths;
}

// Copies every published file (collectFilePaths) from the picked crate
// folder into PREVIEW_FILES_DIR, so that folder plus the generated HTML is a
// self-contained, safe-to-publish subset — the crate folder itself still
// holds every file regardless of custom:publish, published or not. Returns
// a Map of original crate-relative path -> its copy's path, for
// rewriteToPreviewFilesFolder to redirect the generated HTML's links to.
export async function copyPublishedFilesToPreviewFolder(crate, dirHandle, log) {
  const filePaths = collectFilePaths(crate);
  const assetMap = new Map();
  if (!filePaths.length) return assetMap;

  try {
    await dirHandle.removeEntry(PREVIEW_FILES_DIR, { recursive: true });
  } catch {
    // no pre-existing ro-crate-preview-files/ to remove — fine.
  }

  let copied = 0;
  let missing = 0;
  for (const relPath of filePaths) {
    const fileHandle = await getFileHandleAtPath(dirHandle, relPath);
    if (!fileHandle) {
      log(`Publish subset only: file referenced by the crate is missing from the folder — not copied into ${PREVIEW_FILES_DIR}/: ${relPath}`, "warn");
      missing++;
      continue;
    }
    const file = await fileHandle.getFile();
    await writeFileAtPath(dirHandle, `${PREVIEW_FILES_DIR}/${relPath}`, file);
    assetMap.set(relPath, `${PREVIEW_FILES_DIR}/${relPath}`);
    copied++;
  }
  log(
    `Publish subset only: copied ${copied} file(s) into ${PREVIEW_FILES_DIR}/${missing ? ` (${missing} missing from the folder)` : ""}.`,
    copied ? "ok" : "warn"
  );
  return assetMap;
}

// The spelling a reference has in the rendered HTML is not the crate's own
// path. The renderer percent-encodes the URL-reserved characters and the
// markup escapes the HTML-special ones, so "115D#J~Y.PDF" arrives as
// "115D%23J~Y.PDF" and "B&W_photos" as "B&amp;W_photos". Matching assetMap's
// raw paths against the HTML literally therefore missed exactly those files
// and left their links pointing outside PREVIEW_FILES_DIR — a 404 in any
// deployment of the published subset. Every reference is brought back to its
// literal path before assetMap is consulted.
function decodeReferenceFromHtml(value) {
  const unescaped = String(value)
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#0*39);/gi, "'")
    // Last, so "&amp;lt;" comes back as the text "&lt;" rather than "<".
    .replace(/&amp;/gi, "&");
  return unescaped
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // A stray '%' that isn't an escape sequence: keep the segment as it is.
        return segment;
      }
    })
    .join("/");
}

// And the reverse, for the path written back. Getting this wrong is the other
// half of the same bug: emitting a literal '#' would hand the browser
// "…/115D" plus the fragment "J~Y.PDF". '%' goes first so the escapes added
// after it are not themselves re-escaped. Spaces are left alone, as the
// renderer leaves them in the references that already work.
function encodePathForHtml(path) {
  return String(path)
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F")
    .replace(/&/g, "&amp;");
}

const EXTERNAL_REFERENCE = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

// Redirects every href="…"/src="…" and CSS url(…) reference to one of
// assetMap's original paths over to its copy under ro-crate-preview-files/,
// across the whole rendered page. Works at the regex level, like
// fixEncodedSlashes (collection2crate's src/crate.js) — a DOM/cheerio
// parse-and-reserialize risks subtly reformatting markup that isn't ours to
// rewrite, on output real users will deploy as-is. Each reference is matched
// generically and then looked up, rather than building one alternation of
// every known path: that is what lets an escaped spelling be recognised, and
// it keeps the work linear in the page rather than in paths × page.
//
// A path is looked up whole before any '#'/'?' suffix is considered, so a
// file whose own name contains one of those characters is found instead of
// being mistaken for a fragment/query — see src/preview_assets.js's
// resolveFileHandle for the in-app-preview equivalent of this same hazard.
export function rewriteToPreviewFilesFolder(html, assetMap) {
  if (!html || !assetMap || !assetMap.size) return html;

  const redirect = (value) => {
    if (!value || EXTERNAL_REFERENCE.test(value)) return null;
    const decoded = decodeReferenceFromHtml(value);
    if (assetMap.has(decoded)) return encodePathForHtml(assetMap.get(decoded));
    // Longest base first, scanning back from the end: a filename may contain
    // '#'/'?' of its own, so the delimiter that begins a real query or
    // fragment is not necessarily the first one in the reference —
    // "115D#J~Y.PDF#page=3" splits at the second '#', not the first. A
    // genuine query or fragment keeps its own delimiter and spelling; only
    // the path in front of it is swapped.
    for (let i = decoded.length - 1; i > 0; i--) {
      const char = decoded[i];
      if (char !== "#" && char !== "?") continue;
      const base = decoded.slice(0, i);
      if (assetMap.has(base)) {
        return encodePathForHtml(assetMap.get(base)) + decoded.slice(i).replace(/&/g, "&amp;");
      }
    }
    return null;
  };

  return html
    .replace(/(src|href)="([^"]*)"/gi, (whole, attr, value) => {
      const next = redirect(value);
      return next === null ? whole : `${attr}="${next}"`;
    })
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, quote, value) => {
      const next = redirect(value);
      return next === null ? whole : `url(${quote}${next}${quote})`;
    });
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0.00s";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)}s`;
}

function pickPreferredFile(files, ext, hints = []) {
  const byExt = files.filter((f) => f && f.type === "file" && typeof f.name === "string" && f.name.toLowerCase().endsWith(ext));
  if (!byExt.length) return null;
  for (const h of hints) {
    const found = byExt.find((f) => f.name.toLowerCase().includes(h));
    if (found) return found;
  }
  return byExt[0];
}

function preferredUploadedFile(uploadedFiles, ext, hints = []) {
  if (!uploadedFiles) return null;
  const uniqueFiles = [];
  const seen = new Set();
  uploadedFiles.forEach((file) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    uniqueFiles.push(file);
  });
  return pickPreferredFile(uniqueFiles, ext, hints);
}

function getNestedValue(obj, path) {
  let cur = obj;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[key];
  }
  return cur;
}

function pickConfigString(cfg, paths) {
  for (const p of paths) {
    const v = getNestedValue(cfg, p);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function isLikelyInlineTemplate(text) {
  return /<[a-z!/][^>]*>/i.test(text);
}

function isLikelyInlineCss(text) {
  return /[{;}]/.test(text) && /\s/.test(text);
}

function isAbsolutePathSpec(value) {
  return /^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^~\//.test(value);
}

function pathTailCandidates(value) {
  const rel = String(value || "").replace(/^~\//, "").replace(/^[A-Za-z]:[\\/]/, "").replace(/^\/+/, "").replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join("/"));
  return out;
}

function hasUploadedMatch(uploadedFiles, spec) {
  if (!uploadedFiles) return false;
  const rel = String(spec || "").replace(/^\.\//, "").replace(/^~\//, "").replace(/^[A-Za-z]:[\\/]/, "").replace(/^\/+/, "").replace(/\\/g, "/");
  const base = rel.split("/").pop();
  return !!(uploadedFiles.get(rel) || uploadedFiles.get(base));
}

// The Build panel's "Home page" and "Site domain" fields are per-crate
// choices, so when set they override whatever the template itself shipped
// for homePageId/domain — those are typically a placeholder value or
// another project's (see Language-Research-Technology/rocss-templates#3). Left blank, the
// template's own config is untouched, so a template with sensible values of
// its own still works with neither field filled in. `cfg` may be null (no
// template/config resolved at all), in which case there is nothing to
// override and null is returned unchanged.
export function applyHomePageAndDomainOverrides(cfg, options) {
  if (!cfg) return cfg;
  const overrides = {};
  if (options?.homePageId) overrides.homePageId = options.homePageId;
  if (options?.domain) overrides.domain = options.domain;
  return Object.keys(overrides).length ? { ...cfg, ...overrides } : cfg;
}

// Every template a multipage config points at: the root's, plus one per
// entity type. renderMultiPage looks these up by the exact string the config
// used (crateLite.pages[*].template and config.root.template), so they double
// as the keys of the pageTemplates map — see collectPageTemplates.
export function multipageTemplateRefs(cfg) {
  if (!cfg || cfg.multipage === false) return [];
  const refs = [];
  const rootRef = pickConfigString(cfg, ["root:template", "root.template"]);
  if (rootRef) refs.push(rootRef);
  for (const typeCfg of Object.values(cfg.types || {})) {
    const ref = typeCfg && typeof typeCfg === "object" ? typeCfg.template : null;
    if (typeof ref === "string" && ref.trim()) refs.push(ref.trim());
  }
  return [...new Set(refs)];
}

// Resolve each of those refs into template text, keyed by the ref itself.
// Keying by what the config actually wrote — rather than by where the file was
// found — is what lets a config keep working whatever path style it uses: the
// repo bundle's "templates/root-template.html", or the repo-root-relative
// paths a config copied from a CLI checkout carries.
//
// Returns null when the config isn't multipage, so callers can distinguish
// "no multipage wanted" from "multipage wanted but nothing resolved".
export async function collectPageTemplates(cfg, opts = {}) {
  const refs = multipageTemplateRefs(cfg);
  if (!refs.length) return null;

  const pageTemplates = {};
  for (const ref of refs) {
    const resolved = await resolveTemplateAsset(ref, "template", opts);
    if (resolved.text === null || resolved.text === undefined) {
      throw new Error(`Could not resolve template "${ref}" referenced by the config.`);
    }
    pageTemplates[ref] = resolved.text;
  }
  return pageTemplates;
}

function needsLocalTemplateFolder(cfg, uploadedFiles) {
  const refs = [
    pickConfigString(cfg, ["root:template", "root.template", "template", "templateFile", "templatePath", "templateUrl", "files.template", "paths.template", "assets.template"]),
    pickConfigString(cfg, ["style", "css", "styleFile", "stylePath", "styleUrl", "cssFile", "cssPath", "cssUrl", "files.style", "files.css", "paths.style", "paths.css", "assets.style", "assets.css"]),
    // Per-type templates count too: a multipage bundle whose root template was
    // uploaded but whose type templates weren't still needs the folder, and
    // without this the build would fail late instead of asking for it.
    ...multipageTemplateRefs(cfg),
  ].filter(Boolean);
  for (const v of refs) {
    if (/^https?:\/\//i.test(v)) continue;
    if (isLikelyInlineTemplate(v) || isLikelyInlineCss(v)) continue;
    if (hasUploadedMatch(uploadedFiles, v)) continue;
    return true;
  }
  return false;
}

// Local-template-folder access is separate from the picked crate folder
// (dirHandle) — the user grants it once via showDirectoryPicker, cached
// here for the rest of the session.
let uploadedConfigDirHandle = null;
export function resetUploadedConfigDirHandle() {
  uploadedConfigDirHandle = null;
}

async function ensureUploadedConfigDirectoryHandle() {
  if (uploadedConfigDirHandle) {
    const ok = await verifyPermission(uploadedConfigDirHandle, false);
    if (ok) return uploadedConfigDirHandle;
    uploadedConfigDirHandle = null;
  }
  try {
    const picked = await window.showDirectoryPicker({ mode: "read" });
    const ok = await verifyPermission(picked, false);
    if (!ok) throw new Error("Permission to read the config folder was denied.");
    uploadedConfigDirHandle = picked;
    return uploadedConfigDirHandle;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("Config folder selection was cancelled.");
    throw e;
  }
}

async function resolveTemplateAsset(spec, kind, { dirHandle = null, baseRawUrl = "", uploadedFiles = null } = {}) {
  const val = String(spec || "").trim();
  if (!val) return { text: kind === "css" ? "" : null, source: "none" };

  if (kind === "template" && isLikelyInlineTemplate(val)) return { text: val, source: "inline config" };
  if (kind === "css" && isLikelyInlineCss(val)) return { text: val, source: "inline config" };

  if (/^https?:\/\//i.test(val)) {
    const res = await fetch(bustCacheUrl(val), { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not download ${kind} from URL (${res.status} ${res.statusText}).`);
    return { text: await res.text(), source: `url (${val})` };
  }

  if (baseRawUrl) {
    const url = new URL(val.replace(/^\.\//, ""), baseRawUrl).toString();
    const res = await fetch(bustCacheUrl(url), { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not download ${kind} from config path "${val}" (${res.status} ${res.statusText}).`);
    return { text: await res.text(), source: `url (${url})` };
  }

  if (uploadedFiles) {
    const rel = val.replace(/^\.\//, "").replace(/^~\//, "").replace(/^[A-Za-z]:[\\/]/, "").replace(/^\/+/, "").replace(/\\/g, "/");
    const base = rel.split("/").pop();
    const uploaded = uploadedFiles.get(rel) || uploadedFiles.get(base);
    if (uploaded) return { text: await uploaded.text(), source: `upload (${rel})` };
  }

  if (dirHandle) {
    if (isAbsolutePathSpec(val)) {
      for (const candidate of pathTailCandidates(val)) {
        const text = await readFileTextFromDirectory(dirHandle, candidate);
        if (text !== null) return { text, source: `folder (${candidate})` };
      }
    } else {
      const rel = val.replace(/^\.\//, "");
      const text = await readFileTextFromDirectory(dirHandle, rel);
      if (text !== null) return { text, source: `folder (${rel})` };
      // The picked folder is the config's own folder, but the path may be
      // written relative to somewhere further up — a config copied out of a
      // CLI checkout says "test_data/birds/templates/x.html" for a file that
      // sits at "templates/x.html" here. Try successively shorter tails
      // rather than failing on a path that only has the wrong prefix.
      for (const candidate of pathTailCandidates(rel).slice(1)) {
        const tailText = await readFileTextFromDirectory(dirHandle, candidate);
        if (tailText !== null) return { text: tailText, source: `folder (${candidate})` };
      }
    }
  }

  throw new Error(`Could not resolve ${kind} from config value "${val}".`);
}

async function resolveTemplateBundleFromConfig(cfg, opts = {}) {
  const templateRef = pickConfigString(cfg, [
    "root:template", "root.template",
    "template", "templateFile", "templatePath", "templateUrl",
    "files.template", "paths.template", "assets.template",
  ]);
  const styleRef = pickConfigString(cfg, [
    "style", "css", "styleFile", "stylePath", "styleUrl", "cssFile", "cssPath", "cssUrl",
    "files.style", "files.css", "paths.style", "paths.css", "assets.style", "assets.css",
  ]);

  let templateResolved = templateRef ? await resolveTemplateAsset(templateRef, "template", opts) : { text: null, source: "none" };
  let styleResolved = styleRef ? await resolveTemplateAsset(styleRef, "css", opts) : { text: "", source: "none" };

  if (!templateRef && opts.uploadedFiles) {
    const uploadedTemplate = preferredUploadedFile(opts.uploadedFiles, ".html", ["template", "preview"]);
    if (uploadedTemplate) {
      templateResolved = {
        text: await uploadedTemplate.text(),
        source: `upload (${uploadedTemplate.name})`,
      };
    }
  }

  if (!styleRef && opts.uploadedFiles) {
    const uploadedStyle = preferredUploadedFile(opts.uploadedFiles, ".css", ["style", "preview"]);
    if (uploadedStyle) {
      styleResolved = {
        text: await uploadedStyle.text(),
        source: `upload (${uploadedStyle.name})`,
      };
    }
  }

  return {
    template: templateResolved.text,
    css: styleResolved.text || "",
    templateSrc: templateResolved.source,
    cssSrc: styleResolved.source,
  };
}

async function fetchTemplateBundle(owner, repo, ref, folderPath) {
  const safeFolder = String(folderPath || "").replace(/^\/+|\/+$/g, "");
  if (!safeFolder) throw new Error("No template folder selected.");

  const entries = await listGitHubFolder(owner, repo, ref, safeFolder);

  const files = entries
    .filter((e) => e && e.type === "file" && typeof e.name === "string")
    .map((e) => ({
      name: e.name,
      path: e.path || `${safeFolder}/${e.name}`,
      downloadUrl: typeof e.download_url === "string" ? e.download_url : "",
      type: "file",
    }));

  const templateFile = pickPreferredFile(files, ".html", ["template", "tabular", "preview", "index"]);
  const configFile = pickPreferredFile(files, ".json", ["config", "preview"]);
  const styleFile = pickPreferredFile(files, ".css", ["style", "preview", "default"]);

  const template = templateFile
    ? await fetchGitHubTextFile(owner, repo, ref, templateFile.path, templateFile.downloadUrl)
    : null;
  const configText = configFile
    ? await fetchGitHubTextFile(owner, repo, ref, configFile.path, configFile.downloadUrl)
    : null;
  const css = styleFile
    ? await fetchGitHubTextFile(owner, repo, ref, styleFile.path, styleFile.downloadUrl)
    : "";

  let config = null;
  if (configText !== null) {
    try { config = JSON.parse(configText); }
    catch (e) { throw new Error(`Template config ${configFile.name} is not valid JSON: ${e.message}`); }
  }

  // Multipage bundles (see rocss-templates' README) keep their per-role
  // templates in a templates/ subfolder, referenced from config.json as
  // e.g. "templates/root-template.html" — a path relative to this folder.
  // Fetch every .html file there, keyed by that same relative path, so
  // crateToMultiPageHtml's pageTemplates lookup can resolve them directly.
  const pageTemplates = {};
  const templatesSubfolder = entries.find((e) => e && e.type === "dir" && e.name === "templates");
  if (templatesSubfolder) {
    const subEntries = await listGitHubFolder(owner, repo, ref, `${safeFolder}/templates`);
    const subHtmlFiles = subEntries.filter((e) => e && e.type === "file" && /\.html?$/i.test(e.name || ""));
    for (const entry of subHtmlFiles) {
      const text = await fetchGitHubTextFile(owner, repo, ref, entry.path, entry.download_url || "");
      pageTemplates[`templates/${entry.name}`] = text;
    }
  }

  return {
    template,
    config,
    css,
    pageTemplates,
    files: {
      template: templateFile ? templateFile.name : null,
      config: configFile ? configFile.name : null,
      style: styleFile ? styleFile.name : null,
    },
    source: buildGitHubTreeUrl(owner, repo, ref, safeFolder),
  };
}

const plugin = {
  name: "ro-crate-html-output",
  outputPaths: [
    { path: HTML_FILE, kind: "file" },
    { path: MULTIPAGE_DIR, kind: "dir" },
    { path: PREVIEW_FILES_DIR, kind: "dir" },
  ],
  optionSchema: {
    key: "makeHtml", label: "Generate ro-crate-preview.html", default: true,
    children: [
      { key: "collectionLabelsBuilder", type: "collectionLabelsBuilder", label: "Set menu names and order…",
        hint: "Optional, for Structured Word documents mode. Drag rows to reorder. Map each top-level collection folder to a friendlier label shown in the site's navigation menu and cards (e.g. AnmWeb1_HOME → Home) — the raw folder name is used for anything left blank. Affects only this generated HTML, not ro-crate-metadata.json/.xlsx." },
      { key: "templateRepoFolder", type: "select", label: "Template from rocss-templates",
        placeholder: "Loading folders…", hint: "Optional. Select one folder from the template repo." },
      { key: "homePageId", type: "select", label: "Home page",
        placeholder: "No home page — show the collection index",
        hint: "Optional. Pick one of your top-level folders to use as the landing page, instead of the index of collections. Populated from the folder you picked." },
      { key: "domain", type: "text", label: "Site domain",
        placeholder: "https://example.org/my-site",
        hint: "Optional. The hostname this site will be published under, used to build absolute preview-card (Open Graph) image and link URLs. Leave blank to skip those tags." },
      { key: "publishOnly", label: "Publish subset only", default: false,
        hint: "Off = every collection/object/file appears. On = an entity only appears if it has custom:publish:true set, or sits inside a collection/object that has custom:publish:true (an entity's own custom:publish:false always wins over an inherited true) — typically a File-level column in the source spreadsheet. The files that remain are also copied into ro-crate-preview-files/, with this generated HTML's own links updated to point there, so publishing just the generated preview plus that folder never exposes a file that was filtered out. Affects only this generated HTML, not ro-crate-metadata.json/.xlsx." },
      { key: "styledPreview", label: "Upload template files", default: false,
        hint: "Off = the library's plain preview.", children: [
        { key: "configFile", type: "file", folder: true, label: "Config (JSON)", accept: ".json,.css,.html,application/json,text/css,text/html",
          hint: "Required. If config uses relative paths, use \"Choose folder\" (or drag the whole folder in) to keep subfolders intact — picking loose files individually flattens them and can break relative paths." },
      ] },
    ],
  },
  hooks: {
    "crate:write": {
      priority: 40,
      weight: 5,
      activeWhen: (ctx) => !!ctx.options.makeHtml,
      handler: async (ctx) => {
        const { dirHandle, options, crate, log } = ctx;
        const previewStartMs = Date.now();
        let assetResolveMs = 0;
        let renderMs = 0;
        let pageWriteMs = 0;
        if (!options.makeHtml) return;
        if (!(options.overwrite || !(await fileExists(dirHandle, HTML_FILE)))) {
          log(`${HTML_FILE} exists and overwrite is off — skipped.`, "warn");
          return;
        }
        // Bracketing the whole tap: a single-page preview reports nothing in
        // between and just crosses its slice, while the multipage branch below
        // reports per page and so raises the secondary bar for the part of a
        // build most likely to sit there for a while.
        const progress = progressFor(ctx);
        progress.start("Building the HTML preview…");
        let publishFileAssetMap = null;
        try {
          if (options.publishOnly) {
            filterCrateToPublished(crate, log);
            publishFileAssetMap = await copyPublishedFilesToPreviewFolder(crate, dirHandle, log);
          }
          applyCollectionLabelOverrides(crate, options);
          // resolveTerm() (used below to place profile-declared property
          // names) needs the context resolved first — crateToPreviewHtml/
          // crateToMultiPageHtml also call this themselves, but only after
          // the layout has already been computed; safe/idempotent to call twice.
          await crate.resolveContext();
          const profilePropertyGroups = ctx.selectedProfileData?.workflow?.propertyGroups;
          const layout = resolveProfileGroups(crate, profilePropertyGroups);
          if (layout.length) {
            log(`Preview: profile layout applied (${layout.length} group(s): ${layout.map((g) => g.name).join(", ")}).`, "muted");
          } else if (ctx.selectedProfileData) {
            log("Preview: active profile loaded, but no property groups resolved to render the plain preview. Check that the profile's workflow.propertyGroups entries resolve against the built crate context.", "warn");
          } else {
            throw new Error(
              "HTML preview requires an active profile with resolved propertyGroups. " +
              "No profile was loaded for this build, so no preview layout could be resolved. " +
              "Select a profile or re-run the build with a profile in effect."
            );
          }

          let html;
          const selectedFolder = (options.templateRepoFolder || "").trim();
          const repoSelected = !!selectedFolder;
          let pageTemplates = null;
          let pageTemplatesSrc = "none";
          if (options.styledPreview || repoSelected) {
            // Precedence for template/config/style: repo folder → uploaded file → local folder.
            let template = null, templateSrc = "none";
            let cfg = null, cfgSrc = "none";
            let css = "", cssSrc = "none";
            const assetResolveStartMs = Date.now();

            if (repoSelected) {
              const remote = await fetchTemplateBundle(TEMPLATE_REPO_OWNER, TEMPLATE_REPO_NAME, TEMPLATE_REPO_REF, selectedFolder);
              template = remote.template;
              cfg = remote.config;
              css = remote.css;
              if (remote.pageTemplates && Object.keys(remote.pageTemplates).length > 0) {
                pageTemplates = remote.pageTemplates;
                pageTemplatesSrc = `repo (${selectedFolder})`;
              }
              const base = `repo (${selectedFolder})`;
              templateSrc = remote.files.template ? `${base}/${remote.files.template}` : `${base}; no template found`;
              cfgSrc = remote.files.config ? `${base}/${remote.files.config}` : "none";
              cssSrc = remote.files.style ? `${base}/${remote.files.style}` : "none";
            }

            if (options.styledPreview && options.configUpload) {
              const cfgText = await options.configUpload.file.text();
              try { cfg = JSON.parse(cfgText); }
              catch (e) { throw new Error(`uploaded config "${options.configUpload.name}" is not valid JSON: ${e.message}`); }
              cfgSrc = `uploaded (${options.configUpload.name})`;
            } else if (!repoSelected) {
              const folderCfg = await readJsonFromFolder(dirHandle, "preview-config.json");
              if (folderCfg) { cfg = folderCfg; cfgSrc = "preview-config.json from folder"; }
            }

            if (options.styledPreview && cfg) {
              const uploadedFiles = options.configUpload?.siblingFiles || null;
              let configDirHandle = null;
              if (needsLocalTemplateFolder(cfg, uploadedFiles)) {
                configDirHandle = await ensureUploadedConfigDirectoryHandle();
              }
              const assetOpts = { uploadedFiles, dirHandle: configDirHandle };
              const resolved = await resolveTemplateBundleFromConfig(cfg, assetOpts);
              if (resolved.template) { template = resolved.template; templateSrc = resolved.templateSrc; }
              if (resolved.css) { css = resolved.css; cssSrc = resolved.cssSrc; }

              // A local config gets its own template map, resolved from the same
              // uploaded files or picked folder. Without this the repo bundle was
              // the only way to build multipage, which made developing a
              // multipage template locally impossible — the build silently fell
              // through to a single page whose entity links pointed at pages it
              // never wrote.
              const localPageTemplates = await collectPageTemplates(cfg, assetOpts);
              if (localPageTemplates) {
                pageTemplates = localPageTemplates;
                pageTemplatesSrc = configDirHandle ? "picked folder" : "uploaded files";
              }
            }
            assetResolveMs = Date.now() - assetResolveStartMs;
            // A template's own config.json-declared propertyGroups (the most
            // specific, deliberate customization) still wins over the
            // profile's — the profile only fills in when the template didn't
            // set its own.
            const cfgHasOwnGroups = !!(cfg && Array.isArray(cfg.propertyGroups) && cfg.propertyGroups.length);
            const baseCfg = cfg && !cfgHasOwnGroups ? { ...cfg, propertyGroups: layout } : cfg;
            const effectiveCfg = applyHomePageAndDomainOverrides(baseCfg, options);

            // The repo's templates are keyed to the repo's own config, so they
            // can't be paired with a config from somewhere else — but an
            // uploaded config that brought its own templates has just replaced
            // pageTemplates with a matching set, and that pairing is fine.
            const uploadedConfigWithRepoTemplates =
              !!options.configUpload && pageTemplatesSrc.startsWith("repo (");
            if (uploadedConfigWithRepoTemplates && cfg && cfg.multipage !== false) {
              log(`Uploaded config asks for a multipage build but brought no templates, and the ${selectedFolder} repo folder's templates belong to its own config — falling back to a single page. Upload the templates alongside the config, or clear the repo folder.`, "warn");
            }

            if (pageTemplates && !uploadedConfigWithRepoTemplates && cfg && cfg.multipage !== false) {
              log(`Preview: multipage · templates ${pageTemplatesSrc} · config ${cfgSrc}.`, "muted");
              const multipageRenderStartMs = Date.now();
              const templateCount = Object.keys(pageTemplates).length;
              log(`Preview: rendering multipage site (${templateCount} template file(s))…`, "muted");
              const multi = await crateToMultiPageHtml(crate, { config: effectiveCfg, css, pageTemplates });
              const renderDoneMs = Date.now();
              renderMs = renderDoneMs - multipageRenderStartMs;
              log(`Preview: rendered root + ${multi.pages.length} page(s) in ${formatDurationMs(renderDoneMs - multipageRenderStartMs)}. Writing pages…`, "muted");

              const writeStartMs = Date.now();
              // A stale page from a previous build (e.g. one belonging to a
              // collection that no longer exists) would otherwise never get
              // cleaned up, since pages are written by path rather than the
              // whole directory being regenerated — wipe it first so the
              // folder always reflects exactly this build's output.
              try {
                await dirHandle.removeEntry(MULTIPAGE_DIR, { recursive: true });
              } catch {
                // no pre-existing ro-crate-preview_html/ to remove — fine.
              }
              const totalPages = multi.pages.length;
              // Every page reports now. The old code only logged on every 10th
              // or 25th page because each line cost a row in the transcript; a
              // bar position costs nothing, so the throttle went with it.
              const tick = countedProgress(ctx, totalPages, `Writing ${totalPages} preview page(s)…`);
              for (let i = 0; i < multi.pages.length; i += 1) {
                const page = multi.pages[i];
                const pageHtml = publishFileAssetMap && publishFileAssetMap.size
                  ? rewriteToPreviewFilesFolder(page.html, publishFileAssetMap)
                  : page.html;
                await writeFileAtPath(dirHandle, page.path, pageHtml);
                tick(i, `Preview: wrote ${i + 1}/${totalPages} page file(s)…`);
              }
              tick.done();
              pageWriteMs = Date.now() - writeStartMs;
              log(`Wrote ${multi.pages.length} page(s) under ro-crate-preview_html/ in ${formatDurationMs(Date.now() - writeStartMs)}.`, "ok");
              html = multi.rootHtml;
              ctx.lastHtmlTemplate = null;
            } else if (template) {
              log(`Preview: styled tabular · template ${templateSrc} · config ${cfgSrc} · style ${cssSrc}.`, "muted");
              const styledRenderStartMs = Date.now();
              html = await crateToPreviewHtml(crate, { template, config: effectiveCfg, css });
              renderMs = Date.now() - styledRenderStartMs;
              ctx.lastHtmlTemplate = { template, config: effectiveCfg, css, source: templateSrc };
            } else {
              log("Preview: plain (library default template; no custom template file provided).", "muted");
              const plainRenderStartMs = Date.now();
              html = await crateToPreviewHtml(crate, { layouts: { default: layout } });
              renderMs = Date.now() - plainRenderStartMs;
              ctx.lastHtmlTemplate = null;
            }
          } else {
            log("Preview: plain (library default template).", "muted");
            const plainRenderStartMs = Date.now();
            html = await crateToPreviewHtml(crate, { layouts: { default: layout } });
            renderMs = Date.now() - plainRenderStartMs;
            ctx.lastHtmlTemplate = null;
          }
          if (publishFileAssetMap && publishFileAssetMap.size) {
            html = rewriteToPreviewFilesFolder(html, publishFileAssetMap);
          }
          await writeFile(dirHandle, HTML_FILE, html);
          log(`Wrote ${HTML_FILE}.`, "ok");
          const totalPreviewMs = Date.now() - previewStartMs;
          log(
            `Preview summary: total ${formatDurationMs(totalPreviewMs)} (assets ${formatDurationMs(assetResolveMs)}, render ${formatDurationMs(renderMs)}, page writes ${formatDurationMs(pageWriteMs)}).`,
            "muted"
          );
          ctx.buildHtml = html;
        } catch (e) {
          log(`HTML preview failed: ${e.message}`, "err");
        } finally {
          progress.done();
        }
      },
    },
  },
};
