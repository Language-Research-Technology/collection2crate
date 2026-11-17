# TextCleaner plugin specification

Implement a generic text processing plugin named `textcleaner`. It is the
JavaScript counterpart of LADAL's `TextCleaner` Shiny application from the
[SLCLADAL/tools repository](https://github.com/SLCLADAL/tools/tree/main/textcleaner).

## Scope and plugin contract

- Export `createPlugin(deps)` from `index.js`.
- Return `{ name: "textcleaner", optionSchema: { ... } }`.
- The plugin belongs to the **Process** pane in collection2crate (alongside
  `transcript-grammar`, `ca-data-prep`, etc.), not the Visualise pane. It is
  invoked directly from an action tile on the Process page outside or between
  build runs.
- **Generic plugin:** Available to all collection2crate profiles without profile
  restrictions or schema prerequisites.
- **No file upload needed:** The user has already selected a collection folder
  (`dirHandle`) in collection2crate. The plugin works directly on files within
  that directory handle.
- Host dependencies received via `deps`:
  - `openModal`: host modal dialog system for the interactive cleaner interface.
  - `readFileTextFromDirectory`: reads file content by relative path from `dirHandle`.
  - `writeFileAtPath`: writes cleaned files and configuration to `dirHandle`.
- **RO-Crate integration:** Cleaned files can be written or moved into a
  user-selected destination folder (e.g., `cleaned/` or `_outputs/cleaned/`)
  within the collection folder so that collection2crate builders (`generic-input`,
  `ro-crate-json-output`, etc.) can include them as primary text data entities
  in the generated RO-Crate.
- Saved configurations and presets live at `_config/textcleaner/<name>.json`
  under the collection folder, following collection2crate's standing
  configuration convention (`_config/<plugin>/`).

## File and folder discovery (source and destination)

The tool operates on plain-text files (defaulting to `.txt`, with optional
support for `.text` or `.md`) within the selected collection folder:

1. **Source folder scope selector:** allow the user to target the root collection
   folder or a specific subfolder containing raw files (e.g., `transcripts/`,
   `texts/`, `raw/`). The scanner enumerates directories under `dirHandle` to
   populate the selector.
   The scan skips dot-folders, `node_modules`, `_config` and `_backups`.
2. **File scanner & checklist:** enumerate matching text files in the selected
   source scope. Provide checkboxes for each file, with **Select all** and
   **Deselect all** shortcuts, plus a badge showing the number of selected files.
   An **Include subfolders** checkbox widens the scope to the selected folder's
   descendants. A **Refresh** button rescans the collection folder for added,
   renamed or removed files and keeps the current scope when it still exists.
3. **Destination folder:** a text input for the folder where cleaned files will be
   written or moved (e.g. `cleaned/`, `texts/`, `_outputs/cleaned/`). An empty
   value outputs into the source folder.
4. If no text files are present in the chosen source directory, show a clear empty
   state advising the user to choose a different folder.

## Output destination, file routing, and RO-Crate inclusion

A central motivation for TextCleaner in collection2crate is preparing cleaned text
files so that they can be included in the collection's RO-Crate (e.g., as corpus
text entities, inputs for downstream processors such as concordance and n-grams,
or published dataset resources).

### 1. Destination folder selection

The UI provides a dedicated **Destination folder** text input:
- A relative path typed by the user (default: `cleaned/`, or alternatively
  `_outputs/cleaned/`). The folder is created if it does not exist.
- Leaving it empty writes alongside the source files (use suffix or prefix naming).

### 2. File placement and movement mode

The user selects how files are handled between source and destination:

- **Write cleaned copies (copy mode, default):** Writes the cleaned text into
  the chosen destination directory while preserving the original raw files
  intact in the source directory.
- **Move to destination (migration mode):** Writes the cleaned files into the
  destination directory and deletes the original raw files from the source
  folder (or moves raw files to an archive subfolder like `_archive/raw/`),
  ensuring the collection retains only the cleaned files.
- **Overwrite in place:** Replaces the source files with cleaned content in
  their current location. The UI requires explicit confirmation before executing.

### 3. File naming in destination

- **Preserve original filenames (recommended for dedicated folder):**
  When writing into a dedicated destination folder (e.g., `cleaned/`), files
  retain their original filenames (`cleaned/interview-01.txt`). This allows
  RO-Crate entity IDs, metadata tables, and downstream analysis tools to
  reference the files without renaming drift.
- **Suffix mode:** Append a configurable suffix (default: `_cleaned`),
  e.g., `interview-01_cleaned.txt`. Recommended when the destination folder
  is the same as the source folder to prevent accidental overwrites.
- **Prefix mode:** Prepend a configurable prefix (default: `cleaned_`),
  e.g., `cleaned_interview-01.txt`.

### 3a. Destination must be empty

In copy and move modes with a destination folder set, the destination must be
empty (or not yet exist), so cleaned files are never mixed with existing content.

- A non-empty destination turns the step 3 panel border red, shows an error
  ("The destination folder ... is not empty. Choose a different destination
  folder, or delete that folder and press Refresh."), and disables the Clean button.
- The check re-runs when the modal opens, when the destination or placement
  changes, on Refresh, on preset load, and after a run.
- After a successful run the destination is naturally non-empty. It then shows a
  neutral note (no red border) saying where the cleaned files are, and the Clean
  button stays disabled until the destination is changed or emptied.
- Overwrite mode skips this check.
- A same-folder warning is shown when cleaned files would land next to their
  source files.

### 4. RO-Crate inclusion and provenance

- **Automatic discovery by crate builders:** Because the destination folder
  lives directly under `dirHandle`, collection2crate builders (`generic-input`,
  `docx-input`, `roctable`) and output plugins (`ro-crate-json-output`,
  `ro-crate-html-output`) can index the cleaned files during subsequent builds.
  For instance, placing files into `cleaned/` allows `generic-input` to include
  each `.txt` file as a `File` data entity in `ro-crate-metadata.json`.
- **Downstream Process & Visualise integration:** Downstream tools in the
  **Process** pane (e.g., `transcript-grammar`, `ca-data-prep`) and **Visualise**
  pane (concordance, ngrams, sentimentexplorer, collocation, topicdetector)
  can point directly to the destination folder as their text source.
- **Cleaning provenance manifest (optional):** The plugin can save a run
  summary JSON file at `_config/textcleaner/run-<timestamp>.json` recording:
  - Source and destination file paths.
  - Active prebuilt options, custom patterns, and find/replace rules applied.
  - Transformation timestamps and reduction metrics per file.
  This manifest provides auditability and provenance metadata that can be
  referenced in the RO-Crate.

## Cleaning engine and order of operations

The pure engine must be exported as `cleanText(text, options)` so all
transformations can be tested in Node without a browser DOM.

The pipeline executes transformations in the exact sequence established by
LADAL TextCleaner:

### 1. Pre-built removals

Support eight one-click removal options. The first seven run in fixed order,
replacing matches with empty strings (`""`):

| ID | Label | Pattern / Implementation | Description |
|---|---|---|---|
| `tags` | XML / HTML tags | `<[^>]*>` | Removes markup tags and attributes. |
| `nonalpha` | Non-alphanumeric except spaces | `[^\p{L}\p{N} ]` (Unicode flag `u`) | Preserves letters, digits, and spaces. |
| `punct` | Punctuation | `[^\p{L}\p{N}\s]` (Unicode flag `u`) | Removes non-alphanumeric, non-whitespace characters. |
| `numbers` | Numbers | `\d+` | Removes all digit sequences. |
| `urls` | URLs | `https?://\S+\|www[.]\S+` | Removes web links. |
| `emails` | Email addresses | `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+[.][a-zA-Z]{2,}` | Removes standard email addresses. |
| `speaker` | Speaker labels | `(\[[A-Z0-9_]+\]\s*:?\|<[A-Z0-9$_-]+>\s*(<#>\\s*)?)` | Removes spoken corpus speaker turn markers. |

*Note on Unicode handling:* JavaScript regular expressions must use the `u`
(or `v`) flag so that Unicode property escapes `\p{L}` (any letter) and `\p{N}`
(any number) match non-ASCII orthographies accurately.

### 2. Custom regex removals

- An array of custom regular expression patterns (entered one per line in the
  UI, trimmed of leading/trailing whitespace, ignoring blank lines).
- Each valid pattern replaces all matches with `""`.
- If a user pattern is syntactically invalid, skip it gracefully or report
  the error without halting the remaining pipeline.

### 3. Find → Replace table

- An ordered list of `{ find, replace, isRegex, ignoreCase }` rules.
- If `find` is empty or only whitespace, skip the rule.
- If `isRegex` is true:
  - Compile `RegExp(find, ignoreCase ? "gu" : "g")`.
  - Replace matches using `replace`, supporting backreferences (`$1`, `$2`, etc.).
  - Invalid regex patterns must be caught safely.
- If `isRegex` is false:
  - If `ignoreCase` is false, replace all literal occurrences of `find` with `replace`.
  - If `ignoreCase` is true, escape regex metacharacters in `find` and perform
    case-insensitive global replacement.

### 4. Convert to lowercase

- If `lowercase` is true, convert the entire string via `text.toLowerCase()`.
- Runs *after* pre-built removals and replace rules so case-sensitive patterns
  can match original casing prior to flattening.

### 5. Extra whitespace normalization and line trimming

Always executed last when `whitespace` is selected:

- Collapse runs of horizontal spaces and tabs (`[ \t]+`) into a single space `" "`.
- Collapse three or more consecutive line breaks (`\n{3,}`) into two line breaks (`\n\n`).
- Split into lines and trim whitespace from the start and end of every line.
- Join lines back with `\n`.

## Pure engine exports

Export pure helper functions from the plugin implementation:

1. `cleanText(text, options)`:
   - `options.prebuilt`: Set or Array of active prebuilt IDs (`tags`, `nonalpha`, `punct`, `numbers`, `urls`, `emails`, `speaker`, `whitespace`).
   - `options.customPatterns`: Array of regex pattern strings.
   - `options.replacements`: Array of `{ find, replace, isRegex, ignoreCase }`.
   - `options.lowercase`: boolean.
   - Returns the cleaned string.
2. `calculateStats(original, cleaned)`:
   - Computes `{ originalChars, cleanedChars, removedChars, percentRemoved }`.
3. `defaultCleaningOptions()`:
   - Returns default configuration with all prebuilt options disabled and empty tables.

## User interface and workflow

The modal dialog opened from **Clean text files…** must provide:

1. **Scope and file selection (step 1):**
   - Subfolder selector within `dirHandle` (defaulting to the collection root).
   - **Include subfolders** checkbox.
   - List of discovered `.txt`, `.text` and `.md` files with individual checkboxes,
     a counter badge, and **Select all** / **Deselect all** / **Refresh** buttons.
2. **Cleaning operations (step 2):**
   - Pre-built removal checkboxes with clear explanatory labels.
   - Lowercase checkbox.
   - Custom regex textarea (one pattern per line, monospace font).
   - Find → Replace dynamic table:
     - Input fields for `Find` and `Replace with`.
     - Checkbox for `Regex`.
     - Checkbox for `IC` (Ignore Case).
     - Remove row button (`×`) and `+ Add row` button.
3. **Live preview (step 4; step 3 is output and destination):**
   - Dropdown to select any discovered file for preview.
   - **Refresh preview** button triggering a single-file clean without writing to disk.
   - Side-by-side view showing the original text on the left and cleaned text
     on the right, with character reduction metrics banner.
4. **Output options and execution (step 3 and step 5):**
   - **Destination folder:**
     - A text input for a relative path (defaulting to `cleaned/`, or `_outputs/cleaned/`).
     - Leave empty to output directly into the source folder.
   - **Placement mode:**
     - *Write to destination (keep originals)*: writes cleaned files to target folder.
     - *Move to destination*: writes cleaned files to target folder and removes or archives raw source files.
     - *Overwrite in place*: replaces source files (shows explicit confirmation prompt).
   - **Naming mode:**
     - *Preserve original filenames* (e.g. `cleaned/interview-01.txt` — recommended for RO-Crate inclusion).
     - *Suffix mode* (e.g. `interview-01_cleaned.txt`), with an editable suffix.
     - *Prefix mode* (e.g. `cleaned_interview-01.txt`), with an editable prefix.
     - A route preview line shows the sample source path and its destination path.
   - **Execution & summary:**
     - **Clean N selected files** primary action with progress bar. When it is
       disabled, the reason (no files selected, or destination not empty) is
       shown as a hint under the button and as its tooltip.
     - A status line and a collapsible, scrollable summary table, hidden until a
       run finishes and toggled by **Show/Hide summary table**. Destination paths
       in the table are links that open the cleaned file in a new browser tab
       (browsers cannot open the OS file explorer).
     - Post-cleaning change summary table: file name, destination path, original
       characters, cleaned characters, characters removed, and percentage removed.
     - Option to save a cleaning provenance manifest (`_config/textcleaner/run-<timestamp>.json`).
5. **Presets and reproducibility:**
   - Save current cleaning configuration to `_config/textcleaner/<name>.json`
     via **Save preset as…**. Presets are only written on that action, and saving
     an existing name overwrites it.
   - A preset stores the prebuilt options, lowercase, custom patterns, replacement
     rules, destination folder, placement mode, naming mode, suffix, prefix, and
     the source folder scope (`selectedFolder`, `includeSubfolders`). Presets saved
     before scope was stored simply leave the current scope unchanged.
   - Load existing saved presets from `_config/textcleaner/` via the preset dropdown.
   - When the modal opens and presets exist, the first one is loaded and selected
     automatically. Loading a preset restores the scope only if that folder still
     exists, then reselects all files in scope and refreshes the preview.
6. **LADAL attribution:**
   - Footer attributing the tool to Martin Schweinberger and the Language
     Technology and Data Analysis Laboratory (LADAL), with link to the
     [LADAL String Processing Tutorial](https://ladal.edu.au/tutorials/string/string.html).

## Testing requirements

Provide comprehensive tests in a dedicated test suite (e.g. `textcleaner.test.mjs`):

- **Prebuilt removal tests:**
  - `tags`: strips simple and nested XML/HTML tags and attributes.
  - `nonalpha`: preserves non-English Unicode letters (`ä`, `é`, `ñ`, `ø`, etc.) and numbers while removing symbols.
  - `punct`: removes punctuation marks across ASCII and Unicode ranges while preserving letters, numbers, and whitespace.
  - `numbers`: removes integers and decimals.
  - `urls`: removes `http://`, `https://`, and `www.` URLs.
  - `emails`: removes standard email addresses.
  - `speaker`: removes speaker markers such as `[SPEAKER_A]:` and `<S1A-001$A>`.
  - `whitespace`: collapses runs of spaces and tabs, handles excessive newlines, and trims lines.
- **Custom patterns:** handles multiple custom regexes and ignores empty or invalid patterns without throwing.
- **Find/Replace rules:** verifies regex replacement with capture groups (`$1`), fixed literal replacement, and case sensitivity flags.
- **Order of operations:** verifies that replacements and removals execute before lowercase, and whitespace collapse executes last.
- **Stats calculation:** verifies character and percentage counts against known inputs.
- **Destination and path resolution:** verifies destination path computation for
  subfolder targets (`cleaned/file.txt`), source-folder targets with suffix,
  and preservation of original filenames for clean RO-Crate referencing.
- **Prefix naming:** verifies prefix mode path computation alongside suffix mode.
- **Plugin contract:** verifies `optionSchema` structure, action type, and Process-pane compatibility.
