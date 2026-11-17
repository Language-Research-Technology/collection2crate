// Vite-specific asset loading for the vendored siegfried WASM build, split
// out from matcher.js so matcher.js itself stays loadable under plain Node
// (matcher.test.mjs pre-seeds globalThis.identify itself and never reaches
// this module — see matcher.js's loadSiegfried()). This file's own static
// imports below only resolve inside a Vite build/dev server.
//
// wasm_exec.js is a plain script that mutates globalThis (sets globalThis.Go,
// globalThis.fs, etc.) — not an ES module, so it can't be `import`ed
// directly; running its source through the Function constructor is the
// standard way to load Go's WASM glue inside a bundler, and keeps it out of
// module-local scope (it only needs to reach globalThis, which it does
// regardless of the executing function's own scope).
import sfWasmUrl from "./sf.wasm?url";
import wasmExecSrc from "./wasm_exec.js?raw";

// go.run(instance) never resolves: sf.wasm's main() (wasm/wasm.go in the
// siegfried repo) sets globalThis.identify and then blocks forever on
// `<-make(chan bool)` to keep the Go runtime alive for later calls — so it
// must be started without awaiting, then polled for readiness (confirmed
// empirically; there's no other signal exposed for "identify is now
// available").
export async function boot() {
  new Function(wasmExecSrc)();
  const go = new globalThis.Go();
  const bytes = await (await fetch(sfWasmUrl)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  go.run(instance); // intentionally not awaited — see comment above
  for (let i = 0; i < 500 && typeof globalThis.identify !== "function"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (typeof globalThis.identify !== "function") {
    throw new Error("siegfried WASM module failed to initialize (identify() never became available)");
  }
}
