import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Reload the page when collection2crate-plugins changes.
 *
 * The plugins arrive through a symlink under node_modules (preserveSymlinks
 * keeps that path), and Vite never watches node_modules — so an edit to a
 * plugin, or a `git pull` in that checkout, was invisible until the dev
 * server was restarted. This watches the checkout's own source folders and
 * drops every cached transform when one of them changes.
 */
function watchPluginsCheckout() {
  const link = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "node_modules/collection2crate-plugins");
  return {
    name: "c2c-watch-plugins-checkout",
    apply: "serve",
    configureServer(server) {
      if (!existsSync(link)) return;
      const root = realpathSync(link);
      const watched = ["index.js", "plugins", "src"].map((part) => path.join(root, part));
      server.watcher.add(watched);
      const reload = (file) => {
        if (!watched.some((dir) => file === dir || file.startsWith(dir + path.sep))) return;
        server.moduleGraph.invalidateAll();
        server.ws.send({ type: "full-reload" });
        server.config.logger.info(`collection2crate-plugins changed (${path.relative(root, file)}) — reloading`, { timestamp: true });
      };
      for (const event of ["change", "add", "unlink"]) server.watcher.on(event, reload);
    },
  };
}

export default defineConfig({
  // So the built site works from any path, including a GitHub Pages subfolder.
  base: "./",
  plugins: [
    prepareMaspValidator(),
    watchPluginsCheckout(),
    // Buffer/process/global for transitive dependencies (exceljs and friends).
    nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
  ],
  optimizeDeps: {
    // collection2crate-plugins is a local, symlinked source checkout, not a published
    // package, and its modules use Vite's own ?raw / ?url suffixes — which
    // esbuild's dependency pre-bundler doesn't understand, so it fails the dev
    // server outright. Excluding it leaves those imports to Vite's own
    // pipeline, which is where they were always meant to be handled.
    exclude: ["collection2crate-plugins"],
    // Excluding a package also stops Vite pre-bundling what that package
    // imports — and collection2crate-plugins' own dependency tree is mostly CommonJS, living
    // in its own nested node_modules because it is a symlinked checkout. Served
    // raw, `import mammoth from "mammoth"` is a CJS module with no ESM default
    // export, and the dev server dies on it. These are every CJS dependency
    // reached from collection2crate-plugins, named with Vite's `parent > child` syntax so
    // they are pre-bundled to ESM even though their parent is not. Production
    // is unaffected: Rollup's commonjs plugin handles all of this at build time.
    include: [
      "collection2crate-plugins > mammoth",
      "collection2crate-plugins > cheerio",
      "collection2crate-plugins > exceljs",
      "collection2crate-plugins > ro-crate",
      "collection2crate-plugins > ro-crate-excel",
      "collection2crate-plugins > ro-crate-excel/lib/workbook.js",
      "collection2crate-plugins > roctable > ro-crate",
      "collection2crate-plugins > roctable > csv-parse/sync",
      "collection2crate-plugins > roctable > csv-stringify/sync",
    ],
  },
  resolve: {
    // collection2crate-plugins is a local file: dependency, so it arrives as a symlink;
    // without this Vite resolves through it and loses the package identity.
    preserveSymlinks: true,
  },
  build: {
    target: "es2022",
    // The bundled default profile (~1.6 MB) is deliberately its own chunk.
    chunkSizeWarningLimit: 2000,
  },
});
