// File-format identification via siegfried's own official WASM build
// (sf.wasm + wasm_exec.js, this folder — vendored from
// https://github.com/richardlehane/siegfried/releases, currently v1.11.6;
// see SIEGFRIED-LICENSE.txt for its Apache-2.0 terms; refresh with
// `npm run update:pronom`, see update-sf-wasm.mjs). Real siegfried, not a
// reimplementation — full PRONOM byte-signature *and* container-signature
// matching (proper docx/xlsx/odt disambiguation, not a heuristic), plus its
// own built-in extension-based fallback with mismatch warnings, all running
// client-side since collection2crate is browser-only with no server/Node runtime.
//
// getFileHandleAtPath is a collection2crate core function, injected once via
// configure() rather than imported by relative path — called from
// file-format-identify/index.js's createPlugin(deps) before this module's
// exports are used. See this repo's README.
let getFileHandleAtPath;
export function configure(deps) {
  ({ getFileHandleAtPath } = deps);
}

/* ---------- loading the WASM module (once, lazily) ----------
 * The actual Vite-specific asset loading (fetching sf.wasm, running
 * wasm_exec.js) lives in wasm-loader.js, dynamically imported here rather
 * than statically — that keeps this module itself loadable under plain
 * Node (matcher.test.mjs pre-seeds globalThis.identify with its own
 * Node-side WASM instantiation and never triggers this import at all; see
 * that file). In real (browser) use, globalThis.identify is never already
 * present, so this always takes the real loading path. */
let readyPromise = null;
function loadSiegfried() {
  if (!readyPromise) {
    readyPromise = typeof globalThis.identify === "function"
      ? Promise.resolve()
      : import("./wasm-loader.js").then((mod) => mod.boot());
  }
  return readyPromise;
}

/* ---------- per-file identification ---------- */
async function identifyHandle(fileHandle) {
  const raw = await globalThis.identify(fileHandle, "json");
  const parsed = JSON.parse(raw);
  const match = parsed.files?.[0]?.matches?.[0];
  // siegfried reports a genuinely no-match file as a real match object with
  // id: "UNKNOWN" (format/mime left blank) rather than an empty matches
  // array — confirmed against the actual WASM output — so this needs an
  // explicit check, not just a truthiness check on match.id.
  if (!match || !match.id || match.id === "UNKNOWN") return null;
  return {
    puid: match.id,
    name: match.format || match.id,
    mime: match.mime || null,
    warning: match.warning || "",
  };
}

/**
 * Identify file formats for each file by content (real siegfried, run
 * client-side via WASM).
 * @returns a Map of file id -> { puid, name, mime, warning }, only for
 * files that matched something.
 *
 * Keyed by id rather than position in filesWithMeta for the same reason
 * austlang's identifyAllLanguages is (see that module): produced at
 * files:prepare, consumed a hook stage later at crate:build.
 *
 * Calling identify() per file (not once over the whole directory) keeps
 * this consistent with every other per-file scan in this codebase — a
 * single directory-level call has no per-file progress signal (siegfried's
 * own directory walk in wasm/wasm.go has no exclusion list either, so it
 * would also pick up collection2crate's own generated/control files) — and lets
 * the existing sub-progress-bar log lines (main.js's
 * updateBuildProgressFromLog) keep working unchanged.
 */
const CHUNK = 10;

export async function identifyAllFormats(dirHandle, filesWithMeta, log = () => {}, report = () => {}) {
  await loadSiegfried();
  const total = filesWithMeta.length;
  log(`Identifying file formats for ${total} file(s) (offline, siegfried WASM)…`, "muted");
  const byId = new Map();
  for (let i = 0; i < total; i++) {
    const file = filesWithMeta[i];
    const fileHandle = await getFileHandleAtPath(dirHandle, file.relativePath);
    if (fileHandle) {
      const result = await identifyHandle(fileHandle);
      if (result) {
        byId.set(file.id, result);
        const suffix = result.warning ? ` (${result.warning})` : "";
        log(`  ${file.fileName} → ${result.name} (${result.puid})${suffix}`, "muted");
      }
    }
    if ((i + 1) % CHUNK === 0 || i + 1 === total) {
      // Reported, not logged — see the same loop in austlang's matcher.
      report((i + 1) / total, `Format identification: ${i + 1}/${total} file(s)…`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return byId;
}
