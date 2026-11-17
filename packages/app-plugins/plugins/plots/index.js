import embed from "vega-embed";
import { button, element, note } from "../../src/_panel.js";
import { createDefaultConfig, embedOptions, generatePlotSpecs, layoutSpan, validatePlotsConfig } from "./model.js";
import { openPlotsConfigEditor } from "./config/editor.js";
import PACKAGE from "../../package.json" with { type: "json" };

export const CONFIG_PATH = "_config/plots/config.json";

/** The pinned ro-crate-plots commit, shortened, e.g. "github:org/ro-crate-plots#d53c3e0…" -> "d53c3e0". */
export function libraryPin(spec = PACKAGE.dependencies?.["ro-crate-plots"]) {
  if (!spec) return "unknown";
  const ref = String(spec).split("#")[1];
  return ref ? (/^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref) : spec;
}

/** A small pencil button that opens the config editor at one plot's settings. */
function editPlotButton(index, onClick) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z");
  svg.append(path);
  const node = element("button", {
    className: "plots-card-edit",
    attrs: { type: "button", title: "Edit this plot's settings", "aria-label": `Edit plot ${index + 1} settings` },
  }, [svg]);
  node.addEventListener("click", onClick);
  return node;
}

function afterLayout() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function createPlugin(deps = {}) {
  const { readFileTextFromDirectory, writeFileAtPath, openModal } = deps;
  return {
    name: "plots",
    visualisation: {
      label: "Plots",
      hint: "Build Vega and Vega-Lite plots from loaded RO-Crate tables.",
      render(container, { tables = [], dirHandle = null, log = () => {} }) {
        let config = createDefaultConfig(tables);
        let initialized = false;
        const status = element("p", { className: "field-hint" });
        const plotHost = element("div", { className: "plots-grid" });
        const configure = button("Configure plots…", { primary: true, onClick: () => editConfig() });
        const topbar = element("div", { className: "actions" }, [configure]);
        const empty = note("No plots configured yet. Choose Add a plot below to create one.");
        const loading = note("Loading plots configuration…");
        const pin = element("p", {
          className: "field-hint plots-library-pin",
          text: `ro-crate-plots @ ${libraryPin()}`,
          attrs: { title: `Pinned in collection2crate-plugins/package.json: ${PACKAGE.dependencies?.["ro-crate-plots"] || "not declared"}` },
        });

        function show() {
          container.replaceChildren(
            element("h2", { text: "Plots" }),
            note("Create interactive Vega and Vega-Lite visualisations from tables loaded from this folder."),
            topbar,
            pin,
            status,
            plotHost,
          );
        }

        /** Open the config editor; focus is a plotList index (that plot's settings) or "add" (Add a plot). */
        async function editConfig(focus) {
          if (!openModal) {
            status.textContent = "The host did not provide its configuration editor API.";
            return;
          }
          const edited = await openPlotsConfigEditor({ config, tables, openModal, focus });
          if (!edited) return;
          try {
            const checked = validatePlotsConfig(edited);
            if (!dirHandle || !writeFileAtPath) {
              status.textContent = `Choose a collection folder before saving ${CONFIG_PATH}.`;
              return;
            }
            await writeFileAtPath(dirHandle, CONFIG_PATH, `${JSON.stringify(checked, null, 2)}\n`);
            config = checked;
            status.textContent = `Saved ${CONFIG_PATH}.`;
            await renderPlots();
          } catch (error) {
            status.textContent = `Could not save plots configuration: ${error.message}`;
            log(`Plots: could not save ${CONFIG_PATH}: ${error.message}`, "warn");
          }
        }

        // A dashed tile after the last plot that opens the editor at Add a plot.
        const addTile = () => {
          const tile = element("button", {
            className: "plots-add-tile",
            attrs: { type: "button", title: "Open Configure plots at Add a plot" },
          }, [element("span", { className: "plots-add-tile-icon", text: "＋", attrs: { "aria-hidden": "true" } }), element("span", { text: "Add a plot" })]);
          tile.addEventListener("click", () => editConfig("add"));
          return tile;
        };

        async function renderPlots() {
          plotHost.replaceChildren();
          const { plots, missing } = await generatePlotSpecs(config, tables);
          if (!plots.length) {
            plotHost.append(empty, element("div", { className: "plots-grid-inner" }, [addTile()]));
            if (missing.length) status.textContent = `Configured datasets not currently loaded: ${missing.map((item) => item.name).join(", ")}.`;
            else if (!tables.length) status.textContent = "No tables loaded. Select an output folder containing roctable CSVs, then configure plots.";
            else status.textContent = "No plots configured yet.";
            return;
          }
          const grid = element("div", { className: "plots-grid-inner" });
          const pendingEmbeds = [];
          for (const result of plots) {
            // No heading of our own: a plot's title is the one Vega draws from its spec, if any.
            const specTitle = result.plot.makeSpec?.args?.title ?? result.plot.customSpec?.title;
            const titleText = typeof specTitle === "object" && specTitle !== null && !Array.isArray(specTitle) ? specTitle.text : specTitle;
            const label = (Array.isArray(titleText) ? titleText.join(" ") : String(titleText ?? "")).trim() || `Plot ${result.index + 1}`;
            const card = element("section", { className: "plots-card", attrs: { "aria-label": label } });
            card.style.gridColumn = `span ${layoutSpan(result.plot)}`;
            card.append(editPlotButton(result.index, () => editConfig(result.index)));
            if (result.error) {
              card.append(note(`Plot ${result.index + 1}: ${result.error}`));
            } else {
              for (const warning of result.warnings || []) card.append(note(warning));
              const target = element("div", { className: "plots-view" });
              card.append(target);
              pendingEmbeds.push({ target, result });
            }
            grid.append(card);
          }
          grid.append(addTile());
          plotHost.append(grid);
          // Vega's container sizing needs the plot targets to be attached and
          // laid out; embedding while detached makes autosize measure zero.
          await afterLayout();
          for (const { target, result } of pendingEmbeds) {
            const options = embedOptions(config, result.plot);
            try {
              const embedded = await embed(target, result.spec, options);
              if (typeof ResizeObserver !== "undefined" && embedded?.view) {
                let previousWidth = target.getBoundingClientRect().width;
                const observer = new ResizeObserver((entries) => {
                  const width = entries[0]?.contentRect.width || 0;
                  if (!width || Math.abs(width - previousWidth) < 1) return;
                  previousWidth = width;
                  void embedded.view.resize().runAsync();
                });
                observer.observe(target);
              }
            } catch (error) {
              if (options.actions === false || options.actions === undefined) {
                target.replaceChildren(note(`Could not render plot ${result.index + 1}: ${error.message}`));
                continue;
              }
              try {
                const embedded = await embed(target, result.spec, { ...options, actions: false });
                const warning = note(`Plot rendered without Vega action links: ${error.message}`);
                target.before(warning);
                if (typeof ResizeObserver !== "undefined" && embedded?.view) {
                  let previousWidth = target.getBoundingClientRect().width;
                  const observer = new ResizeObserver((entries) => {
                    const width = entries[0]?.contentRect.width || 0;
                    if (!width || Math.abs(width - previousWidth) < 1) return;
                    previousWidth = width;
                    void embedded.view.resize().runAsync();
                  });
                  observer.observe(target);
                }
              } catch (fallbackError) {
                target.replaceChildren(note(`Could not render plot ${result.index + 1}: ${fallbackError.message} (action-link attempt: ${error.message})`));
              }
            }
          }
          const missingNames = missing.map((item) => item.name);
          status.textContent = missingNames.length ? `Datasets not loaded: ${missingNames.join(", ")}.` : "";
        }

        async function initialize() {
          show();
          status.textContent = "";
          if (!dirHandle || !readFileTextFromDirectory) {
            status.textContent = `Choose a collection folder to load or save ${CONFIG_PATH}.`;
            await renderPlots();
            return;
          }
          try {
            const saved = await readFileTextFromDirectory(dirHandle, CONFIG_PATH);
            if (saved == null) {
              config = createDefaultConfig(tables);
              status.textContent = `No saved plots config. Create one at ${CONFIG_PATH}.`;
              await renderPlots();
              if (!initialized) await editConfig();
            } else {
              config = validatePlotsConfig(JSON.parse(saved));
              await renderPlots();
            }
          } catch (error) {
            status.textContent = `Could not load ${CONFIG_PATH}: ${error.message}. The saved file was left unchanged.`;
            config = createDefaultConfig(tables);
            await renderPlots();
          } finally {
            initialized = true;
          }
        }

        const style = element("style", { attrs: { id: "plots-panel-style" } });
        style.textContent = `
.plots-grid-inner { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.plots-library-pin { margin:4px 0; font:11px var(--mono); opacity:0.7; }
.plots-card { position:relative; min-width:0; border:1px solid var(--border); border-radius:var(--radius-sm); padding:30px 12px 12px; }
/* The edit button sits in a strip of its own above the plot, so it never covers Vega's title or "…" menu. */
/* An outlined square with an accent-coloured pencil, so it reads as a button at a glance; hover fills it. */
.plots-card-edit { position:absolute; top:3px; left:7px; display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--panel); color:var(--accent); cursor:pointer; }
.plots-card-edit svg { width:16px; height:16px; fill:currentColor; }
.plots-card-edit:hover, .plots-card-edit:focus-visible { border-color:var(--accent); background:var(--accent-soft); }
/* Dashed and quiet beside the plots, turning accent on hover, like the editor's Add a plot panel. */
.plots-add-tile { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; min-height:120px; border:1px dashed var(--border); border-radius:var(--radius-sm); background:transparent; color:var(--muted); font:inherit; font-size:14px; font-weight:600; cursor:pointer; transition:border-color .15s ease, color .15s ease, background .15s ease; }
.plots-add-tile-icon { font-size:24px; font-weight:400; line-height:1; }
.plots-add-tile:hover, .plots-add-tile:focus-visible { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }
.plots-view { display:block; width:100%; min-width:0; min-height:220px; overflow:auto; }
.plots-view.vega-embed { display:block; box-sizing:border-box; width:100%; max-width:100%; }
.plots-view.vega-embed.has-actions { height:320px; }
.plots-view.vega-embed > .chart-wrapper { width:100%; max-width:100%; }
/* vega-embed stacks its "…" button at z-index 1000 and menu at 1001, above the host's
   sticky header (20) and modals (50). Keep them just above neighbouring plots instead. */
.plots-view.vega-embed summary { z-index:2; }
.plots-view.vega-embed .vega-actions { z-index:3; }
@media(max-width:900px) { .plots-grid-inner { grid-template-columns:repeat(2,minmax(0,1fr)); } .plots-card[style*="span 3"] { grid-column:span 2 !important; } }
@media(max-width:600px) { .plots-grid-inner { grid-template-columns:1fr; } .plots-card { grid-column:span 1 !important; } }
`;
        if (!document.getElementById("plots-panel-style")) document.head.append(style);
        show();
        void initialize();
      },
    },
    outputPaths: [{ path: "_config/plots", kind: "dir" }],
  };
}
