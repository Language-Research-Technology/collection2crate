// Seam: core graph assembly and serialisation.
//
// Nothing is mocked (SPEC.md §9.1): real ro-crate, real ro-crate-excel, real
// ro-crate-static-site. A test that passed against a stub of ro-crate would
// prove nothing about a tool whose entire job is driving ro-crate correctly.

import assert from "node:assert/strict";
import {
  buildFileMetadata, buildCrate, collectTypeCounts, normaliseForDuplicates,
  crateToJsonString, crateToXlsxBytes, crateToPreviewHtml, addLanguageEntities,
} from "../src/crate.js";

// A profile now supplies what a defaults module used to, so each suite defines
// a minimal inline config standing in for one.
const TEST_CONFIG = {
  rootDataset: {
    type: ["Dataset"],
    name: "Test collection",
    description: "A collection assembled by the test suite.",
    datePublished: "2026-01-01",
    license: "https://creativecommons.org/licenses/by/4.0/",
  },
  metadataLicence: { "@id": "https://creativecommons.org/licenses/by/4.0/" },
  fileProperties: {
    "custom:noteField": {
      "@id": "arcp://name,custom/terms#noteField",
      "@type": "rdf:Property",
      name: "Note",
      description: "A free-text note about a file.",
    },
    "custom:possibleDuplicate": {
      "@id": "arcp://name,custom/terms#possibleDuplicate",
      "@type": "rdf:Property",
      name: "Possible duplicate",
      description: "Another file in this crate with a suspiciously similar name.",
    },
  },
  propertyGroups: [{ name: "About", inputs: ["http://schema.org/name", "http://schema.org/description"] }],
};

const FILES = [
  { name: "song.wav", relativePath: "Dyirbal/audio/song.wav" },
  { name: "song copy.wav", relativePath: "Dyirbal/audio/song copy.wav" },
  { name: "notes.txt", relativePath: "Dyirbal/notes.txt" },
  { name: "wordlist.csv", relativePath: "Warlpiri/wordlist.csv" },
];

const noLog = () => {};
const byId = (crate, id) => crate.getEntity(id);
const ids = (value) => [].concat(value ?? []).map((v) => (v && typeof v === "object" ? v["@id"] : v));

/* ---------- file metadata: id, folder chain, duplicate cross-linking ---------- */

{
  const meta = buildFileMetadata(FILES);
  const song = meta.find((f) => f.fileName === "song.wav");

  assert.equal(song.id, "Dyirbal/audio/song.wav",
    "A file's @id is its path relative to the picked folder — that is the crate's link back to disk");
  assert.deepEqual(song.folderChain, ["Dyirbal", "audio"],
    "The folder chain records every directory above the file, in order");
  assert.equal(song.topLevel, "Dyirbal",
    "topLevel is the first folder under the picked folder, which is what becomes a folder entity");

  assert.equal(normaliseForDuplicates("Report (2).docx"), "report",
    "Duplicate normalisation strips the extension and a (2)-style suffix");
  assert.equal(normaliseForDuplicates("report copy.docx"), "report",
    "Duplicate normalisation strips a 'copy' marker");
  assert.equal(normaliseForDuplicates("RE-PORT.docx"), "report",
    "Duplicate normalisation lowercases and collapses non-alphanumerics");

  assert.deepEqual(song.possibleDuplicates, ["Dyirbal/audio/song copy.wav"],
    "A normalised-name collision is recorded as a possible duplicate");
  assert.deepEqual(
    meta.find((f) => f.fileName === "song copy.wav").possibleDuplicates,
    ["Dyirbal/audio/song.wav"],
    "Collisions are cross-linked both ways, so either file leads a reader to the other"
  );
  assert.deepEqual(meta.find((f) => f.fileName === "notes.txt").possibleDuplicates, [],
    "A file with no name collision carries no duplicate links");
}

/* ---------- object mode: one RepositoryObject per top-level folder ---------- */

{
  const crate = buildCrate(buildFileMetadata(FILES), TEST_CONFIG, noLog, { topLevelFolderType: "object" });
  const counts = collectTypeCounts(crate.getGraph());

  assert.equal(counts.RepositoryObject, 2,
    "Object mode emits exactly one RepositoryObject per top-level folder");
  assert.equal(counts.RepositoryCollection, undefined,
    "Object mode emits no RepositoryCollection entities at all");

  const dyirbal = byId(crate, "arcp://name,corpus/Dyirbal");
  assert.ok(dyirbal, "Structural hash ids are rewritten to arcp:// form, which is absolute, on export");
  assert.deepEqual(
    ids(dyirbal.hasPart).sort(),
    ["Dyirbal/audio/song copy.wav", "Dyirbal/audio/song.wav", "Dyirbal/notes.txt"],
    "Every file beneath a top-level folder, however deeply nested, is in that one object's hasPart"
  );
  assert.deepEqual(ids(byId(crate, "Dyirbal/notes.txt").isPartOf), ["arcp://name,corpus/Dyirbal"],
    "Each file links back up to its folder entity via isPartOf");
  assert.ok(ids(crate.rootDataset.hasPart).includes("arcp://name,corpus/Dyirbal"),
    "Top-level folder entities hang off the root dataset");

  assert.equal([].concat(crate.rootDataset.name)[0], "Test collection",
    "The profile-derived root dataset properties are applied to the root");
}

/* ---------- collection mode: nested folders link back via pcdm:memberOf ---------- */

{
  const crate = buildCrate(buildFileMetadata(FILES), TEST_CONFIG, noLog, { topLevelFolderType: "collection" });
  const top = byId(crate, "arcp://name,corpus/Dyirbal");
  const subObj = byId(crate, "arcp://name,corpus/Dyirbal_audio");
  const filesObj = byId(crate, "arcp://name,corpus/Dyirbal_Files");

  assert.deepEqual([].concat(top["@type"]), ["RepositoryCollection"],
    "Collection mode makes each top-level folder a RepositoryCollection");
  assert.ok(subObj, "Each subfolder of a top-level folder becomes its own child RepositoryObject");
  assert.deepEqual(
    ids(subObj["pcdm:memberOf"]),
    [top["@id"]],
    "Nested folder object should be linked back to top-level collection via pcdm:memberOf"
  );
  assert.ok(ids(top["pcdm:hasMember"]).includes(subObj["@id"]),
    "The collection lists each child object in pcdm:hasMember");

  assert.ok(filesObj,
    "Files sitting directly in a top-level folder get a synthesised <Name>_Files object rather than hanging off the collection");
  assert.deepEqual(ids(byId(crate, "Dyirbal/notes.txt").isPartOf), [filesObj["@id"]],
    "A loose top-level file belongs to the synthesised _Files object");
  assert.deepEqual(ids(byId(crate, "Dyirbal/audio/song.wav").isPartOf), [subObj["@id"]],
    "A file inside a subfolder belongs to that subfolder's object");
}

/* ---------- profile-declared file properties ---------- */

{
  const crate = buildCrate(buildFileMetadata(FILES), TEST_CONFIG, noLog);
  const notes = byId(crate, "Dyirbal/notes.txt");
  const song = byId(crate, "Dyirbal/audio/song.wav");

  assert.equal([].concat(notes["custom:noteField"])[0], "",
    "Every property the profile declares in fileProperties is blank-initialised on every File");
  assert.ok(byId(crate, "arcp://name,custom/terms#noteField"),
    "The rdf:Property definition for a declared file property is added to the graph");

  assert.deepEqual(ids(song["custom:possibleDuplicate"]), ["Dyirbal/audio/song copy.wav"],
    "custom:possibleDuplicate is written where duplicates were actually found");
  assert.equal(notes["custom:possibleDuplicate"], undefined,
    "custom:possibleDuplicate is the one property NOT blank-initialised — it is written only where a duplicate exists");

  const noDuplicates = buildCrate(
    buildFileMetadata([{ name: "only.txt", relativePath: "X/only.txt" }]), TEST_CONFIG, noLog
  );
  assert.equal(noDuplicates.getEntity("arcp://name,custom/terms#possibleDuplicate"), undefined,
    "With no duplicates found, even the duplicate property's definition stays out of the graph — nothing is added unconditionally");

  const noProperties = buildCrate(buildFileMetadata(FILES), { rootDataset: { type: ["Dataset"] } }, noLog);
  assert.equal(noProperties.getEntity("Dyirbal/notes.txt")["custom:noteField"], undefined,
    "A profile that declares no fileProperties gets no custom fields written onto its Files");
}

/* ---------- structure from supplied metadata invents no folder entities ---------- */

{
  const crate = buildCrate(buildFileMetadata(FILES), TEST_CONFIG, noLog, { structureFromMetadata: true });
  const counts = collectTypeCounts(crate.getGraph());

  assert.equal(counts.RepositoryObject, undefined,
    "When a spreadsheet already describes what belongs to what, the folder scan must not invent a parallel structure");
  assert.equal(counts.File, 4, "Every scanned file still becomes a File entity");
  assert.ok(ids(crate.rootDataset.hasPart).includes("Dyirbal/notes.txt"),
    "With no folder entities to hold them, files attach directly to the root dataset");
}

/* ---------- reconciling against an existing crate rather than replacing it ---------- */

{
  const first = buildCrate(buildFileMetadata(FILES), TEST_CONFIG, noLog);
  byId(first, "Dyirbal/notes.txt")["custom:noteField"] = ["hand-written by a person"];
  const existingJson = JSON.parse(crateToJsonString(first));

  const second = buildCrate(buildFileMetadata(FILES), TEST_CONFIG, noLog, { existingJson });
  assert.equal([].concat(byId(second, "Dyirbal/notes.txt")["custom:noteField"])[0], "hand-written by a person",
    "A rebuild reconciles against the folder's existing crate instead of replacing it, so typed-in values survive");
  assert.equal(collectTypeCounts(second.getGraph()).File, 4,
    "Reconciling does not duplicate the file entities it already had");
}

/* ---------- arcp:// namespace follows an existing crate, not a hardcoded default ---------- */

{
  // A crate authored elsewhere (not by this tool), with its RepositoryObject
  // already minted under the collection's own namespace rather than "corpus".
  const FOREIGN_NAMESPACE = "2026-ldaca-community-workshops-gooreng-gooreng";
  const existingJson = {
    "@context": ["https://w3id.org/ro/crate/1.1/context"],
    "@graph": [
      { "@id": "ro-crate-metadata.json", "@type": "CreativeWork", about: { "@id": "./" } },
      { "@id": "./", "@type": "Dataset", name: "Test collection", hasPart: [{ "@id": `arcp://name,${FOREIGN_NAMESPACE}/Dyirbal` }] },
      {
        "@id": `arcp://name,${FOREIGN_NAMESPACE}/Dyirbal`,
        "@type": "RepositoryObject",
        name: "Dyirbal",
        hasPart: [{ "@id": "Dyirbal/notes.txt" }],
      },
      { "@id": "Dyirbal/notes.txt", "@type": "File", name: "notes.txt", isPartOf: [{ "@id": `arcp://name,${FOREIGN_NAMESPACE}/Dyirbal` }] },
    ],
  };

  const crate = buildCrate(buildFileMetadata(FILES), TEST_CONFIG, noLog, { existingJson });

  assert.ok(crate.getEntity(`arcp://name,${FOREIGN_NAMESPACE}/Dyirbal`),
    "The folder entity the existing crate already had, under its own namespace, is reused");
  assert.equal(byId(crate, "arcp://name,corpus/Dyirbal"), undefined,
    "No duplicate 'Dyirbal' entity is minted under this tool's default namespace");
  assert.ok(ids(byId(crate, "Dyirbal/audio/song.wav").isPartOf).includes(`arcp://name,${FOREIGN_NAMESPACE}/Dyirbal`),
    "A newly-scanned file under the same folder links to the reused, foreign-namespaced entity");

  assert.ok(byId(crate, `arcp://name,${FOREIGN_NAMESPACE}/Warlpiri`),
    "A brand-new top-level folder is minted under the namespace the existing crate already uses, not 'corpus'");
  assert.equal(byId(crate, "arcp://name,corpus/Warlpiri"), undefined,
    "The default namespace is never used once the crate has adopted another one");
}

/* ---------- language entities ---------- */

{
  const meta = buildFileMetadata(FILES);
  const crate = buildCrate(meta, TEST_CONFIG, noLog);
  const langById = new Map([
    ["Dyirbal/notes.txt", { matchedLanguages: [{ "@id": "#AUSTLANG_Y123", name: "Dyirbal", "custom:austlangCode": "Y123" }] }],
    ["Warlpiri/wordlist.csv", { matchedLanguages: [{ "@id": "#AUSTLANG_C15", name: "Warlpiri" }] }],
  ]);

  assert.equal(addLanguageEntities(crate, meta, langById), 2,
    "addLanguageEntities reports how many distinct languages it added, not how many files matched");
  assert.deepEqual(ids(byId(crate, "Dyirbal/notes.txt")["ldac:subjectLanguage"]), ["#AUSTLANG_Y123"],
    "A matched language is linked from the file as ldac:subjectLanguage");
  assert.ok(byId(crate, "#AUSTLANG_Y123"),
    "The language entity itself is added to the graph, not just referenced");
}

/* ---------- collectTypeCounts ---------- */

{
  const counts = collectTypeCounts([
    { "@type": "File" }, { "@type": ["File", "SoftwareSourceCode"] }, { "@type": "Person" }, {},
  ]);
  assert.deepEqual(counts, { File: 2, SoftwareSourceCode: 1, Person: 1 },
    "An entity with several types counts once under each, and an untyped entity counts under none");
}

/* ---------- all three real outputs generate from a built crate ---------- */

{
  const crate = buildCrate(buildFileMetadata(FILES), TEST_CONFIG, noLog);

  const json = JSON.parse(crateToJsonString(crate));
  assert.ok(Array.isArray(json["@graph"]), "crateToJsonString produces parseable RO-Crate JSON-LD");
  assert.ok(json["@graph"].some((e) => e["@id"] === "ro-crate-metadata.json"),
    "The serialised crate carries its metadata descriptor");

  const bytes = await crateToXlsxBytes(crate);
  assert.ok(bytes.byteLength > 0, "crateToXlsxBytes produces a non-empty workbook through real ro-crate-excel");
  assert.deepEqual(
    [...new Uint8Array(bytes.slice(0, 2))], [0x50, 0x4b],
    "The workbook bytes start with the PK signature of a real .xlsx (zip) file"
  );

  const html = await crateToPreviewHtml(crate, { layouts: { default: TEST_CONFIG.propertyGroups } });
  assert.ok(html.includes("Test collection"),
    "crateToPreviewHtml renders the crate through real ro-crate-static-site");

  await assert.rejects(
    () => crateToPreviewHtml(crate, { layouts: { default: [] } }),
    /no property groups supplied/,
    "With no property groups the preview must throw rather than fetch a default layout from GitHub at render time — a silent generic fallback would hide a profile misconfiguration"
  );

  // The styled branch: a template's layout rides in config.propertyGroups, not
  // in layouts.default. Both shapes go through this one function because that
  // is what collection2crate-plugins' ro-crate-html-output calls — the two
  // drifted apart once already, and the symptom was every styled build failing
  // with "no property groups supplied" while the profile had eight of them.
  const styled = await crateToPreviewHtml(crate, {
    template: "<h1>{{ data.name }}</h1><p>{{ layout.length }} group(s), {{ config.propertyGroups.length }} in config.</p>",
    config: { propertyGroups: TEST_CONFIG.propertyGroups, multipage: false },
    css: "h1 { color: red }",
  });
  assert.match(styled, /<h1>/, "A template preview renders through ro-crate-static-site's renderTemplate");
  assert.match(styled, new RegExp(`${TEST_CONFIG.propertyGroups.length} group\\(s\\)`),
    "The template is handed the resolved layout, and the same groups in config.propertyGroups");

  // A template config that declares pages is still renderable as one page:
  // this function renders a single page whatever the config says, rather than
  // failing inside the library's multipage pass on a missing root template.
  assert.match(
    await crateToPreviewHtml(crate, {
      template: "<h1>{{ data.name }}</h1>",
      config: { propertyGroups: TEST_CONFIG.propertyGroups, types: { RepositoryObject: {} } },
    }),
    /<h1>/,
    "A multipage-shaped config renders as a single page here rather than crashing in roCrateToJSON"
  );

  await assert.rejects(
    () => crateToPreviewHtml(crate, { template: "<h1>x</h1>", config: {} }),
    /config\.propertyGroups/,
    "A styled preview with no layout in its config throws, naming where the groups were missing from"
  );
}

console.log(
  "test-crate: all tests passed (file metadata + duplicates, object and collection modes, " +
  "profile file properties, structureFromMetadata, existing-crate reconcile, arcp:// namespace " +
  "adoption, language entities, type counts, and all three real outputs)"
);
