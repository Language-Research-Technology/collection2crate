// Seam: the folder's existing crate (SPEC.md §4.4a) — which file it is read
// from, how its File entities line up with the folder, the crate a build is
// seeded with, and buildCrate adding to that seed rather than replacing it.
//
// Real ro-crate and ro-crate-excel throughout. The only stand-in is the
// directory: pickNewestCrateSource takes its stat function as an argument, so
// a Map of File-like objects plays the folder.

import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import {
  CRATE_SOURCES, pickNewestCrateSource, loadExistingCrate, localFileIds,
  reconcileFiles, resolveDecisions, withoutIgnored, seedFromExisting, openCrate,
} from "../src/existing_crate.js";
import {
  buildFileMetadata, buildCrate, crateToJsonString, crateToXlsxBytes, collectTypeCounts, mergeCrateInto,
} from "../src/crate.js";

const noLog = () => {};
const CONFIG = { rootDataset: { type: ["Dataset"], name: "Test collection" } };
const FILES = [
  { name: "a.txt", relativePath: "Dyirbal/a.txt" },
  { name: "b.wav", relativePath: "Dyirbal/sub/b.wav" },
  { name: "c.txt", relativePath: "c.txt" },
];
const ids = (value) => [].concat(value || []).map((v) => (v && typeof v === "object" ? v["@id"] : v));
const toJson = (crate) => JSON.parse(crateToJsonString(crate));
const firstBuild = (opts = {}) => buildCrate(buildFileMetadata(FILES), CONFIG, noLog, opts);

// A fake folder: name -> File-like. The dirHandle argument only has to be truthy.
const folder = (entries) => {
  const map = new Map(entries);
  return { dir: {}, stat: async (_dir, name) => map.get(name) || null };
};
const jsonFile = (json, lastModified) => ({
  lastModified,
  text: async () => (typeof json === "string" ? json : JSON.stringify(json)),
});
const xlsxFile = (bytes, lastModified) => ({
  lastModified,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

/* ---------- which file the existing crate comes from ---------- */

assert.deepEqual(CRATE_SOURCES.map((s) => s.name), ["ro-crate-metadata.json", "ro-crate-metadata.xlsx"],
  "Only the core's own two outputs are candidates — additional-ro-crate-metadata.xlsx belongs to the merge plugin");

{
  const { dir, stat } = folder([
    ["ro-crate-metadata.json", jsonFile({}, 1000)],
    ["ro-crate-metadata.xlsx", xlsxFile(new Uint8Array(), 1000)],
  ]);
  assert.equal((await pickNewestCrateSource(dir, stat)).name, "ro-crate-metadata.json",
    "A tie — the build writes both in the same run — goes to the JSON");
}

{
  const { dir, stat } = folder([
    ["ro-crate-metadata.json", jsonFile({}, 1000)],
    ["ro-crate-metadata.xlsx", xlsxFile(new Uint8Array(), 2000)],
  ]);
  assert.equal((await pickNewestCrateSource(dir, stat)).name, "ro-crate-metadata.xlsx",
    "A spreadsheet edited after the last build is the one the author has been working in");
}

{
  const { dir, stat } = folder([["additional-ro-crate-metadata.xlsx", xlsxFile(new Uint8Array(), 5000)]]);
  assert.equal(await pickNewestCrateSource(dir, stat), null, "A folder with neither output has no existing crate");
  assert.equal(await loadExistingCrate(dir, noLog, stat), null);
  assert.equal(await pickNewestCrateSource(null, stat), null, "No folder, no crate");
}

{
  // A real spreadsheet round-trip: the xlsx the build writes reads back as the same entities.
  const crate = firstBuild();
  const bytes = await crateToXlsxBytes(crate);
  const { dir, stat } = folder([["ro-crate-metadata.xlsx", xlsxFile(bytes, 3000)]]);
  const loaded = await loadExistingCrate(dir, noLog, stat);
  assert.equal(loaded.sourceName, "ro-crate-metadata.xlsx");
  assert.ok(loaded.label.startsWith("ro-crate-metadata.xlsx (modified "), "The label names the file the values came from");
  assert.deepEqual(localFileIds(loaded.json).sort(), FILES.map((f) => f.relativePath).sort(),
    "Reading the spreadsheet gives back every File entity the build wrote");
}

{
  const lines = [];
  const good = toJson(firstBuild());
  const { dir, stat } = folder([
    ["ro-crate-metadata.json", jsonFile(good, 1000)],
    ["ro-crate-metadata.xlsx", xlsxFile(new Uint8Array([1, 2, 3]), 2000)],
  ]);
  const loaded = await loadExistingCrate(dir, (m, l) => lines.push(`${l}:${m}`), stat);
  assert.equal(loaded.sourceName, "ro-crate-metadata.json",
    "A spreadsheet that won't parse falls back to the JSON beside it");
  assert.ok(lines.some((l) => l.startsWith("warn:Could not read ro-crate-metadata.xlsx")), "and says so");
}

{
  const { dir, stat } = folder([["ro-crate-metadata.json", jsonFile("{ not json", 1000)]]);
  const lines = [];
  assert.equal(await loadExistingCrate(dir, (m) => lines.push(m), stat), null,
    "Unreadable JSON with nothing to fall back on is no existing crate, not a crash");
  assert.ok(lines[0].includes("is not valid JSON"));
}

/* ---------- reconciling File entities with the folder ---------- */

{
  const json = toJson(firstBuild());
  json["@graph"].push(
    { "@id": "gone.txt", "@type": "File", name: "gone.txt" },
    { "@id": "has%20space.txt", "@type": "File" },
    { "@id": "https://example.org/remote.pdf", "@type": "File" },
    { "@id": "#fragment", "@type": "File" },
    { "@id": "c2c-output/derived.csv", "@type": "File" },
  );
  const scanned = ["Dyirbal/a.txt", "Dyirbal/sub/b.wav", "c.txt", "has space.txt", "new/one.txt"];
  const result = reconcileFiles(json, scanned, { isExcluded: (p) => p.startsWith("c2c-output/") });

  assert.deepEqual(result.matched, ["Dyirbal/a.txt", "Dyirbal/sub/b.wav", "c.txt", "has space.txt"],
    "A percent-encoded @id matches the path the scan found");
  assert.deepEqual(result.newFiles, ["new/one.txt"], "A scanned path with no File entity is new");
  assert.deepEqual(result.missingFiles, ["gone.txt"],
    "Only local File entities can be missing — not remote URLs, not fragments, not output the scan skips on purpose");

  assert.deepEqual(reconcileFiles(null, scanned), { matched: [], newFiles: [], missingFiles: [] },
    "No existing crate means nothing to reconcile — every file is simply built");
}

{
  const result = { newFiles: ["n1", "n2"], missingFiles: ["m1", "m2"] };
  assert.deepEqual(resolveDecisions(result), { ignore: [], keep: [], remove: ["m1", "m2"] },
    "By default every new file is added and every missing entity removed");
  assert.deepEqual(
    resolveDecisions(result, { ignore: ["n2", "stale"], keep: ["m1", "stale"] }),
    { ignore: ["n2"], keep: ["m1"], remove: ["m2"] },
    "Choices are departures from the defaults, and ones that no longer apply are dropped"
  );
  const files = [{ relativePath: "n1" }, { relativePath: "n2" }, { relativePath: "x" }];
  assert.deepEqual(withoutIgnored(files, ["n2"]).map((f) => f.relativePath), ["n1", "x"],
    "An ignored file leaves the scan result, so no plugin sees it");
  assert.equal(withoutIgnored(files, []), files, "Nothing ignored leaves the list untouched");
}

/* ---------- seeding a build ---------- */

{
  const empty = seedFromExisting({ existingCrate: null });
  assert.ok(empty instanceof ROCrate, "No existing crate: a run still starts from a crate — an empty one");
  assert.deepEqual(empty.getGraph().map((e) => e["@id"]).sort(), ["./", "ro-crate-metadata.json"],
    "…holding only the root and the descriptor");
  assert.ok(empty.context.some((entry) => entry && entry.ldac), "…with this tool's context");
  assert.notEqual(seedFromExisting({}), seedFromExisting({}), "Every run gets its own object");
}

{
  const json = toJson(firstBuild());
  const opened = openCrate(json);
  opened.rootDataset.name = ["Changed"];
  assert.notDeepEqual(json["@graph"].find((e) => e["@id"] === "./").name, ["Changed"],
    "openCrate clones, so the working crate's JSON never changes under it");
}

{
  // A Build that continues Process starts from Process's snapshot, not the folder's crate.
  const existing = toJson(firstBuild());
  const prepared = structuredClone(existing);
  prepared["@graph"].push({ "@id": "#from-process", "@type": "Thing", name: "added during Process" });
  const seed = seedFromExisting({ existingCrate: existing, preparedCrate: prepared, fileDecisions: { remove: ["c.txt"] } });
  assert.ok(seed.getEntity("#from-process"), "The Process snapshot is the starting point");
  assert.equal(seed.getEntity("c.txt"), undefined, "Removals still apply");
  assert.ok(!existing["@graph"].some((e) => e["@id"] === "#from-process"), "The folder's crate is untouched");
}

{
  const json = toJson(firstBuild());
  const before = JSON.stringify(json);
  const lines = [];
  const seed = seedFromExisting({
    existingCrate: json,
    fileDecisions: { remove: ["Dyirbal/a.txt", "not-there.txt"], keep: ["c.txt"] },
    log: (m, l) => lines.push(`${l}:${m}`),
  });
  assert.ok(seed instanceof ROCrate);
  assert.equal(seed.getEntity("Dyirbal/a.txt"), undefined, "A removed file entity is gone from the seed");
  assert.ok(!seed.getGraph().some((e) => Object.values(e).some((v) => ids(v).includes("Dyirbal/a.txt"))),
    "…and nothing still points at it");
  assert.ok(seed.getEntity("Dyirbal/sub/b.wav"), "Everything else is carried");
  assert.equal(JSON.stringify(json), before, "Seeding never edits the loaded JSON, so a failed build can't half-apply");
  assert.ok(lines.some((l) => l.startsWith("warn:") && l.includes("c.txt")),
    "A kept entity with no file behind it is named in the build log");
}

/* ---------- buildCrate adds to a seeded crate ---------- */

for (const topLevelFolderType of ["object", "collection"]) {
  const first = firstBuild({ topLevelFolderType });
  const json = toJson(first);
  const seed = new ROCrate(structuredClone(json), { array: true, link: true });
  const second = buildCrate(buildFileMetadata(FILES), CONFIG, noLog, { crate: seed, topLevelFolderType });

  assert.equal(second, seed, `(${topLevelFolderType}) The builder adds to the seeded crate — same object back`);
  assert.deepEqual(collectTypeCounts(second.getGraph()), collectTypeCounts(first.getGraph()),
    `(${topLevelFolderType}) Rebuilding an unchanged folder adds nothing — folder entities are not minted twice`);
  assert.ok(!second.getGraph().some((e) => String(e["@id"]).startsWith("#")),
    `(${topLevelFolderType}) No #-prefixed folder entity appears beside its arcp:// twin`);
  assert.equal(toJson(second)["@context"].length, json["@context"].length,
    `(${topLevelFolderType}) The context isn't appended again on every rebuild`);
}

{
  const first = firstBuild();
  const json = toJson(first);
  const a = json["@graph"].find((e) => e["@id"] === "Dyirbal/a.txt");
  a.name = ["Hand-named"];
  a.isPartOf = [{ "@id": "./" }];
  json["@graph"].find((e) => e["@id"] === "./").hasPart.push({ "@id": "Dyirbal/a.txt" });
  const oldFolder = json["@graph"].find((e) => e["@id"] === "arcp://name,corpus/Dyirbal");
  oldFolder.hasPart = [].concat(oldFolder.hasPart).filter((ref) => ref["@id"] !== "Dyirbal/a.txt");

  const seed = new ROCrate(json, { array: true, link: true });
  const more = [...FILES, { name: "d.txt", relativePath: "Dyirbal/d.txt" }];
  const crate = buildCrate(buildFileMetadata(more), CONFIG, noLog, { crate: seed });

  const entity = crate.getEntity("Dyirbal/a.txt");
  assert.deepEqual(ids(entity.name), ["Hand-named"], "An existing value wins over what the scan would write");
  assert.deepEqual(ids(entity.isPartOf), ["./"], "A file the user moved in the crate stays where they put it");
  const folderEntity = crate.getEntity("arcp://name,corpus/Dyirbal");
  assert.ok(!ids(folderEntity.hasPart).includes("Dyirbal/a.txt"), "…and isn't linked back into its old folder");
  assert.ok(crate.getEntity("Dyirbal/d.txt"), "A new file is added");
  assert.ok(ids(folderEntity.hasPart).includes("Dyirbal/d.txt"), "…under the folder entity the crate already had");
}

{
  const existing = toJson(firstBuild());
  const edited = structuredClone(existing);
  edited["@graph"].push({ "@id": "#typed-in", "@type": "Thing" });
  assert.ok(seedFromExisting({ existingCrate: existing, startingCrate: edited }).getEntity("#typed-in"),
    "The working crate — unsaved edits included — is the starting point ahead of the folder's file");
  assert.ok(seedFromExisting({ existingCrate: null, startingCrate: edited }).getEntity("#typed-in"),
    "…including when the folder has no crate file yet");
}

/* ---------- the Describe form reaches the seed ---------- */

{
  const json = toJson(firstBuild());
  const seed = seedFromExisting({
    existingCrate: json,
    config: { rootDataset: { type: ["Dataset"], name: "Renamed in the form", description: "" } },
  });
  assert.deepEqual(ids(seed.rootDataset.name), ["Renamed in the form"],
    "The form's values replace the existing root's, whichever builder runs next");
}

/* ---------- mergeCrateInto: a builder's own crate lands in the seed ---------- */

{
  const target = new ROCrate(toJson(firstBuild()), { array: true, link: true });
  target.getEntity("c.txt").description = ["Typed by hand"];

  const source = new ROCrate({ array: true, link: true });
  source.addContext({ extra: "https://example.org/extra#" });
  source.rootDataset.name = ["Builder's own name"];
  source.rootDataset.hasMember = [{ "@id": "#doc1" }];
  source.addEntity({ "@id": "#doc1", "@type": "RepositoryObject", name: "doc1", memberOf: { "@id": "./" } });
  source.addEntity({ "@id": "c.txt", "@type": ["File", "extra:Thing"], description: "Parsed", encodingFormat: "text/plain" });

  const { added, enriched } = mergeCrateInto(target, source);
  assert.equal(added, 1, "An entity the seed lacks is added");
  assert.ok(enriched >= 2, "Entities it has are enriched, not replaced");
  assert.deepEqual(ids(target.rootDataset.name), ["Test collection"], "The root keeps its existing name");
  assert.deepEqual(ids(target.rootDataset.hasMember), ["#doc1"], "…and gains the builder's members");
  const c = target.getEntity("c.txt");
  assert.deepEqual(ids(c.description), ["Typed by hand"], "An existing value wins");
  assert.deepEqual(ids(c.encodingFormat), ["text/plain"], "A missing value is filled in");
  assert.ok([].concat(c["@type"]).includes("extra:Thing"), "Types are unioned");
  assert.ok(target.context.some((entry) => entry && entry.extra), "The builder's context comes too");
  assert.deepEqual(ids(target.getEntity("#doc1").memberOf), [target.rootId],
    "A reference to the builder's root points at the seed's root");
  assert.equal(target.getGraph().filter((e) => e["@id"] === "ro-crate-metadata.json").length, 1,
    "The descriptor isn't duplicated");

  const again = mergeCrateInto(target, source);
  assert.deepEqual(again, { added: 0, enriched: 0 }, "Merging the same crate twice changes nothing");
}

console.log(
  "test-existing-crate: all tests passed (source choice + json tie-break, xlsx round-trip and fallback, " +
  "reconcile sets incl. encoded/remote/excluded ids, decisions, ignored files, seeding with removal, " +
  "buildCrate adding to a seed without duplicates, form values on the seed, mergeCrateInto)"
);
