// Seam: how top-level folders turn into entities at the edges — a flat folder
// with no subfolders, deeply nested folders, files sitting at the very top of
// the picked folder, and structureFromMetadata suppressing folder entities
// entirely.

import assert from "node:assert/strict";
import { buildFileMetadata, buildCrate, collectTypeCounts } from "../src/crate.js";

const TEST_CONFIG = { rootDataset: { type: ["Dataset"], name: "Folders" } };
const noLog = () => {};
const ids = (value) => [].concat(value ?? []).map((v) => (v && typeof v === "object" ? v["@id"] : v));
const build = (paths, opts) =>
  buildCrate(buildFileMetadata(paths.map((p) => ({ name: p.split("/").pop(), relativePath: p }))), TEST_CONFIG, noLog, opts);

/* ---------- flat top-level folders, no subfolders ---------- */

{
  const crate = build(["Songs/a.wav", "Songs/b.wav", "Stories/c.txt"], { topLevelFolderType: "object" });
  const counts = collectTypeCounts(crate.getGraph());

  assert.equal(counts.RepositoryObject, 2,
    "Two top-level folders with no subfolders produce exactly two RepositoryObjects");
  assert.deepEqual(
    ids(crate.getEntity("arcp://name,corpus/Songs").hasPart).sort(),
    ["Songs/a.wav", "Songs/b.wav"],
    "A flat folder's files all sit in its object's hasPart"
  );
}

{
  const crate = build(["Songs/a.wav", "Songs/b.wav"], { topLevelFolderType: "collection" });
  const counts = collectTypeCounts(crate.getGraph());

  assert.equal(counts.RepositoryCollection, 1, "Collection mode still makes the top-level folder a collection");
  assert.equal(counts.RepositoryObject, 1,
    "With no subfolders, the only child object is the synthesised _Files one — no empty extra objects are invented");
  assert.ok(crate.getEntity("arcp://name,corpus/Songs_Files"),
    "The synthesised object is named after its parent folder");
}

/* ---------- deep nesting collapses onto the top-level-most object ---------- */

{
  const crate = build(
    ["Corpus/2024/january/recording.wav", "Corpus/2024/february/recording.wav"],
    { topLevelFolderType: "collection" }
  );
  const counts = collectTypeCounts(crate.getGraph());

  assert.equal(counts.RepositoryCollection, 1, "Only the top-level folder becomes a collection, however deep the tree");
  assert.equal(counts.RepositoryObject, 1,
    "Deeper folders do not each mint an object — a chain of one entity per directory level would describe the filesystem, not the collection");
  assert.deepEqual(
    ids(crate.getEntity("Corpus/2024/january/recording.wav").isPartOf),
    ["arcp://name,corpus/Corpus_2024"],
    "A deeply nested file belongs to the object for its second-level folder"
  );
}

/* ---------- files directly in the picked folder ---------- */

{
  const crate = build(["readme.txt", "Songs/a.wav"], { topLevelFolderType: "object" });

  assert.ok(ids(crate.rootDataset.hasPart).includes("readme.txt"),
    "A file with no folder above it attaches straight to the root dataset");
  assert.equal(crate.getEntity("readme.txt").isPartOf, undefined,
    "A root-level file has no folder entity to be part of, so no isPartOf is invented for it");
  assert.equal(collectTypeCounts(crate.getGraph()).RepositoryObject, 1,
    "Root-level files do not produce a folder entity of their own");
}

/* ---------- an empty scan still produces a valid, if bare, crate ---------- */

{
  const crate = build([]);
  assert.ok(crate.rootDataset, "A folder with no files still yields a root dataset");
  assert.equal(collectTypeCounts(crate.getGraph()).File, undefined,
    "No files scanned means no File entities — not a placeholder");
}

/* ---------- structureFromMetadata invents no folder entities ---------- */

{
  const paths = ["Corpus/2024/january/recording.wav", "readme.txt"];
  const scanned = build(paths, { topLevelFolderType: "collection" });
  const supplied = build(paths, { topLevelFolderType: "collection", structureFromMetadata: true });

  assert.ok(collectTypeCounts(scanned.getGraph()).RepositoryCollection >= 1,
    "The same input does produce folder entities when the structure comes from the scan");
  const counts = collectTypeCounts(supplied.getGraph());
  assert.equal(counts.RepositoryCollection, undefined,
    "structureFromMetadata means supplied metadata already says what belongs to what — no collection is invented");
  assert.equal(counts.RepositoryObject, undefined,
    "structureFromMetadata invents no objects either, whatever the folder depth");
  assert.equal(counts.File, 2, "Every scanned file is still described");
  assert.ok(ids(supplied.rootDataset.hasPart).includes("Corpus/2024/january/recording.wav"),
    "Without folder entities, files attach to the root and let the supplied metadata re-parent them");
}

console.log(
  "test-top-level-folders: all tests passed (flat folders, deep nesting, root-level files, " +
  "empty scan, structureFromMetadata)"
);
