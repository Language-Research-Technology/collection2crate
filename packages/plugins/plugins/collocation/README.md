# Collocation plugin

The `collocation` plugin provides a visualisation panel for finding words that
occur near one or more node words in a text corpus. It is a browser-based
JavaScript implementation of the collocation analysis offered by LADAL's
CollocationCalculator.

Source inspiration:

- [SLCLADAL/tools](https://github.com/SLCLADAL/tools)
- [CollocationCalculator: Collocation association measures](https://github.com/SLCLADAL/tools#-collocationcalculator--collocation-association-measures)

## What it does

The panel can analyse all loaded files or one selected source file. For CSV or
TSV files, one or more columns can be selected; their values are combined per
row before analysis. The panel also supports plain text and CHAT files through
the host's normal document loader.

Users can configure:

- comma-separated node words
- case-sensitive or case-insensitive matching
- independent left and right context windows
- minimum co-occurrence frequency
- the association measure used for ranking and the chart
- the number of top collocates shown per node

The results include observed and expected frequencies, MI, MI2, MI3,
log-likelihood (G2), t-score, Delta P12, Delta P21, and Fisher's exact-test
p-value. Results can be filtered, copied as CSV, downloaded as CSV, and saved
with the analysis parameters.

## Implementation

The plugin is visualisation-only. It does not run during crate processing or
write results into the selected crate. Its pure `analyzeCollocations()`
function performs tokenisation, window counting, and statistical calculations;
the `createPlugin()` factory exposes the interactive panel to the host.

The host supplies loaded documents and tables. The plugin does not access the
filesystem directly.

## TODO

- Validate the JavaScript tokenisation, window counts, and association-measure
	calculations against the R implementation using exactly the same corpus,
	node words, window sizes, and thresholds. Compare the complete result tables
	for numerical accuracy.
