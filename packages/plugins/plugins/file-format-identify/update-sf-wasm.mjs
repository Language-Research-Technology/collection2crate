#!/usr/bin/env node
// Refreshes the vendored siegfried WASM build (sf.wasm + wasm_exec.js, this
// folder) from siegfried's official GitHub releases. Run with:
//   npm run update:pronom
//
// Unlike a from-scratch signature port, this needs no Go toolchain for a
// routine update — sf.wasm already embeds siegfried's own compiled PRONOM
// signature set (default.sig, the same one every native release ships); a
// Go build is only needed to *customize* the embedded signature set, which
// this plugin doesn't do.
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const VERSION = process.argv[2] || "1.11.6";
const ASSET_NAME = `siegfried_${VERSION.replace(/\./g, "-")}_wasm.zip`;
const RELEASE_URL = `https://github.com/richardlehane/siegfried/releases/download/v${VERSION}/${ASSET_NAME}`;
const DEST_DIR = fileURLToPath(new URL(".", import.meta.url));

async function main() {
  console.log(`Downloading ${RELEASE_URL} ...`);
  const res = await fetch(RELEASE_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const zipBytes = new Uint8Array(await res.arrayBuffer());

  const tmp = await mkdtemp(path.join(tmpdir(), "sf-wasm-"));
  const zipPath = path.join(tmp, ASSET_NAME);
  await writeFile(zipPath, zipBytes);

  console.log("Extracting sf.wasm and wasm_exec.js...");
  execFileSync("unzip", ["-o", zipPath, "sf.wasm", "wasm_exec.js", "-d", tmp]);

  const { copyFile } = await import("node:fs/promises");
  await copyFile(path.join(tmp, "sf.wasm"), path.join(DEST_DIR, "sf.wasm"));
  await copyFile(path.join(tmp, "wasm_exec.js"), path.join(DEST_DIR, "wasm_exec.js"));
  await rm(tmp, { recursive: true, force: true });

  console.log(`Updated sf.wasm and wasm_exec.js to v${VERSION} in ${DEST_DIR}`);
  console.log("Remember to also check SIEGFRIED-LICENSE.txt is still current, and re-run npm run test:pronom.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
