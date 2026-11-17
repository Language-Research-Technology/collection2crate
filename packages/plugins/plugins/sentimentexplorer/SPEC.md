# SentimentExplorer plugin specification

Implement a visualisation-only plugin named `sentimentexplorer`. It is the
JavaScript counterpart of LADAL's `SentimentExplorer` Shiny app in
the [SLCLADAL/tools repository](https://github.com/SLCLADAL/tools), specifically
the [SentimentExplorer section](https://github.com/SLCLADAL/tools#-sentimentexplorer--nrc-word-emotion-sentiment-analysis).

## Plugin contract

- Export `createPlugin()` from `index.js`.
- Return `{ name: "sentimentexplorer", visualisation: { ... } }`.
- The plugin must declare no hooks and must not run during a build.
- The visualisation label should be `Sentiment Explorer` and its hint should
  explain that it annotates text with the NRC word-emotion lexicon and
  summarises the result per section.
- Implement the pure analysis functions as exported functions, preferably
  `annotateSection(words, sectionName, lexicon)` and
  `buildSummary(annotatedRows)`, so the counting and percentage behavior can
  be tested without a DOM.
- Read the host-provided `ctx.documents`; do not upload files or read the
  filesystem directly.
- Tokenise the same way as the other panels here (Unicode-aware words, not
  `[A-Za-z0-9]`), lowercased unconditionally — the R app always lowercases
  before matching, and there is no case-sensitivity option to preserve.

## The NRC lexicon

The analysis is driven entirely by the NRC Word-Emotion Association Lexicon
(Mohammad & Turney, 2013): a table mapping a word to zero or more of ten
categories — `anger`, `anticipation`, `disgust`, `fear`, `joy`, `sadness`,
`surprise`, `trust`, `negative`, `positive`. A word can belong to several
categories at once (e.g. "excellent" → `joy`, `positive`, `trust`); a word
absent from the lexicon belongs to none.

The NRC lexicon has licensing terms separate from this repository's software
license and must not be redistributed as bundled plugin data. The panel must
make the data download an explicit user action:

- Do not commit a copy or converted representation of the NRC data in this
  repository.
- Explain in the panel that the lexicon is kept out of the repository because
  its data licensing terms differ from the software licence.
- Identify Saif M. Mohammad as the lexicon's author and link the publication
  DOI `10.1111/j.1467-8640.2012.00460.x`.
- Provide a **Load NRC lexicon** button. When clicked, fetch `nrc_lexicon.csv`
  from
  `https://raw.githubusercontent.com/SLCLADAL/tools/main/sentimentexplorer/nrc_lexicon.csv`
  and load the fetched data into memory for analysis in the current browser
  session only. Do not trigger a file download or write the data to disk.
- Keep the **Analyse** button disabled until the lexicon has loaded and passed
  validation. If loading fails, keep it disabled and explain that the user
  can retry the load action.
- Show the required order clearly: **Load NRC lexicon** → **Analyse**.
- The data file is a CSV with `word` and `sentiment` columns. Map each word to
  its set of categories; a word may have multiple rows and categories.
- If the fetch or validation fails, show an actionable error and do not analyse
  until a valid lexicon is available. Keep a direct link to the
  LADAL source file available as a fallback.
- State the lexicon's terms: free for research and educational use; commercial
  use requires permission from the lexicon's author. Link to
  `https://saifmohammad.com/WebPages/NRC-Emotion-Lexicon.htm` for the lexicon
  information and citation.

## Controls

The panel should provide:

1. **File selector.** A multi-select listing every available source file, all
   selected by default (every loaded file is a section unless narrowed down).
   The selected sources limit every downstream step (sections, tokenisation,
   analysis) to their documents.
2. **CSV/TSV column selector, one per selected table.** For each currently
   selected file that is a CSV or TSV table, show its own multi-select
   listing that table's columns — not one shared list — so two selected
   files can each contribute a different named column (e.g. file A's `note`,
   file B's `translation`). Each selected column's cell values are joined per
   row to build that row's text; select that table's own `text` column by
   default when it has one, otherwise select every column of that table.
   Hide the whole column area when no selected file is tabular. Selecting a
   table source (with or without a column change) collapses that file's rows
   into documents that all share one `source` — the file name — so by
   default they form a single section. This plugin's own
   `documentsForSelection(documents, tables, sources, columns)` accepts a
   single source or an array of sources for `sources`, and for `columns`
   accepts either an array (the same column names applied to every selected
   table, matching `collocation`'s function of the same name for a single
   source) or a `Map<source, string[]>` for per-file column selection.
3. **Section assignment.** Every distinct source in the *current* working
   document set (i.e. after the file/column selection above is applied)
   starts as its own section, named after that source. Show one text input
   per such source so a person can rename a section, or give two or more
   sources the same name to merge them into one section before analysis —
   mirroring the R app's per-file section-name inputs, adapted to
   per-source-file rather than per-upload. Changing the file or column
   selection rebuilds this list and discards any previous analysis, since it
   no longer describes the same working documents.
4. **Category filter.** Checkboxes for the ten NRC categories, all selected by
   default, controlling which columns/series the chart, summary table and
   token table show. It filters what is displayed, not what is computed.
5. **Run button** ("Analyse" or similar). Do not recompute on every keystroke
   or checkbox change to the section names; recompute the annotation when
   pressed. The category filter may re-render existing results without a
   fresh Run, since it only changes what is displayed.

The panel should clearly report: no documents loaded, the lexicon failed to
load, and a valid run that annotated zero tokens.

## Tokenisation and corpus

For each section, concatenate the text of every document whose source maps to
that section, in document order, then tokenise into Unicode-aware words
(same token pattern as `ngrams`/`collocation`: `\p{L}\p{M}\p{N}` with an
optional internal apostrophe or hyphen), lowercased unconditionally.

Sections are independent corpora: a token index only orders words within its
own section, and no token crosses a section boundary.

## Per-token annotation

For each section, produce one row per token:

`section`, `token_index` (1-based position within the section), `word`, and
one column per NRC category holding `1` if the lexicon lists that word under
that category, else `0`. A word not in the lexicon has every category column
`0`.

## Summary

For each section, produce one row with:

- `section`
- `total_tokens` — the token count for that section
- for each of the ten categories: a count of tokens where that category is
  `1`, and that count as a percentage of `total_tokens` (rounded to one
  decimal place, matching the R app)

## Results panel

After a run, show stat chips: number of sections, total tokens across all
sections, and the number and percentage of tokens matching at least one
category. Provide:

- A bar chart, one facet/section per group, showing each visible category's
  percentage of that section's tokens, following this repo's existing
  hand-built DOM/SVG approach (no chart library — see `chart` and
  `collocation` for precedent). Each bar's label should show both the count
  and the percentage, as the R app's does.
- A summary table: one row per section, with total tokens and, for each
  visible category, its count and percentage columns.
- A token table: one row per token, showing its section, token index, word,
  and a 1/0 (or clearer visual equivalent) for each visible category.
  Sortable and filterable, as the other panels' result tables are.
- A citation panel or note pointing to the NRC lexicon citation (Mohammad &
  Turney, 2013, DOI `10.1111/j.1467-8640.2012.00460.x`) and this tool's own
  citation, since the lexicon's license requires attribution.
- A parameter view recording the section names and their source mappings,
  and the selected categories, for reproducibility.

Use the host vocabulary from `src/_panel.js` and the shared CSV helpers in
`src/_csv.js`. Do not write analysis output into the selected crate output
directory — visualisation results are copied or downloaded, never filed as
crate content (SPEC-PLUGINS.md).

## Exports

Following this repo's other visualisation panels (no Excel dependency here):

- Copy or download the summary table as CSV.
- Copy or download the full token table as CSV — every row, not only what is
  rendered.
- Download the analysis parameters as a plain-text record.
- Chart image export (PNG/PDF) is optional and only worth adding if the
  chosen rendering approach supports it cleanly; otherwise leave it as a
  documented follow-up rather than shipping a misleading export.

## Testable seam

Add focused tests, once implemented, for:

- Unicode tokenisation and unconditional lowercasing.
- A word mapping to multiple categories at once.
- A word absent from the lexicon annotating as all zeros.
- Per-section token indexing that never crosses a section boundary.
- Merging two sources into one section by matching section names.
- Summary counts and percentages against hand-worked small examples.
- The missing-lexicon state producing no analysis and a clear message.
- `documentsForSelection`: `All files` returns every document unchanged; a
  plain-text/CHAT source is filtered by source; a CSV/TSV source combines its
  selected columns per row into one document, defaulting to the `text`
  column when present.

The plugin should be registered in the package registry as
`sentimentexplorer`, matching this folder's name, the same way `collocation`
is registered next to its own visualisation implementation.
