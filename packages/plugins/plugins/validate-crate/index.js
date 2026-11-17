// Runs the selected MASP profile's validator against the built crate and
// logs pass/fail — automatic whenever a profile is selected, no
// optionSchema. ro-crate-masp is a heavy dependency (pulls in the whole
// validator library), so it's still dynamically imported here, same as
// before this was extracted from processFolder — deps.loadMasp is a thunk
// collection2crate hands in (`() => import("../masp.js")`) rather than a
// direct import, so masp.js stays dynamically imported from collection2crate's
// own tree and this package never statically references it. See this
// repo's README for the createPlugin(deps) contract.
import { progressFor } from "../../src/_progress.js";

let loadMasp;

export function createPlugin(deps) {
  ({ loadMasp } = deps);
  return plugin;
}

const plugin = {
  name: "validate-crate",
  hooks: {
    "crate:validate": {
      priority: 10,
      weight: 3,
      activeWhen: (ctx) => !!ctx.selectedProfileData,
      handler: async (ctx) => {
        const { crate, selectedProfileData, log } = ctx;
        if (!selectedProfileData) return;
        const progress = progressFor(ctx);
        progress.start("Validating crate against profile…");
        try {
          const graph = crate?.getJson?.()["@graph"] || [];
          const entityCount = Array.isArray(graph) ? graph.length : 0;
          log(`Validating crate against profile (${entityCount} entities)…`, "muted");
          const { validateBuiltCrate } = await loadMasp();
          // ro-crate-masp's onProgress fires once per profile class rule (not
          // per entity — see that repo's validateTargetCrateGraph), so on a
          // large crate this is a handful of ticks, not thousands. It feeds
          // the bar directly now; the old version wrote "3/11 rule(s)…" into
          // the log for the host to parse back out, which is exactly what the
          // declared-weight progress contract replaced.
          const result = await validateBuiltCrate(selectedProfileData.validator, crate, (p) => {
            progress.report(p.total ? p.current / p.total : 1, `Validating crate against profile: ${p.current}/${p.total} rule(s)…`);
          });
          if (result.ok) {
            log("Profile validation passed — crate conforms to the selected profile.", "ok");
          } else {
            log(`Profile validation found ${result.errors.length} issue(s):`, "warn");
            for (const e of result.errors) log(`  • ${e.message}`, "warn");
          }
        } catch (e) {
          log(`Profile validation could not run: ${e.message}`, "warn");
        } finally {
          progress.done();
        }
      },
    },
  },
};
