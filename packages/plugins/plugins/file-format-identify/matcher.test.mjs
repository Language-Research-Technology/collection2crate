// Matches this repo's plain-node-assert test style (see collection2crate's
// tests/test-*.mjs) — no framework needed for a handful of fixture checks.
// Run with: node src/file-format-identify/matcher.test.mjs
//
// Exercises the real vendored sf.wasm (not a reimplementation) directly in
// Node, via a minimal FileSystemFileHandle shim over a real on-disk file —
// wasm_exec.js runs fine under Node (it feature-detects globalThis.fs/
// globalThis.process rather than assuming a browser), and a File-System-
// Access-API handle only needs .kind, .name and an async .getFile() that
// resolves to something with .size/.lastModified/.slice() to satisfy
// sf.wasm's own reader (wasm/reader.go in the siegfried repo) — this is
// the same shim shape verified against the real build while planning this
// switch.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { openAsBlob, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { configure, identifyAllFormats } from "./matcher.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Boots the real vendored sf.wasm directly under Node — matcher.js's own
// loadSiegfried() only ever reaches wasm-loader.js's Vite-specific asset
// imports (?url/?raw) when globalThis.identify isn't already present, so
// doing this ourselves here, once, before any test runs, means matcher.js
// stays plain-Node-loadable for testing without needing a bundler at all.
async function bootSiegfriedForTests() {
  if (typeof globalThis.identify === "function") return;
  const wasmExecSrc = await readFile(path.join(HERE, "wasm_exec.js"), "utf8");
  new Function(wasmExecSrc)();
  const go = new globalThis.Go();
  const wasmBytes = await readFile(path.join(HERE, "sf.wasm"));
  const { instance } = await WebAssembly.instantiate(wasmBytes, go.importObject);
  go.run(instance); // never resolves — see matcher.js/wasm-loader.js
  for (let i = 0; i < 500 && typeof globalThis.identify !== "function"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(typeof globalThis.identify, "function", "siegfried WASM module initialized");
}

async function fileHandleFor(filePath) {
  if (!existsSync(filePath)) return null;
  const blob = await openAsBlob(filePath);
  const name = path.basename(filePath);
  return {
    kind: "file",
    name,
    async getFile() {
      return { name, size: blob.size, lastModified: Date.now(), slice: (a, b) => blob.slice(a, b) };
    },
  };
}

// The plugin's own contract: configure() takes { getFileHandleAtPath }, the
// same shape collection2crate's deps.js hands every plugin — here it's a thin
// wrapper resolving relativePath against a Node scratch directory instead
// of a browser FileSystemDirectoryHandle.
function configureAgainst(root) {
  configure({
    getFileHandleAtPath: (dirRoot, relativePath) => fileHandleFor(path.join(dirRoot, relativePath)),
  });
  return root;
}

async function identifyOne(root, relativePath) {
  const byId = await identifyAllFormats(root, [{ id: relativePath, relativePath, fileName: path.basename(relativePath) }]);
  return byId.get(relativePath) || null;
}

await bootSiegfriedForTests();
const scratch = await mkdtemp(path.join(tmpdir(), "sf-wasm-test-"));
configureAgainst(scratch);

try {
  // TIFF — plain byte-signature match, no ambiguity.
  {
    await writeFile(path.join(scratch, "sample.tiff"), Buffer.concat([Buffer.from("49492a00", "hex"), Buffer.alloc(20)]));
    const result = await identifyOne(scratch, "sample.tiff");
    assert.equal(result?.puid, "fmt/353", "TIFF identified by byte signature");
  }

  // Real container-signature disambiguation (docx/xlsx/odt vs generic ZIP)
  // needs a genuine OOXML/ODF structure — a proper [Content_Types].xml
  // Override entry, not just a filename — which is exactly what a
  // hand-built minimal fixture here wouldn't meaningfully exercise beyond
  // what the byte-signature case above already covers. Verified instead
  // against real .docx/.xlsx files from an actual corpus — see this
  // plugin's real-corpus verification run.

  // Plain text — no PRONOM byte signature exists for this at all; only
  // resolvable via siegfried's own built-in extension fallback.
  {
    await writeFile(path.join(scratch, "field-notes.txt"), "Elicitation session, 2026-08-27.\nWord: gunya (dog)\n");
    const result = await identifyOne(scratch, "field-notes.txt");
    assert.equal(result?.puid, "x-fmt/111", "plain text resolves via siegfried's own extension fallback");
    assert.equal(result?.warning, "", "a plausible ASCII text file gets no mismatch warning");
  }

  // A .txt file whose actual content is neither valid text nor a real JPEG
  // (just a truncated magic-byte fragment) — real siegfried is rigorous
  // enough to refuse the extension's own plain-text fallback here too,
  // rather than blindly trusting ".txt" the way a weaker heuristic might.
  {
    await writeFile(path.join(scratch, "mislabeled.txt"), Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(20)]));
    const result = await identifyOne(scratch, "mislabeled.txt");
    assert.equal(result, null, "content that's neither valid text nor a real known format stays unidentified, extension notwithstanding");
  }

  // A real, identifiable format under the wrong extension (genuine HTML
  // content saved as .txt — exactly the scrollIntoView-LICENSE.txt case
  // found in the bates corpus during earlier verification) should still
  // resolve, with the mismatch surfaced as a warning rather than silently
  // trusting either the extension or staying unidentified.
  {
    await writeFile(path.join(scratch, "saved-page.txt"), "<!DOCTYPE html>\n<html><head></head><body>hello</body></html>\n");
    const result = await identifyOne(scratch, "saved-page.txt");
    assert.equal(result?.puid, "fmt/471", "HTML content is identified correctly despite the .txt extension");
    assert.notEqual(result?.warning, "", "the extension mismatch is flagged, not hidden");
  }

  // Content siegfried genuinely can't identify by any means (no signature,
  // no plausible extension, not text) — siegfried reports this as a real
  // match object with id: "UNKNOWN" rather than an empty matches array, so
  // this specifically exercises that identifyHandle() filters it out
  // rather than reporting "UNKNOWN" as if it were a real PUID.
  {
    await writeFile(path.join(scratch, "opaque.xyz123"), Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]));
    const result = await identifyOne(scratch, "opaque.xyz123");
    assert.equal(result, null, "siegfried's own UNKNOWN result is treated as no match");
  }

  // A file that isn't there at all.
  {
    const result = await identifyOne(scratch, "does-not-exist.bin");
    assert.equal(result, null, "a missing file yields no result rather than throwing");
  }

  console.log("All file-format-identify matcher tests passed.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
