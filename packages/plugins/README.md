# collection2crate-plugins

Build plugins for [collection2crate](https://github.com/Language-Research-Technology/collection2crate) —
split out of that repo's `src/plugins/` so a deployment can pick which
plugins it bundles instead of shipping all of them.

This package has **no runtime dependency on collection2crate**. Every plugin
here is a factory, `createPlugin(deps)`, that collection2crate calls with the
specific functions from its own `crate.js`/`fs_helpers.js`/`github.js`/
`masp.js` that plugin needs. That's what lets this repo be developed,
tested, and version-controlled independently, with no circular package
dependency between the two repos.

## Layout

```
index.js                 REGISTRY — the one registry, keyed by plugin name
plugins/<name>/index.js  one folder per plugin; createPlugin(deps) lives here
src/_progress.js         shared machinery, not a plugin
src/_entity_ids.js       the @id an entity made from a name gets, shared by merge and name-lookup
src/_place_lookup.js     GA and GHAP (TLCMap's search API) gazetteer lookup and the Geometry it writes, shared by merge and name-lookup
src/_merge_config.js     which merge config a run uses (uploaded, folder, bundled), shared the same way
src/_csv.js              CSV building and download, for visualisation panels
src/_panel.js            the DOM vocabulary those panels share
src/_transcript_grammar.js  transcript grammars: generation, parsing, saved-grammar I/O
hooks.test.mjs           the hook/priority/progress contract test
visualisation.test.mjs   the panels' pure seams: matching, counting, scaling
```

One folder per plugin under `plugins/`, named exactly as the plugin names
itself and as `REGISTRY` keys it — that triple agreement is what lets a
consumer resolve `collection2crate-plugins/plugins/<name>/index.js` from a
`PLUGINS` selection without a lookup table, and `hooks.test.mjs` asserts the
registry key and `plugin.name` half of it. Anything shared between plugins
rather than being one stays outside `plugins/`, in `src/`.

## Two kinds of plugin

Most plugins here tap the build pipeline: they declare `hooks`, run when a
person presses Process or Build, and write to `ctx`. The rest declare a
**`visualisation`** panel — including `concordance`, `ngrams`, `chart`,
`sentimentexplorer`, `collocation`, `topicdetector` and `plots` — which appears
on collection2crate's Visualise page, taps nothing, and does not run at all
until someone opens it:

```js
{
  name: "concordance",
  visualisation: {
    label: "Concordance",                       // names it in the sidebar
    hint: "Search for a word or phrase…",       // one line, shown with it
    render(container, { documents, tables, log }) { /* build DOM here */ },
  },
}
```

One registry holds both, and a plugin may declare either or both: a panel is
something a plugin offers, like an `optionSchema`. A deployment that leaves a
plugin out of its `PLUGINS` selection gets neither its taps nor its panel.

`SPEC-PLUGINS.md` is the full contract — what `documents` and `tables` are,
where they come from, and what each of the three panels does.

## Consuming this package

collection2crate depends on it as `"collection2crate-plugins": "file:../collection2crate-plugins"` (a
sibling checkout) and imports `REGISTRY` from `index.js`, filtering it by
its `PLUGINS` env var before calling each selected factory. See collection2crate's `SPEC.md` and `src/plugins/index.js`
for the consuming side.

## The two conventions every plugin here follows

**1. Hook names are literal strings, not an imported constant.** A plugin's
`hooks` object is keyed by strings like `"crate:build"` or `"crate:write"`
rather than an imported `HOOKS.CRATE_BUILD` — those strings are a stable
contract owned by collection2crate's `src/plugins/hooks.js`, in the order the pipeline emits
them:

| Hook | String | When |
|---|---|---|
| `C2C_LOADED` | `"c2c:loaded"` | startup, once |
| `FOLDER_PICKED` | `"folder:picked"` | a folder is chosen |
| `PROFILE_SELECTED` | `"profile:selected"` | a MASP profile is chosen |
| `FILES_PREPARE` | `"files:prepare"` | per-file analysis |
| `FILES_WRITE` | `"files:write"` | writing files derived from the folder's own — no crate exists yet |
| `METADATA_MERGE` | `"metadata:merge"` | spreadsheet metadata merge |
| `CRATE_PREPARE` | `"crate:prepare"` | the crate's own metadata, immediately before assembly |
| `CRATE_BUILD` | `"crate:build"` | crate assembly and everything that mutates it |
| `CRATE_VALIDATE` | `"crate:validate"` | validation |
| `CRATE_WRITE` | `"crate:write"` | writing to the folder |

Which button runs a tap follows from its stage. collection2crate's **Process**
step emits the file half — `files:prepare → files:write → metadata:merge` — and
its **Build** step emits the crate half — `crate:prepare → crate:build →
crate:validate → crate:write`. Every `crate:` stage belongs to Build. The two
halves are disjoint, and a build continues the `ctx` the Process run finished
with, so a plugin spanning both (prepare files, then describe them in the
crate) writes to `ctx` in a file stage and reads it back at `crate:build`,
exactly as it would within one run.

One caveat for anything seeding `ctx.config`, as `xlsx-crate-input` does at
`crate:prepare`: the host rebuilds that object from the profile and the
Describe form on every run, so a seed only survives to be used because
`crate:prepare` runs in the same step as the assembly that reads it. Plugin-
owned keys on `ctx` (`ctx.xlsxCrate`, `ctx.langById`, anything you invent)
are carried between the two runs untouched.

If collection2crate ever renames one of these, every plugin here keyed to the
old string silently stops firing — there's no import to break loudly. Grep
this repo for the old string when that happens.

These replaced an earlier, smaller set: `"config:prepare"` is now
`"crate:prepare"`, `"files:analyze"` is now `"files:prepare"`, and
`"crate:built"` folded into `"crate:build"` — the old separate
build-then-mutate pair is now one stage ordered by `priority` (below), with
the build's chosen *builder* running ahead of every annotating tap. The write
stage is `"crate:write"`; it was `"output:write"` until the stage names were
made uniform, and collection2crate emits only the new name.

**Every tap declares its `priority`.** A tap is an object, not a bare
function:

```js
hooks: {
  "files:prepare": {
    priority: 20,                                       // 0–100, lower runs earlier
    weight: 4,                                          // share of the progress bar (default 0)
    activeWhen: (ctx) => !!ctx.options.enableMyThing,   // omit for "always"
    handler: async (ctx) => { /* ... */ },
  },
},
```

`priority` is explicit on every tap in this repo rather than left to the
default (10) plus stable-sort registration order, so a plugin's position in
a stage is a property of the plugin itself and survives being filtered out
of, or reordered in, a deployment's `PLUGINS` selection. The numbers are
spaced 10 apart so a new plugin can be slotted between two existing ones
without renumbering. Taps on `"crate:build"` start at 20, leaving 0–10 to
the builders — see below.

Current assignments, per stage:

| Stage | Order |
|---|---|
| `folder:picked` | — (the existing crate is loaded by collection2crate itself) |
| `files:prepare` | `generic-input` 0 · `austlang` 10 · `file-format-identify` 20 · `ca-data-prep` 30 · `chat-export` 40 · `name-lookup` 50 |
| `files:write` | `ca-data-prep` 10 · `chat-export` 20 |
| `crate:prepare` | `xlsx-crate-input` 10 |
| `crate:build` | `docx-input` 5 · `generic-input` 10 · `xlsx-crate-input` 20 · `austlang` 30 · `file-format-identify` 40 · `ca-data-prep` 50 · `chat-export` 60 · `merge` 70 · `roctable` 80 |
| `crate:validate` | `validate-crate` 10 |
| `crate:write` | `docx-input` 5 · `roctable` 10 · `ro-crate-json-output` 20 · `ro-crate-xlsx-output` 30 · `ro-crate-html-output` 40 |

`docx-input` splits the same way for a different reason: it extracts embedded
and referenced media while parsing, because the crate has to name those files,
but writes them at `crate:write` — nothing reads them before the crate they
belong to is written out, and the directory is wiped and rewritten in one go
rather than accumulating stale media from renamed documents. The bytes live on
`ctx` in between.

`name-lookup` does all its work at `files:prepare`, during Process, on the
crate the run was seeded with: named entity recognition (compromise) over each
`.txt`/`.md`/`.docx`/`.pdf` file's text (PDFs through `unpdf`), other proper
names checked against the GA and GHAP gazetteers (`src/_place_lookup.js`,
shared with `merge`), and each name turned into the `@id` merge would give it
(`src/_entity_ids.js`: `#john_smith`, `#place-mount-isa`) — reused if the crate already holds it and
created as a `Person` or `Place` if not. With the gazetteer on, places get
coordinates as a linked `Geometry`, written as merge writes them and looked
up with the merge config's `placeMatchRegion`; a Place that already has a
`geo` keeps it. Geoscience Australia is asked a hundred names per request
(`upper(name) in (…)`); only its misses cost a request each, and only when
"Exact place names only" is off or "Also check GHAP" is on — TLCMap's list
parameters don't work, so GHAP is one name per request. Answers are kept in
`_config/name-lookup/gazetteer-cache.json`, filed under the lookup settings,
so a later run only asks about new names; a lookup that got no reply isn't
kept. A gazetteer name that only starts with or contains the
file's ("Murray Upp" → Murray Upper) counts too, unless `nameLookupExactOnly`
is on — `merge`'s `placeExactOnly` makes the same choice for merged places. Files are linked as
`custom:participant` (people) and schema.org's `contentLocation` (places, as merge
links them, so the HTML preview's map can follow a File to a Place's
coordinates). Names of three letters or fewer ("M", "Mt") are dropped. An uploaded people list
(`nameLookupPeopleFile`: a `.txt`, one name per line) replaces NER's guesses
about who is a person: the people are then the listed names a file mentions —
whole names, any case, any whitespace between words — in the list's spelling,
and a listed name is never taken for a place. Places still come from NER and
the gazetteers. Build starts from the crate Process
finished with, so the links are there without a `crate:build` tap; a File new
to the crate is added bare, and `generic-input`'s scan fills it in.

`ca-data-prep` and `chat-export` each split across two stages on purpose: the
files they derive are written at `files:write`, during Process, and the
entities describing those files are added at `crate:build`, the first point
where a crate exists. Neither half needs the other to have run in the same
run — the records they both read live on `ctx`, which a build carries over
from Process.

These reproduce the execution order `REGISTRY`'s own order used to imply.
Note that `ca-data-prep` replaces `ctx.crate` wholesale at 50, so the two
taps ahead of it (`austlang` 30, `file-format-identify` 40) contribute
nothing on a build where transcript processing is on — preserved as-is
here, since this change was a rename, not a reordering.

### Builders

There is no separate kind of plugin for reading a folder, and no input-mode
setting the host dispatches on. A **builder** is just a plugin whose
`"crate:build"` tap sits in the band `priority <= 10` and produces
`ctx.crate`; everything at 20 and above annotates the crate a builder
produced, which is why those taps can assume it already exists.

collection2crate runs **exactly one builder per build**: of the builder taps whose
`activeWhen(ctx)` passes, the lowest priority wins, and *every* tap belonging
to a builder that lost is skipped for that build — other stages included. So
a specialised builder doesn't have to coordinate with the baseline one, or
even know it exists:

| Builder | Priority | Gate |
|---|---|---|
| `docx-input` | 5 | `activeWhen: ctx => !!ctx.options.docxInput` |
| `generic-input` | 10 | none — the fallback |

`generic-input` carries no option, so it is always active and always the last
builder standing; switching on `docxInput` puts a builder ahead of it and
stands it down, folder scan (`files:prepare` at 0) included. A new builder
needs a lower priority than the fallback and an option of its own for a
profile to enable — nothing in the host changes. Exactly one builder in the
registry may go ungated; `hooks.test.mjs` enforces that, since a second
unconditional one could never run.

**A builder adds to the run's crate; it never replaces it.** collection2crate
gives every pipeline run its own crate from the first stage on: a copy of the
folder's existing crate (after asking the user about new and missing files),
or an empty one when the folder has none (collection2crate SPEC.md §4.4a). So
`ctx.crate` is already set in `files:prepare`, and a builder adds to that
object — `buildCrate(files, config, log, { crate: ctx.crate })` for a folder
scan, `mergeCrateInto(ctx.crate, ownCrate)` for a builder that assembles its
own graph. The existing crate wins: properties an entity already has keep
their values. `ctx.existingCrate` says whether the folder had a crate. A
`null` `ctx.crate` only happens with a host that doesn't seed one, and then
the builder creates it.

collection2crate checks this itself. A build fails with an error naming the
builder if the builder never ran, if it ends with no `ctx.crate`, or if it
replaced a seeded crate with a different object. The same rule holds for any
tap at 20 and above, and for any stage before `crate:build`: `ca-data-prep`
keeps a first build transcript-only by clearing the scan's entities out of the
run's crate (`clearFolderScan`) before merging into it, rather than swapping
the crate.

### Progress

Progress is **declared and weighted**, not inferred from log text. A tap
that does visible work sets `weight` (default 0 — no slice of the bar) and,
if it only runs conditionally, `activeWhen(ctx)`. Before a build the host
sums `weight` across every tap whose `activeWhen` passes and gives each an
ordered `[start%, end%]` slice of the main bar; the handler then reports
only its own position inside that slice:

```js
import { progressFor } from "../_progress.js";

handler: async (ctx) => {
  const progress = progressFor(ctx);
  progress.start("Identifying file formats…");
  for (let i = 0; i < total; i++) {
    // ...
    progress.report((i + 1) / total, `Format identification: ${i + 1}/${total} file(s)…`);
  }
  progress.done();
}
```

`report(fraction, label)` drives the main bar (scaled into the tap's slice)
and the secondary bar (the raw fraction) from one call — the secondary bar
appears by itself the first time a tap reports more than once before
`done()`, and stays hidden for a tap that only brackets `start()`/`done()`
around a single label. `done()` snaps the main bar to the slice end.

`ctx.log` and `ctx.progress` are **independent channels**: no log message
drives bar state any more. The old convention — emitting
`"… 12/40 file(s)…"` through `ctx.log` and letting collection2crate's host
parse the `done/total` out of the string — is gone. Keep logging what is
worth reading in the transcript; report progress separately.

Always go through `progressFor(ctx)` (`src/_progress.js`) rather than
touching `ctx.progress` directly. It returns the same three-call shape on a
host that has no `ctx.progress` at all, so a plugin from this repo still
runs under an older collection2crate instead of throwing partway through a build.

`countedProgress(ctx, total, label)` from the same module wraps the common
"loop over N things" case: it starts the tap, hands back a `tick(index,
label)` that takes the zero-based index of the item just finished, and
`tick.done()` closes it out. Tick on the skipped paths too (a `continue`
inside the loop), or the bar comes up short on a run where half the inputs
were unreadable.

### Testing

```bash
npm test          # hooks.test.mjs — the hook/priority/progress contract
npm run test:pronom
```

`hooks.test.mjs` constructs every plugin in `REGISTRY` against a stub `deps` and asserts the parts of the contract that fail
*silently* rather than loudly: a tap keyed to a hook name collection2crate no
longer emits never fires, a tap left as a bare function never gets a slice
of the bar, and two taps sharing a priority in one stage quietly fall back
to registration order. It also prints the resolved execution order per
stage, which is the quickest way to see what a priority change actually
did. The list of valid hook names is duplicated there rather than imported
— this package has no runtime dependency on collection2crate, so accepting a
contract change from the other side is a deliberate edit to that list.

**2. Every plugin module exports `createPlugin(deps)`**, not a static
`plugin` object. `deps` is the exact set of collection2crate core functions
that plugin needs, assigned into module-level bindings the plugin's hook
handlers close over. Call it once, before the plugin's hooks can fire.

## Per-plugin dependencies

| Plugin | `deps` keys it needs |
|---|---|
| `xlsx-crate-input` | `readFileBytes`, `loadMasp` |
| `austlang` | `addLanguageEntities` |
| `file-format-identify` | `graphEntityById` (handed to `matcher.js`'s own `configure(deps)` on each dynamic import, for `getFileHandleAtPath`) |
| `ca-data-prep` | `writeFileAtPath`, `fileExists`, `readFileTextFromDirectory` (reads the chosen transcript grammar), `mergeCrateInto` (lands the transcript crate in an existing one) |
| `chat-export` | `writeFileAtPath`, `fileExists`, `readFileTextFromDirectory` (the chosen transcript grammar; its .docx/.txt reading goes through `ca-data-prep`'s own exports rather than `deps`) |
| `merge` | `readJsonFromFolder`, `graphEntityById` |
| `name-lookup` | `readFileBytes` (only when a file in `filesWithMeta` has no `handle`), `readJsonFromFolder` (the folder's `merge-config.json`, for its place-lookup settings, and the gazetteer cache), `writeFileAtPath` (the gazetteer cache, `_config/name-lookup/`) |
| `roctable` | `readJsonFromFolder`, `writeFileAtPath`, `getFileHandleAtPath`, `readFileTextFromDirectory`, `loadCrateFromJson` (lets "Configure tables…" inspect the folder's crate without a build running), `openModal` (the table-selection tree, `config-tree-ui.js`) |
| `transcript-grammar` | `writeFileAtPath`, `readFileTextFromDirectory`, `openModal` (the three-step grammar editor and the tester, `ui.js`); its `.docx` reading goes through `ca-data-prep`'s `extractDocumentText`, imported on demand |
| `validate-crate` | `loadMasp` |
| `concordance`, `ngrams`, `chart` (panels) | none — a panel receives its data in `ctx`, and never touches the folder |
| `plots` (panel) | `readFileTextFromDirectory`, `writeFileAtPath`, `openModal` (loads and saves `_config/plots/config.json` in the selected folder) |
| `ro-crate-json-output` | `crateToJsonString`, `writeFile`, `fileExists` |
| `ro-crate-xlsx-output` | `crateToXlsxBytes`, `writeFile`, `fileExists` |
| `ro-crate-html-output` | `crateToPreviewHtml`, `crateToMultiPageHtml`, `writeFile`, `writeFileAtPath`, `readJsonFromFolder`, `readFileTextFromDirectory`, `verifyPermission`, `fileExists`, `bustCacheUrl`, `buildGitHubTreeUrl`, `fetchGitHubTextFile`, `listGitHubFolder` |
| `generic-input` (builder) | `buildFileMetadata`, `buildCrate` (adds the scan to the crate collection2crate seeded from the folder's existing one, if any — collection2crate SPEC.md §4.4a) |
| `docx-input` (builder) | `writeFileAtPath`, `fileExists` (both handed to `docx_crate.js`'s own `configure(deps)` once its dynamic import resolves), `mergeCrateInto` (lands the parsed crate in an existing one) |

`openModal` has one shape, documented in collection2crate SPEC.md §6.2 — a
plugin builds its content in `onMount(body, { close })` and declares its
buttons as `actions`, never drawing its own:

```js
const chosen = await openModal({
  title: "Configure RO-Crate tables",
  onMount(body) { body.append(/* your controls */); },
  actions: [
    { label: "Cancel", value: null },
    // called at click time, so it sees whatever the controls have edited
    { label: "Save configuration", primary: true, value: () => working },
  ],
});
```

Dismissing resolves `null`, which the caller should treat as "no choice was
made" rather than an empty result. Content uses the host's own classes —
`.button`, `.button primary`, `.button subtle`, `.checkbox`, `.field-hint`,
`.data-table` — so a plugin ships no CSS.

`loadMasp` is a thunk — `() => import("../masp.js")` — rather than the
function itself, so `ro-crate-masp` (a heavy validator library) stays
dynamically imported from collection2crate's own tree instead of becoming a
static import anywhere in this package.

`ca-data-prep` (`plugins/ca-data-prep/`) parses transcripts by line shape,
not by Word style, so the authoring convention is the contract:

```
Speakers:
D:→Dora [Dora Leung] (Australian, male) #dora     ← code, then the speaker
…
PRELIMINARIES                                            ← section marker, alone on its line
1→D:→so I'm Dora?                                      ← optional turn number, code, turn
MAIN
D:→hi                                                    ← unnumbered is equally fine
```

It reads `.docx` and `.txt` files (as does `chat-export`). A `.txt` is
decoded as UTF-8, or UTF-16 when it starts with that byte-order mark, and
each of its lines is given the shape of a `.docx` paragraph before parsing
(`plainTextAsParagraphs` in `process.js`), so both go through the same parser
and a line number in the log is the line's number in the file. A `.txt` with
the same name as a `.docx` is skipped with a warning, since the two would
write the same CSV and CHAT file. `txt-transcripts.test.mjs` covers this.

A line that is not a turn is folded into the turn above it, which is what
makes wrapped text work — and what makes an unrecognised turn shape fail
silently and completely rather than partially: every following line, section
markers included, collapses into the last line the parser did recognise, and
the CSV comes out as a header and nothing else. `transcript.test.mjs` pins
the shapes that must parse; add to it before touching `SPEAKER_LINE` or
`TURN_LINE` in `process.js`.

`transcript-grammar` (`plugins/transcript-grammar/`) lets a person define that
convention for their own documents instead of accepting it. It taps no build
stage; it offers two actions, shown on collection2crate's Process page next to
the transcript processing option:

- **Define a transcript grammar…** — paste a transcript or choose a `.txt` /
  `.docx`; mark line ranges as **header metadata**, **speaker info** or
  **main** (plus marker lines such as `Speakers:` or `PRELIMINARIES`, and lines
  to ignore); in a **cleanup** step, build rules for lines to skip (a
  timestamp line "and every line like it") and text to remove from rows
  wherever it appears (inline timecodes, markup — "exactly this" or "anything
  shaped like this"), and columns of data to drop from main rows (select any
  part of a column in a row: a tab-separated field, or — in a line without
  tabs — the characters out to the neighbouring columns), with a
  before/after preview; then, in individual cleaned
  rows, select characters and mark them as a
  speaker's code / name / alternate name / affiliation / id, or a turn's
  number / speaker / text. Fixed text every row has but nobody wants kept —
  a tag like `<u speaker=`, the `>` after a name, a `[05:36]` timestamp — is
  marked **Ignore**: it is matched as written (digits match any digits) and
  never captured. Letters left unmarked match anything, and the editor names
  them so they can be marked. Speaker info is optional: in a format that names
  the speaker on every row, the speakers are whoever the turns name. The patterns are generated from that markup
  (`grammar.js`'s `buildGrammar`) and re-run over the whole sample as you go,
  so you see what they parse and what they miss before saving.
  A format whose rows put every field at the same character positions (the
  London-Lund Corpus, say) can choose to read main rows by **Fixed-width
  columns** instead of by **Text pattern** — a choice at the top of the Main
  tab, set to fixed-width by default when every main row is the same length. Fields are
  then marked once, on a row as the document has it: each becomes a column
  (the selection widened over the blanks either side, so a right-aligned
  `10` also covers `100`), everything outside the marked columns is left
  out, and punctuation beside a turn number or speaker inside its column (an
  overlap `(`) is matched but not kept. A ruler over each sample row counts
  the characters and shades the columns; the **Columns** list gives each
  field's range (from 1, both ends included) in boxes that can be edited
  directly, with **Use the marks** to go back to what the marks give; and
  **Columns across rows** shows the columns shaded down a dozen rows of the
  sample, the ones the columns don't read first, flagged ✕.
  With either reading, **Join a row to the one above when it repeats its turn
  number and speaker** reads a row split over several lines (a London-Lund
  tone unit too long for its line) as one: the text of each repeat joins the
  row above, as long as nothing but blank, skipped or wrapped lines comes
  between. A new grammar starts with it on when the sample has such rows; the
  editor says how many, and saves it as `turnRow.joinRepeats`.
  Main rows can also carry fields of your own: **Your own labels** on the Main
  tab adds one ("Prosody", "Overlap"), which gets its own mark button and
  colour and is marked like the built-in fields, with either reading. A
  label some sample marks is saved in `turnRow.customFields` (`{ key, label }`,
  the key its group in the pattern), and ca-data-prep writes its values as an
  extra CSV column after `turnNumber,speakerID,text,section`, headed by the label.
  Speaker rows take labels of their own the same way ("Role", "Age"), saved in
  `speakerRow.customFields`; ca-data-prep gives each speaker's Person an
  `additionalProperty` for each non-empty one — a `PropertyValue` entity
  (`#AA-role`) with the label as its `name` and the value as its `value`.
- **Test a transcript grammar…** — parse another document with a saved one.

A grammar is saved to `_config/transcript-grammar/<name>.json`: named-group
regular expressions (`speakerRow`, `turnRow`, `headerField`), region start
markers, section names, line-skip patterns (`ignore`) and removal patterns (`strip`, applied to speaker and main lines before rows are read) and dropped columns (`dropColumns`: `{ "tab": n }` for the n-th tab-separated field of a line with tabs, `{ "from": a, "to": b }` for characters a up to b of a line without; 0-based, applied to main rows only, before `strip`). A fixed-width `turnRow` also has `fixedWidth: true` and its `columns` (`{ key, from, to }`, 0-based, `to` exclusive or null for "to the end of the line"); it is matched against the line as the document has it, `strip` applies to each field's value instead, and it saves no `dropColumns`. Only the shape of the sample is
kept — delimiters, brackets, which fields are optional — never its text,
since the rows marked up are real speaker declarations. `parseWithGrammar(text,
grammar)` is pure; it and the folder helpers live in
`src/_transcript_grammar.js`, since three plugins use them.
`transcript-grammar.test.mjs` covers generation and parsing.

**Parsing with a saved grammar.** `ca-data-prep`'s `transcriptGrammar` option
(a child of "Process plain transcript documents", listing the grammars saved
in the folder) swaps the built-in convention for the chosen grammar;
`chat-export` reads the same option, so the CSV and the CHAT file agree. The
result has the same shape either way — CSV rows, Person entities, the log —
so nothing downstream knows which reader ran. Differences worth knowing:

- sections are the grammar's own markers; `PRELIMINARIES` / `MAIN` /
  `POSTLIMINARIES` still abbreviate to `PRE` / `MAIN` / `POST` in the CSV, any
  other name is written as is;
- a row the grammar cannot read is reported (`turn-row-unmatched`) and left
  out of the CSV, and a wrapped line folded into the row above is reported on
  its own line (`line-folded`); header lines that aren't `Key: value` are
  counted as non-conforming too;
- a chosen grammar that is missing or invalid fails Process rather than
  falling back to the built-in convention;
- Process records a fingerprint of the grammar it parsed with, and Build
  warns if the saved grammar has changed since (re-saving the same markup
  does not count).

`transcript-with-grammar.test.mjs` covers this, including that the grammar
marked up from the built-in convention's own fixture reproduces the built-in
reader row for row.

The `roctable` plugin (`plugins/roctable/`) takes its name from the
[`roctable`](https://github.com/ptsefton/roctable) library it wraps — a WIP
library not yet on npm — installed as a git dependency pinned to a
commit (`"roctable": "github:ptsefton/roctable#<sha>"`), since it isn't
tagged or released. Bump the pinned commit deliberately, not by dropping
the pin — an unpinned GitHub dependency would silently pick up whatever
the repository's default branch has on the next `npm install`. It reuses
the library's own crate-walking functions directly (`ctx.crate` is already
an `ro-crate` `ROCrate` instance, the same shape it expects) — including
`load_text`, via a `fileReader` this plugin injects
(`browserFileReader` in `plugins/roctable/index.js`, wrapping
`readFileTextFromDirectory`) rather than the library's own Node-`fs`-based
default (see its `lib/io.js` and `SPEC.md` §9.0). Its config load/save and
CSV file writing stay this plugin's own job either way — the library's
`lib/config.js`/`lib/csv.js` file I/O is Node-`fs`-only and simply isn't
called from here; see `collection2crate/docs/roctable-spec.md`.

The plugin is split across three files: `index.js` (the plugin itself —
hooks, the `optionSchema`, the `roctableConfigure` action), `discover.js`
(inspect the crate and merge onto whatever config already exists — the one
code path both the build-time hook and the standalone action call, plus the
`ldac:mainText`/`indexableText` default-seeding rule), and `config-tree-ui.js`
(the checkbox-tree editor `openModal` renders — a table heading per `@type`,
unrolling to its properties' include/expand/load_text/join). Config lives at
`_config/roctable/config.json`, output at `_outputs/roctable/` — collection2crate
issue #81's proposed per-plugin directory convention, adopted here ahead of
it becoming repo-wide.

## Writing a new plugin here

```js
// plugins/my-thing/index.js
let someCoreFn;

export function createPlugin(deps) {
  ({ someCoreFn } = deps);
  return plugin;
}

const plugin = {
  name: "my-thing",
  optionSchema: { key: "enableMyThing", label: "…", default: false },
  // Declare every file/directory this plugin may write directly into the
  // picked folder (root-relative path; "/" for one nested under a directory
  // this plugin owns outright, e.g. "my-thing-output/report.csv" — not for a
  // single file buried inside someone else's tree). See "Declaring output
  // paths" below.
  outputPaths: [{ path: "my-thing-output", kind: "dir" }],
  hooks: {
    "crate:build": {
      priority: 20,
      weight: 1,
      activeWhen: (ctx) => !!ctx.options.enableMyThing,
      handler: (ctx) => { /* ... */ },
    },
  },
};
```

### Declaring output paths

A plugin that writes into the picked folder (rather than only reading from it,
or only mutating `ctx.crate` in memory) should declare `outputPaths`: an array
of `{ path, kind }`, `kind` being `"file"` or `"dir"`. collection2crate composes
these across every registered plugin (`composeOutputPaths()` in its
`src/plugins/index.js`, generated alongside `composeOptionSchema`/
`composeSettingsSchema`) for two things: excluding a previous build's own
output from being rescanned as corpus content on the next build (the same job
`GENERATED_FILENAMES` in collection2crate's `crate.js` already does for the core
JSON/xlsx/HTML outputs), and an opt-in Settings toggle that deletes all of it
before a build runs, so stale output from a renamed or removed source file
never lingers.

Rules of thumb:

- **Respect `ctx.options.overwrite`.** It is the person's answer to whether a
  run may replace what is already in their folder, and it covers derived files
  as much as the crate's own: check before writing, and say what you skipped
  (`` `${path} exists and overwrite is off — skipped.` ``) rather than passing
  over it silently. Every writing plugin here does this.
- **Declare every top-level entry you write, even ones gated behind an
  option.** The declaration describes what the plugin *may* produce across
  its lifetime, not just what a specific run's options enable — a stale file
  from a run where the option was on should still be found and skipped/
  cleaned when a later run has it off. `ro-crate-html-output` declares both
  `ro-crate-preview.html` and `ro-crate-preview_html` even though the latter
  only appears for a multipage template.
- **Two plugins writing into the same shared directory both declare it** —
  `chat-export` and `ca-data-prep` both declare `{ path: "c2c-output", kind:
  "dir" }`; collection2crate's composition dedupes by `path`.
- **`kind: "dir"` means collection2crate may delete the whole subtree.** Only
  declare a directory path when the plugin owns everything under it — don't
  declare a directory that content files might also legitimately live in.
- **No `outputPaths` at all is correct for a plugin that never writes to the
  folder** — `merge`, `austlang`, `validate-crate`, and the input-analysis
  half of every plugin all fall here; only the writing side declares.
- **A path under `_config/<slug>/` or `_backup/<slug>/` (collection2crate issue
  #81's proposed per-plugin directories) still gets scan-excluded, but
  collection2crate's "Delete plugin output before rebuilding" skips deleting it**
  — those two are meant to persist across builds (standing configuration,
  changed-file backups), unlike `_outputs/<slug>/`, which is exactly the
  disposable generated content that setting exists to clear.
- **Generated files go under `_outputs/`, standing configuration under
  `_config/`.** Name the folder inside for *what it holds*, not for the plugin
  that writes it: `_outputs/csv/`, `_outputs/logs/`, `_outputs/chat/` — someone
  opening the folder is looking for their CSVs, not for the plugin that made
  them. A plugin whose output has no such name uses its own (`roctable` writes
  `_outputs/roctable/`, configured from `_config/roctable/`).
  Declare each directory you write individually; `_outputs/` is shared, so a
  plugin claiming it whole would hand its own "delete output before rebuilding"
  sweep everybody else's files. The exceptions to all of this are the crate's
  own published artefacts — `ro-crate-metadata.json`, the xlsx, the preview and
  its assets — which belong at the folder root where a reader of the crate
  expects them, not filed under output directories at all.

### Generated files in the crate

A plugin that writes files it also describes in the crate should let the
person building it leave those files out. `src/_crate_outputs.js` has the
shared pieces:

- `outputsInCrateOption(key, what)` returns a checkbox child option,
  **Include … in the RO-Crate**. It is marked `stage: "build"`, so changing it
  on the Process page doesn't make the person run Process again.
- `includeOutputs(ctx.options, key)` is true only when the box is ticked.
  collection2crate starts a checkbox unticked unless the profile lists it in
  `buildOptions.plugins`, and forces it off when the profile doesn't offer it.
  So a profile that offers the parent option should offer this one too, and
  list it in `plugins` to keep the files in the crate by default.
- `removeOutputEntities(ctx.crate, [dir])`: when leaving files out, also call
  this at `crate:build`, because the run's crate carries on from the folder's
  existing one and may already describe them. It removes every entity under
  the directories, every reference to them, and any `Annotation` left with no
  body.

| Plugin | Option key | Files | Leaving them out also drops |
|---|---|---|---|
| `ca-data-prep` | `transcriptOutputsInCrate` | `_outputs/csv/` | each document's `ldac:mainText` and its `Annotation` |
| `chat-export` | `chatOutputsInCrate` | `_outputs/chat/` | — |

`ca-data-prep`'s `_outputs/logs/` are never described in the crate. Either way
the files are still written to the folder. A profile shows the option by
naming its key in `enabledOptionKeys`, and starts it ticked by listing it in
`plugins` (the ldac profile does both).

Then register it in this repo's `index.js` (`REGISTRY` — one registry, for
builders and annotating plugins alike), and in collection2crate's
`src/plugins/index.js`, wire up the `deps` object it's called with.
