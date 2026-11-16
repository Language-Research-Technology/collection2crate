# Visualisation plugins

Visualisation panels for collection2crate's Visualise page. They read data
that a build already produced and let a person explore it; they do not run
during build processing. Panels receive the loaded `documents` and `tables`
from the host, and may use the selected folder handle only through injected
host file APIs when they need to persist per-folder settings.

## The contract

A plugin declares visualisation the way it declares anything else — as a member on
the same registry entry, in the one `REGISTRY`:

```js
export function createPlugin(deps) {
  return {
    name: "concordance",
    visualisation: {
      label: "Concordance",
      hint: "Search for a word or phrase and see every occurrence in context.",
      render(container, ctx) { /* … */ },
    },
  };
}
```

- `label` names the panel in the Visualise sidebar; `hint` is the one-line
  description shown with it.
- `render(container, ctx)` builds the panel's DOM inside `container`, an empty
  element the host owns. It is called each time the panel is shown, and may be
  called again when the loaded documents change; it must not assume it is the
  first call, and must not retain anything between calls except through `ctx`.
- `ctx` carries `{ documents, tables, dirHandle, log }` — the two views of the
  loaded data described below, the selected folder handle for panels that keep
  per-folder configuration, and the host's logger for anything worth putting
  in the build log. A panel must use injected host file APIs rather than read
  or write through `dirHandle` directly.

A plugin may declare `visualisation` alongside `hooks`, or on its own. These two
declare no hooks at all: they never run during a build, so they register
nothing on the bus, and `registerAllPlugins` skips them as it already skips any
plugin with no `hooks`. No second registry, no separate selection mechanism —
a deployment that leaves a plugin out of `PLUGINS` gets neither its taps nor
its panel.

## The documents

`ctx.documents` is a flat list, one entry per line, row or utterance:

```js
{ id: "_outputs/csv/interview-01.csv#12",  // path + row, unique
  source: "_outputs/csv/interview-01.csv", // for display and grouping
  speaker: "CHI",                          // "" when the format has none
  text: "the actual line of text" }
```

Flat, not nested by file, because both plugins iterate the corpus and report
which source each result came from. One line per entry, not one per file, is
what makes n-grams stop at line boundaries rather than running across an
utterance break (see below).

Loading is the **host's** job, not a plugin's: collection2crate owns the folder
handle, and one picker on the page serves every panel.

**That picker lists output directories, not files.** The choices are the
directories plugins declared as `outputPaths` — `_outputs/csv/` (ca-data-prep),
`_outputs/chat/` (chat-export), `_outputs/logs/` — named as what produced them
rather than as a list of filenames. A corpus build writes hundreds of files
whose names change with every source document; the handful of folders they land
in does not, and "the CSVs the transcript processing made" is the choice a
person is actually making. Picking one loads every supported file in it.

The three shapes the loader reads:

| Extension | Parsed as | `speaker` from |
|---|---|---|
| `.csv` | a `text` column, or every cell joined when there is none | a `speakerId`/`speaker` column, if present |
| `.cha` | CHAT utterance lines (`*CHI:\t…`); `@`-prefixed header lines are metadata, not text | the tier label |
| anything else | one non-empty line per document | — |

A directory is only offered when it exists *and* holds a supported file, so a
declared output holding HTML or images never appears as a dead option — and a
panel never has to render an empty state for a folder that could never have had
anything in it.

### `ctx.tables` — the same CSVs, unflattened

Flattening a CSV to one line of text per row is what the text panels want and
what a chart panel cannot use: a chart needs the columns back.

```js
{ source: "_outputs/csv/interview-01.csv",
  header: ["speakerId", "start", "end", "text"],
  rows: [["CHI", "0.0", "2.4", "the actual line"], …] }
```

So the host parses each CSV once and offers both views of it: `tables` for
anything that reads columns, `documents` for anything that reads running text.
A `.cha` or `.txt` source produces documents only and never appears in
`tables` — there are no columns to offer.

## What collection2crate has to add

Host-side work this spec depends on, none of it done yet:

- `composeVisualisationPanels()` in `src/plugins/index.js`, alongside
  `composeOptionSchema()` and the others, returning every plugin's `visualisation`
  member in registry order.
- A Visualise page that is nothing but a panel host: the output-directory
  picker and the composed panels in its left rail, the chosen panel rendered in
  the right column. It holds no visualisation of its own.
- One loaded set of data shared by every panel. Switching panels does not
  reload, and a panel never picks files for itself — which is also what makes
  running the same corpus through two panels a comparison rather than a
  coincidence.
- The loader described above, in the host rather than in a plugin, producing
  both `documents` and `tables`.
- **Moving the chart UI out of `main.js`** into the `chart` plugin below. It is
  the page's own content today — the file list, the chart-type and axis
  selects, `drawChart()` and its SVG helpers, roughly 150 lines around
  `refreshVisualiseView()`. Once the page is a panel host, a built-in chart
  would be the one panel that arrived by a different route and could not be
  deselected from a deployment; there is no reason for it to be the exception.

## Shared helpers

`src/_csv.js` in this repo, next to `_progress.js`: `csvField(value)` (quote
when the value holds a comma, quote or newline; double any quote),
`buildCsvText(header, rows)`, and `downloadCsv(filename, text)`. Both plugins
offer the same two result actions and must escape identically.

Results are **copied or downloaded, never written into the folder**. Visualisation
is exploratory — a person tries twenty searches and keeps one — and a plugin
that wrote each attempt into `_outputs/` would be filing drafts as crate
content. If a particular visualisation is worth keeping, it belongs in the crate by
a deliberate act, which is a separate feature from either of these.

## Styling

Use the host's existing vocabulary — `.field`, `.actions`, `.button`,
`.data-table`, `.table-scroll`, `.empty-note`, `.mono` — rather than
plugin-specific class names. Anything genuinely specific to a panel (the keyword 
column's centring, the numeric columns' alignment) is a handful of rules the 
plugin ships with its own prefixed class.

---

## concordance

Keyword-in-context: find every match of a search term across the loaded
documents and show it with a few words of context either side. Follows the
[LADAL concordancing tutorial](https://ladal.edu.au/tutorials/concordancing/).

**Controls.** The panel is titled Concordance Lines and has a Search section
with a query box, Search button (Enter searches too), examples, a match type
selector (Fixed, Glob, Regex), a Case sensitive checkbox, and a context window
slider in words per side, 1–15, default 5.

**Matching.** Fixed searches for the literal query, Glob treats `*` as any
sequence and `?` as any single character, and Regex uses JavaScript regular
expression syntax. The pattern is compiled with `g`, plus `i` unless *Case
sensitive* is selected. A zero-length match advances the index by one rather
than looping forever. An invalid regex reports the engine's own message next
to the query box and leaves the previous results alone.

**Context.** Take the raw text either side of the match, split on whitespace,
and keep the last N words on the left and the first N on the right. Character
slicing then word trimming, rather than tokenising each document up front:
same window, far less work, and it keeps the keyword exactly as it appeared.

**Results.** A table of source, speaker, left context, keyword, right context.
Sort by left or by right context (the two orderings a concordance is read in),
and copy or save as CSV with those five columns. Results are vertically
scrollable. At most 2000 rows are rendered, with the count stating both
numbers when it is capped — exports carry every match.

**Testable seam.** `search(documents, query, options) → rows`, pure and
exported: matching, context windows, the zero-length guard and the regex
failure path are all reachable without a DOM.

---

## ngrams

Contiguous word sequences ranked by frequency, with association measures for
bigrams. Follows the [LADAL collocations
tutorial](https://ladal.edu.au/tutorials/collocations/collocations.html).

**Controls.** N-gram size 1–5 (default 2), minimum frequency (default 2), an
Analyze button, case-sensitive and remove-stopwords checkboxes, and a filter
box that narrows the rendered rows without recomputing.

**Tokenising.** Letters, marks and digits, with an optional internal apostrophe
or hyphen: `/[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu`. Punctuation is
dropped rather than kept as a token. **This differs from chaos2crate's
`[A-Za-z0-9]+`**, which silently drops every non-ASCII letter — unusable for
the orthographies this tool exists to serve. Lowercased unless *case sensitive*.

**Counting.** Every n-gram, plus every unigram and the token total regardless
of `n`, since the bigram measures need them. **An n-gram never spans two
documents**: each entry is its own utterance or line, so the window slides
within one and stops at its end. Rows below the minimum frequency are dropped,
as are rows containing a stopword when that option is on.

**Association measures**, bigrams only, where `O` is the pair's count, `f1`/`f2`
the two words' unigram counts and `N` the token total:

```
expected = f1 * f2 / N
MI       = log2(O / expected)          # null when expected is 0
t-score  = (O - expected) / sqrt(O)
```

The tutorial's third measure, log-ratio, is `log2((O/N)/(E/N))` — algebraically
identical to `log2(O/E)`, the same number as MI — so it is not offered as a
separate column.

**Stopwords.** A short list of English function words, enough to take `the of a`
out of a frequency list. It is English and nothing else, so **the option
defaults to off and is labelled "Remove English stopwords"** — the opposite of
chaos2crate, where it defaults on. Dropping `ngu`, `kari` or `yi` from an
Australian language corpus because they collide with an English list is a worse
failure than a noisy first page of results, and it is invisible to whoever hit
Analyze.

**Results.** A table of n-gram and count, plus MI and t-score columns when
`n` is 2; sort by frequency, and by MI or t-score when those columns exist.
Copy or save as CSV — `ngrams-n<N>.csv` — carrying whichever columns are shown.
Same 2000-row render cap and full-set export as the concordance.

**Testable seam.** `analyzeNgrams(documents, options) → rows`, pure and
exported: counting, the document boundary, the frequency and stopword filters,
and both measures against hand-worked numbers.

---

## chart

The tabular chart that is the Visualise page today: pick a CSV, pick a chart
type and two columns, get an SVG.

**Controls.** A select naming the tables in `ctx.tables` — a chosen directory
can hold many CSVs and a chart draws one at a time — then chart type (bar, line,
scatter) and two column selects, category/x and value/y, populated from that
table's header. The panel picks among what is loaded; it does not browse the
folder.

**Rendering.** Hand-built SVG, no chart library: axes, ticks, and one mark per
row. Bars for `bar`, a polyline for `line`, circles with a larger invisible hit
target for `scatter`. Non-numeric values in the y column are skipped rather
than coerced to zero, and the panel says how many rows it skipped — a column of
`"n/a"` silently plotting as a floor of zeroes is a chart that lies.

**Below the chart**, the chosen table as a plain data table, so the numbers
behind a shape are one glance away.

**Empty state.** When `ctx.tables` is empty — the chosen directory holds text
but no CSV, or nothing is chosen yet — the panel says which option produces
tabular output rather than just reporting nothing.

**Testable seam.** The scale and tick arithmetic — the part that is wrong in
silence — as a pure function over `{ rows, xColumn, yColumn, width, height }`,
returning the positions the SVG is drawn from. The drawing itself stays
untested, as DOM.

---
