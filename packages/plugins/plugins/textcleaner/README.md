# TextCleaner plugin

The `textcleaner` plugin provides a batch text cleaning and normalization tool
in collection2crate's **Process** pane. It is a browser-based JavaScript
implementation of LADAL's `TextCleaner` Shiny application from the
[SLCLADAL/tools repository](https://github.com/SLCLADAL/tools/tree/main/textcleaner).

Source inspiration:

- [SLCLADAL/tools](https://github.com/SLCLADAL/tools)
- [TextCleaner: LADAL Text Cleaning Tool](https://github.com/SLCLADAL/tools/tree/main/textcleaner)
- [LADAL Tutorial: String Processing in R](https://ladal.edu.au/tutorials/string/string.html)

## What it does

The tool allows researchers to clean and standardize plain-text files
(`.txt`) in the currently selected collection folder using pre-built one-click
cleaning options, custom regular expression removals, and configurable
find-and-replace rules.

Unlike standalone web tools that require uploading files, this plugin works
directly with the folder selected in collection2crate:

1. **Folder and file selection:** scan the collection folder (or choose a
   subfolder) to discover text files. Select all files or specific subsets to
   clean.
2. **Pre-built removal options:** one-click checkboxes for:
   - XML / HTML tags (`<[^>]*>`)
   - Non-alphanumeric characters except spaces (`[^\p{L}\p{N} ]`)
   - Punctuation (`[^\p{L}\p{N}\s]`)
   - Numbers / digits (`\d+`)
   - URLs (`https?://\S+|www\.\S+`)
   - Email addresses (`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+[.][a-zA-Z]{2,}`)
   - Speaker labels (`(\[[A-Z0-9_]+\]\s*:?|<[A-Z0-9$_-]+>\s*(<#>\\s*)?)`)
   - Extra whitespace (collapses runs of spaces/tabs to a single space,
     reduces 3+ newlines to double newlines, and trims each line)
3. **Case conversion:** convert text to lowercase.
4. **Custom regex removals:** multi-line patterns applied in sequence,
   removing matches.
5. **Find → Replace rules:** arbitrary find-and-replace pairs supporting
   regex or fixed matching, case-sensitive or case-insensitive flags, and regex
   capture group replacement (`$1`, `$2`, etc.).
6. **Live side-by-side preview:** inspect any chosen file's original text
   versus its cleaned output with character reduction statistics before
   modifying files.
7. **Destination folder & RO-Crate routing:** select or create a destination
   folder (e.g., `cleaned/` or `_outputs/cleaned/`) to receive the cleaned
   files—either writing new copies while preserving filenames or moving/migrating
   the files so that collection2crate crate builders (`generic-input`,
   `ro-crate-json-output`) can index and include the cleaned text files as
   primary data entities in the generated RO-Crate.
8. **Batch cleaning & summary:** execute the pipeline across all selected
   files with a change summary table (original characters, cleaned characters,
   characters removed, percentage reduction).

## Profile compatibility

TextCleaner is a generic plugin designed for all collection2crate profiles.
It does not depend on specific transcript conventions or tabular schemas,
making it suitable for any corpus or text collection project.

## Implementation

The plugin runs from the **Process** pane as an interactive action modal (similar
to `transcript-grammar`), operating directly outside or between build runs:

- Pure engine: `cleanText(text, options)` and `calculateReductionStats(original, cleaned)`
  perform text transformations and metric calculations deterministically,
  allowing thorough automated testing without a DOM.
- Host integration: file reads and writes go through collection2crate's
  injected `deps` (`readFileTextFromDirectory`, `writeFileAtPath`, `openModal`),
  respecting the browser File System Access API without Node.js `fs` dependencies.
- Configuration persistence: cleaning presets and rule sets can be saved to
  and restored from `_config/textcleaner/` inside the collection folder.

## Citation

Schweinberger, Martin. (2026). *TextCleaner: A browser-based text cleaning tool*.
Brisbane: The University of Queensland. Language Technology and Data Analysis
Laboratory (LADAL). <https://ladal.edu.au/tools.html>
