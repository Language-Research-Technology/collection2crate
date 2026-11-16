// Finds the people and places a folder's files talk about, by named entity
// recognition over each file's text, and links them into the crate: the File
// gets custom:participant → Person and contentLocation → Place.
//
// All of it happens at files:prepare, during Process, on the crate the run was
// seeded with — so the people and places are already in the crate Process
// hands to Build (ctx.preparedCrate), and only an entity the crate holds by
// then (from the folder's existing crate, or edited in) can be reused. A File
// that is new to the crate is added here, bare; generic-input's scan at Build
// finds it and fills it in rather than adding a second one.
//
// Hook names are literal strings and core collection2crate functions arrive
// via createPlugin(deps) — see this repo's README.
import { progressFor } from "../../src/_progress.js";
import { generatedEntityId } from "../../src/_entity_ids.js";

let readFileBytes, readJsonFromFolder, writeFileAtPath;

export function createPlugin(deps) {
  ({ readFileBytes, readJsonFromFolder, writeFileAtPath } = deps);
  return plugin;
}

const PARTICIPANT = "custom:participant";
// schema.org's own property for "the location depicted or described in the
// content" — what merge links places with too, and what the HTML preview's
// map follows from a File to a Place's coordinates.
const PLACE = "contentLocation";

// Added only when a file was actually linked through one, like austlang's.
// custom:participant usually arrives with the profile's fileProperties already;
// contentLocation is schema.org's and needs no definition.
const PROPERTY_DEFINITIONS = {
  [PARTICIPANT]: { "@id": "arcp://name,custom/terms#participant", "@type": "rdf:Property", name: "Participant", description: "A participant associated with the file." },
};

const refsOf = (value) => (Array.isArray(value) ? value : value ? [value] : [])
  .filter((v) => v !== "" && v != null);

function link(crate, fileId, property, id) {
  const refs = refsOf(crate.getProperty(fileId, property));
  if (refs.some((ref) => (ref?.["@id"] ?? ref) === id)) return false;
  crate.setProperty(fileId, property, [...refs.map((ref) => (ref?.["@id"] ? { "@id": ref["@id"] } : ref)), { "@id": id }]);
  return true;
}

/**
 * Link each file to the people and places found in it, reusing any entity
 * the crate already has under a name's @id (merge's scheme, src/_entity_ids.js) and creating a Person or Place for
 * the rest. A File the crate doesn't hold yet is added, named from `fileNames`.
 *
 * @param {ROCrate} crate
 * @param {Object<string, {people: string[], places: string[]}>} namesByFile  keyed by File @id
 * @param {Object<string, string>} [fileNames]  File @id → file name, for a File added here
 * @returns {{ created: number, reused: number, links: number }}
 */
export function linkNamedEntities(crate, namesByFile, fileNames = {}) {
  const counts = { created: 0, reused: 0, links: 0 };
  const seen = new Set();
  const used = new Set();
  const kinds = [["people", "Person", PARTICIPANT], ["places", "Place", PLACE]];

  for (const [fileId, names] of Object.entries(namesByFile || {})) {
    if (!crate.getEntity(fileId)) {
      crate.addEntity({ "@id": fileId, "@type": "File", name: fileNames[fileId] || fileId.split("/").pop() });
    }
    for (const [key, type, property] of kinds) {
      for (const name of names?.[key] || []) {
        const id = generatedEntityId(type, name);
        if (!seen.has(id)) {
          seen.add(id);
          if (crate.getEntity(id)) counts.reused++;
          else { crate.addEntity({ "@id": id, "@type": type, name }); counts.created++; }
        }
        if (link(crate, fileId, property, id)) { counts.links++; used.add(property); }
      }
    }
  }

  for (const property of used) {
    const definition = PROPERTY_DEFINITIONS[property];
    if (definition && !crate.getEntity(definition["@id"])) crate.addEntity(definition);
  }
  return counts;
}

/**
 * The candidates a gazetteer knows as places, each marked exact or partial.
 * Exact: the gazetteer's name is the candidate's, or a spelling of it the
 * lookup tries itself ("Mt Isa" for "Mount Isa"). Partial: anything else it
 * answered with — GA's names starting with the candidate, GHAP's containing it
 * ("Murray Upper" for "Murray Upp"). Exact matches are ranked first, so a
 * partial one only stands where the gazetteer had nothing better.
 *
 * @param {string[]} candidates
 * @param {(name: string) => Promise<{matchedName?: string}|null>} lookup
 * @returns {Promise<Map<string, { exact: boolean, matchedName: string }>>}
 */
export async function confirmPlaces(candidates, lookup) {
  const { normalizePlaceName, placeNameVariants } = await import("../../src/_place_lookup.js");
  const confirmed = new Map();
  for (const name of candidates) {
    const match = await lookup(name);
    if (!match) continue;
    const spellings = new Set([name, ...placeNameVariants(name)].map(normalizePlaceName));
    confirmed.set(name, { exact: spellings.has(normalizePlaceName(match.matchedName)), matchedName: match.matchedName || "" });
  }
  return confirmed;
}

const hasGeometry = (place) => [].concat(place?.geo ?? []).some((ref) => ref && (ref["@id"] || typeof ref === "string"));

/**
 * Give each Place found by name the coordinates its lookup returned, as a
 * Geometry linked the way merge links one (setPlaceGeometry). A Place that
 * already points at a Geometry — entered by hand, or by an earlier run — is
 * left as it is.
 *
 * @param {ROCrate} crate
 * @param {Map<string, {latitude: number, longitude: number, asWKT: string}>} coordinatesByName
 * @returns {Promise<{ placed: number, kept: number }>}
 */
export async function addPlaceCoordinates(crate, coordinatesByName) {
  const { setPlaceGeometry } = await import("../../src/_place_lookup.js");
  const counts = { placed: 0, kept: 0 };
  const done = new Set(); // "Cairns" and "CAIRNS" are one Place
  for (const [name, match] of coordinatesByName) {
    const id = generatedEntityId("Place", name);
    const place = crate.getEntity(id);
    if (!place || done.has(id)) continue;
    done.add(id);
    if (hasGeometry(place)) { counts.kept++; continue; }
    setPlaceGeometry(crate, id, name, match);
    counts.placed++;
  }
  return counts;
}

// What the gazetteers said, kept in the folder so the next Process run only
// asks about names it hasn't seen. Standing data rather than output, so under
// _config/ (kept by "Delete plugin output before rebuilding"). Answers are
// filed under the settings that produced them — a different region,
// provider list or exact/partial choice gives different answers — and a
// lookup that got no reply is never kept (the service's settled()).
export const CACHE_DIR = "_config/name-lookup";
export const CACHE_PATH = `${CACHE_DIR}/gazetteer-cache.json`;

/** A short, stable key for the lookup settings that decide an answer. */
export function cacheKeyFor(settings) {
  const text = JSON.stringify({
    providers: settings.providers || [],
    exactOnly: !!settings.exactOnly,
    placeMatchRegion: settings.placeMatchRegion || "",
    records: settings.records || settings.cache || null,
    geoscienceAustralia: settings.geoscienceAustralia?.url || "",
    ghap: settings.ghap?.url || "",
  });
  let hash = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

async function loadCache(dirHandle) {
  const cache = dirHandle ? await readJsonFromFolder(dirHandle, CACHE_PATH) : null;
  return cache && typeof cache.lookups === "object" ? cache : { version: 1, lookups: {} };
}

async function bytesOf(ctx, file) {
  try {
    if (file.handle?.getFile) return await (await file.handle.getFile()).arrayBuffer();
    if (ctx.dirHandle && file.relativePath) return await readFileBytes(ctx.dirHandle, file.relativePath);
  } catch {
    // Unreadable (moved, permission withdrawn): reported by the caller.
  }
  return null;
}

// Reading the files is most of the work without the gazetteer; with it, the
// lookups — one request or two per distinct place or candidate — are.
const READ_SHARE = 0.5;
const LOOKUP_TIMEOUT_MS = 8000;

const plugin = {
  name: "name-lookup",
  optionSchema: {
    key: "enableNameLookups", label: "Identify people and places named in files", default: false,
    hint: "Reads each .txt, .md, .docx and .pdf file and finds people's and places' names with named entity recognition. Names of three letters or fewer are left out. Links each file to a Person (as participant) or Place (as contentLocation), reusing one already in the crate under the @id merge would give it (#john_smith, #place-mount-isa).",
    children: [
      { key: "nameLookupPeopleFile", type: "file", label: "People list (TXT)",
        accept: ".txt,text/plain",
        hint: "Optional — one name per line. When given, people are the names on this list that a file mentions (whole names, any case), instead of the people named entity recognition guesses. A listed name is never taken for a place." },
      { key: "nameLookupGazetteer", label: "Look names up in the Australian gazetteers", default: true,
        hint: "Uses Geoscience Australia to treat other capitalised names that match a place as places, and to give places coordinates, preferring the region set as placeMatchRegion in the merge config. Needs the network. Answers are kept in _config/name-lookup/ so a later run only looks up new names.",
        children: [
          { key: "nameLookupExactOnly", label: "Exact place names only", default: true,
            hint: "On: only exact names count, which Geoscience Australia answers a hundred at a time. Off: a name it doesn't know exactly is still a place if one starts with it (\"Murray Upp\" → Murray Upper) — one request per name, so slower." },
          { key: "nameLookupGhap", label: "Also check GHAP", default: false,
            hint: "Asks TLCMap's Gazetteer of Historical Australian Places about every name Geoscience Australia doesn't know — historical and Aboriginal place names it lacks. One request per name at about 3 seconds each, so a folder with thousands of names takes a long time on its first run." },
        ] },
    ],
  },
  outputPaths: [{ path: CACHE_DIR, kind: "dir" }],
  hooks: {
    "files:prepare": {
      priority: 50,
      weight: 4,
      activeWhen: (ctx) => !!ctx.options.enableNameLookups,
      handler: async (ctx) => {
        if (!ctx.options.enableNameLookups) return;
        if (!ctx.crate) {
          ctx.log("Name lookup: this host gives Process no crate to add people and places to — skipped.", "warn");
          return;
        }
        const { isReadableForNames, fileText, extractNames, parseNameList, createNameMatcher } = await import("./extract.js");
        const files = (ctx.filesWithMeta || []).filter((file) => isReadableForNames(file.fileName || file.name || ""));
        if (!files.length) {
          ctx.log("Name lookup: no .txt, .md, .docx or .pdf files to read.", "muted");
          return;
        }

        // A people list replaces NER's guesses about who is a person.
        let findPeople = null;
        const peopleUpload = ctx.options.nameLookupPeopleUpload;
        if (peopleUpload?.file) {
          const listed = parseNameList(await peopleUpload.file.text());
          findPeople = createNameMatcher(listed);
          ctx.log(
            listed.length
              ? `Name lookup: people are the ${listed.length} name(s) in ${peopleUpload.name}, not named entity recognition's guesses.`
              : `Name lookup: ${peopleUpload.name} lists no names, so no people will be found.`,
            listed.length ? "muted" : "warn",
          );
        }

        const gazetteer = ctx.options.nameLookupGazetteer !== false;
        const progress = progressFor(ctx);
        const readShare = gazetteer ? READ_SHARE : 1;
        progress.start("Finding people and places in files…");
        try {
          const namesByFile = {};
          const fileNames = {};
          let unreadable = 0;
          for (let index = 0; index < files.length; index++) {
            const file = files[index];
            const fileName = file.fileName || file.name;
            const bytes = await bytesOf(ctx, file);
            if (!bytes) unreadable++;
            else {
              try {
                namesByFile[file.id] = extractNames(await fileText(bytes, fileName), { findPeople });
                fileNames[file.id] = fileName;
              } catch (e) {
                ctx.log(`Name lookup: couldn't read ${file.relativePath}: ${e.message}`, "warn");
              }
            }
            progress.report(((index + 1) / files.length) * readShare, `Name lookup: read ${index + 1}/${files.length} file(s)…`);
          }
          if (unreadable) ctx.log(`Name lookup: ${unreadable} file(s) could not be read.`, "warn");

          let coordinates = new Map();
          if (gazetteer) {
            const { createPlaceLookupService, placeLookupSettings, normalizePlaceName } = await import("../../src/_place_lookup.js");
            const { resolveMergeConfig } = await import("../../src/_merge_config.js");
            const { config, source } = await resolveMergeConfig(ctx.options, ctx.dirHandle, readJsonFromFolder);
            const settings = placeLookupSettings(config);
            if (settings.placeMatchRegion) ctx.log(`Name lookup: preferring places in ${settings.placeMatchRegion} (merge config: ${source}).`, "muted");
            // A timed-out lookup reads as "not a place", and GA's 2.5s default
            // loses the first few requests of a cold connection. GHAP has its own,
            // longer default.
            const exactOnly = !!ctx.options.nameLookupExactOnly;
            const providers = (settings.providers?.length ? settings.providers : ["geoscience-australia", "ghap"])
              .filter((provider) => provider !== "ghap" || ctx.options.nameLookupGhap);
            const serviceSettings = {
              ...settings,
              providers,
              ...(exactOnly ? { exactOnly } : {}),
              geoscienceAustralia: { timeoutMs: LOOKUP_TIMEOUT_MS, ...settings.geoscienceAustralia },
              ghap: { ...settings.ghap },
            };
            const service = createPlaceLookupService(serviceSettings);

            const all = Object.values(namesByFile);
            const candidates = [...new Set(all.flatMap((names) => names.candidates))];
            const places = [...new Set(all.flatMap((names) => names.places))];

            const cacheKey = cacheKeyFor(serviceSettings);
            const cache = await loadCache(ctx.dirHandle).catch(() => ({ version: 1, lookups: {} }));
            const remembered = cache.lookups[cacheKey]?.names || {};
            service.seed(remembered);
            const asked = [...candidates, ...places];
            const fromCache = asked.filter((name) => Object.hasOwn(remembered, normalizePlaceName(name))).length;
            if (fromCache) ctx.log(`Name lookup: ${fromCache} of ${asked.length} name(s) answered from ${CACHE_PATH}.`, "muted");

            await service.prefetch(asked, (fraction, label) => progress.report(readShare + fraction * (1 - readShare), label));

            const confirmed = await confirmPlaces(candidates, (name) => service.lookup(name));
            // The lookup already asked for exact names only; this also drops a
            // gazetteer's nearest answer to an exact query that isn't one.
            if (exactOnly) for (const [name, m] of confirmed) if (!m.exact) confirmed.delete(name);
            for (const names of all) {
              names.places = [...names.places, ...names.candidates.filter((name) => confirmed.has(name))];
            }
            if (candidates.length) {
              ctx.log(`Name lookup: the gazetteers know ${confirmed.size} of ${candidates.length} other name(s) as places.`, confirmed.size ? "ok" : "muted");
            }
            // Partial matches are the ones worth a second look, so name them.
            const partial = [...confirmed].filter(([, m]) => !m.exact);
            if (partial.length) {
              const shown = partial.slice(0, 10).map(([name, m]) => `${name} → ${m.matchedName}`).join("; ");
              ctx.log(`Name lookup: ${partial.length} place(s) by partial match: ${shown}${partial.length > 10 ? "; …" : ""}.`, "muted");
            }
            for (const name of [...places, ...confirmed.keys()]) {
              const match = await service.lookup(name);
              if (match) coordinates.set(name, match);
            }

            if (ctx.dirHandle && asked.length > fromCache) {
              cache.lookups[cacheKey] = {
                settings: { providers, exactOnly, placeMatchRegion: settings.placeMatchRegion || "" },
                names: { ...remembered, ...service.settled() },
              };
              try {
                await writeFileAtPath(ctx.dirHandle, CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
              } catch (e) {
                ctx.log(`Name lookup: couldn't save ${CACHE_PATH}: ${e.message}`, "warn");
              }
            }
          }

          const { created, reused, links } = linkNamedEntities(ctx.crate, namesByFile, fileNames);
          ctx.log(
            `Name lookup: ${links} link(s) from ${files.length} file(s) — ${created} new Person/Place entity(ies), ${reused} already in the crate.`,
            links ? "ok" : "muted",
          );
          if (coordinates.size) {
            const { placed, kept } = await addPlaceCoordinates(ctx.crate, coordinates);
            ctx.log(
              `Name lookup: coordinates for ${placed} place(s)${kept ? `; ${kept} already had their own, left as they were` : ""}.`,
              placed ? "ok" : "muted",
            );
          }
        } finally {
          progress.done();
        }
      },
    },
  },
};
