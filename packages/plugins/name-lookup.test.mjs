// name-lookup: people and places found in a file's text by named entity
// recognition — with other proper names confirmed as places by a gazetteer —
// then linked from the File at Process, reusing an entity the crate already
// holds under the name's @id and creating one otherwise. Offline: the
// gazetteer is a stub here.
//
//   node name-lookup.test.mjs
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import { REGISTRY } from "./index.js";
import { linkNamedEntities, confirmPlaces, addPlaceCoordinates, CACHE_PATH } from "./plugins/name-lookup/index.js";
import { generatedEntityId } from "./src/_entity_ids.js";
import { extractNames, fileText, isReadableForNames, parseNameList, createNameMatcher } from "./plugins/name-lookup/extract.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};
const ids = (value) => (Array.isArray(value) ? value : [value]).map((v) => v?.["@id"] ?? v);

const TEXT = "Dora Leung recorded this with John Smith's family at Mount Isa. " +
  "Later, Mrs. Mary O'Brien travelled to Queensland and Palm Island, then on to Yarrabah.";

// A one-page PDF whose text is `text`, with a correct xref table — enough for
// pdf.js to read without repairing it.
function pdfWithText(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

// The \`where\` of a GA query, whether sent in the URL (one name) or as a form
// POST (a batch), and the names an exact query asks for, upper-cased.
const gaWhere = (url, init) => new URL(url).searchParams.get("where") || new URLSearchParams(String(init?.body || "")).get("where") || "";
function gaNamesAsked(url, init) {
  const where = gaWhere(url, init);
  const list = where.match(/in \((.*)\)\s*$/);
  if (list) return [...list[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  const single = where.match(/^upper\(name\) = upper\('(.+?)'\)\s*$/);
  return single ? [single[1].toUpperCase()] : [];
}

console.log("name-lookup");

await check("@ids follow merge's scheme", () => {
  assert.equal(generatedEntityId("Person", "John Smith"), "#john_smith");
  assert.equal(generatedEntityId("Person", "Mary O'Brien"), "#mary_o_brien");
  assert.equal(generatedEntityId("Place", " Mount  Isa "), "#place-mount-isa");
});

await check("a Person merge made from a spreadsheet is the one a file links to", async () => {
  const { mergeXlsxIntoCrate } = await import("./plugins/merge/xlsx.js");
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Sheet1").addRows([["@id", "contentPerson", "location"], ["a.txt", "Dora Leung", "Mount Isa"]]);
  const bytes = await book.xlsx.writeBuffer();
  const crate = new ROCrate({ array: true, link: true });
  crate.addEntity({ "@id": "a.txt", "@type": "File", name: "a.txt" });
  await mergeXlsxIntoCrate(crate, bytes,
    { mapping: [{ source: "contentPerson", target: "custom:contentPerson", type: "Person" },
                { source: "location", target: "contentLocation", type: "Place" }],
      placeLookup: { enabled: false } },
    () => {}, (c, id) => c.getEntity(id));
  const counts = linkNamedEntities(crate, { "a.txt": { people: ["Dora Leung"], places: ["Mount Isa"] } });
  assert.deepEqual(counts, { created: 0, reused: 2, links: 1 }, "merge already linked Mount Isa by contentLocation; only Dora Leung is new");
  assert.deepEqual(ids(crate.getProperty("a.txt", "contentLocation")), ["#place-mount-isa"], "one link, not two");
});

await check("finds people and places, without honorifics, possessives or trailing punctuation", () => {
  const { people, places, candidates } = extractNames(TEXT);
  assert.deepEqual(people, ["Dora Leung", "John Smith", "Mary O'Brien"]);
  assert.deepEqual(places, ["Mount Isa", "Queensland", "Palm Island"]);
  assert.deepEqual(candidates, ["Yarrabah"], "other proper names are left for the gazetteer");
});

await check("a name running across a comma is two", () => {
  const { people, candidates } = extractNames("Notes by George Watson, Jambun.");
  assert.deepEqual(people, ["George Watson"]);
  assert.deepEqual(candidates, ["Jambun"]);
});

await check("names of three letters or fewer are dropped", () => {
  const { people, places, candidates } = extractNames("M Dixon met T and Dr Watson at Mt Garnet, then Ayr, Mt and Bulgun.");
  const all = [...people, ...places, ...candidates];
  for (const junk of ["M", "T", "Mt", "Ayr"]) assert.ok(!all.includes(junk), `"${junk}" is dropped`);
  assert.ok(all.includes("Bulgun"), "four letters stay");
  assert.ok(all.some((name) => name.includes("Dixon")), "a name with an initial stays");
});

await check("a people list: one name per line, comments and blanks skipped, each name once", () => {
  assert.deepEqual(
    parseNameList("﻿# consultants\r\nMary O’Brien\n\n  Chloe   Grant \nchloe grant\nAnn\n"),
    ["Mary O’Brien", "Chloe Grant", "Ann"],
  );
});

await check("listed names match whole, in any case, across line breaks, longest first, in the list's spelling", () => {
  const find = createNameMatcher(["Mary O’Brien", "Mary", "Chloe Grant", "Ann", "Jo"]);
  assert.deepEqual(
    find("Met MARY o'brien and Chloe\nGrant in Annerley; Ann's notes. Mary later. Jordan wrote."),
    ["Mary O’Brien", "Chloe Grant", "Ann", "Mary"],
  );
  assert.deepEqual(createNameMatcher([])("Anyone"), []);
});

await check("with a people list, people come from the list, not NER, and a listed name is never a place", () => {
  const findPeople = createNameMatcher(["Chloe Grant", "Tully"]);
  const { people, places, candidates } = extractNames("Dora Leung met Chloe Grant at Mount Isa, Tully and Yarrabah.", { findPeople });
  assert.deepEqual(people, ["Chloe Grant", "Tully"], "Dora Leung, NER's guess, is not a person");
  assert.ok(places.includes("Mount Isa"));
  assert.ok(![...places, ...candidates].includes("Tully"), "listed, so not a place");
  assert.ok(![...places, ...candidates].includes("Dora Leung"), "nor are NER's people places");
});

await check("reads .txt, .md, .docx and .pdf only", async () => {
  assert.ok(["notes.txt", "a/b.MD", "x.docx", "scan.PDF"].every(isReadableForNames));
  assert.ok(!isReadableForNames("song.wav") && !isReadableForNames("sheet.xlsx"));
  assert.equal(await fileText(new TextEncoder().encode("Hello Dora"), "a.txt"), "Hello Dora");
});

await check("reads a PDF's text", async () => {
  const text = await fileText(pdfWithText("Dora Leung visited Mount Isa."), "field-notes.pdf");
  assert.match(text, /Dora Leung visited Mount Isa\./);
});

await check("the gazetteer confirms exact names and partial ones, and says which", async () => {
  const gazetteer = { Yarrabah: "Yarrabah", Dyirbal: "Dyirbal Creek", "Mt Garnet": "Mount Garnet" };
  const lookup = async (name) => (gazetteer[name] ? { matchedName: gazetteer[name] } : null);
  const confirmed = await confirmPlaces(["Yarrabah", "Dyirbal", "Mt Garnet", "Jambun"], lookup);
  assert.deepEqual([...confirmed], [
    ["Yarrabah", { exact: true, matchedName: "Yarrabah" }],
    ["Dyirbal", { exact: false, matchedName: "Dyirbal Creek" }],
    ["Mt Garnet", { exact: true, matchedName: "Mount Garnet" }],
  ]);
});

await check("reuses an existing entity, creates the rest, links each once", () => {
  const crate = new ROCrate({ array: true, link: true });
  crate.addEntity({ "@id": "a.txt", "@type": "File", name: "a.txt", "custom:participant": "" });
  crate.addEntity({ "@id": "#dora_leung", "@type": "Person", name: "Dora Leung", description: "Described by hand" });
  const names = { people: ["Dora Leung", "John Smith"], places: ["Mount Isa"] };

  const counts = linkNamedEntities(crate, { "a.txt": names });
  assert.deepEqual(counts, { created: 2, reused: 1, links: 3 });
  assert.deepEqual(ids(crate.getProperty("a.txt", "custom:participant")), ["#dora_leung", "#john_smith"]);
  assert.deepEqual(ids(crate.getProperty("a.txt", "contentLocation")), ["#place-mount-isa"]);
  assert.deepEqual([].concat(crate.getEntity("#dora_leung").description), ["Described by hand"], "the existing entity is kept as it was");
  assert.ok([].concat(crate.getEntity("#place-mount-isa")["@type"]).includes("Place"));
  assert.equal(crate.getEntity("arcp://name,custom/terms#place"), undefined, "contentLocation is schema.org's: no definition added");

  assert.equal(linkNamedEntities(crate, { "a.txt": names }).links, 0, "a second run adds no duplicate links");
});

await check("a File new to the crate is added so it can be linked", () => {
  const crate = new ROCrate({ array: true, link: true });
  linkNamedEntities(crate, { "notes/new.txt": { people: ["Dora Leung"], places: [] } }, { "notes/new.txt": "new.txt" });
  assert.deepEqual([].concat(crate.getEntity("notes/new.txt").name), ["new.txt"]);
  assert.deepEqual(ids(crate.getProperty("notes/new.txt", "custom:participant")), ["#dora_leung"]);
});

await check("Process alone links the crate: files:prepare is the only tap", async () => {
  const plugin = REGISTRY["name-lookup"]({ readFileBytes: async () => null });
  assert.deepEqual(Object.keys(plugin.hooks), ["files:prepare"]);

  const handleFor = (bytes) => ({ getFile: async () => ({ arrayBuffer: async () => bytes.buffer }) });
  const crate = new ROCrate({ array: true, link: true });
  crate.addEntity({ "@id": "notes.txt", "@type": "File", name: "notes.txt" });
  const ctx = {
    options: { enableNameLookups: true, nameLookupGazetteer: false },
    crate,
    log: () => {},
    filesWithMeta: [
      { id: "notes.txt", relativePath: "notes.txt", fileName: "notes.txt", handle: handleFor(new TextEncoder().encode(TEXT)) },
      { id: "scan.pdf", relativePath: "scan.pdf", fileName: "scan.pdf", handle: handleFor(pdfWithText("Interview with Chloe Grant.")) },
      { id: "song.wav", relativePath: "song.wav", fileName: "song.wav" },
    ],
  };
  await plugin.hooks["files:prepare"].handler(ctx);
  assert.deepEqual(ids(crate.getProperty("notes.txt", "custom:participant")), ["#dora_leung", "#john_smith", "#mary_o_brien"]);
  assert.deepEqual(ids(crate.getProperty("notes.txt", "contentLocation")), ["#place-mount-isa", "#place-queensland", "#place-palm-island"], "Yarrabah needs the gazetteer, which is off");
  assert.deepEqual(ids(crate.getProperty("scan.pdf", "custom:participant")), ["#chloe_grant"]);
  assert.equal(crate.getEntity("song.wav"), undefined);
});

await check("coordinates follow merge's region preference, from the folder's merge-config.json", async () => {
  // Geoscience Australia knows two exact "Cairns" and one "Yarrabah"; GHAP nothing.
  const GA = {
    Cairns: [{ name: "Cairns", latitude: -22.6, longitude: 148.2, authority: "QLD", category: "ADMINISTRATIVE AREA", feature: "COUNTY" },
             { name: "Cairns", latitude: -30.0, longitude: 150.0, authority: "NSW", category: "POPULATED PLACE", feature: "LOCALITY" },
             { name: "Cairns", latitude: -16.9, longitude: 145.7, authority: "QLD", category: "POPULATED PLACE", feature: "POPULATION CENTRE" }],
    Yarrabah: [{ name: "Yarrabah", latitude: -17.0, longitude: 145.9, authority: "QLD" }],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const rows = url.toString().includes("ga.gov.au")
      ? gaNamesAsked(url, init).flatMap((name) => Object.entries(GA).find(([n]) => n.toUpperCase() === name)?.[1] || [])
      : [];
    return new Response(JSON.stringify({ features: rows.map((attributes) => ({ attributes })) }), { headers: { "content-type": "application/json" } });
  };
  try {
    const crate = new ROCrate({ array: true, link: true });
    crate.addEntity({ "@id": "#place-yarrabah", "@type": "Place", name: "Yarrabah", geo: { "@id": "#yarrabah-by-hand" } });
    crate.addEntity({ "@id": "#yarrabah-by-hand", "@type": "Geometry", asWKT: "POINT(1 2)" });
    const plugin = REGISTRY["name-lookup"]({
      readJsonFromFolder: async (_dir, path) => (path === "merge-config.json" ? { placeMatchRegion: "QLD" } : null),
    });
    const bytes = new TextEncoder().encode("We travelled from Cairns to Yarrabah with Chloe Grant.");
    const logs = [];
    const ctx = {
      options: { enableNameLookups: true }, crate, dirHandle: {}, log: (m) => logs.push(m),
      filesWithMeta: [{ id: "trip.txt", relativePath: "trip.txt", fileName: "trip.txt", handle: { getFile: async () => ({ arrayBuffer: async () => bytes.buffer }) } }],
    };
    await plugin.hooks["files:prepare"].handler(ctx);

    assert.deepEqual(ids(crate.getProperty("trip.txt", "contentLocation")), ["#place-cairns", "#place-yarrabah"]);
    assert.deepEqual(ids(crate.getEntity("#place-cairns").geo), ["#location-cairns"]);
    assert.deepEqual([].concat(crate.getEntity("#location-cairns").asWKT), ["POINT(145.7 -16.9)"], "the QLD city: not the QLD county listed first, nor the town in NSW");
    assert.deepEqual(ids(crate.getEntity("#place-yarrabah").geo), ["#yarrabah-by-hand"], "a Place's own coordinates are kept");
    assert.ok(logs.some((m) => /preferring places in QLD/.test(m)), "the log says which region it preferred");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("ties go to the region first, then to a populated place", async () => {
  const { createPlaceLookupService } = await import("./src/_place_lookup.js");
  const county = { name: "Cairns", latitude: -22.6, longitude: 148.2, authority: "QLD", category: "ADMINISTRATIVE AREA", feature: "COUNTY" };
  const nswTown = { name: "Cairns", latitude: -30.0, longitude: 150.0, authority: "NSW", category: "POPULATED PLACE", feature: "LOCALITY" };
  const realFetch = globalThis.fetch;
  const answer = (rows) => {
    globalThis.fetch = async (url) => new Response(
      JSON.stringify({ features: url.toString().includes("ga.gov.au") ? rows.map((attributes) => ({ attributes })) : [] }),
      { headers: { "content-type": "application/json" } });
  };
  const lookup = (region) => createPlaceLookupService({ placeMatchRegion: region, providers: ["geoscience-australia"] }).lookup("Cairns");
  try {
    answer([county, nswTown]);
    assert.equal((await lookup("")).latitude, -30.0, "no region: the populated place over the county");
    assert.equal((await lookup("QLD")).latitude, -22.6, "the preferred region outranks a town elsewhere");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("a partial match is a place too, named as the file has it, and logged — unless exact names only", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const rows = /like upper\('Jambun%'\)/.test(gaWhere(url, init))
      ? [{ name: "Jambun Creek", latitude: -17.9, longitude: 145.9, authority: "QLD", category: "WATERWAY", feature: "CREEK" }]
      : [];
    return new Response(JSON.stringify({ features: rows.map((attributes) => ({ attributes })) }), { headers: { "content-type": "application/json" } });
  };
  try {
    const crate = new ROCrate({ array: true, link: true });
    const plugin = REGISTRY["name-lookup"]({ readJsonFromFolder: async () => null });
    const bytes = new TextEncoder().encode("We camped at Jambun with Chloe Grant.");
    const logs = [];
    await plugin.hooks["files:prepare"].handler({
      options: { enableNameLookups: true }, crate, dirHandle: {}, log: (m) => logs.push(m),
      filesWithMeta: [{ id: "camp.txt", relativePath: "camp.txt", fileName: "camp.txt", handle: { getFile: async () => ({ arrayBuffer: async () => bytes.buffer }) } }],
    });
    assert.deepEqual(ids(crate.getProperty("camp.txt", "contentLocation")), ["#place-jambun"]);
    assert.deepEqual([].concat(crate.getEntity("#place-jambun").name), ["Jambun"], "the name as the file has it, not the gazetteer's");
    assert.deepEqual([].concat(crate.getEntity("#location-jambun").asWKT), ["POINT(145.9 -17.9)"]);
    assert.ok(logs.some((m) => /1 place\(s\) by partial match: Jambun → Jambun Creek/.test(m)), "the partial match is named in the log");

    const exactCrate = new ROCrate({ array: true, link: true });
    await plugin.hooks["files:prepare"].handler({
      options: { enableNameLookups: true, nameLookupExactOnly: true }, crate: exactCrate, dirHandle: {}, log: () => {},
      filesWithMeta: [{ id: "camp.txt", relativePath: "camp.txt", fileName: "camp.txt", handle: { getFile: async () => ({ arrayBuffer: async () => bytes.buffer }) } }],
    });
    assert.equal(exactCrate.getEntity("#place-jambun"), undefined, "with exact names only, Jambun isn't a place");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("answers are kept in the folder: a second run asks nobody; GHAP only when ticked", async () => {
  const folder = new Map(); // path → text, standing in for the picked folder
  const deps = {
    readJsonFromFolder: async (_dir, path) => (folder.has(path) ? JSON.parse(folder.get(path)) : null),
    writeFileAtPath: async (_dir, path, text) => { folder.set(path, text); },
  };
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push(String(url));
    const rows = gaNamesAsked(url, init).includes("YARRABAH")
      ? [{ name: "Yarrabah", latitude: -17.0, longitude: 145.9, authority: "QLD", category: "POPULATED PLACE" }] : [];
    return new Response(JSON.stringify({ features: rows.map((attributes) => ({ attributes })) }), { headers: { "content-type": "application/json" } });
  };
  const bytes = new TextEncoder().encode("We travelled to Yarrabah and Jambun with Chloe Grant.");
  const run = async (options) => {
    const crate = new ROCrate({ array: true, link: true });
    await REGISTRY["name-lookup"](deps).hooks["files:prepare"].handler({
      options: { enableNameLookups: true, nameLookupExactOnly: true, ...options }, crate, dirHandle: {}, log: () => {},
      filesWithMeta: [{ id: "trip.txt", relativePath: "trip.txt", fileName: "trip.txt", handle: { getFile: async () => ({ arrayBuffer: async () => bytes.buffer }) } }],
    });
    return crate;
  };
  try {
    const first = await run({});
    assert.deepEqual(ids(first.getProperty("trip.txt", "contentLocation")), ["#place-yarrabah"]);
    assert.equal(requests.length, 1, "first run: one batched GA request");
    assert.ok(!requests.some((u) => u.includes("tlcmap.org")), "GHAP isn't asked unless ticked");
    const saved = JSON.parse(folder.get(CACHE_PATH));
    const names = Object.values(saved.lookups)[0].names;
    assert.equal(names.yarrabah.latitude, -17.0);
    assert.equal(names.jambun, null, "a definite miss is kept too");

    requests.length = 0;
    const second = await run({});
    assert.equal(requests.length, 0, "second run: answered from the folder");
    assert.deepEqual([].concat(second.getEntity("#location-yarrabah").asWKT), ["POINT(145.9 -17)"]);

    await run({ nameLookupGhap: true });
    assert.ok(requests.some((u) => u.includes("tlcmap.org") && u.includes("Jambun")), "with GHAP ticked, GA's misses go to GHAP");
    assert.equal(Object.keys(JSON.parse(folder.get(CACHE_PATH)).lookups).length, 2, "kept apart from the GA-only answers");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("Process with an uploaded people list links the listed people only", async () => {
  const crate = new ROCrate({ array: true, link: true });
  const bytes = new TextEncoder().encode("Dora Leung recorded Chloe Grant and Ann Smith at Mount Isa.");
  const logs = [];
  await REGISTRY["name-lookup"]({}).hooks["files:prepare"].handler({
    options: {
      enableNameLookups: true, nameLookupGazetteer: false,
      nameLookupPeopleFile: "people.txt",
      nameLookupPeopleUpload: { name: "people.txt", file: { text: async () => "Chloe Grant\nAnn Smith\nNobody Here\n" } },
    },
    crate, log: (m) => logs.push(m),
    filesWithMeta: [{ id: "notes.txt", relativePath: "notes.txt", fileName: "notes.txt", handle: { getFile: async () => ({ arrayBuffer: async () => bytes.buffer }) } }],
  });
  assert.deepEqual(ids(crate.getProperty("notes.txt", "custom:participant")), ["#chloe_grant", "#ann_smith"]);
  assert.equal(crate.getEntity("#dora_leung"), undefined, "NER's person is not used");
  assert.deepEqual(ids(crate.getProperty("notes.txt", "contentLocation")), ["#place-mount-isa"], "places still come from NER");
  assert.ok(logs.some((m) => /3 name\(s\) in people\.txt/.test(m)), "the log says the list is in use");
});

await check("no coordinates for a place the crate doesn't hold", async () => {
  const crate = new ROCrate({ array: true, link: true });
  const counts = await addPlaceCoordinates(crate, new Map([["Nowhere", { latitude: 1, longitude: 2, asWKT: "POINT(2 1)" }]]));
  assert.deepEqual(counts, { placed: 0, kept: 0 });
});

await check("off by default; the gazetteer is on once the option is", () => {
  const plugin = REGISTRY["name-lookup"]({});
  assert.equal(plugin.optionSchema.default, false);
  const gazetteer = plugin.optionSchema.children.find((c) => c.key === "nameLookupGazetteer");
  assert.equal(gazetteer.default, true);
  assert.equal(gazetteer.children.find((c) => c.key === "nameLookupGhap").default, false, "GHAP, the slow part, is opt-in");
  assert.equal(plugin.hooks["files:prepare"].activeWhen({ options: {} }), false);
});

if (failures) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
