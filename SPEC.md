# Collection2Crate — SPEC

**What it is:** a browser tool that turns a folder of files on your computer into an [RO-Crate](https://www.researchobject.org/ro-crate/), with optional data cleaning, data processing and format conversion steps. Collection2Crate is built for people organising diverse collections of files who need consistent, publishable metadata without becoming RO-Crate experts.

---

## 1. What collection2crate does

The user opens a local folder, picks a *profile* according to what kind of collection it is, and goes through workflow steps specified by the profile. Workflows may be different for different types of collections, and may include steps for data cleaning, file conversion, automatically adding metadata based on file contents, build RO-Crate, and other actions. Workflow steps are specified by the selected profile. 

### Key concepts:

- **Nothing leaves the machine.** All reads and writes are handled by the File System Access API. No server, no upload, no accounts needed.

- **It uses the RO-Crate libraries** — `ro-crate` for the graph, `ro-crate-excel` to read and write the excel version, `ro-crate-static-site` to genereate the HTML static site preview. Ro-Crate libraries are used rather than bespoke JSON-LD scripts.

- **A profile decides what the tool does for a selected run.** A MASP profile determines which fields you're asked for in describing the collection, which capabilities are available for processing metadata and data, what gets written out, how the preview is laid out, and what counts as a valid RO-Crate. The bundled schema.org default is a minimal profile with a minimal crate and a plain preview, nothing domain-specific and no processing actions. 

- **Almost everything is a plugin.** The core builds a graph and hands it around; file processing, data merging, validation, and file outputs are handled by plugins tapping named lifecycle hooks which determine when a plugin runs. Each one declares its own UI. Plugins can add UI "tiles" to the Process or Build pages through their `pluginOptionsSchema` config, and into the Settings modal through their `pluginSettingsSchema` config. Plugins can be enabled or disabled by default; those with no options or settings are effectively "always on".

**The core c2c tool** turns a selected file list into an RO-Crate graph and serialises it. It has no opinion about where the files came from, what enriched them, or how they're presented.

**The pipeline** owns only the mandatory steps: initialises a context object, load existing crate, load plugins, update context with data from, root description form, build in-memory crate, validate crate, output crate.

**State** that must persist across a session (theme, folder-handling mode, overwrite behaviour, an uploaded template) is written to localStorage and is explicitly independent of the active MASP profile. Build options, by contrast, always reset from the profile at the start of each run.



---

## 2. The shape of the system

The workflow follows a process of sequential steps, each emitting one or more hooks (see §4.2 for a list of hooks). 

1) **Startup**
- Page loads

2) **Select**
- Interface to select folder and profile

- Select folder
    - If a crate exist, c2c loads existing crate using whichever is newest of JSON/Excel formats

- Select a MASP profile 
    - Plugins are installed according to profile's tool-config 

3) **Process**
- Interface to describe, process the collection's files and merge metadata
- Available after profile:selected hook is emitted

- Describe the collection
    - c2c overrides existing root collection metadata with metadata from a description form. Fields are derived from selected profile's root collection metadata schema and pre-populated if there's an existing crate.

- Process files using plugin options
    - Plugins use this hook to affect data and metadata. Plugins may output file format conversions here so they can be written into the crate if needed.
  
- Metadata merge
    - This is a good time for plugins to merge metadata from an uploaded spreadsheet into an existing crate, after all file processing happens.


4) **Build**
- Interface to build the RO-Crate files
- Available after profile:selected is emitted, as profiles with no plugins may entirely skip the process step
    - c2c builds an in-memory RO-Crate
    - c2c uses MASP validator to validate the crate and logs pass/fail with per-rule progress
    - c2c outputs JSON and Excel formats of the crate. If a crate exists, existing `ro-crate-metadata` files are moved into a `_backups` dir (into a dated subdir) before the new crate files are generated.
    - HTML preview plugin may write a HTML static site using ROCSS.


5) **Show** (available after crate:build is emitted)
- Interface to show crate files
    - Launch the HTML preview if built
    - View the JSON metadata (in-browser JSON viewer)
    - View the Excel metadata (in-browser spreadsheet viewer)
    - Available after crate:build hook has been emitted 
    - No hooks are run in this mode
     
6) **Edit**
- Interface to edit the crate data in form style interface
    - Available after crate:build hook has been emitted 
    - No hooks are run in this mode

7) **Visualise**
- Interface to select data from output folders or results of tabular plugin and perform data vis actions on the selected data.
    - Available after crate:build hook has been emitted 
    - No hooks are run in this mode


The interface has a menu with items for the main steps, as well as a Settings item, which opens a UI modal for c2c and plugin settings. 


---

## 3. Key concepts

**RO-Crate** — a packaging standard: a folder plus a JSON-LD manifest describing its contents as a graph of typed, linked entities.

**Entity** — a node in that graph: a `File`, a `Person`, a `Place`, a `RepositoryCollection`. Identified by `@id`, typed by `@type`, linked by properties like `hasPart`, `author`, `contentLocation`.

**MASP profile** — *Machine-Actionable Schema/Profile*. Itself an RO-Crate, published in a profile repository, formally stating what entity types a conforming crate contains, which properties each may or must carry, and what values those accept. Read through the [`ro-crate-masp`](https://github.com/Language-Research-Technology/ro-crate-masp) validator.

**Hook** — a named point in the build lifecycle where plugins run. 

**Plugin** — a module exporting a `plugin` object with an optional UI schema fragment and a set of hook handlers.


---

## 4. Hooks and pipeline

This is the heart of the system, defined in `src/plugins/hooks.js` and `src/plugins/pipeline.js`. 

### 4.1 The hook bus

The hook bus keeps track of each registered plugins' intentions, according to the stages that are intended. It is a small in-memory registry, implemented as a `Map` from hook name to an array of handler entries.

c2c has one registration primitive and one invocation primitive:

```js
hookBus.on(hookName, handler, { priority: 20, pluginName: "plugin-name" }) // hook bus registration
await hookBus.emit(hookName, ctx) // pipeline invocation, runs all handlers in order
```

c2c's `registerAllPlugins()` pushes each plugin's handler onto each hook's array and re-sorts it by priority (default `10`, stable sort so ties keep registration order). c2c's `runPipeline()` looks up that hook's array and runs each handler in order.

A handler is a plain Javascript function in a plugin's `hooks` object, keyed by the name of the hook it taps. A plugin can have handlers for multiple hooks in that same object.

Example hook handler:

```
const plugin = {
  name: "plugin-name",
  hooks: {
    "files:prepare": { priority: 20, handler: async (ctx) => { ... } },
  },
};
```

Handlers run **sequentially and awaited**, never in parallel. They mutate a shared crate, ordering is handled by setting the priority.

A small helper sits next to the bus: `announceAndEmit(hookBus, hookName, ctx)` calls `ctx.log` with which plugins are registered for a hook, in run order, before calling `emit`, and logs even when none are, as confirmation the hook point itself exists and fired, not just a report of what ran. Every caller below uses it instead of `emit` directly, so a build or a folder pick traces its own actual shape rather than relying on each plugin to self-report. Any `ctx` passed through it must carry a `log` function.


### 4.2 The hooks

Nine hooks are used, defined in `src/plugins/hooks.js`.

| Hook | When | Actions |
|---|---|---|
| c2c:loaded | Startup | c2c initialises a `ctx` object, a shared data object which plugins can read from and write to. |
| folder:picked | Select folder | Folder and file list stored in `ctx`, existing crate loaded to `ctx`. |
| profile:selected | MASP selected | Plugins selected by profile tool-config are installed and options are loaded into `ctx` options. |
| files:prepare | Process files | Plugins may affect data and metadata. |
| files:write | Process files | Plugins write files they derived from the folder's own (CSV, CHAT, converted media). No crate exists yet. |
| metadata:merge | Process files | Plugins may merge metadata from an uploaded spreadsheet. |
| crate:prepare | Build | c2c merges root collection metadata from the Describe form into `ctx`; plugins seed the crate's own metadata from what the file stages found, immediately before it is assembled. |
| crate:build | Build | c2c builds an in-memory RO-Crate. |
| crate:validate | Build | c2c validates the crate. |
| crate:write | Build | Write RO-Crate files. |



### 4.3 The context object

When the tools starts, it creates an empty `ctx` object. Subsequent steps will add to it: `selectedDir`, `files`, `options` (every Build option and Setting, flattened), `log`.

The pipeline and plugins add to it as they go: `langById` from the AUSTLANG plugin, `entities` and `typeCounts` from the pipeline, `buildHtml` from the HTML plugin, etc.

Plugins are stateless. The bus is created once at module load and handlers registered once; all per-build state lives in the fresh `ctx`.


### 4.4 The pipeline

The pipeline is a sequence of hook emissions.

```js
const { builder, standDown } = resolveBuilder(hookBus, ctx);   // who assembles the crate; who doesn't run at all
await announceAndEmit(hookBus, FILES_PREPARE, ctx, { skip: standDown });   // announced every build, whether or not anything taps it
await announceAndEmit(hookBus, FILES_WRITE, ctx, { skip: standDown });     // derived files reach the folder here, before any crate exists
await announceAndEmit(hookBus, METADATA_MERGE, ctx, { skip: standDown });
await announceAndEmit(hookBus, CRATE_PREPARE, ctx, { skip: standDown });   // the crate's own metadata, immediately before assembly
await announceAndEmit(hookBus, CRATE_BUILD, ctx, { skip: standDown });     // the builder at <=10, then every annotating tap from 20
if (!ctx.crate) throw new Error(...);                 // a builder that built nothing fails the build here
ctx.entities   = graph.length;                        // core: entity stats
ctx.typeCounts = collectTypeCounts(graph);
await announceAndEmit(hookBus, CRATE_VALIDATE, ctx, { skip: standDown });
await announceAndEmit(hookBus, CRATE_WRITE, ctx, { skip: standDown });
```

**The crate is assembled by a plugin, not by the core.** A *builder* is an
ordinary plugin whose `crate:build` tap sits in the builder band — priority
`<= BUILDER_PRIORITY` (10) — and assigns `ctx.crate`. Taps at 20 and above
annotate the crate a builder produced, which is the assumption the old,
separate `crate:built` stage used to guarantee. The pipeline registers nothing
of its own on the bus: `generic-input`'s tap at 10 is what calls `crate.js`'s
`buildCrate()`, and it is in `PLUGINS` like everything else (§4.5).

**Exactly one builder runs per build.** `resolveBuilder()` takes the builder
taps whose `activeWhen(ctx)` passes and keeps the lowest priority; every tap
belonging to a builder that lost is skipped for the whole build, on every
stage. That last part is what makes the mechanism work without any plugin
knowing about another: `generic-input`'s folder scan is its own
`files:prepare` tap at priority 0, and it does not run on a build `docx-input`
won — no `analyzeFiles` method, no host special case, no input mode. A
builder with no `activeWhen` is the fallback; the gated ones sit below it and
take the band when their option is on.

Two failures are explicit rather than silent: no active builder at all (the
profile's options, or this deployment's `PLUGINS` selection, left none) fails
before the first handler runs, and a builder that finishes leaving no
`ctx.crate` fails at the end of `crate:build` rather than carrying an empty
hand into validation.

**`files:write` is where derived files reach the folder.** A plugin that turns
the folder's own files into new ones — a transcript into a CSV, a document into
a CHAT file, a video into a derivative — writes them at this stage, with its
inputs prepared by `files:prepare` and no crate in the picture yet. Two stages
write to disk, and they answer different questions: `files:write` puts *files*
in the folder, `crate:write` serialises *the crate* (§4.2). A plugin that does
both writes its files here and adds the entities describing them at
`crate:build`, which is the only point where `ctx.crate` exists.

**The two steps run disjoint halves of the pipeline.** Process runs the file
half — `files:prepare → files:write → metadata:merge` — and Build runs the
crate half — `crate:prepare → crate:build → crate:validate → crate:write`.
Every `crate:` stage belongs to Build; the split is exactly where the names say
it is. Nothing runs twice — the file work happens once, in Process, and a build
assembles a crate from it rather than redoing it — and each stage is emitted by
exactly one of the two steps.

**`crate:prepare` opens the crate half, and has to.** It runs immediately
before assembly, after the file stages have had their say — so a tap here sees
the finished picture of what the crate will describe rather than a half-formed
one. It belongs to Build for a mechanical reason as well as a tidy one:
`ctx.config` is host-owned and rebuilt from the profile and the Describe form
on every run, so anything a `crate:prepare` tap seeds into it — as
`xlsx-crate-input` seeds `config.rootDataset` from a workbook's root entity —
would be overwritten by the next run's refresh if it were prepared in the
step before. Settling the crate's metadata in the same run that assembles the
crate is what makes that seeding survive to be used.

**A build continues the ctx Process left behind.** A build does not start from
a fresh `ctx`: it reuses the one its Process run finished with, so `langById`,
`caDataPrep`, `xlsxCrate` — whatever a file-stage tap put there — is still in
hand when `crate:build` reads it. The host-owned fields are
refreshed over the carried object each run (options and describe values can
have changed in between); everything a plugin added is carried untouched. A
plugin needs no cross-run mechanism of its own: write to `ctx` at
`files:prepare`, read it at `crate:build`, exactly as within a single run.

**So Build is gated on Process.** The Build page and its button stay disabled
until a Process run has finished, because there would otherwise be nothing to
build from. The exception is a profile that enables no processing options at
all: nothing to prepare, so Build opens immediately and works from the file
metadata the folder scan produced when the folder was picked. Changing a
processing option — or any option nested under one — discards the prepared run
and closes Build again, since what it prepared no longer describes what was
asked for. Changing a *build* option does not: it changes what the build does,
not what was prepared. A new folder or a different profile discards it too.

**Clearing stale output follows the writing, not the build.** `main.js` clears
every declared `outputPaths` entry (when "Delete plugin output before
rebuilding" is on) for any run that includes `files:write` or `crate:write`,
since either reaches the folder. Backing up `ro-crate-metadata.json`/`.xlsx`
stays tied to `crate:write`, which is the only run that rewrites them.

**Progress is planned before the first handler runs.** The host sums `weight`
across every tap whose `activeWhen(ctx)` passes, assigns each an ordered
`[start%, end%]` slice of the main bar, and swaps the live slice before each
handler — see §4.6 and SPEC-UI.md.



### 4.5 The plugin registry

```js
export const PLUGINS = [           // one registry — builders and annotators alike
  genericInputPlugin, docxInputPlugin, xlsxCrateInputPlugin, austlangPlugin, caDataPrepPlugin,
  mergePlugin, validateCratePlugin, jsonOutputPlugin, xlsxOutputPlugin, htmlOutputPlugin,
];

```

**One registry.** There is no second array and no separate kind of plugin for
reading a folder. A plugin that assembles the crate is one whose `crate:build`
tap sits in the builder band (§4.4); `generic-input` is the ungated fallback at
priority 10, `docx-input` a gated builder at 5. Adding a way to read a folder —
an archive import, an OAI-PMH harvest — is adding a plugin with an option, and
touches nothing in the host.

**This `src/plugins/index.js` is generated, not hand-written** (see §4.7a below) — the plugin *implementations* are in a sibling repo, `collection2crate-plugins`.

**Ordering.** Array order in `PLUGINS` *is* hook-execution order for plugins sharing a stage at equal priority. Every registration defaults to priority 10 and `Array#sort` is stable, so registering in this order reproduces the original inline sequence with no explicit priority numbers: `xlsx-crate-input` first so the entities it contributes exist for the two that read the graph after it, then AUSTLANG before merge (all three tap `files:prepare`), and JSON before XLSX before HTML (all tap `crate:write`). Every plugin in `collection2crate-plugins` now declares its priority explicitly anyway, so the array order is documentation rather than mechanism.

`xlsx-crate-input` is an example of a plugin that taps **multiple** hooks for a single job (`folder:picked`, `crate:prepare`, and `crate:build`) because its work spans from before a folder is even confirmed to hold anything build-worthy, through file processing, to after. What it does at each stage, and how it merges, is described in §7.


### 4.6 Schema composition

Each plugin owns its slice of the UI:

```js
const PLUGIN_OPTIONS_SCHEMA   = [...composeOptionSchema(),   ...CORE_OPTION_SCHEMA];
const PLUGIN_SETTINGS_SCHEMA = [...CORE_SETTINGS_SCHEMA,    ...composeSettingsSchema()];
```

A plugin's `pluginOptionsSchema` puts it in the Build panel (per-build choices); a `pluginSettingsSchema` puts it in the Settings modal (app preferences). A plugin with neither is always-on. JSON output and validation are both like this.

A third, optional field composes the same way: `outputPaths`, an array of `{ path, kind }` (`kind` is `"file"` or `"dir"`) declaring every file/directory a plugin may write directly into the picked folder — `ro-crate-json-output` declares `ro-crate-metadata.json`, `ro-crate-html-output` declares both `ro-crate-preview.html` and `ro-crate-preview_html`, `chat-export` and `ca-data-prep` both declare the `c2c-output` directory they share. `main.js` uses the result for two things: excluding those top-level names from `walkDirectory`'s scan (the same job `GENERATED_FILENAMES`/`CONTROL_FILENAMES` do for the core outputs — see §7.1), and the Settings modal's "Delete plugin output before rebuilding" toggle, which deletes every declared path before a build runs. See collection2crate-plugins' README ("Declaring output paths") for the authoring convention. A plugin that only reads the folder, or only mutates `ctx.crate` in memory, declares no `outputPaths` at all — same absence-as-signal convention as `optionSchema`/`settingsSchema`.

### 4.7 Writing a new plugin

Plugin implementations live in the sibling `collection2crate-plugins` repo (§4.7a)

Plugins can subscribe to a hook with a priority 0-100 (lower meaning they run earlier). 

Plugins may tap into any hook; there is no distinction between input/build/output plugins, and no registry for any of them but `PLUGINS`. The one structural rule is the builder band (§4.4): a `crate:build` tap at priority 10 or lower is claiming to assemble `ctx.crate`, and only one such tap runs per build, so anything that merely annotates the crate belongs at 20 or above.


```js
// collection2crate-plugins/plugins/my-thing/index.js
let doIt; // core collection2crate function this plugin needs, if any

export function createPlugin(deps) {
  ({ doIt } = deps);
  return plugin;
}

const plugin = {
  name: "my-thing",
  optionSchema: { key: "enableMyThing", label: "Do the thing", default: false },
  hooks: {
    "crate:build": {
      priority: 20, // 0–100, lower runs earlier; 20 is the first slot above the builder band (§4.4)
      handler: async (ctx) => {
        if (!ctx.options.enableMyThing) return;      // check your own option
        const { doItHeavily } = await import("./heavy.js"); // dynamic-import heavy deps
        doItHeavily(ctx.crate, doIt);
        ctx.log("Did the thing.", "ok");
      },
    },
  },
};
```

Then register it in collection2crate-plugins' own `index.js` (`REGISTRY`, keyed by the plugin's `name`), and add that same key to collection2crate's `PLUGINS` env var (or leave it unset/`all`, the default) so `scripts/select-plugins.mjs` includes it the next time `src/plugins/index.js` is regenerated — see §4.7a. Where it runs relative to others sharing its hook comes from `REGISTRY`'s own order in collection2crate-plugins, not from anything on the collection2crate side. For the option to be reachable, a profile must name `enableMyThing` in its `buildOptions.enabledOptionKeys`.

Four conventions worth following: **guard on your own option first** (handlers run on every build); **dynamic-import anything heavy** so it stays out of the main bundle; **log through `ctx.log`** rather than `console`; and **write a user-facing doc** if the plugin asks anything of the *person preparing content or running a build* — an authoring convention (headings, filename patterns, magic strings like `SOUND FILE:`), an option whose effect isn't self-explanatory from its label, or an expected file/config shape it reads. That doc is for the plugin's users, not its maintainers — this section and the rest of this file are the latter. It belongs under `docs/` (see §11), linked from the README rather than folded into it, following the pattern `docs/docx-authoring.md` set for `docx-input` (§7.1). A plugin with no user-visible behaviour beyond a self-explanatory option toggle doesn't need one.

Registering it in collection2crate-plugins' `REGISTRY` (above) is the path for a plugin that's joining that repo. It doesn't have to — §4.7a covers pulling a plugin in from somewhere else entirely: another repo built the same way (`PLUGINS=name=some-package`), or a one-off local file you're testing without touching any repo's registry at all (`PLUGINS=name=./path.js`).

### 4.7a The collection2crate-plugins repo

Every plugin under §7's catalogue — the builders included — lives in `collection2crate-plugins`, a sibling checkout (`../collection2crate-plugins` next to this repo).The plugin *engine* is in this repo's `src` dir: `src/plugins/hooks.js` (the hook bus and `HOOKS` constants) and `src/plugins/pipeline.js` (orchestration), plus the isomorphic core every plugin reaches into — `src/crate.js`, `src/fs_helpers.js`, `src/github.js`, `src/masp.js`.

**collection2crate-plugins has no runtime dependency on this repo.** Two conventions make that possible, both covered in collection2crate-plugins' own README:

- Hook names are literal strings (`"crate:build"`, `"crate:write"`, …) rather than an imported `HOOKS.CRATE_BUILD` — a stable contract owned by `src/plugins/hooks.js`, just not one collection2crate-plugins imports to use.
- Every plugin module exports `createPlugin(deps)` instead of a static `plugin` object. `deps` is collection2crate's core functions, built once by `src/plugins/deps.js`'s `buildDeps()` (the same full object handed to every plugin — an unused key is simply never read) and passed to each selected plugin's factory.

Collection2crate depends on collection2crate-plugins as `"collection2crate-plugins": "file:../collection2crate-plugins"` — a local, symlinked dependency; not yet published to npm.

**It is a fork of `c2c-plugins`, taken at the point input modes were dissolved (§4.4).** `c2c-plugins` stays on the old contract — a second `INPUT_REGISTRY` of mutually-exclusive input-mode plugins, dispatched on `ctx.options.inputMode` — because `chaos2crate`, this app's predecessor, still consumes it that way and would fail at import against the new shape (the export is simply gone). The two repos share history up to the fork and nothing after it; a fix that matters to both has to be applied to both.

**Build-time plugin selection.** Not every deployment needs every plugin (`ca-data-prep` is specific to one dataset, for instance), so `src/plugins/index.js` is generated rather than hand-written: `node scripts/select-plugins.mjs` reads a `PLUGINS` env var (comma-separated plugin names; unset or `all` means everything) and writes `src/plugins/index.js` with static imports for only the selected plugins, pulled from collection2crate-plugins' `REGISTRY` — one registry, builders included, so a deployment selects a builder the same way it selects anything else. A selection with no builder in it is a deployment that cannot build a crate; the pipeline says so on the first run rather than at generation time, since a build-time check can't know which builders a custom entry provides. A runtime filter over an already-imported registry wouldn't achieve real bundle-size exclusion — Rollup can't tree-shake based on which object keys get read at runtime — so exclusion has to happen by simply never writing the `import` statement for a plugin that wasn't selected.

```bash
npm run build       # every plugin (default)
PLUGINS=merge,validate-crate,ro-crate-json-output npm run build   # only these
```

The generator runs automatically before `dev`/`build`/`test` (package.json's `predev`/`prebuild`/`pretest` scripts call `select-plugins`), so `src/plugins/index.js` is always freshly regenerated before use — it's still committed so the file isn't missing for anyone who reads the repo without running a script first, but treat its content as disposable; don't hand-edit it.

**A `PLUGINS` entry doesn't have to come from collection2crate-plugins.** Each entry is either a bare name (collection2crate-plugins' `REGISTRY`, validated, ordered by `REGISTRY`'s own hook-execution order — the default and the common case), or `name=source`:

- `name=some-package` — `some-package`'s own `plugins/<name>/index.js`, the same layout convention collection2crate-plugins itself follows. For a plugin repo meant to stick around, wire it into `package.json` as its own dependency first — `"other-plugins": "file:../other-plugins"` for another local checkout (same pattern as collection2crate-plugins itself), or `"other-plugins": "github:org/other-plugins"` for one pulled from elsewhere online — then `npm install`, then reference it this way. There's no runtime remote-loading mechanism here; "online repo" still means "installed as a real dependency before the build runs," same as collection2crate-plugins.
- `name=./relative/path.js` or `name=/absolute/path.js` — an exact filesystem path (resolved against this repo's own root for a relative path), for a one-off local plugin you're testing without editing `package.json` at all.

Either form just needs to export `createPlugin(deps)`, the same contract as every plugin in collection2crate-plugins — `deps` is the identical object `buildDeps()` produces, so an external or local plugin can read whatever core functions it needs the same way. `select-plugins.mjs` dynamically imports every custom entry at generation time (before writing anything) specifically to catch a bad path or a missing `createPlugin` export immediately, with a clear message, rather than failing obscurely inside Vite later. Ordering: collection2crate-plugins' `REGISTRY` names keep their documented order; custom entries are appended after, in the order given in `PLUGINS` — there's no ordering information available for a plugin outside collection2crate-plugins' own registry, so place custom entries accordingly if they share a hook stage with something order-sensitive.

```bash
# a plugin from another repo built like collection2crate-plugins
PLUGINS=merge,special=other-plugins npm run build

# a plugin file you're testing locally, not wired into package.json at all
PLUGINS=merge,scratch=../scratch-plugin/index.js npm run build
```

### 4.7b Quick start: writing your own plugin

The full description is §4.7/§4.7a above; this is the short version.

1. **Create a file** exporting `createPlugin(deps)`, which returns a plugin object:
  ```js
  // e.g. ../my-plugin/index.js
  export function createPlugin(deps) {
      return {
      name: "my-plugin",
      hooks: {
        "crate:build": {
          priority: 20, // 0–100, lower runs earlier; 20 is the first slot above the core's own assembly
          handler: (ctx) => {
            ctx.log("my-plugin ran!", "ok");
            // do something with ctx.crate
          },
        },
      },
    };
  }
  ```
2. **Pick a hook** to tap.
3. **Use `deps` for anything you need from collection2crate's core** (`crate.js`/`fs_helpers.js`/`github.js` functions) instead of importing them — e.g. `({ writeFileAtPath } = deps)` at the top of the file. This is what keeps a plugin decoupled and portable (§4.7a).
4. **Point `PLUGINS` at it** — no `package.json` changes needed for a quick local file:
   ```bash
   PLUGINS=merge,austlang,my-thing=../my-plugin/index.js npm run dev
   ```
5. **If it's meant to stick around**, turn it into its own small repo built like collection2crate-plugins (`plugins/<name>/index.js`), wire it into `package.json` (`"my-plugins": "file:../my-plugins"` or a `github:` URL), `npm install`, then reference it as `name=my-plugins` instead of a raw path.
6. **Add `pluginOptionsSchema`** if it should be toggleable in the Build panel, and make sure the active profile's `buildOptions.enabledOptionKeys` names your option key — otherwise it's off by default (§5.4).


---

## 5. MASP profiles

### 5.1 A profile is always in effect

There is no un-profiled path and no ad-hoc fallback config. But a profile is never *demanded* of the user either: when none has been chosen, the **bundled schema.org default** applies.

The default is `profiles/schema-org` from [`ro-crate-masp`](https://github.com/Language-Research-Technology/ro-crate-masp) — its own description reads "A minimal RO-Crate profile combined with the Schema.org MASP schema crate." It gives you a valid, plain RO-Crate: schema.org vocabulary, no domain assumptions, and a preview you can open.

Concretely, building under the default produces:

| | |
|---|---|
| Describe asks for | `name`, `description`, `datePublished`, `license`, `conformsTo` — five fields |
| Root dataset type | `Dataset` |
| Written onto each `File` | nothing custom — the profile declares no `fileProperties` |
| Output | `ro-crate-metadata.json` and `ro-crate-preview.html` |
| Preview | the library's built-in template, laid out by the profile's own six property groups — self-contained, no template fetch |
| Optional processing offered | none — no merge, no language lookups, no template sources (§5.4) |

This is the "I just want an RO-Crate" path: something valid to publish and something you can look at, with nothing invented about your data and no network call in the build. Choosing a domain profile from the profile repository is how you opt *into* structure, vocabulary, and plugins — never how you escape a broken default.

**The default's build options are ours, not upstream's.** `tools.collection2crate.buildOptions` is a collection2crate extension; the vendored profile has no such block, and upstream has no reason to carry a key only this app reads. So `src/default_profile.js` overlays one — enabling `makeHtml` and nothing else — onto an otherwise unmodified copy of the dependency's file. Pushing it upstream would put our concern in their repo and tie us to their release cycle; forking the profile into `c2c-masp-profiles` would cost the offline guarantee that bundling exists for.

**Why bundled rather than fetched.** A fallback that can fail to load is not a fallback. The default's two JSON files are imported from the `ro-crate-masp` dependency at build time, so it works offline, survives a GitHub rate-limit, and can't 404. The profile crate is ~1.6 MB (~261 kB gzipped), so it is dynamically imported into its own chunk — the same treatment the AUSTLANG data pack gets, and it is only downloaded when a build actually runs without a chosen profile.

### 5.2 What a profile ships

Profiles come from two places: the **profile repository** (`Language-Research-Technology/c2c-masp-profiles`), fetched when the user picks one, and the **bundled default** (§5.1), compiled in from the `ro-crate-masp` dependency. Both have the same shape — a folder containing:

```
<profile-name>/profile-crate/
    ro-crate-metadata.json    the profile as an RO-Crate: classes, properties, cardinalities
    <mode file>               editor hints, plus collection2crate's own configuration
```

The mode file's name differs by source: `c2c-masp-profiles` calls it `tool-config.json`; the bundled default keeps the `ro-crate-masp` dependency's own `crate-o-mode.json` unmodified (see §5.1 on why it isn't forked just to rename it). Both names are tried, repository-style first. `masp.js`'s `MASP_PROFILES_REPO_NAME` hardcodes the `c2c-masp-profiles` name.

**A profile folder sits at the root of the profile repository**, not under a `profiles/` directory — `ldac/profile-crate/…`, not `profiles/ldac/profile-crate/…`. The repository root also holds a README, a `package.json` and a validator script, so the profile list is not "every top-level directory": `listProfiles()` reads the repository tree in one request and takes the folders that actually contain `profile-crate/ro-crate-metadata.json`. One request rather than one per folder also keeps the unauthenticated rate limit (§6.2) out of the way. The files themselves are then fetched raw, which costs no quota at all.

The first file is standard MASP, shared with `crate-o`. The second is where profile-specific behaviour lives:

| mode file key | Controls |
|---|---|
| `rootDataset.type` / `.conformsTo` | the root entity's `@type` and profile conformance |
| `metadataLicence` | the metadata descriptor's own licence |
| `fileProperties` | which custom fields get blank-initialised on every `File`, with their `rdf:Property` definitions. Either an object keyed by property name, or the array of `{ key, definition }` pairs the repository's profiles use; `normaliseFileProperties()` reads both into the keyed form so nothing downstream sees two shapes |
| `propertyGroups` | how properties are grouped in the HTML preview |
| `longTextInputs` | which Describe fields render as textareas |
| `tools.collection2crate.buildOptions` | which plugins and options the user is offered |
| editor hints (`rootDataset.type`, …) | required by the validator — see §5.6 |

### 5.3 The Describe form

The profile's root class definition is introspected into a field schema and the form is rendered from it. Nothing about the form is written into the app.

| Declared type | Rendered as |
|---|---|
| `Text` | text input, or textarea if named in `longTextInputs` |
| `Date` | date input, defaulted to today |
| `URL` | url input |
| property with an enumerated value list | select |
| another class, e.g. `Person` | text input that synthesises a linked `{@id, @type, name}` entity on submit |
| `Value` (PropertyValue-fixed) | nothing — structural, not user-editable |

Multi-valued properties take comma-separated input and produce arrays of references. Textarea selection comes from the profile rather than a guess at the property's name — MASP's editor-definition shape has no multiline hint, and the tool has no business inferring one.

**Structural properties are never rendered.** `pcdm:hasMember`, `pcdm:memberOf`, `hasPart` and `isPartOf` are dropped from the field schema even when a profile declares them. A profile is right to require that a collection have members; that requirement is satisfied by the folder scan or by supplied metadata, never by typing. Rendering them does active harm: given a class range they become entity-ref fields, so typing "magpie" mints an empty `RepositoryObject` that then appears in the preview beside the real one.

**Prefilling from the folder.** A folder may already hold the crate's metadata in more than one form: the spreadsheet the collection is authored in, and the `ro-crate-metadata.json` a previous build (or a `rocxl` sync) wrote. `pickNewestCrateSource()` in collection2crate-plugins' `src/xlsx-crate-input/xlsx_crate.js` picks between them by `lastModified` — whichever the author touched last is the one they've been working in, so that's what the form reflects. Candidates, in tie-break order:

1. `additional-ro-crate-metadata.xlsx`
2. `ro-crate-metadata.xlsx`
3. `ro-crate-metadata.json`

Ties go to the earlier entry, so a build that writes its outputs in the same second doesn't flip the answer away from the hand-authored spreadsheet. The chosen file is named above the form, because with several possible sources "where did these values come from?" deserves an answer that doesn't require opening any of them.

This is a **read of the root entity only** — it fills form fields, nothing more. Folding a spreadsheet's other entities into the build is the separate, opt-in job of the `xlsx-crate-input` plugin's hooks, and stays tied to the explicit `additional-ro-crate-metadata.xlsx`: merging a previous build's whole graph back in would resurrect entities for files since deleted from the folder.

### 5.4 Gating plugins and options

```jsonc
"tools": {
  "collection2crate": {
    "url": "",
    "version": "0.0.1",
    "buildOptions": {
      "enabledOptionKeys": ["makeHtml", "templateRepoFolder", "merge", "mergeFile", "mergeMappingBuilder"],
      "plugins": ["makeHtml"],
      "templateRepoFolder": "ldac"
    }
  }
}
```

- `enabledOptionKeys` is an **allow-list**. Build options are hidden by default; a key — top-level or nested — appears only if the profile names it. Each profile opts in to the handful its workflow needs.
- `plugins` turns on checkbox-style options: it's an array of option keys, not individual `key: true` entries — a profile lists `"merge"` rather than declaring `"merge": true`. An option key not in `plugins` starts unchecked even if `enabledOptionKeys` shows it.
- Any other key pre-fills that (non-checkbox) option's value and fires its change handler so dependent fields settle — `templateRepoFolder` above, or any `select`/text option.
- Settings are **not** gated — they're machine and user preferences, orthogonal to the profile. A profile may still pre-fill one for its own run (`topLevelFolderType`, say): the person's own persisted setting is the fallback, not the override — which is what §1 means by the setting being independent of the profile: a profile does not *reset* it, it may only speak for its own build.
- **How the folder is read is not a setting.** It used to be — an `inputMode` select in the Settings modal that a profile could pre-fill, because the structured-documents profile is unusable in generic mode. A builder is an ordinary plugin now (§4.4), so such a profile names that plugin's own option in `enabledOptionKeys`/`plugins` like any other: `"enabledOptionKeys": ["docxInput"], "plugins": ["docxInput"]`. A profile still carrying `inputMode` gets the generic folder scan; when it named anything other than `"generic"`, `configNote` in `masp.js` says so in the build log rather than letting the build silently differ from what the profile asked for. A profile naming `"generic"` loses nothing and is not warned about.
- The resolution itself is `resolveBuildOptions()` in `src/masp.js`, deliberately not in `main.js`: it is the rule that decides what a build does, so it is somewhere a test can reach (§9.1).
- `buildOptions` lives under `tools.collection2crate` rather than at the mode file's top level, since the same mode file is shared with `crate-o` (§5.2) — namespacing under `tools` lets each consumer carry its own config without colliding. `url` and `version` are unused by collection2crate today; they exist for the tool itself to be identified/versioned per profile.

**Hidden means off.** An option the profile didn't enable is not merely hidden — it is forced to its off value, so the plugin behind it does not run. Visibility and execution are the same decision, which makes `enabledOptionKeys` the single source of truth for what a build does: what a profile declares is exactly what happens. Without it the two drift, because plugins read `ctx.options` whether or not a field is on screen — any option whose schema default is `true` would keep running invisibly, and a profile could neither guarantee a capability runs nor guarantee it doesn't.

That guarantee is what lets the bundled default be described precisely: it names `makeHtml`, so it emits JSON and a preview and nothing else — no merge, no language lookups, no template fetch.

**A profile with no `tools.collection2crate.buildOptions` block at all offers no optional processing** — the absent block reads as an empty allow-list, not as "no opinion". That keeps an upstream profile authored for `crate-o` (which knows nothing about collection2crate's options) conservative here rather than switching everything on. The bundled default gets its block from an overlay in `src/default_profile.js` (§5.1), precisely because the vendored file has none.

Always-on plugins are unaffected: JSON output and validation have no option key, so nothing gates them.

### 5.5 Validation

After every build `validate-crate` runs the profile's validator and reports into the build log — under the bundled default just as under a chosen profile, so even the minimal path tells you whether the crate conforms. Advisory: a failing crate is still written with its issues listed, because a crate you can inspect beats a refused build.

### 5.6 `ro-crate-masp` integration notes

Three upstream quirks shape `src/masp.js`:

- The package declares a `main` entry that doesn't exist in the repo, so the validator is imported by internal path. It lazy-loads `fs` only when handed a file path; the wrapper always passes parsed objects, so it runs unmodified in the browser.
- `setEditorHints()` is **required**, not optional. Without it, `getRootDatasetTypes()` returns the metadata *descriptor's* type rather than the subject dataset's.
- The validator has no passing path for `URL`-typed properties: its reference branch demands a matching entity node (which a bare URL never has), and its scalar branch doesn't list `URL`. Errors naming a URL-typed property are annotated in the log as a known limitation rather than presented as data problems.

Top-level validator errors are cardinality-phrased ("Expected at least 1 instances of X, found 0") and don't name the field, so the wrapper also pulls the per-property detail out of `results.rules`, which does.

---

## 6. The core

### 6.1 Crate assembly — `src/crate.js`

Isomorphic: imports only browser-safe entry points, returns strings and bytes rather than writing files. The same module runs under Node for tests and in the browser for real work.

**File metadata.** `buildFileMetadata(files)` derives each file's `@id` (its relative path), folder chain, top-level group, and possible duplicates. Duplicate detection normalises filenames — lowercase, strip `copy`/`duplicate` and `(2)`-style suffixes, collapse non-alphanumerics — and cross-links collisions.

**Graph assembly.** `buildCrate(filesWithMeta, config, log, opts)` initialises an `ROCrate` with the `ldac`, `pcdm`, `custom`, and `AUSTLANG` contexts, applies the profile-derived root dataset, emits folder and file entities, and rewrites structural hash-ids (`#Dyirbal`) to `arcp://` form on export.

Top-level folders are emitted one of two ways:

| Mode | Structure |
|---|---|
| `object` | one `RepositoryObject` per top-level folder; every file beneath it in `hasPart` |
| `collection` | one `RepositoryCollection` per folder, containing a child `RepositoryObject` per subfolder, plus a synthesised `<Name>_Files` object for files sitting directly in the top level |

**Profile-declared file properties.** `config.fileProperties` pairs a compact key with the `rdf:Property` entity documenting it. Each key is blank-initialised on every `File`; the definitions are added to the graph. `custom:possibleDuplicate` is the exception — written only when duplicates were actually found, and only if the profile asked for it. Nothing is added unconditionally.

### 6.1a HTML previews

A preview is rendered in `crate.js` and decided in `ro-crate-html-output`: the plugin resolves the layout, fetches whatever template files are involved, and picks a route; the core renders what it is handed and fetches nothing. That split is the reason the no-fallback rule below can hold — a renderer that reaches for a default layout mid-render is a renderer that has to be online.

**The layout always comes from the active profile.** The profile's mode file declares `propertyGroups` (§5.2); the plugin resolves those group definitions against the built crate's context and passes the result down. Nothing invents a layout, and a build with no profile has no preview.

**Three routes, one function each:**

| Route | Call | Writes |
|---|---|---|
| Plain — the library's own preview | `crateToPreviewHtml(crate, { layouts: { default: groups } })` | `ro-crate-preview.html` |
| Styled single page — a `rocss-templates` bundle, or uploaded template files | `crateToPreviewHtml(crate, { template, config, css })` | `ro-crate-preview.html` |
| Multipage — a bundle whose `config.multipage !== false` | `crateToMultiPageHtml(crate, { config, css, pageTemplates })` → `{ rootHtml, pages }` | `ro-crate-preview.html` plus one page per entity under `ro-crate-preview_html/` |

The layout travels differently on the two paths, because each mirrors the shape its source already has: `layouts.default` for the plain preview, `config.propertyGroups` for the styled ones, since that is how a template's own `config.json` declares it. `pageTemplates` maps the template paths named in `config.root.template` / `config.types.<Type>.template` to their already-fetched text — template lookup is the plugin's job, so the same core function works whether a bundle came from GitHub or an upload.

**No layout fallback.** All three routes *throw* when their groups are missing, naming the key that was empty. The library would otherwise fetch a default layout from GitHub at render time — fragile, CORS-blocked, and a silent generic layout hides a profile misconfiguration rather than reporting it.

Three things the renderer does to every crate before handing it to the library, each fixing a failure that is otherwise hard to attribute:

- **`resolveContext()` first.** Term resolution runs throughout `roCrateToJSON`; without this, property lookups miss depending on internal resolution timing, which surfaces as some entities rendering their properties and others not, apparently at random.
- **Compact predicates are mirrored to full URIs.** A merge can write `dc:format` while the tabular renderer resolves by full URI; both keys are present by the time it looks.
- **Percent-encoded slashes in `href`s are restored.** Otherwise a preview's links to files in sub-folders don't resolve on disk.

The single-page route renders one page whatever its config says (`multipage: false` is forced into `roCrateToJSON`), so pointing it at a multipage bundle degrades to a root page instead of failing inside the library on a missing `config.root.template`.

**The preview opens from blob: URLs, so every reference in it is rewritten
first** (`preview_assets.js`). Stylesheets, images and links to data files are
read through the directory handle and inlined as their own blobs, `url()`
values inside the CSS included. Links to *other preview pages* can't be: a
blob's content is fixed when it is created, and preview pages link to each
other in cycles, so no order exists in which every URL is known before the
content naming it. Those links keep their folder path in a marker attribute
and are resolved when clicked — the preview window calls back into the app,
which holds the directory handle, builds that page the same way and navigates
to it. Lazy resolution is also what keeps a thousand-page crate's preview as
quick to open as a one-page crate's. Every blob handed out is tracked and
revoked together when the next preview opens.

Saving from the Edit view re-renders through the same functions, reusing `lastHtmlTemplate` from the session's last build so a styled preview isn't silently downgraded to plain (§6.3).

### 6.1b Visualisation panels

The Visualise page is a panel host and nothing else: an output-folder picker
and the composed panel list on the left, the chosen panel rendered on the
right. Every panel comes from a plugin — `composeVisualisationPanels()` gathers
each plugin's `visualisation` member the way `composeOptionSchema()` gathers its
options, so a deployment that leaves a plugin out of `PLUGINS` loses its panel
with its taps. The page itself analyses nothing.

A panel is `{ label, hint, render(container, ctx) }` and taps no hook: it never
runs during a build, only when someone opens it. `render` is handed an empty
container it owns and `ctx = { documents, tables, log }`. It may be called
again — on a new folder, or a new panel — so it must not assume it is the
first call. A panel that throws is caught and reported in its own container
rather than taking the page down: it is somebody else's plugin.

**The picker offers directories, not files** (`visualise_data.js`). The
candidates are the plugin-declared `outputPaths` of `kind: "dir"` that exist
and hold something readable — `_outputs/csv/`, `_outputs/chat/`,
`_outputs/logs/`. A build writes hundreds of files whose names change each
time; the handful of folders they land in does not. A declared output holding
only HTML or images never appears, so no panel has to explain an empty folder
that could never have held anything.

Choosing one loads it **once, into two views of the same parse**: `documents`,
one per line, row or utterance (`{ id, source, speaker, text }`), and `tables`,
header and rows, for panels that read columns. A `.csv`/`.tsv` produces both; a
`.cha` contributes its utterance tiers only, since its `@` and `%` lines are
metadata rather than anybody's words; anything else contributes one document
per non-empty line. Switching panels does not reload — which is what makes
running one corpus through two panels a comparison rather than a coincidence.

### 6.2 Shared helpers

`src/fs_helpers.js` — File System Access wrappers: permission checks, existence checks, text and JSON reads, `writeFile`, and `writeFileAtPath` which creates intermediate directories.

`src/github.js` — fetch primitives shared by `main.js` (profile list, template dropdown) and the HTML plugin (template bundles), kept neutral to avoid a circular import. Raw fetches are cache-busted with a timestamp, because `raw.githubusercontent.com` caches per-URL for minutes and can serve a stale profile after a push. Folder listings go through the Contents API, which is rate-limited to 60 unauthenticated requests/hour, so successful listings are cached per `(owner, repo, ref, path)` for the page's lifetime — failures aren't cached, so a rate-limit blip is retried rather than remembered.

`src/ui_helpers.js` — `openModal`, handed to plugins through `deps` so a plugin can ask a question without importing anything from the app. There is **one** shape, used by the app's own dialogs and by plugins alike:

```js
openModal({
  title,                       // header text
  body,                        // optional: a Node, or an HTML string
  onMount(body, { close }),    // optional: build and wire the content
  actions: [                   // footer buttons, left to right
    { label: "Cancel", value: null },
    { label: "Save", primary: true, value: () => working },
  ],
  modalClassName,              // optional: extra class on the panel
});                            // → Promise of the chosen action's value
```

An action's `value` is **called if it is a function**, at click time, so an action can hand back state the content has edited since the modal opened — that is how roctable's Save returns its working config and generic-input's "Add selected" returns the currently ticked paths. Dismissing (✕, backdrop click, Escape) always resolves `null`, which every caller reads as "no choice was made", distinct from an explicit empty result. The footer is omitted when there are no `actions`.

A plugin builds its content in `onMount` and never its own buttons, so every dialog in the app shares one footer, one dismissal rule and one keyboard behaviour. Plugin-built content uses the host's own class vocabulary — `.button`, `.button primary`, `.button subtle`, `.checkbox`, `.field-hint`, `.data-table` — so no plugin ships CSS.

### 6.3 Entity editing

The Edit view loads an existing `ro-crate-metadata.json` into a live `ROCrate`: browse and filter entities by type or text, edit values, add and remove values, add and delete entities, rename `@id`s with reference-following, delete with reference cleanup. Structural entities — root, descriptor, `File`/`RepositoryObject`/`RepositoryCollection` — have locked identifiers, since renaming them breaks the crate's relationship to the folder.

Saving rewrites the JSON and regenerates the xlsx and HTML if those files exist, reusing `lastHtmlTemplate` from the session's last build so a styled preview isn't silently downgraded to plain.

---

## 7. Plugin catalogue

### 7.0 Every option key, and who owns it

A profile's `enabledOptionKeys` (§5.4) names keys from this table. Child keys are **listed separately, not implied by their parent** — a profile enabling `merge` without `mergeFile` gets the toggle and no file picker.

| Key | Plugin | Surface | Notes |
|---|---|---|---|
| `docxInput` | `docx-input` | Build panel | read the folder as structured Word documents — a builder (§4.4), so switching it on stands `generic-input` down for the build |
| `xlsxCrate` | `xlsx-crate-input` | Build panel | use metadata from an RO-Crate spreadsheet |
| ↳ `xlsxCrateFile` | `xlsx-crate-input` | Build panel | file picker; overrides the folder's `additional-ro-crate-metadata.xlsx` |
| `enableLanguageLookups` | `austlang` | Build panel | AUSTLANG matching |
| ↳ `includeAlternateNames` | `austlang` | Build panel | widens matching, trades precision for recall |
| `merge` | `merge` | Build panel | merge a spreadsheet's columns by `@id` |
| ↳ `mergeFile` | `merge` | Build panel | file picker |
| ↳ `mergeMappingBuilder` | `merge` | Build panel | column → property mapping dialog |
| ↳ `doPlaceLookups` | `merge` | Build panel | coordinate lookup for merged `Place` entities |
| `makeHtml` | `ro-crate-html-output` | Build panel | write `ro-crate-preview.html` |
| ↳ `collectionLabelsBuilder` | `ro-crate-html-output` | Build panel | menu names/order for `docx-input` builds — applied to the generated HTML only; `docx_crate.js` always uses each folder's own name/order for the crate itself |
| ↳ `templateRepoFolder` | `ro-crate-html-output` | Build panel | folder in `rocss-templates` |
| ↳ `styledPreview` | `ro-crate-html-output` | Build panel | upload template files instead |
| ↳ ↳ `configFile` | `ro-crate-html-output` | Build panel | the uploaded `config.json` and its siblings |
| `enableRoctable` | `roctable` | Build panel | flatten the crate into one CSV per `@type` |
| ↳ `roctableConfigure` | `roctable` | Build panel | opens the table picker outside a build; an `action`, so it stores no value |
| ↳ `roctableConfigUpload` | `roctable` | Build panel | overrides `_config/roctable/config.json` from the folder |
| `transcriptGrammarEdit` | `transcript-grammar` | Build panel | opens the transcript grammar editor — mark up a sample's regions and rows, save the generated patterns to `_config/transcript-grammar/<name>.json`; an `action` |
| ↳ `transcriptGrammarTest` | `transcript-grammar` | Build panel | parses another document with a saved grammar; an `action` |
| `makeXlsx` | `ro-crate-xlsx-output` | Settings modal | write `ro-crate-metadata.xlsx` |

Two kinds of key are deliberately absent from it:

- **`deleteOutputsBeforeBuild`, `overwrite`, `themeMode`, `topLevelFolderType`** — core settings. `deleteOutputsBeforeBuild` deletes every plugin-declared `outputPaths` entry (§4.6) from the folder before a build runs; `overwrite` has no effect while it's on.
- **`ro-crate-json-output` and `validate-crate`** — no schema at all, which is how "always on, ungateable" is expressed.

The table is generated from the registry, so it can be regenerated rather than audited by eye:

```bash
node --input-type=module -e "
import { PLUGINS } from './src/plugins/index.js';
const walk = (n, p, kind, d = 0) => { if (!n) return;
  console.log('  '.repeat(d) + n.key.padEnd(24 - d * 2) + p.padEnd(24) + kind);
  for (const c of n.children || []) walk(c, p, kind, d + 1); };
for (const p of PLUGINS) { walk(p.optionSchema, p.name, 'Build panel'); walk(p.settingsSchema, p.name, 'Settings modal'); }
"
```


---

## 8. Technical speecification

Build as a Chromium web app (not React/Vue).


---

## 9. Testing

### 9.1 What is testable, and where the line falls

The isomorphic core — `crate.js`, `masp.js`, `default_profile.js`, and the hook-bus engine (`hooks.js`, `pipeline.js`) — runs unmodified under Node. That is the whole reason it's isomorphic, and it's what the suite exercises: real `ro-crate`, real `ro-crate-excel`, real `ro-crate-static-site`, real `ro-crate-masp`. **Nothing is mocked.** A test that passes against a stub of `ro-crate` would prove nothing about a tool whose entire job is driving `ro-crate` correctly.

**Plugin implementations are out of scope for this repo's tests, deliberately.** Every plugin lives in the sibling `collection2crate-plugins` repo (§4.7a); testing what a plugin actually does is that repo's job, not this one's. `test-hooks.mjs` still exercises the bus/pipeline machinery every plugin runs through, but only against small synthetic plugin objects defined inline in the test — never against a real plugin imported from `collection2crate-plugins`.

Below the line sits everything requiring a browser: `main.js`, the File System Access wrappers, and the DOM. `showDirectoryPicker` needs a native dialog, so the wizard's click-through cannot be automated here. That's a real limit, not an oversight — the mitigation is keeping logic *out* of `main.js` and in modules that can be reached from Node, which is why plugins own their behaviour and `main.js` mostly assembles `ctx`.

### 9.2 Requirements

**A test must be able to fail.** This is the one non-negotiable. A script that catches an exception, logs it, and exits 0 is not a test — it is a demo that cannot report bad news. Every check goes through `node:assert/strict`; a `try`/`catch` around an operation under test is only acceptable if the catch re-throws or asserts.

**Every assertion carries a message stating the expected behaviour.** Not a restatement of the expression — the *rule* being enforced, in prose a reader can check against the spec. The message is the test's real documentation; the expression is just how it's checked.

**Tests read as scenarios.** Group assertions under a comment naming the situation, in the order the pipeline would encounter it. A reader should be able to follow what the tool is supposed to do without reconstructing it from expressions.

**Each seam gets a test that could plausibly break.** The architecture's seams are the natural units: core graph assembly, the hook bus's own mechanics, and the profile contract. Prefer one test per seam over one test per file.

**Success output says what was verified.** A bare "passed" tells you a file ran. `test-default-profile: all tests passed (schema.org (default), 5 Describe fields, 6 property groups)` tells you *what* held.

**Non-goal: a test framework.** Plain scripts plus `node:assert/strict` need no runner, no config, and no dependency, and they double as executable examples of the API. Adopting `node:test` would buy parallelism and reporting the suite is far too small to need. Revisit if the suite outgrows a handful of files.

### 9.3 The style, concretely

```js
/* ---------- collection mode nests child folders under the collection ---------- */

assert.deepEqual(
  subObj["pcdm:memberOf"],
  { "@id": top["@id"] },
  "Nested folder object should be linked back to top-level collection via pcdm:memberOf"
);
```

Versus the same check written unreadably — correct, and silent about intent:

```js
assert.deepEqual(subObj["pcdm:memberOf"], { "@id": top["@id"] });
```

When it fails, the first names the broken rule; the second makes you open the source and infer it.

Because a profile now supplies what `defaults.js` used to, each script defines a minimal inline `TEST_CONFIG` — root dataset, plus `fileProperties` and an explicit layout where relevant — standing in for a profile.

### 9.4 Coverage

Five suites, run by `npm test`. Every one exits non-zero when the behaviour it covers breaks.

| Seam | Test | State |
|---|---|---|
| Hook bus — registration order, priority, stable sort | `test-hooks.mjs` | ✅ |
| Hook bus — handlers run sequentially and awaited, never in parallel | `test-hooks.mjs` | ✅ |
| Hook bus — the same `ctx` object reaches every handler unchanged | `test-hooks.mjs` | ✅ |
| `registerAllPlugins` — both hook shapes (plain function, `{priority, handler}`), against synthetic plugin objects only | `test-hooks.mjs` | ✅ |
| `announceAndEmit` — logs registered plugins, and logs even when none tap a hook | `test-hooks.mjs` | ✅ |
| `HOOKS` constants match collection2crate-plugins' real, documented contract | `test-hooks.mjs` | ✅ |
| Progress — weight summed only over taps whose `activeWhen` passes; ordered slices; the sub-bar appears only on a second `report()` before `done()` | `test-hooks.mjs` | ✅ |
| Pipeline — stage order (including `files:write` directly after `files:prepare` and before any crate exists), the builder ahead of every annotating `crate:build` tap, builder resolution (lowest active priority wins, the losers' taps skipped on every stage), a build with no builder and a builder that builds nothing both failing loudly | `test-hooks.mjs` | ✅ |
| File metadata — id, folder chain, duplicate cross-linking | `test-crate.mjs` | ✅ |
| Graph assembly — object mode (one `RepositoryObject` per top-level folder) | `test-crate.mjs` | ✅ |
| Graph assembly — collection mode (nested folder links back via `pcdm:memberOf`) | `test-crate.mjs` | ✅ |
| Graph assembly — flat folders (no subfolders), and `structureFromMetadata` (no invented folder entities) | `test-top-level-folders.mjs` | ✅ |
| Profile-declared file properties — blank-initialised, duplicate flag only when found and asked for | `test-crate.mjs` | ✅ |
| `collectTypeCounts` | `test-crate.mjs` | ✅ |
| All three real outputs (JSON, xlsx, HTML) generate from a built crate; both preview shapes (plain `layouts.default` and a styled `template` + `config.propertyGroups`) render, a multipage-shaped config still renders as one page, and each throws rather than fetching a default layout when its groups are missing | `test-crate.mjs` | ✅ |
| Visualise data — delimited parsing (quotes, embedded newlines, unnamed columns), documents from tables/CHAT/text, which extensions are offered, one parse feeding both `documents` and `tables`, directories offered only when present and non-empty | `test-visualise-data.mjs` | ✅ |
| Preview rewriting — relative paths resolved (`.`/`..`, percent-encoding, fragments), assets inlined as blobs, links to other preview pages marked for click-time resolution, the navigation script injected once and only when a page links somewhere | `test-preview-links.mjs` | ✅ |
| Entity editing — set/delete property, add/rename/delete entity with reference cleanup, structural `@id` stability | `test-edit-crate.mjs` | ✅ |
| An edited crate still regenerates JSON and xlsx | `test-edit-crate.mjs` | ✅ |
| Default profile — loads, carries this app's `buildOptions` overlay, offers nothing beyond `makeHtml` | `test-default-profile.mjs` | ✅ |
| Profile load — validator, root dataset type, Describe schema (structural properties excluded) | `test-default-profile.mjs` | ✅ |
| Validation — `validateBuiltCrate` always returns a definite `ok` and an `errors` array | `test-default-profile.mjs` | ✅ |
| Layout resolution — `propertyGroups` come from the mode file, not invented | `test-default-profile.mjs` | ✅ |
| Build options — hidden means off, `plugins` switches on, child keys listed separately, pre-fills applied, no block means nothing offered | `test-default-profile.mjs` | ✅ |
| `fileProperties` — read from either the keyed object or the array of `{key, definition}` pairs | `test-default-profile.mjs` | ✅ |
| Profile repository layout — profile folders at the repository root, both mode-file names tried, profiles found by their profile crate rather than by being a top-level directory | `test-default-profile.mjs` | ✅ |
| The generated registry (`src/plugins/index.js`) and every real `collection2crate-plugins` plugin it wires in — merge, place lookup, xlsx-crate-input, austlang, docx-input, file-format-identify, ca-data-prep, chat-export, roctable, validate-crate, and the three `crate:write` writers | — | out of scope by design (§9.1) |
| Browser layer — `main.js`, FSA, the wizard | — | out of scope (§9.1) |

`scripts/run-tests.mjs` discovers `test-*.mjs` rather than listing them, so a new suite is picked up automatically without also being registered.

### 9.5 Remaining gaps

This repo's test suite deliberately never imports or exercises a real plugin from `collection2crate-plugins`. Every plugin under §7's catalogue — merge, place lookup, xlsx-crate-input, austlang, docx-input, file-format-identify, ca-data-prep, chat-export, roctable, validate-crate, and the three `crate:write` writers — lives in that sibling repo (§4.7a); testing what a plugin actually does is that repo's job, not this one's. An earlier version of this suite (`test-place-merge.mjs`) reached directly into `collection2crate-plugins/plugins/merge/xlsx.js` and `.../place_lookup.js` to test merge and place-lookup logic from here; it's been removed, and `test-hooks.mjs`'s own real-registry test (which registered the actual, generated `PLUGINS`) went with it, for the same reason — this suite exists to prove the isomorphic core and the hook-bus engine are correct, not to duplicate `collection2crate-plugins`' own test coverage of its plugins.

The **browser layer stays untestable here** (§9.1). The mitigation is architectural, not test-shaped: keep logic in modules Node can reach, so as little as possible depends on `main.js`'s own untested wiring.

---

## 10. Dependencies and runtime

| Package | Role |
|---|---|
| `ro-crate` | graph assembly and entity management |
| `ro-crate-excel` | xlsx output, via `lib/workbook.js` |
| `ro-crate-static-site` | HTML rendering, single and multi page |
| `ro-crate-masp` | profile loading and validation |
| `exceljs` | workbook read/write |
| `mammoth` | docx → HTML |
| `cheerio` | HTML parsing for the docx adapter |
| `@describo/data-packs` | source of the bundled AUSTLANG data (dev) |

Built with Vite. `vite-plugin-node-polyfills` supplies Buffer/process/global for transitive dependencies; `base: './'` lets the built site work from any path.

Dynamic imports keep heavy plugin code out of the main bundle — the docx adapter and the AUSTLANG data pack are separate chunks, downloaded only when a build actually uses them.

**Browser requirements.** File System Access API (Chrome/Edge), which needs a secure context — `localhost` or HTTPS, never `file://`. Also `fetch` for profiles, templates, and gazetteers; `localStorage` for settings; `postMessage` for preview navigation.

---

## 11. File layout

```
src/
  main.js                        UI, wizard, ctx assembly, schema composition — the one non-isomorphic module (§9.1)
  crate.js                       CORE — crate assembly, serialisation, preview rendering (isomorphic)
  masp.js                        CORE — profile fetch, load, introspection, validation (thin wrapper over ro-crate-maps)
  default_profile.js             the bundled schema.org fallback (§5.1), overlaid with this app's buildOptions
  fs_helpers.js                  CORE — File System Access API wrappers (browser-only)
  github.js                      shared GitHub fetch primitives + listing cache
  preview_assets.js              reference rewriting for the blob-served preview: assets inlined, page links resolved on click
  visualise_data.js              the Visualise page's data: which output folders can be read, and both views of one
  ui_helpers.js                  modal helper (openModal — §6.2)
  style.css                      theme variables + shared UI classes

  plugins/
    hooks.js                     hook bus + the HOOKS constants + announceAndEmit
    pipeline.js                  mandatory steps + build-hook emission order
    deps.js                      buildDeps() — the one deps object every plugin factory receives
    index.js                     GENERATED by scripts/select-plugins.mjs — PLUGINS; do not hand-edit

public/
  .nojekyll                      static-site deploy marker (GitHub Pages)

tests/
  test-hooks.mjs              test-crate.mjs          test-edit-crate.mjs
  test-default-profile.mjs   test-top-level-folders.mjs

scripts/
  run-tests.mjs                 discovers and runs every tests/test-*.mjs (npm test)
  select-plugins.mjs             generates src/plugins/index.js from the PLUGINS env var (§4.7a)

vite.config.js                   shebang-stripping + preserveSymlinks (local file: deps) + node polyfills
index.html
```

Every plugin implementation lives in the sibling `collection2crate-plugins` repo, not under this repo's `src/plugins/` (§4.7a) — this repo holds only the plugin *engine* (`hooks.js`, `pipeline.js`, `deps.js`) and the isomorphic core plugins reach into through it. `src/plugins/index.js` currently imports, by default ("all"), every plugin in `collection2crate-plugins`' registry:

```
collection2crate-plugins/plugins/
  generic-input/index.js         builder — files:prepare 0 (folder scan) + crate:build 10 (the ungated fallback)
  docx-input/index.js            builder — crate:build 5, gated on `docxInput`; a docx corpus
  xlsx-crate-input/index.js      crate:build (+folder:picked, crate:prepare) — spreadsheet as crate
  austlang/index.js              files:prepare + crate:build — language identification
  file-format-identify/index.js  file-format identification
  ca-data-prep/index.js          data-prep plugin
  chat-export/index.js           chat-export plugin
  merge/index.js                 crate:build — spreadsheet merge
  roctable/index.js              crate → tabular output (CSV per @type)
  validate-crate/index.js        crate:validate — profile validation
  ro-crate-json-output/index.js  crate:write — JSON
  ro-crate-xlsx-output/index.js  crate:write — xlsx
  ro-crate-html-output/index.js  crate:write — HTML + template resolution
```

Each plugin is one folder under that repo's `plugins/`, named as the plugin
names itself and as its `REGISTRY` keys it — which is what lets a `PLUGINS`
entry resolve to `collection2crate-plugins/plugins/<name>/index.js` with no
lookup table. What is shared between plugins rather than being one (the
progress helper) sits outside `plugins/`, in that repo's `src/`.

That list — and each plugin's own internal file layout (`xlsx_crate.js`, `matcher.js`, `place_lookup.js`, `layout.js`, and so on) — is `collection2crate-plugins`' to document in its own repo, not this spec's; this file only tracks what `PLUGINS` currently resolves to.

---

## 12. UI

Refer to SPEC-IU.md



---

## 13. Limitations and direction

**Not implemented.** PDF *content* language identification (filename matching only). OCFL building. SHACL-style RO-Crate validation independent of the selected profile's MASP rules.

**Known rough edges.** GitHub access is unauthenticated, so profile and template listings are rate-limited and private repositories are out of reach. The docx adapter wipes `files/` on every build rather than updating incrementally. `ro-crate-masp` mis-validates `URL`-typed properties; the tool annotates rather than works around it. The bundled default profile adds ~261 kB gzipped to the deployed site, in its own chunk, downloaded only when a build runs without a chosen profile.

**Where the architecture points.** The hook contract absorbs new capability without touching the pipeline: new ways of reading a folder (archive import, OAI-PMH harvest) as builders — a `crate:build` tap in the builder band plus an option of its own; new processors (content-based language ID, other gazetteers, database merge sources) as `crate:build` taps; new formats (RDF/XML, institutional XML schemas) as `crate:write` taps. In each case the profile, not new UI, decides who gets them.


**Cross-repo drift.** One profile in `c2c-masp-profiles` still names options no
plugin provides, so they are offered and do nothing:

- `chordpro-songs` names an `inputMode` of `chordpro` and four options
  (`fixStDirective`, `reviewSetlistMatches`, `reviewKeyGuesses`,
  `normalizeCapoKey`) that no plugin provides at all. Since input modes are
  gone (§4.4), the `inputMode` key is now inert rather than fatal: the profile
  builds with the generic folder scan, and `configNote` says in the build log
  that the key is no longer read. The four options are still offered and still
  do nothing. Closing this means writing the chordpro builder — a `crate:build`
  tap below priority 10 gated on an option of its own — and having the profile
  name that option instead of `inputMode`.
- `structured-docs` names `"inputMode": "docx"` for the same reason and needs
  the same edit: `"enabledOptionKeys": ["docxInput"], "plugins": ["docxInput"]`.
  Until then it builds with the generic scan, which is not what it wants — the
  build log says so, but this is the one profile where the change is not
  cosmetic.

The other half of this drift is closed: the `crate2tables` plugin was renamed
`roctable` to match the library it wraps, and its option keys now match what
the profiles name.


---

## 14. Glossary

**Builder** — the plugin that assembles `ctx.crate`: a `crate:build` tap at priority 10 or lower (§4.4). Exactly one runs per build; `generic-input` is the ungated fallback.

**arcp** — URI scheme (`arcp://name,corpus/…`) for crate-internal identifiers that need to be absolute.

**CURIE** — compact URI: `ldac:subjectLanguage` expanding via the crate's context.

**Descriptor** — the entity describing `ro-crate-metadata.json` itself, pointing at the root dataset.

**Isomorphic** — runs unchanged in browser and Node; here, no file-system or DOM access, so the core is directly testable.

**LDAC** — Language Data Commons of Australia, whose profile vocabulary (`ldac:`) this tool emits.

**MASP** — Machine-Actionable Schema/Profile: a profile expressed as an RO-Crate, readable by tools.

**PCDM** — Portland Common Data Model, source of the `pcdm:hasMember`/`memberOf` collection relationships.

**Root dataset** — the entity representing the collection as a whole; everything hangs off it.

**Structural entity** — one whose `@id` encodes its place in the crate (files, folders, the root); renaming breaks the mapping to disk, so the editor locks them.
