// Seam: matching a folder's existing crate back to the profile that built it
// (SPEC.md §5.1a) — the conformance URIs read from a crate's root and from a
// profile's mode file, and the rule for when that match switches profile.
//
// Real ro-crate: the crates are built by buildCrate, so the conformsTo being
// read is the one the app actually writes. The only stand-in is the profile
// repository, whose mode files are supplied by a function.

import assert from "node:assert/strict";
import {
  profileConformsTo, crateConformsTo, buildConformanceIndex, chooseProfileForCrate,
} from "../src/masp.js";
import { buildCrate, buildFileMetadata, crateToJsonString } from "../src/crate.js";

const LDAC = "https://w3id.org/ldac/profile#Collection";
const BIRDS = "https://language-research-technology.github.io/c2c-masp-profiles/birds/profile-crate/#profile";

const MODES = {
  birds: { rootDataset: { type: ["Dataset", "RepositoryCollection"], conformsTo: BIRDS } },
  ldac: { rootDataset: { type: ["Dataset", "RepositoryCollection"], conformsTo: LDAC } },
  "language-resources": { rootDataset: { type: ["Dataset"], conformsTo: { "@id": LDAC } } },
  "no-conformance": { rootDataset: { type: ["Dataset"] } },
};
const fetchMode = async (name) => {
  if (name === "broken") throw new Error("404");
  return MODES[name];
};

const crateWith = (conformsTo) => {
  const config = { rootDataset: { type: ["Dataset"], name: "Test", ...(conformsTo ? { conformsTo } : {}) } };
  const crate = buildCrate(buildFileMetadata([{ name: "a.txt", relativePath: "a.txt" }]), config, () => {});
  return JSON.parse(crateToJsonString(crate));
};

// Both shapes of conformsTo read the same.
assert.deepEqual(profileConformsTo(MODES.birds), [BIRDS]);
assert.deepEqual(profileConformsTo(MODES["language-resources"]), [LDAC]);
assert.deepEqual(profileConformsTo(MODES["no-conformance"]), []);
assert.deepEqual(profileConformsTo(null), []);

// The crate's root is found through the descriptor, as built.
assert.deepEqual(crateConformsTo(crateWith(BIRDS)), [BIRDS]);
assert.deepEqual(crateConformsTo(crateWith({ "@id": BIRDS })), [BIRDS]);
assert.deepEqual(crateConformsTo(crateWith(null)), []);
assert.deepEqual(crateConformsTo(null), []);

// A profile with no conformance or no mode file is left out, not fatal.
const index = await buildConformanceIndex([...Object.keys(MODES), "broken"], fetchMode);
assert.deepEqual(index.map((e) => e.name), ["birds", "ldac", "language-resources"]);

// One match switches.
const birds = chooseProfileForCrate(crateWith(BIRDS), index, "schema.org (default)");
assert.equal(birds.choice, "switch");
assert.equal(birds.name, "birds");

// Already on it: nothing to do.
assert.equal(chooseProfileForCrate(crateWith(BIRDS), index, "birds").choice, "active");

// Two profiles declare the LDaC URI: report, don't guess…
const ldac = chooseProfileForCrate(crateWith(LDAC), index, "schema.org (default)");
assert.equal(ldac.choice, "ambiguous");
assert.equal(ldac.name, null);
assert.deepEqual(ldac.matches, ["ldac", "language-resources"]);
// …unless the active profile is one of them.
const kept = chooseProfileForCrate(crateWith(LDAC), index, "language-resources");
assert.equal(kept.choice, "active");
assert.equal(kept.name, "language-resources");

// Unknown or absent conformance keeps the active profile.
assert.equal(chooseProfileForCrate(crateWith("https://example.org/other"), index, "birds").choice, "none");
assert.equal(chooseProfileForCrate(crateWith(null), index, "birds").choice, "none");
assert.equal(chooseProfileForCrate(null, index).choice, "none");

console.log(
  `test-profile-match: all tests passed (${index.length} indexed profiles; single match switches, ` +
    `shared ${LDAC} is ambiguous, active profile kept)`
);
