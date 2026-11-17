// Coordinates for a place name from the Geoscience Australia and GHAP
// gazetteers. Shared: merge uses it to give merged Places coordinates,
// name-lookup to decide whether a proper name is a place, and to place it.
import { generatedGeometryId, placeGeoId } from "./_entity_ids.js";
export function normalizePlaceName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleCaseWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function normalizeCommonPlaceTypos(value) {
  return String(value || "")
    .replace(/\blsland\b/gi, "Island")
    .replace(/\blslands\b/gi, "Islands");
}

export function placeNameVariants(placeName) {
  const start = titleCaseWords(normalizeCommonPlaceTypos(placeName));
  if (!start) return [];

  const seen = new Set();
  const queue = [start];
  const out = [];
  while (queue.length) {
    const current = queue.shift();
    const key = normalizePlaceName(current);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(current);

    const nextValues = [
      current.replace(/\bMt\.?\b/gi, "Mount"),
      current.replace(/\bMount\b/gi, "Mt"),
    ];

    const mountMatch = current.match(/^Mount\s+(.+)$/i);
    if (mountMatch?.[1]) nextValues.push(`${mountMatch[1]} Mountain`);

    const mountainMatch = current.match(/^(.+)\s+Mountain$/i);
    if (mountainMatch?.[1]) nextValues.push(`Mount ${mountainMatch[1]}`);

    nextValues
      .map(titleCaseWords)
      .filter(Boolean)
      .forEach((nextValue) => {
        if (!seen.has(normalizePlaceName(nextValue))) queue.push(nextValue);
      });
  }
  return out;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toWkt(longitude, latitude) {
  return `POINT(${longitude} ${latitude})`;
}

function coordinateRecord(value, provider, matchedName = "") {
  if (!value || typeof value !== "object") return null;
  const latitude = asNumber(value.latitude ?? value.lat ?? value.y ?? value[".latitude"]);
  const longitude = asNumber(value.longitude ?? value.lon ?? value.lng ?? value.long ?? value.x ?? value[".longitude"]);
  if (latitude === null || longitude === null) return null;
  return {
    matchedName: String(matchedName || value.name || value.placename || value.title || "").trim(),
    latitude,
    longitude,
    asWKT: typeof value.asWKT === "string" && value.asWKT.trim()
      ? value.asWKT.trim()
      : toWkt(longitude, latitude),
    provider,
  };
}

function normalizeRegionToken(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

const REGION_ALIASES = new Map([
  ["QLD", "QLD"],
  ["QUEENSLAND", "QLD"],
  ["NSW", "NSW"],
  ["NEW SOUTH WALES", "NSW"],
  ["VIC", "VIC"],
  ["VICTORIA", "VIC"],
  ["SA", "SA"],
  ["SOUTH AUSTRALIA", "SA"],
  ["WA", "WA"],
  ["WESTERN AUSTRALIA", "WA"],
  ["TAS", "TAS"],
  ["TASMANIA", "TAS"],
  ["NT", "NT"],
  ["NORTHERN TERRITORY", "NT"],
  ["ACT", "ACT"],
  ["AUSTRALIAN CAPITAL TERRITORY", "ACT"],
]);

function canonicalRegion(value) {
  const token = normalizeRegionToken(value);
  if (!token) return "";
  return REGION_ALIASES.get(token) || token;
}

const REGION_MATCH_TOKENS = new Map([
  ["QLD", ["QLD", "QUEENSLAND"]],
  ["NSW", ["NSW", "NEW SOUTH WALES"]],
  ["VIC", ["VIC", "VICTORIA"]],
  ["SA", ["SA", "SOUTH AUSTRALIA"]],
  ["WA", ["WA", "WESTERN AUSTRALIA"]],
  ["TAS", ["TAS", "TASMANIA"]],
  ["NT", ["NT", "NORTHERN TERRITORY"]],
  ["ACT", ["ACT", "AUSTRALIAN CAPITAL TERRITORY"]],
]);

function candidateRegionTexts(candidate) {
  if (!candidate || typeof candidate !== "object") return [];
  const fields = [
    candidate.state,
    candidate.state_name,
    candidate.stateName,
    candidate.state_code,
    candidate.stateCode,
    candidate.region,
    candidate.region_name,
    candidate.regionName,
    candidate.province,
    candidate.admin1,
    candidate.admin_name_1,
    candidate.jurisdiction,
    candidate.authority,
  ];

  const values = new Set();
  for (const raw of fields) {
    const token = normalizeRegionToken(raw);
    if (token) values.add(token);
    const canonical = canonicalRegion(raw);
    if (canonical) values.add(canonical);
  }
  return [...values];
}

function candidateMatchesPreferredRegion(candidate, preferredRegion) {
  const preferred = canonicalRegion(preferredRegion);
  if (!preferred) return false;

  const regionTexts = candidateRegionTexts(candidate);
  if (!regionTexts.length) return false;

  const preferredTokens = REGION_MATCH_TOKENS.get(preferred) || [preferred];
  return regionTexts.some((text) => {
    const padded = ` ${text} `;
    return preferredTokens.some((token) => padded.includes(` ${token} `));
  });
}

function extractCandidateRegions(candidate) {
  const values = new Set();
  for (const raw of candidateRegionTexts(candidate)) {
    const canonical = canonicalRegion(raw);
    if (canonical) values.add(canonical);
  }
  return [...values];
}

function regionBonus(candidate, preferredRegion) {
  return candidateMatchesPreferredRegion(candidate, preferredRegion) ? 10 : 0;
}

// Where several places share a name — GA has a county, a parish and a city
// all called "Cairns" in Queensland — the one people live in is the one a
// text or a spreadsheet almost always means. Smaller than the region bonus,
// so a preferred region still wins over a town somewhere else.
const POPULATED = /\b(populated place|population centre|population center|locality|town|city|suburb|village|township)\b/i;

function populatedBonus(candidate) {
  const kinds = [candidate.category, candidate.feature, candidate.feature_term, candidate.feature_type, candidate.featureType, candidate.type];
  return kinds.some((kind) => typeof kind === "string" && POPULATED.test(kind)) ? 5 : 0;
}

function flattenCandidates(payload, out = []) {
  if (!payload) return out;
  if (Array.isArray(payload)) {
    payload.forEach((item) => flattenCandidates(item, out));
    return out;
  }
  if (typeof payload !== "object") return out;

  if (payload.type === "Feature" && payload.geometry?.coordinates) {
    const [longitude, latitude] = payload.geometry.coordinates;
    out.push({
      ...payload.properties,
      longitude,
      latitude,
    });
    return out;
  }

  if (payload.attributes && typeof payload.attributes === "object") {
    const geometry = Array.isArray(payload.geometry?.coordinates)
      ? { longitude: payload.geometry.coordinates[0], latitude: payload.geometry.coordinates[1] }
      : {};
    out.push({
      ...payload.attributes,
      ...geometry,
    });
    return out;
  }

  if (Array.isArray(payload.features)) {
    payload.features.forEach((item) => flattenCandidates(item, out));
    return out;
  }

  if (Array.isArray(payload.results)) {
    payload.results.forEach((item) => flattenCandidates(item, out));
    return out;
  }

  if (Array.isArray(payload.items)) {
    payload.items.forEach((item) => flattenCandidates(item, out));
    return out;
  }

  out.push(payload);
  return out;
}

function rankCandidate(candidate, targetName, preferredRegion = "") {
  const candidateName = normalizePlaceName(
    candidate.name ?? candidate.placename ?? candidate.place_name ?? candidate.title ?? candidate.preferredName ?? ""
  );
  if (!candidateName) return 0;

  let nameRank = 1;
  if (candidateName === targetName) nameRank = 4;
  else if (candidateName.startsWith(targetName) || targetName.startsWith(candidateName)) nameRank = 3;
  else if (candidateName.includes(targetName) || targetName.includes(candidateName)) nameRank = 2;

  // Keep exact name quality dominant, then bias toward preferred region for
  // ties/near ties, then toward populated places among what is still tied.
  return (nameRank * 100) + regionBonus(candidate, preferredRegion) + populatedBonus(candidate);
}

function pickBestRecord(payload, provider, placeName, options = {}) {
  const preferredRegion = options && typeof options === "object" ? options.placeMatchRegion : "";
  const targetName = normalizePlaceName(placeName);
  const matches = flattenCandidates(payload)
    .map((candidate) => ({
      rank: rankCandidate(candidate, targetName, preferredRegion),
      regionBoost: regionBonus(candidate, preferredRegion),
      candidateRegions: extractCandidateRegions(candidate),
      candidateName: String(
        candidate.name ?? candidate.placename ?? candidate.place_name ?? candidate.title ?? candidate.preferredName ?? ""
      ).trim(),
      rec: coordinateRecord(candidate, provider, candidate.name ?? candidate.placename ?? candidate.title ?? ""),
    }))
    .filter((entry) => entry.rec);
  if (!matches.length) return null;
  matches.sort((a, b) => b.rank - a.rank);

  const winner = matches[0];
  if (winner && winner.regionBoost > 0) {
    winner.rec.regionPreferenceApplied = true;
    winner.rec.regionPreference = canonicalRegion(preferredRegion);
    winner.rec.matchedRegion = winner.candidateRegions[0] || "";
    winner.rec.matchedCandidateName = winner.candidateName || winner.rec.matchedName || "";
  }
  return winner.rec;
}

function createTimeoutSignal(timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === "undefined") return { signal: undefined, cancel: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

function manualLookup(records, placeName) {
  const key = normalizePlaceName(placeName);
  if (!key) return null;
  if (records instanceof Map) return records.get(key) || null;
  return null;
}

function buildManualRecords(rawRecords) {
  const out = new Map();
  if (!rawRecords) return out;

  const add = (name, value) => {
    const key = normalizePlaceName(name);
    const rec = coordinateRecord(value, "manual", name);
    if (key && rec) out.set(key, rec);
  };

  if (Array.isArray(rawRecords)) {
    rawRecords.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      add(entry.name, entry);
    });
    return out;
  }

  if (typeof rawRecords === "object") {
    Object.entries(rawRecords).forEach(([name, value]) => add(name, value));
  }
  return out;
}

// `onFailure` is called when no answer came back (network error, timeout, a
// non-2xx status, a body that isn't JSON) — as opposed to an answer with no
// places in it. A caller that keeps answers beyond this run must not keep
// those. `body` makes it a form POST, for queries too long for a URL.
async function fetchJson(url, timeoutMs, { body, onFailure } = {}) {
  if (typeof fetch !== "function") { onFailure?.(); return null; }
  const { signal, cancel } = createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json, application/geo+json" },
      cache: "no-store",
      signal,
      ...(body ? { method: "POST", body } : {}),
    });
    if (!res.ok) { onFailure?.(); return null; }
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("json")) return await res.json();
    const text = await res.text();
    if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) { onFailure?.(); return null; }
    return JSON.parse(text);
  } catch {
    onFailure?.();
    return null;
  } finally {
    cancel();
  }
}

function escapeWhereLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}

// TLCMap's Gazetteer of Historical Australian Places (GHAP), through its
// search API (https://tlcmap.org/api — docs: tlcmap-docs, developers/
// search-api.md). /api serves the ANPS and Composite gazetteers only, never
// user-contributed layers. Answers are GeoJSON Features whose properties carry
// name, state and feature_term ("populated place", "county", …). Like the GA
// lookup: an exact name first (`name` matches the title, case-insensitively),
// then — unless exactOnly — names containing it.
async function lookupViaGhap(placeName, options) {
  const baseUrl = String(options?.url || "https://tlcmap.org/api").trim();
  if (!baseUrl) return null;
  const search = (param) => {
    const url = new URL(baseUrl);
    url.searchParams.set("format", "json");
    url.searchParams.set(param, placeName);
    url.searchParams.set("per_page", String(options?.perPage || 50));
    return url;
  };
  // TLCMap takes about 3s a request, past the 2.5s GA gets.
  const timeoutMs = options?.timeoutMs || 10000;
  const fetchOptions = { onFailure: options?.onFailure };
  const match = pickBestRecord(await fetchJson(search("name"), timeoutMs, fetchOptions), "ghap", placeName, options);
  if (match || options?.exactOnly) return match;
  return pickBestRecord(await fetchJson(search("containsname"), timeoutMs, fetchOptions), "ghap", placeName, options);
}

const GA_QUERY_URL = "https://services.ga.gov.au/gis/rest/services/Composite_Gazetteer_of_Australia/MapServer/0/query";
const GA_OUT_FIELDS = "id,name,feature,category,theme,latitude,longitude,authority";

// `exactRows`: the rows a batched exact query (lookupManyViaGeoscienceAustralia)
// already returned for this name — an empty array is a definite "no exact
// match" — so the exact request is skipped.
async function lookupViaGeoscienceAustralia(placeName, options) {
  const baseUrl = String(options?.url || GA_QUERY_URL).trim();
  if (!baseUrl) return null;
  const fetchOptions = { onFailure: options?.onFailure };
  let match;
  if (Array.isArray(options?.exactRows)) {
    match = pickBestRecord({ features: options.exactRows.map((attributes) => ({ attributes })) }, "geoscience-australia", placeName, options);
  } else {
    const exactUrl = new URL(baseUrl);
    exactUrl.searchParams.set("where", `upper(name) = upper('${escapeWhereLiteral(placeName)}')`);
    exactUrl.searchParams.set("outFields", String(options?.outFields || GA_OUT_FIELDS));
    exactUrl.searchParams.set("returnGeometry", String(options?.returnGeometry || "false"));
    exactUrl.searchParams.set("f", String(options?.format || "pjson"));
    const exactPayload = await fetchJson(exactUrl, options?.timeoutMs || 2500, fetchOptions);
    match = pickBestRecord(exactPayload, "geoscience-australia", placeName, options);
  }
  if (match || options?.exactOnly) return match;

  const fuzzyUrl = new URL(baseUrl);
  fuzzyUrl.searchParams.set("where", `upper(name) like upper('${escapeWhereLiteral(placeName)}%')`);
  fuzzyUrl.searchParams.set("outFields", String(options?.outFields || GA_OUT_FIELDS));
  fuzzyUrl.searchParams.set("returnGeometry", String(options?.returnGeometry || "false"));
  fuzzyUrl.searchParams.set("f", String(options?.format || "pjson"));
  const payload = await fetchJson(fuzzyUrl, options?.timeoutMs || 2500, fetchOptions);
  return pickBestRecord(payload, "geoscience-australia", placeName, options);
}

// GA's query service takes a whole list of names in one `in (…)` clause: a
// hundred names come back in about the time one does. Returns a Map from each
// name's normalised form to its rows ([] for none) — only for names whose
// batch was answered; a batch that failed is simply absent, and those names
// get their own requests later. A batch GA cut short (exceededTransferLimit:
// a name like "Spring Creek" has hundreds of rows) is split and asked again,
// so a name is never wrongly reported as missing.
export const GA_BATCH_SIZE = 100;

async function lookupManyViaGeoscienceAustralia(names, options = {}, report = () => {}) {
  const baseUrl = String(options.url || GA_QUERY_URL).trim();
  const found = new Map();
  if (!baseUrl || !names.length) return found;
  const timeoutMs = Math.max(options.timeoutMs || 2500, 15000);
  let done = 0;

  const ask = async (batch) => {
    const literals = batch.map((name) => `'${escapeWhereLiteral(name.toUpperCase())}'`).join(",");
    const body = new URLSearchParams({
      where: `upper(name) in (${literals})`,
      outFields: String(options.outFields || GA_OUT_FIELDS),
      returnGeometry: "false",
      f: "json",
    });
    const payload = await fetchJson(baseUrl, timeoutMs, { body });
    if (payload?.exceededTransferLimit && batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      await ask(batch.slice(0, half));
      await ask(batch.slice(half));
      return;
    }
    if (payload && Array.isArray(payload.features)) {
      for (const name of batch) found.set(normalizePlaceName(name), []);
      for (const feature of payload.features) {
        const rows = found.get(normalizePlaceName(feature?.attributes?.name));
        if (rows) rows.push(feature.attributes);
      }
    }
    done += batch.length;
    report(done / names.length);
  };

  for (let i = 0; i < names.length; i += GA_BATCH_SIZE) await ask(names.slice(i, i + GA_BATCH_SIZE));
  return found;
}

export function createPlaceLookupService(options = {}, log = () => {}) {
  const settings = options && typeof options === "object" ? options : {};
  const enabled = settings.enabled !== false;
  const placeMatchRegion = String(
    settings.placeMatchRegion || settings.preferredRegion || settings.region || ""
  ).trim();
  // exactOnly: only a place whose name is the one asked for (or a spelling the
  // lookup tries itself) — no names starting with or containing it. Applies to
  // every provider; a provider's own exactOnly can still turn it on alone.
  const exactOnly = settings.exactOnly === true;
  const providers = Array.isArray(settings.providers) && settings.providers.length
    ? settings.providers
    : ["geoscience-australia", "ghap"];
  const manualRecords = buildManualRecords(settings.records || settings.cache);
  const resultCache = new Map();
  // Keys whose answer rests on a request that got no reply: right for this run
  // (nothing better is coming), but not to be kept beyond it — see settled().
  const uncertain = new Set();
  // GA's exact rows per normalised spelling, from prefetch's batched queries.
  const gaExactRows = new Map();
  let hasLoggedConfig = false;
  const PREFETCH_CONCURRENCY = 5;

  const service = {
    async lookup(placeName) {
      const key = normalizePlaceName(placeName);
      if (!key || !enabled) return null;
      if (resultCache.has(key)) return resultCache.get(key);

      if (!hasLoggedConfig) {
        const preferred = placeMatchRegion || "(none)";
        log(
          `Place lookup config: providers=${providers.join(", ")}; preferred region=${preferred}; manual records=${manualRecords.size}.`,
          "info"
        );
        hasLoggedConfig = true;
      }

      const variants = placeNameVariants(placeName);

      for (const variant of variants) {
        const manual = manualLookup(manualRecords, variant);
        if (manual) {
          resultCache.set(key, manual);
          return manual;
        }
      }

      let match = null;
      let failed = false;
      const onFailure = () => { failed = true; };
      for (const variant of variants) {
        for (const provider of providers) {
          if (provider === "ghap") {
            match = await lookupViaGhap(variant, {
              ...(settings.ghap || {}),
              ...(exactOnly ? { exactOnly } : {}),
              placeMatchRegion,
              onFailure,
            });
          } else if (provider === "geoscience-australia") {
            match = await lookupViaGeoscienceAustralia(variant, {
              ...(settings.geoscienceAustralia || {}),
              ...(exactOnly ? { exactOnly } : {}),
              exactRows: gaExactRows.get(normalizePlaceName(variant)),
              placeMatchRegion,
              onFailure,
            });
          }
          if (match) break;
        }
        if (match) break;
      }

      if (!match && providers.length) log(`Place lookup: no coordinates found for "${placeName}".`, "info");
      if (match && match.regionPreferenceApplied) {
        const preferred = match.regionPreference || placeMatchRegion;
        const matchedRegion = match.matchedRegion ? ` (${match.matchedRegion})` : "";
        const matchedName = match.matchedCandidateName || match.matchedName || placeName;
        log(
          `Place lookup: region preference "${preferred}" favored "${matchedName}"${matchedRegion} for input "${placeName}".`,
          "info"
        );
      }
      if (match) {
        const regionNote = match.matchedRegion ? `, region=${match.matchedRegion}` : "";
        const preferredNote = match.regionPreferenceApplied
          ? `, preferredRegion=${match.regionPreference || placeMatchRegion}`
          : "";
        log(
          `Place lookup: selected "${match.matchedName || placeName}" -> lat=${match.latitude}, lon=${match.longitude} (provider=${match.provider}${regionNote}${preferredNote}).`,
          "info"
        );
      }
      resultCache.set(key, match);
      if (failed && !match) uncertain.add(key);
      return match;
    },

    // Answers from an earlier run (name-lookup's folder cache), keyed by
    // normalizePlaceName: a record, or null for "no such place". They are
    // taken as they are — no request is made for those names.
    seed(entries) {
      for (const [key, record] of Object.entries(entries || {})) {
        if (key && !resultCache.has(key)) resultCache.set(key, record ?? null);
      }
    },

    // Every answer worth keeping beyond this run: everything looked up, minus
    // the misses that rest on a request that got no reply.
    settled() {
      const out = {};
      for (const [key, record] of resultCache) if (!uncertain.has(key)) out[key] = record;
      return out;
    },

    // Resolves every name in `placeNames` up front, reporting a fraction as it
    // goes — so a merge with many distinct Place values doesn't look frozen.
    // GA is asked first in batches (lookupManyViaGeoscienceAustralia), every
    // spelling of every name at once; that settles any name GA knows exactly,
    // and any name it doesn't when nothing else would be asked. The rest are
    // looked up one at a time, `PREFETCH_CONCURRENCY` at once. `report(fraction,
    // label)` is the progress channel (see src/_progress.js); it is
    // deliberately not `log`, which is the transcript.
    async prefetch(placeNames, report = () => {}) {
      if (!enabled) return;
      const names = [...new Set(placeNames)].filter((n) => normalizePlaceName(n) && !resultCache.has(normalizePlaceName(n)));
      const total = names.length;
      if (!total) return;
      log(`Place lookup: resolving ${total} place name(s)…`, "muted");
      // A name the config gives coordinates for (manual records) never needs
      // a gazetteer, so it stays out of the batches — lookup() settles it
      // before asking anyone.
      const hasManual = (name) => placeNameVariants(name).some((variant) => manualLookup(manualRecords, variant));

      const askGa = providers.includes("geoscience-australia");
      const batchShare = askGa ? 0.3 : 0;
      if (askGa) {
        const spellings = new Map();
        for (const name of names) {
          if (hasManual(name)) continue;
          for (const variant of placeNameVariants(name)) {
            const key = normalizePlaceName(variant);
            if (key && !gaExactRows.has(key) && !spellings.has(key)) spellings.set(key, variant);
          }
        }
        const rows = !spellings.size ? new Map() : await lookupManyViaGeoscienceAustralia([...spellings.values()], settings.geoscienceAustralia || {},
          (fraction) => report(fraction * batchShare, `Place lookup: checked ${Math.round(fraction * spellings.size)}/${spellings.size} spelling(s) with Geoscience Australia…`));
        for (const [key, found] of rows) gaExactRows.set(key, found);
      }

      let done = 0;
      let next = 0;
      const worker = async () => {
        while (next < names.length) {
          const name = names[next++];
          await service.lookup(name);
          done++;
          report(batchShare + (done / total) * (1 - batchShare), `Place lookup: resolved ${done}/${total} place name(s)…`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, total) }, worker));
    },
  };

  return service;
}

/**
 * The lookup settings a merge config asks for: its `placeLookup` block, with
 * a top-level `placeMatchRegion` ("QLD", "Queensland") as the region to
 * prefer when a name matches places in more than one.
 */
export function placeLookupSettings(mergeConfig) {
  const settings = { ...(mergeConfig && typeof mergeConfig.placeLookup === "object" ? mergeConfig.placeLookup : {}) };
  if (mergeConfig && typeof mergeConfig.placeMatchRegion === "string" && mergeConfig.placeMatchRegion.trim()) {
    settings.placeMatchRegion = settings.placeMatchRegion || mergeConfig.placeMatchRegion.trim();
  }
  return settings;
}

/**
 * Give the Place `placeId` the coordinates in `lookup` (a lookup() result),
 * as a linked Geometry: created if missing, its values replaced if not.
 *
 * @returns {{ geometryId: string, createdGeometry: boolean, enriched: boolean }}
 *   `enriched`: the Place didn't already point at a Geometry.
 */
export function setPlaceGeometry(crate, placeId, placeName, lookup) {
  const placeNode = crate.getEntity(placeId);
  const geometryId = generatedGeometryId(placeNode || { "@id": placeId }, placeName);
  let geometryNode = crate.getEntity(geometryId);
  const hadGeo = !!placeGeoId(placeNode);
  let createdGeometry = false;
  if (!geometryNode) {
    crate.addEntity({
      "@id": geometryId,
      "@type": "Geometry",
      ".latitude": lookup.latitude,
      ".longitude": lookup.longitude,
      asWKT: lookup.asWKT,
    });
    createdGeometry = true;
  } else {
    geometryNode["@type"] = geometryNode["@type"] || "Geometry";
    geometryNode[".latitude"] = lookup.latitude;
    geometryNode[".longitude"] = lookup.longitude;
    geometryNode.asWKT = lookup.asWKT;
  }
  if (placeNode) placeNode.geo = { "@id": geometryId };
  return { geometryId, createdGeometry, enriched: !!placeNode && !hadGeo };
}
