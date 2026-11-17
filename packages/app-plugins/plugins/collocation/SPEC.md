# Collocation plugin specification

Implement a visualisation-only plugin named `collocation`. It is the JavaScript
counterpart of LADAL's `CollocationCalculator` Shiny app from the
[SLCLADAL/tools repository](https://github.com/SLCLADAL/tools), specifically
the [CollocationCalculator section](https://github.com/SLCLADAL/tools#-collocationcalculator--collocation-association-measures).

## Plugin contract

- Export `createPlugin()` from `index.js`.
- Return `{ name: "collocation", visualisation: { ... } }`.
- The plugin must declare no hooks and must not run during a build.
- The visualisation label should be `Collocations` and its hint should explain
  that it finds words associated with one or more node words in a token window.
- Implement the pure analysis function as an exported function, preferably
  `analyzeCollocations(documents, options)`, so the statistical behavior can be
  tested without a DOM.
- Read the host-provided `ctx.documents`; do not upload files or read the
  filesystem. Each document has `text`, and may have `source` and `speaker`.
- Treat the corpus as one token stream, matching the R app's concatenation of
  uploaded files. This intentionally differs from the N-gram plugin, whose
  n-grams stop at document boundaries.

## Controls

The panel should provide:

1. **File selector:** choose whether the corpus is built from `All files` or
  from one specific source file. This controls which loaded documents are
  passed to the collocation calculation; changing it must not reload files.
2. **CSV/TSV column selector:** when a CSV or TSV file is selected, show a
  multi-select list of its columns. The selected columns determine which cell
  values are used as text, with values from multiple selected columns joined
  together for each row. Select the `text` column by default when it exists;
  otherwise select all columns. Hide this control for non-tabular files and
  when `All files` is selected.
3. A comma-separated node-word input. Trim empty entries. With case-insensitive
   matching, lowercase both the parsed nodes and corpus tokens.
4. An `Ignore case` checkbox, on by default.
5. Independent integer inputs for left span and right span, each defaulting to
   5 and constrained to 1-20.
6. A minimum co-occurrence count, defaulting to 2 and constrained to at least 1.
7. A top-N value for the chart, defaulting to 20 and constrained to 5-100.
8. A plot-measure selector containing `OE`, `MI`, `MI2`, `MI3`, `G2`, `tscore`,
   `DeltaP12`, `DeltaP21`, and `Fisher`, defaulting to `DeltaP12`.
9. A Calculate button. Do not recompute after every keystroke; calculate from
   the current controls when it is pressed.

The panel should clearly report missing text, missing node words, invalid or
empty input, and a valid analysis that found no qualifying collocates.

## Tokenisation and corpus

Tokenise text using Unicode-aware words, equivalent to the R app's
`stringi::stri_extract_all_words`. Preserve letters and marks from non-English
orthographies and do not use `[A-Za-z0-9]`. Lowercase tokens when `ignoreCase`
is true. Concatenate all document token arrays in document order with no
boundary marker.

For each node word, find every token position. For every occurrence, collect
up to `spanLeft` tokens immediately to its left and `spanRight` tokens
immediately to its right, excluding the node token itself. A token can be
counted more than once for a node when it falls in the window of multiple node
occurrences, matching the R implementation. Do not treat the node itself as a
collocate at its own position.

The result must contain one row per `(node, collocate)` pair whose observed
window count `O` is at least `minFreq`. A collocate may occur in results for
multiple nodes. Node words that do not occur produce no rows.

## Statistics

Let:

- `N` be the total number of corpus tokens.
- `f_node` be the corpus frequency of the node.
- `f_collocate` be the corpus frequency of the collocate.
- `O` be the observed window co-occurrence count.
- `E = (f_node * f_collocate) / N`.

Return these columns in this order:

`node`, `collocate`, `O`, `E`, `f_node`, `f_collocate`, `N`, `OE`, `MI`,
`MI2`, `MI3`, `G2`, `tscore`, `DeltaP12`, `DeltaP21`, `Fisher`.

Compute:

- `OE = O / E`
- `MI = log2(O / E)`
- `MI2 = log2(O^2 / E)`
- `MI3 = log2(O^3 / E)`
- `G2`, the log-likelihood ratio for the 2x2 table below
- `tscore = (O - E) / sqrt(O)`
- `DeltaP12 = O / f_node - (f_collocate - O) / (N - f_node)`
- `DeltaP21 = O / f_collocate - (f_node - O) / (N - f_collocate)`
- `Fisher`, the two-tailed Fisher exact-test p-value for the same table

The contingency table is:

```text
              collocate  not collocate
node              a=O       b=f_node-O
not node          c=f_collocate-O
                              d=N-f_node-f_collocate+O
```

Clamp `b`, `c`, and `d` at zero when rounding or numerical edge cases would
make them negative, as the R implementation does. For G2, use
`2 * sum(observed * log(observed / expected))`, treating a zero observed or
expected cell as contributing zero. For Delta P denominators, use a nonzero
fallback of 1 when the complement count is zero, matching the R app.

JavaScript has no built-in Fisher exact test. Add a small, tested implementation
or a maintained dependency. It must return the two-tailed p-value and should
use a documented large-table strategy so the UI remains responsive. The R app
uses simulated p-values for tables whose total exceeds 2000; choose and document
an equivalent deterministic or approximate strategy for the browser.

Round display/export numeric measures to four decimal places, but keep full
precision in the pure result if that makes sorting more accurate. Use `null` for
undefined statistical values rather than `Infinity` or `NaN`.

## Results panel

After calculation, show summary counts for total tokens, number of node words,
and number of result rows. Provide:

- A sortable/filterable results table containing every qualifying row.
- Default sorting by the selected plot measure, descending, with null values at
  the end.
- A measure guide describing all nine measures and the variables `O`, `E`,
  `f_node`, `f_collocate`, and `N`.
- A parameter view showing the node words, spans, minimum frequency, top-N,
  selected measure, and case setting for reproducibility.
- A bar chart with one facet or clearly grouped section per node, showing the
  top N collocates for the selected measure. Exclude null values and state the
  window, threshold, and corpus token count in the chart context. A chart is
  optional for the first implementation only if the result table remains fully
  usable; the intended feature is parity with the R app and includes the chart.

Use the host vocabulary from `src/_panel.js` and existing shared CSV helpers.
Do not write analysis output into the selected crate output directory.

## Exports

Provide actions for:

- Copying the complete result table as CSV.
- Downloading the complete result table as
  `collocations-YYYY-MM-DD.csv` (or an equivalent date-stamped filename).
- Downloading parameters as a plain-text record.
- Downloading the chart as PNG and PDF only if the chosen browser-side chart
  implementation supports reliable export; otherwise keep chart export as a
  documented follow-up rather than producing a misleading file.

The CSV must include all 16 result columns, not only the rendered rows. Escape
fields through `src/_csv.js`.

## Testable seam

Add focused tests for `analyzeCollocations` covering:

- Unicode tokenisation and case-insensitive node matching.
- Comma-separated nodes and missing nodes.
- Independent left/right windows, including corpus edges.
- Repeated node occurrences and counts that can overlap.
- Minimum-frequency filtering and no-result output.
- All association measures against hand-worked small tables.
- Stable handling of zero denominators and null statistical values.
- Fisher p-values against known 2x2 tables.
- Full result-column order and numeric rounding/export behavior.

The plugin is registered in the package registry as `collocation` already; keep
that registry entry when replacing the placeholder with the visualisation
implementation.
