#!/usr/bin/env node
// Discovers and runs every *.test.mjs in this package (npm test).
//
// Each test sits next to what it tests: a plugin's own tests in its folder
// under plugins/, a shared module's tests in lib/, and the checks that hold
// for every plugin in REGISTRY in tests/. Discovery rather than a list, so a
// new test runs simply by existing — the same approach as packages/app's
// scripts/run-tests.mjs.
//
// Arguments filter by path: `npm test -- name-lookup` runs only the files
// whose path contains "name-lookup"; several arguments run any that match.

import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCHED = ["plugins", "lib", "tests"];

async function findTests(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await findTests(full));
    else if (entry.name.endsWith(".test.mjs")) found.push(path.relative(PACKAGE_ROOT, full));
  }
  return found;
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, file)], {
      cwd: PACKAGE_ROOT,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const filters = process.argv.slice(2);
const all = (await Promise.all(SEARCHED.map((dir) => findTests(path.join(PACKAGE_ROOT, dir))))).flat().sort();
const files = filters.length ? all.filter((file) => filters.some((filter) => file.includes(filter))) : all;

if (!files.length) {
  console.error(filters.length
    ? `run-tests: no *.test.mjs matches ${filters.join(", ")}.`
    : `run-tests: no *.test.mjs found under ${SEARCHED.join(", ")}.`);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  console.log(`\n▶ ${file}`);
  const code = await run(file);
  if (code !== 0) {
    failed++;
    console.error(`✗ ${file} exited ${code}`);
  }
}

console.log(
  failed
    ? `\nrun-tests: ${failed} of ${files.length} file(s) FAILED`
    : `\nrun-tests: ${files.length} file(s) passed`
);
process.exit(failed ? 1 : 0);
