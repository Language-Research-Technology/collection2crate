// Seam: the working crate (SPEC.md §4.4a) and the Describe form's view of
// its root (§5.3). Real ro-crate throughout; no DOM.

import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import {
  createWorkingCrate, rootFieldText, rootFormValues, rootPropertiesForFields, applyFieldText,
} from "../src/working_crate.js";

const graph = (extra = []) => ({
  "@context": ["https://w3id.org/ro/crate/1.1/context"],
  "@graph": [
    { "@id": "ro-crate-metadata.json", "@type": "CreativeWork", about: { "@id": "./" } },
    { "@id": "./", "@type": "Dataset", name: "Loaded name", author: [{ "@id": "https://orcid.org/0000-0001" }, { "@id": "#bo" }] },
    { "@id": "https://orcid.org/0000-0001", "@type": "Person", name: "Ann Author" },
    { "@id": "#bo", "@type": "Person" },
    { "@id": "a.txt", "@type": "File" },
    ...extra,
  ],
});

const FIELDS = [
  { key: "name", control: "text", multiple: false, types: ["Text"] },
  { key: "description", control: "textarea", multiple: false, types: ["Text"] },
  { key: "author", control: "entity", multiple: true, types: ["Person"] },
  { key: "datePublished", control: "date", multiple: false, types: ["Date"] },
];
const byKey = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const ids = (v) => [].concat(v || []).map((x) => (x && typeof x === "object" ? x["@id"] : x));

/* ---------- lifecycle ---------- */

{
  const empty = createWorkingCrate();
  assert.equal(empty.onDisk, false);
  assert.equal(empty.dirty, false);
  assert.equal(empty.hasContent, false, "A folder with no crate has nothing to show until something is added");
  assert.deepEqual(empty.crate.getGraph().map((e) => e["@id"]).sort(), ["./", "ro-crate-metadata.json"]);

  const t0 = empty.token;
  empty.crate.rootDataset.name = ["Typed"];
  empty.touch();
  assert.equal(empty.dirty, true, "An edit leaves unsaved changes");
  assert.equal(empty.hasContent, true, "…and something to show");
  assert.notEqual(empty.token, t0, "Every edit changes the token");

  empty.markSaved();
  assert.equal(empty.dirty, false);
  assert.equal(empty.onDisk, true, "Saving puts the crate in the folder");
}

{
  const json = graph();
  const working = createWorkingCrate({ json, onDisk: true });
  assert.equal(working.hasContent, true);
  working.crate.rootDataset.name = ["Changed"];
  working.touch();
  assert.deepEqual(json["@graph"][1].name, "Loaded name", "The loaded JSON is never edited in place");

  const first = working.toJSON();
  assert.equal(working.toJSON(), first, "toJSON is cached until the next change");
  assert.deepEqual(first["@graph"].find((e) => e["@id"] === "./").name, ["Changed"]);
  working.touch();
  assert.notEqual(working.toJSON(), first, "…and recomputed after it");

  const t = working.token;
  working.replace(graph([{ "@id": "b.txt", "@type": "File" }]));
  assert.ok(working.crate.getEntity("b.txt"), "replace() swaps in a new crate");
  assert.equal(working.dirty, false, "…as saved, by default (a build wrote it)");
  assert.notEqual(working.token, t);
}

/* ---------- the Describe form reads the root ---------- */

{
  const crate = new ROCrate(graph(), { array: true, link: true });
  assert.equal(rootFieldText(crate, byKey.name), "Loaded name");
  assert.equal(rootFieldText(crate, byKey.author), "Ann Author, #bo",
    "An entity reads as its name, or its @id when it has none");
  assert.deepEqual(rootFormValues(crate, FIELDS), { name: "Loaded name", author: "Ann Author, #bo" },
    "Empty fields are left out");
  assert.deepEqual(rootPropertiesForFields(crate, FIELDS), {
    name: ["Loaded name"],
    author: [{ "@id": "https://orcid.org/0000-0001" }, { "@id": "#bo" }],
  }, "The config gets the root's own values — references by @id, nothing re-synthesised from display text");
}

/* ---------- the Describe form writes the root ---------- */

{
  const crate = new ROCrate(graph(), { array: true, link: true });

  assert.equal(applyFieldText(crate, byKey.name, "Loaded name"), false, "Unchanged text is not a change");
  assert.equal(applyFieldText(crate, byKey.name, "  New name "), true);
  assert.deepEqual(crate.rootDataset.name, ["New name"]);

  assert.equal(applyFieldText(crate, byKey.description, ""), false, "Clearing a field that was empty is not a change");
  assert.equal(applyFieldText(crate, byKey.name, ""), true, "Clearing a field removes the property");
  assert.equal(crate.rootDataset.name, undefined);

  assert.equal(applyFieldText(crate, byKey.author, "Ann Author, #bo"), false,
    "Entity text that still reads the same keeps the references as they are");
  assert.equal(applyFieldText(crate, byKey.author, "Ann Author, Cy Coder"), true);
  assert.deepEqual(ids(crate.rootDataset.author), ["https://orcid.org/0000-0001", "#cy-coder"],
    "A kept name keeps its ORCID @id; new text mints an entity");
  const cy = crate.getEntity("#cy-coder");
  assert.ok(cy, "The new person is in the crate");
  assert.deepEqual([].concat(cy["@type"]), ["Person"]);
  assert.deepEqual([].concat(crate.getEntity("https://orcid.org/0000-0001").name), ["Ann Author"],
    "The kept entity's name is not overwritten with display text");

  assert.equal(applyFieldText(crate, byKey.author, "https://orcid.org/0000-0002"), true);
  assert.deepEqual(ids(crate.rootDataset.author), ["https://orcid.org/0000-0002"],
    "Text that looks like an identifier is used as the @id");

  assert.equal(applyFieldText(crate, byKey.author, "Cy Coder"), true);
  assert.deepEqual(ids(crate.rootDataset.author), ["#cy-coder"],
    "Text naming an entity already in the crate links to it rather than minting a duplicate");
}

console.log(
  "test-working-crate: all tests passed (lifecycle: dirty/saved/token/replace/cache, " +
  "root → form text, root → config without re-synthesis, form text → root incl. clearing and entity reuse)"
);
