// "Publish subset only" (ro-crate-html-output's publishOnly option) removes
// every collection/object/file under the root that doesn't resolve to
// published, before the crate is handed to crateToPreviewHtml/
// crateToMultiPageHtml. custom:publish:true cascades down from a
// RepositoryCollection to its RepositoryObjects/Files, but an entity's own
// custom:publish:true/false always overrides whatever it inherited —
// including reviving an object or file nested inside an otherwise-
// unpublished collection. Namespaced like every other non-standard term
// this codebase adds (custom:participant, custom:compiler, ...) — a
// ro-crate-excel spreadsheet (see xlsx-crate-input) carries this as a
// custom:publish column, typically on the @type=File sheet rather than
// RepositoryObject/Collection.
//
// Fixtures deliberately mirror buildCrate()'s real linking convention
// (collection2crate's src/crate.js): the root dataset and every
// RepositoryCollection link to their members via pcdm:hasMember, not
// hasPart — only a RepositoryObject uses hasPart, for its own files. An
// earlier version of this test used hasPart everywhere, which passed
// against a bug where the filter only walked hasPart/hasMember and never
// pcdm:hasMember — so a real crate's root (pcdm:hasMember only) always
// resolved to "kept 0 of 0" while this test stayed green.
//
// Collection D covers a further real-world gap: an ro-crate-excel
// spreadsheet can describe a RepositoryObject with no hasPart array at all,
// relying solely on its files' own isPartOf back-references — inconsistently
// even within the same spreadsheet (some objects declare hasPart, others
// don't). The filter has to discover such children via the crate's live
// @reverse index, not just forward hasPart/hasMember/pcdm:hasMember.
//
//   node publish-filter.test.mjs
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import { filterCrateToPublished } from "./plugins/ro-crate-html-output/index.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};
const ids = (crate) => crate.getGraph().map((e) => e["@id"]).sort();
const refs = (v) => [].concat(v ?? []).map((x) => (x && typeof x === "object" ? x["@id"] : x));

function buildTestCrate() {
  const crate = new ROCrate({ array: true, link: true });
  crate.addValues(crate.rootDataset, "pcdm:hasMember", [{ "@id": "#collectionA" }, { "@id": "#collectionB" }, { "@id": "#collectionC" }, { "@id": "#collectionD" }]);

  crate.addEntity({
    "@id": "#collectionA", "@type": "RepositoryCollection", name: "Collection A", "custom:publish": true,
    "pcdm:hasMember": [{ "@id": "#objectA1" }, { "@id": "#objectA2" }],
  });
  crate.addEntity({ "@id": "#objectA1", "@type": "RepositoryObject", name: "Object A1", hasPart: [{ "@id": "fileA1.txt" }] });
  crate.addEntity({ "@id": "fileA1.txt", "@type": "File", name: "fileA1.txt" });
  // custom:publish:false on an object overrides its collection's inherited custom:publish:true.
  crate.addEntity({ "@id": "#objectA2", "@type": "RepositoryObject", name: "Object A2", "custom:publish": false, hasPart: [{ "@id": "fileA2.txt" }] });
  crate.addEntity({ "@id": "fileA2.txt", "@type": "File", name: "fileA2.txt" });

  crate.addEntity({
    "@id": "#collectionB", "@type": "RepositoryCollection", name: "Collection B",
    "pcdm:hasMember": [{ "@id": "#objectB1" }, { "@id": "#objectB2" }],
  });
  // custom:publish:true on an object overrides its (unpublished) collection.
  crate.addEntity({ "@id": "#objectB1", "@type": "RepositoryObject", name: "Object B1", "custom:publish": true, hasPart: [{ "@id": "fileB1.txt" }] });
  crate.addEntity({ "@id": "fileB1.txt", "@type": "File", name: "fileB1.txt" });
  crate.addEntity({ "@id": "#objectB2", "@type": "RepositoryObject", name: "Object B2", hasPart: [{ "@id": "fileB2.txt" }] });
  crate.addEntity({ "@id": "fileB2.txt", "@type": "File", name: "fileB2.txt" });

  // The real-world grain: an ro-crate-excel spreadsheet's custom:publish
  // column lives on the @type=File sheet, not RepositoryObject/Collection —
  // so an unpublished object/collection can still have one published file.
  crate.addEntity({
    "@id": "#collectionC", "@type": "RepositoryCollection", name: "Collection C",
    "pcdm:hasMember": [{ "@id": "#objectC1" }],
  });
  crate.addEntity({ "@id": "#objectC1", "@type": "RepositoryObject", name: "Object C1", hasPart: [{ "@id": "fileC1.txt" }, { "@id": "fileC2.txt" }] });
  crate.addEntity({ "@id": "fileC1.txt", "@type": "File", name: "fileC1.txt", "custom:publish": true });
  crate.addEntity({ "@id": "fileC2.txt", "@type": "File", name: "fileC2.txt" });

  // Collection D → Object D1 has no hasPart at all; its files only declare
  // isPartOf pointing up at it, the "1. Culture"-shaped case above.
  crate.addEntity({
    "@id": "#collectionD", "@type": "RepositoryCollection", name: "Collection D",
    "pcdm:hasMember": [{ "@id": "#objectD1" }],
  });
  crate.addEntity({ "@id": "#objectD1", "@type": "RepositoryObject", name: "Object D1" });
  crate.addEntity({ "@id": "fileD1.txt", "@type": "File", name: "fileD1.txt", "custom:publish": true, isPartOf: { "@id": "#objectD1" } });
  crate.addEntity({ "@id": "fileD2.txt", "@type": "File", name: "fileD2.txt", isPartOf: { "@id": "#objectD1" } });

  return crate;
}

console.log("filterCrateToPublished");

await check("cascade, individual override, and shell survival at both object and file grain", () => {
  const crate = buildTestCrate();
  const seen = [];
  filterCrateToPublished(crate, (msg, level) => seen.push([level, msg]));
  const graph = ids(crate);

  assert.ok(graph.includes("./"), "root dataset is never removed");
  assert.ok(["#collectionA", "#objectA1", "fileA1.txt"].every((id) => graph.includes(id)), "collection A's plain object cascades from the collection's custom:publish:true, via pcdm:hasMember");
  assert.ok(!graph.includes("#objectA2") && !graph.includes("fileA2.txt"), "an object's own custom:publish:false overrides an inherited custom:publish:true");

  assert.ok(graph.includes("#collectionB"), "collection B survives as a structural shell because it has a published descendant");
  assert.ok(graph.includes("#objectB1") && graph.includes("fileB1.txt"), "an object's own custom:publish:true overrides its unpublished collection");
  assert.ok(!graph.includes("#objectB2") && !graph.includes("fileB2.txt"), "an object with no flag, under an unpublished collection, is excluded");

  assert.ok(graph.includes("#collectionC") && graph.includes("#objectC1"), "collection C and its object survive as shells for a single published file");
  assert.ok(graph.includes("fileC1.txt"), "a File's own custom:publish:true is honoured directly, the real-world grain");
  assert.ok(!graph.includes("fileC2.txt"), "its unflagged sibling file, under the same unpublished object, is excluded");

  assert.ok(graph.includes("#collectionD") && graph.includes("#objectD1"), "collection D and its hasPart-less object survive as shells, discovered only via fileD1's reverse isPartOf");
  assert.ok(graph.includes("fileD1.txt"), "a published file reachable only via reverse isPartOf (no forward hasPart on its object) is still found");
  assert.ok(!graph.includes("fileD2.txt"), "its unflagged sibling, also reachable only via reverse isPartOf, is still correctly excluded");

  assert.deepEqual(refs(crate.getEntity("#collectionA")["pcdm:hasMember"]), ["#objectA1"], "the removed sibling's pcdm:hasMember ref is cleaned up, not left dangling");
  assert.deepEqual(refs(crate.getEntity("#collectionB")["pcdm:hasMember"]), ["#objectB1"], "same cleanup on the shell collection's pcdm:hasMember");
  assert.deepEqual(refs(crate.getEntity("#objectC1").hasPart), ["fileC1.txt"], "same cleanup at file level under the shell object's hasPart");
  assert.deepEqual(refs(crate.getEntity("#objectD1")["@reverse"]?.isPartOf), ["fileD1.txt"], "the removed fileD2's reverse isPartOf link is cleaned up too, not left dangling");

  assert.ok(!seen.some(([level]) => level === "warn"), "no warning is logged when some entities do carry a custom:publish flag");
});

await check("nothing marked custom:publish empties the crate and warns", () => {
  const crate = new ROCrate({ array: true, link: true });
  crate.addValues(crate.rootDataset, "pcdm:hasMember", [{ "@id": "#collectionA" }]);
  crate.addEntity({ "@id": "#collectionA", "@type": "RepositoryCollection", name: "Collection A", "pcdm:hasMember": [{ "@id": "#objectA1" }] });
  crate.addEntity({ "@id": "#objectA1", "@type": "RepositoryObject", name: "Object A1", hasPart: [{ "@id": "fileA1.txt" }] });
  crate.addEntity({ "@id": "fileA1.txt", "@type": "File", name: "fileA1.txt" });

  const seen = [];
  filterCrateToPublished(crate, (msg, level) => seen.push([level, msg]));
  const graph = ids(crate);

  assert.ok(!graph.includes("#collectionA") && !graph.includes("#objectA1") && !graph.includes("fileA1.txt"), "nothing is published, so no content entity remains");
  assert.ok(seen.some(([level, msg]) => level === "warn" && /no collection\/object\/file/.test(msg)), "warns that nothing was marked custom:publish:true");
});

console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
