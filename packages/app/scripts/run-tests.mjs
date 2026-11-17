#!/usr/bin/env node
// Discovers and runs every tests/test-*.mjs (npm test).
//
// Discovery rather than a list, so a new suite is picked up by existing simply
// by existing — one less thing to forget when adding one.

import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(REPO_ROOT, "tests");

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(TEST_DIR, file)], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const files = (await readdir(TEST_DIR))
  .filter((name) => /^test-.*\.mjs$/.test(name))
  .sort();

if (!files.length) {
  console.error("run-tests: no tests/test-*.mjs found.");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const code = await run(file);
  if (code !== 0) {
    failed++;
    console.error(`✗ ${file} exited ${code}`);
  }
}

console.log(
  failed
    ? `\nrun-tests: ${failed} of ${files.length} suite(s) FAILED`
    : `\nrun-tests: ${files.length} suite(s) passed (${files.join(", ")})`
);
process.exit(failed ? 1 : 0);
