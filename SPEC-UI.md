## 1. UI overview

The UI is a single static index.html. There is no view framework and no client-side router. Every page is a `<section>` in the same document, switching between them by toggling a hidden class. 

THe UI has a `light` and `dark` mode, toggled from `Settings` and persisted to localStorage; `light` is the default with no attribute present. The stylesheet is linked from `index.html` and the stored theme is applied by a tiny inline script in `<head>`, both before the first paint — styles imported from JS, or a theme applied once the app boots, mean a page of unstyled markup or a white flash ahead of a dark page.


## 2. Colour and typography

All colour is expressed as CSS custom properties on `:root` (`--bg`, `--panel`, `--panel-2`, `--border`, `--text`, `--muted`, `--accent`, `--ok`, `--warn`, `--err`, plus a `--mono` font stack), so every component is themed indirectly rather than hard-coded. 

Typography is the system font stack (`-apple-system`, `Segoe UI`, `Roboto`) at 15px/1.5 for body text, switching to the monospace stack for anything that is data rather than prose: identifiers, JSON/XLSX previews, code-like values, form inputs that hold technical values (dates, URLs, IDs).

Structural chrome is consistent throughout: 8–14px border radii, 1px `--border` outlines, no drop shadows except on modals, and a single accent colour (blue) used for focus rings, active/selected states, and progress fills; green/amber/red are reserved for success, warning and error states respectively (build status, validation, dirty-state badges).


## 3. Page shell

Every screen sits under a fixed two-part header:

- **Header** — app name, a one-line strapline with the tool name and a version tag.

- **Context bar** — appears once a folder is chosen; shows the active folder path plus page-switch buttons (Select, Process, Build, Show, Edit, Visualise) and a Settings button. These buttons enable/disable based on what currently exists in the folder (e.g. "Show" and "Edit" are disabled until a crate has been built).

Below that, a single `<main>` holds all views as sibling `<section>` elements, mutually exclusive via `hidden`.


## 4. Shared layout patterns

Structural CSS patterns are reused rather than styling each screen independently:

`.two-col-grid` (`.col-left` / `.col-right`) — a left/right split, stacked into a single column below a 768px breakpoint and forced side-by-side above it. Used for Select, Process, Build, Edit, Visualise screens (options left, action buttons and log/results right). Edit and Visualise have a narrow left-hand column. Show is a full-width page, with HTML/JSON/Spreadsheet options as tabs above a full-width preview pane.

Select lists should have a max width of 500px.


## 5. Interaction conventions

Navigation is entirely in-page: views change via class toggling, never a URL or page load.
Anything optional (build options, settings) defaults to a collapsed, scannable summary (a tile or a card) rather than an always-expanded form; detail is one click away in a modal.

Choosing a new folder mid-build resets the UI defensively (buttons and progress bar return to idle) even though it does not abort in-flight plugin work — a generation counter on the controller side simply stops that stale run from touching the log or UI further.

The HTML preview opens in a new browser window rather than an embedded frame: a crate preview is a full page in its own right, meant to be read at the width it was designed for. The Show page's HTML tab holds the button and a status line; JSON and Spreadsheet render in-page. The window is opened synchronously on the click, before the file is read, or the browser's pop-up blocker takes it — when it is blocked anyway, the status line says so and how to fix it.

Accessibility affordances present throughout: `aria-live` regions on status text and logs, `aria-expanded` on disclosure toggles, `role="progressbar"` with `aria-valuemin`/`max`/`now` on every progress bar, and `role="button"`/`tabindex` on the non-`<button>` clickable cards.

Action buttons (Continue, Build etc) start as primary (blue). When the button's action completes, change colour to green. If an action fails, change to red.


## 6. Logging and progess indication

### Log display

A line-by-line log is collapsed behind a Details/Hide toggle, collapsed by default, so day-to-day the UI only shows the single status line of the most recent message, rather than a scrolling wall of text. Clicking Details expands the full log history (and reveals Clear/Copy/Save buttons). 

The log is persistent across the Select, Process and Build pages. It doesn't appear on Show, Edit, Visualise pages.

For performance, appending a log span is synchronous (so nothing is dropped mid-burst even if a build throws), but the expensive follow-up work — scrolling to bottom, enabling/disabling the action buttons — is coalesced to once per animation frame via requestAnimationFrame, so hundreds of near-duplicate log lines from a noisy validator don't each force a synchronous layout.

### Log action buttons

The Clear button empties the log and resets both progress bars. All three buttons are disabled whenever the log is empty.

The Copy button writes the log panel's full text to the clipboard and flashes a checkmark on the button for two seconds as the only feedback. 

The Save button downloads the same full text as a .log file named after the current folder (c2c-<foldername>.log). 



### Progress bars

Two progress bars track 1) main progress and 2) a slimmer, secondary progress bar for long sub-steps that would otherwise sit silently inside one big step on the main bar. This is used for things like AUSTLANG language lookups, place-name geocoding, file-format identification, file export generation. hideSubProgress() fades the secondary bar out over two seconds so a fast sub-step finishing doesn't just flicker away. It's purely cosmetic nesting, visually under the main bar, but tracked and driven independently of it.


Progress is declared and weighted, not inferred from log text. A hook tap that does visible work adds weight (default 0) and, if conditional, activeWhen(ctx), alongside `priority`/`handler`:

```
hooks: {
  "files:prepare": { weight: 2, activeWhen: (ctx) => ctx.options.enableMyThing, priority: 10, handler: async (ctx) => { ... } },
},
```

Before a build, the host sums weight across every tap whose activeWhen passes (default: always) and assigns each an ordered [start%, end%] slice of the main bar. A handler reports only its own position within that slice:


```
ctx.progress.start(label);
ctx.progress.report(fraction, label);  // fraction ∈ [0,1], local to this tap
ctx.progress.done();
```


`report()` drives the main bar (scaled into the tap's slice) and the sub-bar (raw fraction) from one call — no done/total string parsing. runPipeline() calls ctx.progress.complete() / fail(error) on return/throw. ctx.log and ctx.progress are independent channels; no log message drives bar state.

The sub-bar is not a separate call — it appears automatically the first time a tap calls `report()` more than once before `done()` (a granular, multi-item step), and stays hidden for a tap that only brackets `start()`/`done()` around a single label. `done()` always snaps the main bar to the tap's slice end and, if shown, fades the sub-bar. Only one tap is ever live at a time (handlers run sequentially), so one shared sub-bar element suffices.



## 7. Reconciling files with an existing crate

When a picked folder holds an existing crate whose file entities don't match the folder (SPEC.md §4.4a), a modal opens straight after the pick, using the shared `openModal` shape. It doesn't open when every file matches.

- **Two lists, each shown only if it has entries:** "New files" (in the folder, not in the crate) and "Missing files" (in the crate, not in the folder). Paths use the monospace stack, and each list has a count in its heading.
- **Each row has a two-way toggle:** Add / Ignore for new files, Remove / Keep for missing files. They default to Add and Remove, so the folder is the source of truth unless the user says otherwise.
- **Each list has "all" controls** (Add all / Ignore all, Remove all / Keep all), because a large folder can produce hundreds of rows.
- **Long lists scroll** inside the modal, with a filter box above them once a list passes 20 rows. The "all" controls act on the rows the filter is showing.
- **Confirm applies the decisions.** Cancel, ✕ or Escape keeps the choices as they were — the defaults, the first time — so dismissing the modal is never a silent "keep everything".
- **The existing-crate card on Select summarises the result** (e.g. "Next build: 3 new file(s) added, 1 missing entity removed") and has a link to reopen the modal. Changing a choice after Process has run discards what Process prepared, as changing a processing option does, since Process read a different set of files.
