// CORE — crate assembly, serialisation and entity editing.
//
// Isomorphic (SPEC.md §6.1/§9.1): this module imports only browser-safe
// entry points, takes plain data in and returns strings/bytes out. It never
// touches the File System Access API or the DOM, which is what lets the
// whole of it run unmodified under Node for tests/*.mjs and in the browser
// for real work. Anything that needs a directory handle lives in
// fs_helpers.js instead; anything that needs a profile lives in masp.js.

import { ROCrate } from "ro-crate";

// ---------------------------------------------------------------------------
// Names the folder scan must never treat as corpus content
// ---------------------------------------------------------------------------

// What a build of this tool writes itself. Plugins declare their own via
// outputPaths (SPEC.md §4.6); these are the core's, which no plugin owns.
export const GENERATED_FILENAMES = new Set([
  "ro-crate-metadata.json",
  "ro-crate-metadata.xlsx",
  "ro-crate-preview.html",
  "ro-crate-preview_html",
  "ro-crate-preview_files",
]);

// Input files that configure a build rather than belong to the collection.
// Scanning these in would describe the tool's own paperwork as content.
export const CONTROL_FILENAMES = new Set([
  "additional-ro-crate-metadata.xlsx",
  "merge-config.json",
  "crate2tables-config.json",
  "_backups",
  ".DS_Store",
  ".git",
  "node_modules",
]);

export const BACKUP_DIR = "_backups";

// The four vocabularies this tool emits (SPEC.md §6.1). All four are prefix
// definitions rather than remote context URLs, so resolveContext() never
// makes a network request — a build has to work offline (SPEC.md §5.1).
export const CRATE_CONTEXT = Object.freeze({
  ldac: "https://w3id.org/ldac/terms#",
  pcdm: "http://pcdm.org/models#",
  custom: "arcp://name,custom/terms#",
  AUSTLANG: "https://collection.aiatsis.gov.au/austlang/language/",
});

// Entities whose @id encodes their place in the crate. The editor locks
// these (SPEC.md §6.3) and buildCrate mints them rather than a user.
export const STRUCTURAL_TYPES = new Set([
  "File",
  "Dataset",
  "RepositoryObject",
  "RepositoryCollection",
]);

const ARCP_PREFIX = "arcp://name,corpus/";

// ---------------------------------------------------------------------------
// File metadata
// ---------------------------------------------------------------------------

function basename(path) {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

// Normalise a filename for duplicate detection: lowercase, drop the
// extension, strip "copy"/"duplicate" markers and "(2)"-style suffixes, then
// collapse everything non-alphanumeric. "Report (2).docx", "report copy.docx"
// and "REPORT.docx" all land on "report".
export function normaliseForDuplicates(fileName) {
  let base = basename(String(fileName || ""));
  const dot = base.lastIndexOf(".");
  if (dot > 0) base = base.slice(0, dot);
  return base
    .toLowerCase()
    .replace(/[\s_-]*\((?:\d+)\)\s*$/g, "")
    .replace(/[\s_-]*(?:copy|duplicate)(?:\s*\d+)?\s*$/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Derive each file's crate identity from a flat scan result.
 *
 * @param {Array<{name: string, relativePath: string, handle?: any, size?: number, lastModified?: number}>} files
 * @returns {Array<object>} one entry per file, cross-linked by possibleDuplicates
 */
export function buildFileMetadata(files) {
  const out = (files || []).map((f) => {
    const relativePath = String(f.relativePath || f.name || "");
    const parts = relativePath.split("/").filter(Boolean);
    const fileName = parts.length ? parts[parts.length - 1] : relativePath;
    const folderChain = parts.slice(0, -1);
    return {
      // @id is the relative path — the crate's link back to disk.
      id: relativePath,
      relativePath,
      fileName,
      name: fileName,
      folderChain,
      topLevel: folderChain.length ? folderChain[0] : "",
      handle: f.handle,
      size: f.size,
      lastModified: f.lastModified,
      possibleDuplicates: [],
    };
  });

  // Cross-link collisions both ways, so either file leads a reader to the other.
  const byKey = new Map();
  for (const entry of out) {
    const key = normaliseForDuplicates(entry.fileName);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      entry.possibleDuplicates = group.filter((o) => o !== entry).map((o) => o.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Graph assembly
// ---------------------------------------------------------------------------

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function refId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") return value["@id"] || null;
  return null;
}

/**
 * An ROCrate from already-parsed crate JSON.
 *
 * For reading a folder's existing crate outside a build — roctable's
 * "Configure tables…" inspects one to work out which types could become
 * tables, without waiting for a build to produce ctx.crate.
 */
export function loadCrateFromJson(json) {
  return new ROCrate(json, { array: true, link: true });
}

/** Look one entity up in a crate by @id, returning the live (mutable) proxy. */
export function graphEntityById(crate, id) {
  if (!crate || !id) return null;
  return crate.getEntity(id) || null;
}

/**
 * Assemble the RO-Crate graph.
 *
 * @param {Array<object>} filesWithMeta  buildFileMetadata() output
 * @param {object} config                profile-derived config (SPEC.md §5.2)
 * @param {function} log                 ctx.log
 * @param {object} [opts]
 * @param {"object"|"collection"} [opts.topLevelFolderType]
 * @param {boolean} [opts.structureFromMetadata]  supplied metadata already says
 *   what belongs to what, so don't invent a parallel folder structure
 * @param {object} [opts.existingJson]   the folder's current crate, reconciled
 *   against rather than replaced
 * @returns {ROCrate}
 */
export function buildCrate(filesWithMeta, config, log = () => {}, opts = {}) {
  const {
    topLevelFolderType = "object",
    structureFromMetadata = false,
    existingJson = null,
  } = opts || {};
  const cfg = config || {};

  const crate = existingJson
    ? new ROCrate(existingJson, { array: true, link: true })
    : new ROCrate({ array: true, link: true });
  crate.addContext(CRATE_CONTEXT);

  applyRootDataset(crate, cfg, log);
  applyMetadataLicence(crate, cfg);

  const fileProperties = cfg.fileProperties || {};
  const filePropertyKeys = Object.keys(fileProperties).filter((k) => k !== "custom:possibleDuplicate");
  const wantsDuplicateFlag = Object.prototype.hasOwnProperty.call(fileProperties, "custom:possibleDuplicate");

  const files = filesWithMeta || [];

  if (structureFromMetadata) {
    log("Structure comes from supplied metadata — not emitting folder entities.", "muted");
  }

  const folderIds = structureFromMetadata
    ? new Map()
    : emitFolderEntities(crate, files, topLevelFolderType, log);

  let added = 0;
  let anyDuplicates = false;
  for (const file of files) {
    const existing = crate.getEntity(file.id);
    const entity = existing || { "@id": file.id, "@type": "File" };
    entity.name = entity.name?.length ? entity.name : file.fileName;

    // Blank-initialise every property the profile declared, so a person
    // filling the spreadsheet in sees the column even when it is empty.
    for (const key of filePropertyKeys) {
      if (entity[key] === undefined) entity[key] = "";
    }
    // The one conditional property: written only where duplicates were
    // actually found, and only if the profile asked for it.
    if (wantsDuplicateFlag && file.possibleDuplicates.length) {
      entity["custom:possibleDuplicate"] = file.possibleDuplicates;
      anyDuplicates = true;
    }

    if (!existing) {
      crate.addEntity(entity);
      added++;
    } else {
      for (const [k, v] of Object.entries(entity)) {
        if (k === "@id" || k === "@type") continue;
        existing[k] = v;
      }
    }

    const parentId = structureFromMetadata ? null : folderIds.get(file.folderChain.join("/")) || null;
    linkFileToParent(crate, file.id, parentId);
  }

  // Property definitions only exist in the graph if something uses them.
  for (const key of Object.keys(fileProperties)) {
    if (key === "custom:possibleDuplicate" && !anyDuplicates) continue;
    const definition = fileProperties[key];
    if (definition && definition["@id"]) crate.addEntity(definition);
  }

  log(`Crate assembled: ${added} new file entity(ies), ${crate.getGraph().length} entity(ies) total.`, "ok");

  rewriteStructuralIds(crate);
  return crate;
}

function applyRootDataset(crate, cfg, log) {
  const root = crate.rootDataset;
  const declared = cfg.rootDataset || {};
  const types = asArray(declared.type);
  if (types.length) root["@type"] = types;
  for (const [key, value] of Object.entries(declared)) {
    if (key === "type") continue;
    if (value === undefined || value === null || value === "") continue;
    root[key] = Array.isArray(value) ? value : [value];
  }
  if (!root.name?.length) root.name = ["Untitled collection"];
  if (declared.conformsTo) {
    log(`Root dataset conforms to ${refId(asArray(declared.conformsTo)[0])}.`, "muted");
  }
}

function applyMetadataLicence(crate, cfg) {
  if (!cfg.metadataLicence) return;
  const descriptor = crate.metadataFileEntity || crate.getEntity("ro-crate-metadata.json");
  if (descriptor) descriptor.license = [cfg.metadataLicence];
}

// Top-level folders become either one RepositoryObject each, or a
// RepositoryCollection with a child RepositoryObject per subfolder plus a
// synthesised <Name>_Files object for the loose files (SPEC.md §6.1).
// Returns folderPath -> entity @id for every folder that got an entity.
function emitFolderEntities(crate, files, mode, log) {
  const ids = new Map();
  const topLevels = new Map();
  for (const file of files) {
    if (!file.folderChain.length) continue;
    const top = file.folderChain[0];
    if (!topLevels.has(top)) topLevels.set(top, []);
    topLevels.get(top).push(file);
  }

  for (const [top, members] of topLevels) {
    const topId = `#${top}`;
    if (mode === "collection") {
      crate.addEntity({ "@id": topId, "@type": "RepositoryCollection", name: top });
      ids.set(top, topId);
      addToRoot(crate, topId);

      const subfolders = new Set();
      let hasLooseFiles = false;
      for (const file of members) {
        if (file.folderChain.length > 1) subfolders.add(file.folderChain.slice(0, 2).join("/"));
        else hasLooseFiles = true;
      }
      for (const path of subfolders) {
        const childName = path.split("/")[1];
        const childId = `#${path.replace(/\//g, "_")}`;
        crate.addEntity({
          "@id": childId,
          "@type": "RepositoryObject",
          name: childName,
          "pcdm:memberOf": { "@id": topId },
        });
        ids.set(path, childId);
        pushRef(crate, topId, "pcdm:hasMember", childId);
        // Deeper folders belong to their top-level-most object, not to a
        // chain of one entity per directory level.
        for (const file of members) {
          if (file.folderChain.length > 2 && file.folderChain.slice(0, 2).join("/") === path) {
            ids.set(file.folderChain.join("/"), childId);
          }
        }
      }
      if (hasLooseFiles) {
        const filesId = `#${top}_Files`;
        crate.addEntity({
          "@id": filesId,
          "@type": "RepositoryObject",
          name: `${top}_Files`,
          "pcdm:memberOf": { "@id": topId },
        });
        ids.set(top, filesId);
        pushRef(crate, topId, "pcdm:hasMember", filesId);
      }
    } else {
      crate.addEntity({ "@id": topId, "@type": "RepositoryObject", name: top });
      ids.set(top, topId);
      addToRoot(crate, topId);
      // Every file beneath a top-level folder hangs off that one object.
      for (const file of members) ids.set(file.folderChain.join("/"), topId);
    }
  }

  log(`Emitted ${topLevels.size} top-level folder entity(ies) in ${mode} mode.`, "muted");
  return ids;
}

function addToRoot(crate, id) {
  pushRef(crate, crate.rootId, "hasPart", id);
}

function pushRef(crate, ownerId, property, targetId) {
  const owner = crate.getEntity(ownerId);
  if (!owner) return;
  const current = asArray(owner[property]).map(refId).filter(Boolean);
  if (current.includes(targetId)) return;
  owner[property] = [...asArray(owner[property]), { "@id": targetId }];
}

function linkFileToParent(crate, fileId, parentId) {
  if (parentId) {
    pushRef(crate, parentId, "hasPart", fileId);
    const file = crate.getEntity(fileId);
    if (file) file.isPartOf = [{ "@id": parentId }];
  } else {
    addToRoot(crate, fileId);
  }
}

// Structural hash ids (#Dyirbal) are fine inside the graph but are not
// absolute, so they are rewritten to arcp:// form (SPEC.md §14) before the
// crate leaves this module.
export function rewriteStructuralIds(crate) {
  const renames = [];
  for (const entity of crate.getGraph()) {
    const id = entity["@id"];
    if (typeof id !== "string" || !id.startsWith("#")) continue;
    const types = asArray(entity["@type"]);
    if (!types.some((t) => t === "RepositoryObject" || t === "RepositoryCollection")) continue;
    renames.push([id, `${ARCP_PREFIX}${id.slice(1)}`]);
  }
  for (const [from, to] of renames) {
    if (crate.getEntity(to)) continue;
    crate.updateEntityId(from, to);
  }
  return renames.length;
}

/** Count entities by @type — the build log's one-line shape summary. */
export function collectTypeCounts(graph) {
  const counts = {};
  for (const entity of graph || []) {
    for (const type of asArray(entity["@type"])) {
      const key = String(type);
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Attach AUSTLANG matches to their files. Called by the austlang plugin at
 * crate:build with the Map its matcher produced at files:prepare.
 * @returns {number} how many distinct languages were added
 */
export function addLanguageEntities(crate, filesWithMeta, langById) {
  if (!crate || !langById) return 0;
  const seen = new Set();
  for (const file of filesWithMeta || []) {
    const hit = langById.get ? langById.get(file.id) : langById[file.id];
    const languages = hit?.matchedLanguages || [];
    if (!languages.length) continue;
    const entity = crate.getEntity(file.id);
    if (!entity) continue;
    for (const language of languages) {
      const id = language["@id"];
      if (!id) continue;
      if (!crate.getEntity(id)) crate.addEntity({ "@type": "Language", ...language });
      seen.add(id);
      pushRef(crate, file.id, "ldac:subjectLanguage", id);
    }
  }
  return seen.size;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function crateToJsonString(crate) {
  return JSON.stringify(crate.toJSON(), null, 2);
}

export async function crateToXlsxBytes(crate) {
  // The package's "main" pulls in Node-only code; lib/workbook.js is the
  // browser-clean entry (see collection2crate-plugins' xlsx-crate-input for the same note).
  const { default: Workbook } = await import("ro-crate-excel/lib/workbook.js");
  const workbook = new Workbook({ crate });
  await workbook.crateToWorkbook();
  const buffer = await workbook.workbook.xlsx.writeBuffer();
  return buffer;
}

// No layout fallback (SPEC.md §6.1): without property groups the library
// fetches a default layout from GitHub at render time, which is fragile,
// CORS-blocked, and silently hides a profile misconfiguration. Throw instead.
function requireGroups(propertyGroups, fnName, where) {
  const groups = Array.isArray(propertyGroups) ? propertyGroups : [];
  if (!groups.length) {
    throw new Error(
      `${fnName}: no property groups supplied (${where}). A profile must provide propertyGroups; ` +
      "rendering without them would fetch a default layout from GitHub at render time."
    );
  }
  return groups;
}

// Hrefs the renderer percent-encodes back to real path separators, so a
// preview's links to files in sub-folders resolve on disk.
function fixEncodedSlashes(html) {
  return String(html).replace(/href="([^"#][^"]*)"/g, (match, href) =>
    href.includes("%2F") ? `href="${href.replace(/%2F/g, "/")}"` : match
  );
}

function contextPrefixMap(crate) {
  const out = new Map();
  const ctx = crate.getJson()["@context"];
  const collect = (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value !== "string") continue;
      if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(key)) continue;
      if (!/^(https?:|urn:|arcp:)/i.test(value)) continue;
      out.set(key, value);
    }
  };
  if (Array.isArray(ctx)) ctx.forEach(collect);
  else collect(ctx);
  return out;
}

// Some merges write compact predicates (e.g. "dc:format"); the tabular
// renderer often resolves by full URI. Mirror compact keys to full URI keys so
// rendering finds values regardless of key form.
function expandCompactPropertiesForRender(crate) {
  const prefixes = contextPrefixMap(crate);
  if (!prefixes.size) return;
  for (const entity of crate.graph) {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) continue;
    for (const key of Object.keys(entity)) {
      if (!key || key.startsWith("@") || key.includes("://")) continue;
      const i = key.indexOf(":");
      if (i <= 0) continue;
      const base = prefixes.get(key.slice(0, i));
      const local = key.slice(i + 1);
      if (!base || !local) continue;
      const full = `${base}${local}`;
      if (entity[full] === undefined) entity[full] = entity[key];
    }
  }
}

/**
 * Render one preview page.
 *
 * Takes an options bag, which is the contract collection2crate-plugins'
 * ro-crate-html-output calls with — two shapes, one function:
 *
 *   { layouts: { default: groups } }        the library's plain preview
 *   { template, config, css }               a rocss-templates styled preview,
 *                                           whose layout rides in
 *                                           config.propertyGroups
 *
 * resolveContext() must run before either: roCrateToJSON's term resolution
 * depends on it, and without it property lookups miss depending on internal
 * resolution timing — which shows up as some entities rendering their
 * properties and others not, apparently at random.
 */
export async function crateToPreviewHtml(crate, opts = {}) {
  const { layouts = null, template = null, config = null, css = "", getMdContent } = opts;
  const { renderSinglePage, renderTemplate, roCrateToJSON } = await import("ro-crate-static-site");

  await crate.resolveContext();
  expandCompactPropertiesForRender(crate);

  if (template) {
    const cfg = config || {};
    const layout = requireGroups(cfg.propertyGroups, "crateToPreviewHtml", "config.propertyGroups");
    // multipage: false for this call whatever the config says — we are
    // rendering one page, and roCrateToJSON's multipage pass would otherwise
    // reach for cfg.root.template and die on "Cannot read properties of
    // undefined". The multipage build has its own function below.
    const data = await roCrateToJSON(crate, { ...cfg, multipage: false }, layout);
    data.cratePath = "";
    data.layout = layout;
    data.hasLayout = true;
    return fixEncodedSlashes(
      await renderTemplate({ data, template, config: { ...cfg, propertyGroups: layout }, css, layout, getMdContent })
    );
  }

  const layout = requireGroups(layouts?.default, "crateToPreviewHtml", "opts.layouts.default");
  return fixEncodedSlashes(
    await renderSinglePage({ crate, getMdContent, layouts: { default: layout }, layout })
  );
}

/**
 * Render a whole multipage site: a root page plus one page per entity the
 * template's config.types matches. `pageTemplates` maps the template-path
 * strings in config.root.template / config.types.<Type>.template to their
 * already-fetched text — the plugin fetches those, this only renders.
 *
 * Returns { rootHtml, pages: [{ id, path, html }] }, every page through the
 * same href fixup as the single-page preview.
 */
export async function crateToMultiPageHtml(crate, { config = null, css = "", pageTemplates = {} } = {}) {
  const { renderMultiPage, roCrateToJSON } = await import("ro-crate-static-site");

  await crate.resolveContext();
  expandCompactPropertiesForRender(crate);

  const cfg = config || {};
  const layout = requireGroups(cfg.propertyGroups, "crateToMultiPageHtml", "config.propertyGroups");
  const crateLite = {
    ...(await roCrateToJSON(crate, cfg, layout)),
    cratePath: "",
    hasLayout: true,
    layout,
  };
  const { rootHtml, pages } = await renderMultiPage(crateLite, cfg, css, { pageTemplates });
  return {
    rootHtml: fixEncodedSlashes(rootHtml),
    pages: (pages || []).map((page) => ({ ...page, html: fixEncodedSlashes(page.html) })),
  };
}


// ---------------------------------------------------------------------------
// Entity editing (SPEC.md §6.3) — isomorphic so tests/test-edit-crate.mjs
// can drive the same code the Edit view does.
// ---------------------------------------------------------------------------

export function isStructuralEntity(crate, id) {
  if (!crate) return false;
  if (id === crate.rootId) return true;
  const descriptorId = crate.metadataFileEntity?.["@id"];
  if (descriptorId && id === descriptorId) return true;
  const entity = crate.getEntity(id);
  if (!entity) return false;
  return asArray(entity["@type"]).some((t) => STRUCTURAL_TYPES.has(String(t)));
}

export function listEntities(crate, { type = "", text = "" } = {}) {
  const needle = String(text || "").trim().toLowerCase();
  return crate.getGraph().filter((entity) => {
    if (type && !asArray(entity["@type"]).map(String).includes(type)) return false;
    if (!needle) return true;
    return entityHaystack(entity).includes(needle);
  });
}

// Only the entity's OWN values. A crate opened with link:true resolves
// references into the referenced entity, so serialising an entity whole would
// make a search for "Alex" also match every entity that merely links to Alex —
// which is not what a person filtering a list means.
function entityHaystack(entity) {
  const parts = [entity["@id"], ...asArray(entity["@type"])];
  for (const [key, value] of Object.entries(entity)) {
    if (key === "@id" || key === "@type") continue;
    parts.push(key);
    for (const item of asArray(value)) {
      parts.push(item && typeof item === "object" ? item["@id"] || "" : String(item));
    }
  }
  return parts.join(" ").toLowerCase();
}

export function setEntityProperty(crate, id, property, values) {
  const entity = crate.getEntity(id);
  if (!entity) throw new Error(`No entity with @id "${id}".`);
  if (property === "@id") throw new Error("Use renameEntityId() to change an @id.");
  entity[property] = asArray(values);
  return entity;
}

export function deleteEntityProperty(crate, id, property) {
  const entity = crate.getEntity(id);
  if (!entity) throw new Error(`No entity with @id "${id}".`);
  if (property === "@id" || property === "@type") {
    throw new Error(`"${property}" cannot be deleted from an entity.`);
  }
  delete entity[property];
  return entity;
}

export function addEntity(crate, entity) {
  const id = entity?.["@id"];
  if (!id) throw new Error("A new entity needs an @id.");
  if (crate.getEntity(id)) throw new Error(`An entity with @id "${id}" already exists.`);
  crate.addEntity({ "@type": "Thing", ...entity });
  return crate.getEntity(id);
}

/**
 * Rename an @id, following every reference to it.
 * Structural ids are refused: renaming one breaks the crate's mapping to disk.
 */
export function renameEntityId(crate, oldId, newId) {
  if (!crate.getEntity(oldId)) throw new Error(`No entity with @id "${oldId}".`);
  if (oldId === newId) return crate.getEntity(oldId);
  if (crate.getEntity(newId)) throw new Error(`An entity with @id "${newId}" already exists.`);
  if (isStructuralEntity(crate, oldId)) {
    throw new Error(`"${oldId}" is a structural entity — its @id is locked to its place in the crate.`);
  }
  crate.updateEntityId(oldId, newId);
  retargetReferences(crate, oldId, newId);
  return crate.getEntity(newId);
}

/** Delete an entity and every dangling reference left pointing at it. */
export function deleteEntity(crate, id) {
  if (!crate.getEntity(id)) throw new Error(`No entity with @id "${id}".`);
  if (id === crate.rootId) throw new Error("The root dataset cannot be deleted.");
  crate.deleteEntity(id);
  retargetReferences(crate, id, null);
  return crate;
}

// Walk every property of every entity, rewriting (newId) or dropping (null)
// references to oldId. A property left with no values at all is removed
// rather than kept as an empty array.
function retargetReferences(crate, oldId, newId) {
  for (const entity of crate.getGraph()) {
    for (const property of Object.keys(entity)) {
      if (property === "@id" || property === "@type") continue;
      const values = asArray(entity[property]);
      if (!values.length) continue;
      let changed = false;
      const next = [];
      for (const value of values) {
        const target = value && typeof value === "object" ? value["@id"] : null;
        if (target !== oldId) { next.push(value); continue; }
        changed = true;
        if (newId) next.push({ "@id": newId });
      }
      if (!changed) continue;
      if (next.length) entity[property] = next;
      else delete entity[property];
    }
  }
}
