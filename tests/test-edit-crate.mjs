// Seam: entity editing (SPEC.md §6.3) — the operations the Edit view drives,
// exercised here against the same isomorphic functions, so the behaviour is
// pinned even though the view itself is out of scope (SPEC.md §9.1).

import assert from "node:assert/strict";
import {
  buildFileMetadata, buildCrate, crateToJsonString, crateToXlsxBytes,
  listEntities, setEntityProperty, deleteEntityProperty, addEntity,
  renameEntityId, deleteEntity, isStructuralEntity,
} from "../src/crate.js";

const TEST_CONFIG = {
  rootDataset: { type: ["Dataset"], name: "Editable collection", description: "For the editor tests." },
  propertyGroups: [{ name: "About", inputs: ["http://schema.org/name"] }],
};
const noLog = () => {};
const ids = (value) => [].concat(value ?? []).map((v) => (v && typeof v === "object" ? v["@id"] : v));

function freshCrate() {
  const crate = buildCrate(
    buildFileMetadata([
      { name: "a.wav", relativePath: "Songs/a.wav" },
      { name: "b.txt", relativePath: "Stories/b.txt" },
    ]),
    TEST_CONFIG, noLog
  );
  addEntity(crate, { "@id": "#alex", "@type": "Person", name: "Alex Example" });
  setEntityProperty(crate, crate.rootId, "author", [{ "@id": "#alex" }]);
  setEntityProperty(crate, "Songs/a.wav", "author", [{ "@id": "#alex" }]);
  return crate;
}

/* ---------- browsing and filtering ---------- */

{
  const crate = freshCrate();
  assert.equal(listEntities(crate, { type: "File" }).length, 2,
    "Filtering by type returns exactly the entities carrying that @type");
  assert.deepEqual(
    listEntities(crate, { text: "Alex Example" }).map((e) => e["@id"]),
    ["#alex"],
    "A text filter matches an entity's own values only — not the values of entities it merely links to"
  );
  assert.deepEqual(
    listEntities(crate, { text: "#alex" }).map((e) => e["@id"]).sort(),
    ["#alex", "./", "Songs/a.wav"].sort(),
    "Searching an identifier does find the entities that reference it, which is how you discover what points at something"
  );
  assert.equal(listEntities(crate, { type: "File", text: "b.txt" }).length, 1,
    "Type and text filters combine rather than replacing each other");
}

/* ---------- setting and deleting property values ---------- */

{
  const crate = freshCrate();
  setEntityProperty(crate, "#alex", "affiliation", "University of Somewhere");
  assert.deepEqual([].concat(crate.getEntity("#alex").affiliation), ["University of Somewhere"],
    "A scalar set on a property is stored as a single-valued array, matching how every other value is held");

  setEntityProperty(crate, "#alex", "affiliation", ["One", "Two"]);
  assert.deepEqual([].concat(crate.getEntity("#alex").affiliation), ["One", "Two"],
    "Setting a property replaces its values rather than appending to them");

  deleteEntityProperty(crate, "#alex", "affiliation");
  assert.equal(crate.getEntity("#alex").affiliation, undefined,
    "Deleting a property removes it entirely, not leaving an empty array behind");

  assert.throws(() => deleteEntityProperty(crate, "#alex", "@type"), /cannot be deleted/,
    "@type cannot be deleted from an entity — an untyped node is not an entity");
  assert.throws(() => setEntityProperty(crate, "#alex", "@id", "#someone-else"), /renameEntityId/,
    "Changing an @id must go through renameEntityId so references are followed");
  assert.throws(() => setEntityProperty(crate, "#nobody", "name", "x"), /No entity/,
    "Editing an entity that isn't there is an error, not a silent creation");
}

/* ---------- adding entities ---------- */

{
  const crate = freshCrate();
  const added = addEntity(crate, { "@id": "#place-1", "@type": "Place", name: "Somewhere" });
  assert.equal(added["@id"], "#place-1", "addEntity returns the live entity it added");
  assert.ok(crate.getEntity("#place-1"), "The new entity is in the graph");

  assert.throws(() => addEntity(crate, { "@id": "#place-1", "@type": "Place" }), /already exists/,
    "Adding an entity over an existing @id is refused rather than silently merging into it");
  assert.throws(() => addEntity(crate, { "@type": "Place" }), /needs an @id/,
    "An entity with no @id cannot be added — @id is what makes it addressable");

  const untyped = addEntity(crate, { "@id": "#thing-1", name: "Unlabelled" });
  assert.deepEqual([].concat(untyped["@type"]), ["Thing"],
    "An entity added with no type gets Thing, so it is still a valid node");
}

/* ---------- renaming an @id follows every reference ---------- */

{
  const crate = freshCrate();
  renameEntityId(crate, "#alex", "https://orcid.org/0000-0002-1825-0097");

  assert.equal(crate.getEntity("#alex"), undefined, "The old @id no longer resolves after a rename");
  assert.ok(crate.getEntity("https://orcid.org/0000-0002-1825-0097"), "The entity is reachable at its new @id");
  assert.deepEqual(ids(crate.rootDataset.author), ["https://orcid.org/0000-0002-1825-0097"],
    "Every reference to the old @id is rewritten — a rename that left a dangling pointer would break the graph");
  assert.deepEqual(ids(crate.getEntity("Songs/a.wav").author), ["https://orcid.org/0000-0002-1825-0097"],
    "References are followed wherever they are, not only on the root");

  assert.throws(() => renameEntityId(crate, "#missing", "#x"), /No entity/,
    "Renaming an entity that isn't there is an error");
  addEntity(crate, { "@id": "#taken", "@type": "Thing" });
  assert.throws(() => renameEntityId(crate, "https://orcid.org/0000-0002-1825-0097", "#taken"), /already exists/,
    "A rename onto an occupied @id is refused rather than merging two entities");
}

/* ---------- structural identifiers are locked ---------- */

{
  const crate = freshCrate();

  assert.ok(isStructuralEntity(crate, crate.rootId), "The root dataset is structural");
  assert.ok(isStructuralEntity(crate, "ro-crate-metadata.json"), "The metadata descriptor is structural");
  assert.ok(isStructuralEntity(crate, "Songs/a.wav"), "A File is structural — its @id is its path on disk");
  assert.ok(isStructuralEntity(crate, "arcp://name,corpus/Songs"), "A RepositoryObject is structural");
  assert.equal(isStructuralEntity(crate, "#alex"), false, "A Person is not structural and can be renamed freely");

  for (const id of ["Songs/a.wav", "arcp://name,corpus/Songs", crate.rootId]) {
    assert.throws(() => renameEntityId(crate, id, "#renamed"), /structural/,
      `"${id}" must keep its identifier — renaming it breaks the crate's mapping to the folder`);
  }
}

/* ---------- deleting an entity cleans up references to it ---------- */

{
  const crate = freshCrate();
  deleteEntity(crate, "#alex");

  assert.equal(crate.getEntity("#alex"), undefined, "The deleted entity is gone from the graph");
  assert.equal(crate.rootDataset.author, undefined,
    "A property whose only value referenced the deleted entity is removed, not left as an empty array");

  const second = freshCrate();
  addEntity(second, { "@id": "#jo", "@type": "Person", name: "Jo" });
  setEntityProperty(second, second.rootId, "author", [{ "@id": "#alex" }, { "@id": "#jo" }]);
  deleteEntity(second, "#alex");
  assert.deepEqual(ids(second.rootDataset.author), ["#jo"],
    "Deleting one of several referenced entities drops only that reference and keeps the rest");

  assert.throws(() => deleteEntity(second, second.rootId), /root dataset cannot be deleted/,
    "The root dataset cannot be deleted — everything else in the crate hangs off it");
  assert.throws(() => deleteEntity(second, "#gone"), /No entity/,
    "Deleting something that isn't there is an error rather than a no-op");
}

/* ---------- an edited crate still regenerates JSON and xlsx ---------- */

{
  const crate = freshCrate();
  renameEntityId(crate, "#alex", "#alex-example");
  setEntityProperty(crate, "#alex-example", "name", ["Alex Example (edited)"]);
  deleteEntity(crate, "Stories/b.txt");

  const json = JSON.parse(crateToJsonString(crate));
  assert.ok(Array.isArray(json["@graph"]), "An edited crate still serialises to valid RO-Crate JSON-LD");
  assert.ok(json["@graph"].some((e) => e["@id"] === "#alex-example"),
    "The edits are present in the serialised output");
  assert.ok(!json["@graph"].some((e) => e["@id"] === "Stories/b.txt"),
    "A deleted entity does not reappear in the serialised output");
  assert.ok(
    !JSON.stringify(json).includes('"Stories/b.txt"'),
    "No dangling reference to the deleted entity survives anywhere in the graph"
  );

  const bytes = await crateToXlsxBytes(crate);
  assert.ok(bytes.byteLength > 0,
    "An edited crate still regenerates a workbook, which is what the Edit view's save does when an xlsx exists");
}

console.log(
  "test-edit-crate: all tests passed (browse/filter, set and delete values, add entity, " +
  "rename with reference-following, structural @id locking, delete with reference cleanup, regeneration)"
);
