// Spreadsheet-merge logic (ported from corpus-tools-dyirbal/merge.js) —
// moved out of crate.js since, unlike crate.js's other output generators
// (crateToJsonString/crateToXlsxBytes/crateToPreviewHtml, all called from
// both a plugin AND main.js's Edit-Save flow directly), this code has no
// caller besides the merge plugin itself. graphEntityById is the one thing
// still shared with crate.js (addLanguageEntities, the austlang plugin's
// crate-mutation primitive, uses it too) — collection2crate's core function,
// passed in by the caller (merge/index.js's createPlugin(deps)) rather than
// imported by relative path, per this repo's README.
import ExcelJS from "exceljs";
import { createPlaceLookupService, setPlaceGeometry, placeLookupSettings } from "../../src/_place_lookup.js";
import { generatedEntityId } from "../../src/_entity_ids.js";

// ExcelJS cell values can be plain scalars or rich objects (formula results,
// rich text, hyperlinks); normalise to a plain string.
function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if (v.result !== undefined) return String(v.result);
    if (v.hyperlink && v.text) return String(v.text);
    return "";
  }
  return String(v);
}

// Read workbook sheet names plus the header row from a selected sheet
// (defaulting to the first sheet). Used by the merge-mapping builder UI.
export async function readXlsxHeaders(xlsxData, preferredSheetName = "") {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxData);
  if (!wb.worksheets.length) throw new Error("The spreadsheet has no worksheets");
  const sheetNames = wb.worksheets.map((ws) => ws.name);
  const wanted = String(preferredSheetName || "").trim();
  const sheet = wanted ? wb.getWorksheet(wanted) : wb.worksheets[0];
  if (!sheet) throw new Error(`Sheet "${wanted}" not found in the workbook`);
  let headers = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) headers = row.values.slice(1).map(cellText);
  });
  return { sheetName: sheet.name, sheetNames, headers };
}

// Read prefix->URI context definitions found anywhere in a workbook.
// Used by the mapping UI to warn about unresolved prefixed targets.
export async function readXlsxContextPrefixes(xlsxData) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxData);
  if (!wb.worksheets.length) throw new Error("The spreadsheet has no worksheets");
  return scanWorkbookContexts(wb);
}

// "custom:" is this app's own made-up namespace (arcp://name,custom/terms#) —
// unlike "ldac:", which is a real published vocabulary, nothing external
// defines what a custom: property means. Turns "dateCaptured" into
// "Date Captured" for a generated rdf:Property's name.
const CUSTOM_PROPERTY_PREFIX = "custom:";
const CUSTOM_PROPERTY_BASE = "arcp://name,custom/terms#";
function prettifyPropertyLocalName(localName) {
  return localName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function getTargetPrefix(term) {
  const t = String(term || "").trim();
  if (!t || t.includes("://")) return "";
  const i = t.indexOf(":");
  if (i <= 0) return "";
  const prefix = t.slice(0, i);
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(prefix) ? prefix : "";
}

function normalizePrefixKey(raw) {
  const key = String(raw || "").trim().replace(/:$/, "");
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(key) ? key : "";
}

function isLikelyContextUri(value) {
  return /^(https?:|urn:|arcp:)/i.test(String(value || "").trim());
}

function addParsedContextEntries(raw, outMap) {
  if (!raw) return;
  if (Array.isArray(raw)) {
    raw.forEach((entry) => addParsedContextEntries(entry, outMap));
    return;
  }
  if (typeof raw !== "object") return;
  Object.entries(raw).forEach(([k, v]) => {
    const prefix = normalizePrefixKey(k);
    if (!prefix || typeof v !== "string") return;
    const uri = v.trim();
    if (!isLikelyContextUri(uri)) return;
    if (!outMap.has(prefix)) outMap.set(prefix, uri);
  });
}

function parseContextCellValue(value, outMap) {
  const text = cellText(value).trim();
  if (!text) return;
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      addParsedContextEntries(JSON.parse(text), outMap);
      return;
    } catch {
      return;
    }
  }
}

function scanWorkbookContexts(workbook) {
  const contexts = new Map();
  workbook.worksheets.forEach((ws) => {
    let headers = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {
        headers = row.values.slice(1).map((v) => String(cellText(v)).trim());
        return;
      }

      // Generic key/value rows (prefix in col A, URI in col B), with or without headers.
      const a = cellText(row.getCell(1).value).trim();
      const b = cellText(row.getCell(2).value).trim();
      const prefA = normalizePrefixKey(a);
      if (prefA && isLikelyContextUri(b) && !contexts.has(prefA)) contexts.set(prefA, b);

      // A row like @context | { ...json... }.
      if (a === "@context") parseContextCellValue(row.getCell(2).value, contexts);

      if (!headers.length) return;

      // Column named @context containing JSON object/array values.
      const contextCol = headers.indexOf("@context");
      if (contextCol !== -1) parseContextCellValue(row.getCell(contextCol + 1).value, contexts);

      // Prefix table columns such as prefix + uri/namespace/context/@id.
      const prefixCol = headers.findIndex((h) => /^(prefix|term)$/i.test(h));
      const uriCol = headers.findIndex((h) => /^(uri|namespace|context|@id|iri)$/i.test(h));
      if (prefixCol !== -1 && uriCol !== -1) {
        const pref = normalizePrefixKey(cellText(row.getCell(prefixCol + 1).value));
        const uri = cellText(row.getCell(uriCol + 1).value).trim();
        if (pref && isLikelyContextUri(uri) && !contexts.has(pref)) contexts.set(pref, uri);
      }
    });
  });
  return contexts;
}

function getExistingContextPrefixes(crate) {
  const prefixes = new Set();
  const ctx = crate.getJson()["@context"];
  const collect = (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    Object.keys(entry).forEach((k) => {
      const p = normalizePrefixKey(k);
      if (p) prefixes.add(p);
    });
  };
  if (Array.isArray(ctx)) ctx.forEach(collect);
  else collect(ctx);
  return prefixes;
}

function splitMappingValues(value) {
  return value
    .split(/\s*[,/]\s*/).map((v) => v.trim()).filter(Boolean)
    .map((v) => v.replace(/[\[\]?()']/g, "").trim()).filter(Boolean);
}

// The mapping config exists in two shapes in the wild. Canonical — what the
// bundled merge_config.json and hand-written configs use, and what this
// function returns:
//   { "mapping": [ { "source": "<column>", "target": "<property>", "type": "Person" } ] }
// And the shape main.js's "Build mapping from spreadsheet columns..." dialog
// saves:
//   { "map": { "<column>": { "property": "<property>", "type": "Person" } } }
// Read both, so a config built in that dialog isn't silently a no-op. "Text"
// is that dialog's default for "no special handling", and means untyped here,
// where a truthy `type` is what turns cell values into linked entities.
function normaliseMappings(mergeConfig) {
  if (Array.isArray(mergeConfig?.mapping)) return mergeConfig.mapping;
  const map = mergeConfig?.map;
  if (!map || typeof map !== "object") return [];
  return Object.entries(map).flatMap(([source, spec]) => {
    const target = String(spec?.property ?? "").trim();
    if (!source || !target) return [];
    const type = String(spec?.type ?? "").trim();
    return [{ source, target, ...(type && type !== "Text" ? { type } : {}) }];
  });
}


// Merge a spreadsheet's rows into matching crate entities (by an "@id" column),
// applying the config's column→property mappings. Typed mappings split on comma
// or slash and generate linked entities. Any "custom:" target property that's
// actually used but has no rdf:Property entity yet (the profile-declared ones
// from config.fileProperties, or a prior merge) gets a minimal one generated
// so it's not left undocumented in the graph. Mutates `crate` in place;
// returns stats.
export async function mergeXlsxIntoCrate(crate, xlsxData, mergeConfig, log = () => {}, graphEntityById, report = () => {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxData);

  let sheet;
  if (wb.worksheets.length > 1) {
    sheet = mergeConfig.sheet ? wb.getWorksheet(mergeConfig.sheet) : wb.worksheets[0];
    if (!sheet) throw new Error(`Sheet "${mergeConfig.sheet}" not found in the workbook`);
  } else {
    sheet = wb.worksheets[0];
  }
  if (!sheet) throw new Error("The spreadsheet has no worksheets");

  const headers = [];
  const dataRows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) headers.push(...row.values.slice(1).map(cellText));
    else if (row.values.length > 1) dataRows.push(row.values.slice(1));
  });

  const idCol = headers.indexOf("@id");
  if (idCol === -1) throw new Error('The spreadsheet needs an "@id" column');

  const entityById = new Map();
  crate.graph.forEach((e) => { if (e["@id"]) entityById.set(e["@id"], e); });

  const mappings = normaliseMappings(mergeConfig);
  if (!mappings.length)
    log('Merge: the mapping config defines no usable column mappings, so nothing will be merged. Expected a "mapping" array of {source, target, type} entries.', "warn");
  const requiredPrefixes = new Set(
    mappings.map((m) => getTargetPrefix(m && m.target)).filter(Boolean)
  );
  const workbookContexts = scanWorkbookContexts(wb);
  const existingPrefixes = getExistingContextPrefixes(crate);
  const addedContexts = [];
  const placeLookupConfig = placeLookupSettings(mergeConfig);
  const placeLookup = createPlaceLookupService(placeLookupConfig, log);
  requiredPrefixes.forEach((prefix) => {
    if (existingPrefixes.has(prefix)) return;
    const uri = workbookContexts.get(prefix);
    if (!uri) return;
    crate.addContext({ [prefix]: uri });
    existingPrefixes.add(prefix);
    addedContexts.push(`${prefix}: ${uri}`);
  });

  let merged = 0, generated = 0, enrichedPlaces = 0;
  const missingCols = new Set();
  const matchedIds = new Set();   // entity @ids that a spreadsheet row matched
  const unmatchedRowIds = [];     // spreadsheet @ids with no matching entity
  const usedCustomProps = new Set(); // "custom:" target properties actually written

  // Every distinct "Place" value gets network-looked-up exactly once here,
  // with bounded concurrency and progress logging — the merge loop below then
  // hits placeLookup's cache (populated by this prefetch) instead of awaiting
  // a fresh lookup per row, which used to serialize one network round trip
  // (up to ~10s worst case each, across variants/providers) per row.
  const placeMappings = mappings.filter((m) => m.type === "Place");
  if (placeMappings.length) {
    const placeCols = new Set(placeMappings.map((m) => headers.indexOf(m.source)).filter((c) => c !== -1));
    const uniquePlaces = new Set();
    for (const row of dataRows) {
      for (const col of placeCols) {
        const raw = cellText(row[col]).trim();
        if (!raw) continue;
        for (const val of splitMappingValues(raw)) uniquePlaces.add(val);
      }
    }
    if (uniquePlaces.size) await placeLookup.prefetch([...uniquePlaces], report);
  }

  for (const row of dataRows) {
    const entityId = cellText(row[idCol]).trim();
    if (!entityId) continue;
    const entity = entityById.get(entityId);
    if (!entity) { unmatchedRowIds.push(entityId); continue; }
    matchedIds.add(entityId);

    for (const mapping of mappings) {
      const col = headers.indexOf(mapping.source);
      if (col === -1) { missingCols.add(mapping.source); continue; }
      const value = cellText(row[col]).trim();
      if (!value) continue;

      if (mapping.type) {
        const values = splitMappingValues(value);
        if (!values.length) continue;
        const refs = [];
        for (const val of values) {
          const id = generatedEntityId(mapping.type, val);
          if (!entityById.get(id)) {
            const ge = { "@id": id, "@type": mapping.type, name: val };
            crate.addEntity(ge);
            entityById.set(id, graphEntityById(crate, id) || ge);
            generated++;
          }
          if (mapping.type === "Place") {
            const placeNode = graphEntityById(crate, id) || entityById.get(id);
            const lookup = await placeLookup.lookup(val || placeNode?.name || "");
            if (lookup) {
              const result = setPlaceGeometry(crate, id, val, lookup);
              if (result.createdGeometry) { generated++; entityById.set(result.geometryId, graphEntityById(crate, result.geometryId)); }
              if (result.enriched) enrichedPlaces++;
            }
          }
          refs.push({ "@id": id });
        }
        entity[mapping.target] = refs.length === 1 ? refs[0] : refs;
        merged++;
      } else {
        entity[mapping.target] = value;
        merged++;
      }
      if (mapping.target.startsWith(CUSTOM_PROPERTY_PREFIX)) usedCustomProps.add(mapping.target);
    }
  }

  const generatedProps = [];
  usedCustomProps.forEach((target) => {
    const id = CUSTOM_PROPERTY_BASE + target.slice(CUSTOM_PROPERTY_PREFIX.length);
    if (crate.hasEntity(id)) return;
    crate.addEntity({ "@id": id, "@type": "rdf:Property", name: prettifyPropertyLocalName(target.slice(CUSTOM_PROPERTY_PREFIX.length)), description: "" });
    generatedProps.push(target);
  });

  // File entities in the crate that no spreadsheet row matched (by exact @id) —
  // these get no merged metadata (e.g. no encodingFormat). Usually a path/name
  // mismatch between the folder and the spreadsheet's @id column.
  const isFile = (e) => { const t = e["@type"]; return Array.isArray(t) ? t.includes("File") : t === "File"; };
  const unmatchedFiles = crate.graph.filter((e) => isFile(e) && e["@id"] && !matchedIds.has(e["@id"])).map((e) => e["@id"]);

  const sample = (arr, n = 12) => arr.slice(0, n).map((s) => `\n    • ${s}`).join("") + (arr.length > n ? `\n    …and ${arr.length - n} more` : "");

  if (missingCols.size) log(`Merge: columns not in spreadsheet, skipped: ${[...missingCols].join(", ")}.`, "warn");
  if (unmatchedFiles.length)
    log(`Merge: ${unmatchedFiles.length} file(s) had NO matching spreadsheet row — no metadata merged (check the @id path):${sample(unmatchedFiles)}`, "warn");
  if (unmatchedRowIds.length)
    log(`Merge: ${unmatchedRowIds.length} spreadsheet row(s) matched no entity in the crate:${sample(unmatchedRowIds)}`, "warn");
  if (addedContexts.length)
    log(`Merge: added ${addedContexts.length} missing context prefix(es) from workbook: ${addedContexts.join(", ")}.`, "ok");
  const unresolvedPrefixes = [...requiredPrefixes].filter((p) => !existingPrefixes.has(p));
  if (unresolvedPrefixes.length)
    log(`Merge: no matching context found in workbook for prefix(es): ${unresolvedPrefixes.join(", ")}.`, "warn");
  if (generatedProps.length)
    log(`Merge: generated rdf:Property definitions for ${generatedProps.length} custom propert${generatedProps.length === 1 ? "y" : "ies"} not yet described in the crate: ${generatedProps.sort().join(", ")}.`, "ok");
  if (enrichedPlaces)
    log(`Merge: added Geometry coordinates for ${enrichedPlaces} place reference${enrichedPlaces === 1 ? "" : "s"}.`, "ok");
  log(`Merged ${merged} value(s) from "${sheet.name}" into ${matchedIds.size} entity/ies; generated ${generated} new entity/ies.`, "ok");
  return {
    merged,
    generated,
    enrichedPlaces,
    generatedProperties: generatedProps.length,
    addedContexts: addedContexts.length,
    skipped: unmatchedRowIds.length,
    unmatchedFiles: unmatchedFiles.length,
    sheet: sheet.name,
  };
}
