// No plugin imports from another plugin's folder.
//
// A plugin that reaches into another's files breaks whenever that plugin is
// reorganised, and makes the other plugin's internals a contract nobody
// declared. Code two plugins need lives in lib/ instead. Tests are exempt:
// one may check two plugins working together.
//
//   npm test -w collection2crate-plugins -- boundaries
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PLUGINS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins");
// Static `from "..."`, `import "..."` and dynamic `import("...")` specifiers.
const SPECIFIER = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;

async function sourceFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (/\.(m?js)$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) files.push(full);
  }
  return files;
}

const crossings = [];
for (const plugin of (await readdir(PLUGINS, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)) {
  const own = path.join(PLUGINS, plugin);
  for (const file of await sourceFiles(own)) {
    // Comments may quote an import (a deps thunk, say) without making one.
    const text = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1] || match[2] || match[3];
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      const relative = path.relative(PLUGINS, target);
      if (relative.startsWith("..")) continue; // lib/, outside plugins/
      if (relative.split(path.sep)[0] !== plugin) {
        crossings.push(`${path.relative(PLUGINS, file)} imports ${specifier}`);
      }
    }
  }
}

try {
  assert.deepEqual(crossings, [], "move what two plugins share into lib/");
  console.log("  ok   no plugin imports from another plugin's folder");
} catch (e) {
  console.log(`  FAIL no plugin imports from another plugin's folder\n       ${crossings.join("\n       ")}`);
  console.error("\nboundaries.test: 1 check(s) failed");
  process.exit(1);
}
console.log("\nAll checks passed");
