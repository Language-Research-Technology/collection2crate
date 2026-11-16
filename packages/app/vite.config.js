import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

/**
 * ro-crate-masp's validator doubles as a CLI, and that costs it three things a
 * bundler can't take at face value (SPEC.md §5.6 covers why we import it by
 * internal path at all):
 *
 *  - a `#!` shebang line, which is legal for Node and a syntax error for Rollup;
 *  - a trailing `if (require.main === module) { … }` CLI block, whose bare
 *    `require` is not rewritten by Vite's CommonJS interop and throws
 *    "require is not defined" the moment the module is evaluated in a browser;
 *  - a lazy `require("fs")` inside readJsonFileSync, for the path-argument form
 *    of the API. The wrapper always passes parsed objects, so that branch is
 *    unreachable here — but the bare `require` still has to go.
 *
 * Rewriting them at transform time keeps the dependency unforked.
 */
function prepareMaspValidator() {
  return {
    name: "c2c-prepare-masp-validator",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("node_modules")) return null;
      let next = code;

      if (next.startsWith("#!")) next = next.replace(/^#![^\n]*\n/, "\n");

      const cliBlock = next.indexOf("if (require.main === module) {");
      if (cliBlock >= 0) {
        next = `${next.slice(0, cliBlock)}// CLI entry point removed for the browser bundle.\n`;
      }

      next = next.replace(
        /const fs = require\(["']fs["']\);/g,
        'const fs = { readFileSync() { throw new Error("This build passes parsed objects, never file paths — there is no filesystem in the browser."); } };'
      );

      return next === code ? null : { code: next, map: null };
    },
  };
}

export default defineConfig({
  // So the built site works from any path, including a GitHub Pages subfolder.
  base: "./",
  plugins: [
    prepareMaspValidator(),
    // Buffer/process/global for transitive dependencies (exceljs and friends).
    nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
  ],
  build: {
    target: "es2022",
    // The bundled default profile (~1.6 MB) is deliberately its own chunk.
    chunkSizeWarningLimit: 2000,
  },
});
