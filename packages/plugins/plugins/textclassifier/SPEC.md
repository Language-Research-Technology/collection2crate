# TextClassifier plugin specification

Implement a visualisation-only plugin named `textclassifier`. It assigns
labels, initially themes or topics, to texts held in the rows of a loaded
table. The person defines the labels in one of two ways:

- **By description.** They write each label's name and a short description,
  and a pretrained classification model decides which labels apply to each
  text. No examples are needed.
- **By example.** They point the panel at rows that already carry labels,
  for example rows tagged by hand, and the panel learns the labels from
  those rows and applies them to the rest.

Classification runs in the browser. Texts are not sent to any server.

This first version treats each table row as one text. Later versions will
add other ways of turning rows into texts, such as windows of consecutive
conversation turns (see "Later modes").

## Where it fits

collection2crate users build tables from their RO-Crates with the `roctable`
plugin and explore them on the Visualise page. These tables are often
de-normalised: one table holds many conversations appended together, one
turn per row, with columns identifying the conversation, the speaker and
the turn's position.

Typical inputs:

- **Conversation turns.** One row per turn, from many conversations. Each
  turn is short.
- **Whole texts.** One row per text, as in the COOEE corpus of early
  Australian English. Each text can be many paragraphs long.

The panel must work on both without the person restructuring the table.

### Relation to `topicdetector`

`topicdetector` finds topics with LDA, a statistical method that groups
documents by shared vocabulary. Its topics come from word counts, and a
person names them afterwards. This plugin works the other way round. The
person decides the labels first, and the panel decides how well each text
fits them. The two panels are complementary: LDA can suggest themes worth
defining here.

## Plugin contract

- Export `createPlugin()` from `index.js`.
- Return `{ name: "textclassifier", visualisation: { ... } }` with no hooks.
  The plugin never runs during a build.
- Label `Text Classifier`. Hint: "Assign theme or topic labels to the rows of
  a table, from label descriptions or from rows already labelled."
- Read `ctx.tables` only. Rows from `.cha`, `.txt` and other non-table
  sources have no columns to carry through to results, so they are out of
  scope for the first version.
- Results are copied or downloaded as CSV through `src/_csv.js`, never
  written into the folder, as for every other panel.
- Load the model runtime and model code with dynamic `import()` when the
  person first runs a classification, not when the panel renders. This
  follows SPEC.md §10 in the host.

## Input

**Table.** A select over `ctx.tables`. One table at a time, because the
results are that table's rows with extra columns.

**Text column.** The column to classify. Default to a column named `text`
if one exists, otherwise ask. Rows whose text cell is empty are skipped and
counted.

**Columns to keep.** A multi-select of other columns to copy into the
results, such as conversation ID, speaker or turn number. Default to every
column except the text column. The results must be joinable back to the
source table, so the source row number is always included.

**Row filter (optional).** Classify only rows where a chosen column has a
chosen value, for example one speaker or one conversation. This lets a
person try their labels on a small sample before running the whole table.

## Defining labels

### By description

The person enters a list of labels, each with:

- a **name**, which appears in the results as a column header or value;
- a **description**, saying what counts as this label. This text is given
  to the model, and its wording has the largest effect on the results.

For one label per row they also enter a **question** that frames the task,
for example "Which theme is the speaker talking about?".

They choose one of two label types:

- **One label per row.** Every row gets exactly one label. The model is
  given all the labels as options and returns a probability for each, and
  the probabilities sum to 1. The panel adds a label named `none` with the
  description "none of the other labels apply" unless the person removes
  it. Without it, every row is forced into some theme even when none fits.
- **Any number of labels per row.** For each label, the model judges
  whether the statement "The text is about <name>: <description>." is true,
  and returns the probability that it is. The question that frames the task
  is not used, and there is no `none` label: a row that matches no label
  simply gets none. A row is given every label whose probability is
  at or above a threshold. The default threshold is 0.5, and it can be set
  per label. This is the right type when a passage can be about several
  themes at once.

The label set can be saved and loaded as a JSON file, so it can be reused
across tables and shared between people. Use the host's injected file APIs
to save it under `_config/textclassifier/` in the selected folder, the way
`plots` saves its configuration.

### By example

The person chooses a column that already holds labels, for example from
hand tagging. Rows with a value in that column are the training rows.
Rows without a value are the rows to classify.

The method is not yet decided and needs an experiment first (see "Open
questions"). The candidate is:

1. compute a vector for each text with a small multilingual text-embedding
   model that runs in the browser;
2. fit a simple classifier on the training rows, such as logistic
   regression or nearest neighbours;
3. apply it to the unlabelled rows.

Whatever method is used, the panel must hold back part of the labelled rows
from training and report the classifier's accuracy on them before it
classifies anything else. A person needs to know how far to trust the
labels before using them.

## Comparing with existing labels

When the table already has a label column, the person can compare the
panel's labels with it, whichever way the labels were defined. Report:

- overall agreement: the proportion of rows where the labels match;
- per label: precision, recall and the number of rows;
- a confusion table of existing label against assigned label, for one label
  per row;
- the rows where the two disagree, as a table the person can read through.

This is how a person tests and improves their label descriptions against
rows they have already tagged by hand. Matching between existing labels
and label names is exact after trimming whitespace and ignoring case. The
panel lists any existing values that match no label name, so mismatched
spellings are visible.

## The first model: THX-01

Use THX-01 (<https://huggingface.co/doofz/THX-01>, Apache 2.0). It is a
multilingual encoder model, mmBERT-base with a small decision layer on
top, 322 million parameters in total. It is trained to answer
multiple-choice and yes/no questions about a text and to return calibrated
probabilities. "Calibrated" means a probability of 0.8 should be correct
about 80% of the time.

An experiment on 2026-10-14 established the following. The conversion
scripts are in `tools/`: `export_onnx.py`, then `quantize_web.py 8`.

- The model was converted to ONNX and runs in Chrome with `onnxruntime-web`.
  The tokenizer runs through the `PreTrainedTokenizer` class from
  `@huggingface/transformers`, constructed from the model's `tokenizer.json`
  and `tokenizer_config.json`.
- The model's own Python code for building inputs and reading outputs was
  ported to JavaScript, about 200 lines. Token IDs and option positions
  match the Python code exactly.
- Size. The full-precision model is 1.3 GB. The version to ship is 345 MB:
  - the vocabulary table is stored as 8-bit integers, with one scale per
    row;
  - the other weights are 8-bit, using `MatMulNBits`.

  Probabilities from this version are within 0.02 of the full-precision
  model on the test texts. Two other approaches did not work:
  - Standard dynamic 8-bit quantisation changed which label won.
  - 4-bit quantisation of the vocabulary table uses the
    `GatherBlockQuantized` operator, which `onnxruntime-web` does not
    support.
- Speed on an Apple M4 Max, for 4 questions about one text of about 150
  words:
  - WebGPU: about 90 ms.
  - CPU, multi-threaded WASM: about 0.5 s.
  - CPU, single-threaded WASM: about 3.6 s.

Cautions to state in the panel:

- THX-01 was published by an organisation with no other track record. Its
  benchmark results are its authors' own and have not been checked
  independently. The panel must not present its labels as reliable without
  a comparison against hand-labelled rows.
- Its authors report weak results when labels overlap in meaning: 44.6%
  accuracy on a six-way emotion task. Theme labels for conversations may
  overlap in the same way.
- It was trained mostly on modern business text: support tickets, emails
  and invoices. How well it handles conversation transcripts, historical
  English or Australian languages is unknown.

**Loading.** The model is downloaded only when the person asks, with a
**Load model** button that states the download size, followed by a progress
bar. The browser keeps it with the Cache API, so later sessions do not
download it again. Use WebGPU when the browser offers it, otherwise WASM,
and show which one is in use.

**Hosting.** The converted model files must be hosted somewhere the panel
can fetch them from, with the original licence and attribution.

## Swappable models

THX-01 is the first model, not a fixed part of the plugin. It will be
possible to replace it, or offer several models side by side, without
changing the panel. To allow this:

- Each model is described by one entry in a model list (`models.js`): an
  ID, a display name, which way of defining labels it serves ("by
  description" or "by example"), its file URLs, download size, licence and
  attribution, and the function that loads it.
- A loaded model exposes one interface to the panel. For "by description"
  this is `classify(texts, labelSet) → probabilities per text per label`.
  The panel does not know how the model builds its input or reads its
  output; THX-01's input format lives in its own module.
- When the list has more than one model, the panel shows a model select.
  The settings record and the export name the model used, so results from
  different models can be compared.
- The model URL comes from the list entry, so a deployment can point at
  its own copy of the files.

## Long texts

The model reads at most 1024 tokens per question, and that limit includes
the question and the label descriptions. With a typical label set, about
700 tokens are left for the text, roughly 500 English words. Conversation
turns fit easily. Many COOEE letters do not.

For the first version:

- text beyond the limit is cut off, as the model's own code does;
- every result row has a `truncated` column, true when this happened;
- the panel reports how many rows were cut off before and after a run.

A long-text mode is listed under "Later modes".

## Later modes

Not part of this version. Listed so the first version's design does not
rule them out:

- **Windows of rows.** Classify a turn together with the turns around it,
  within one conversation. A column identifies the conversation, and a
  column or the row order gives the sequence. Consecutive turns with the
  same label then become regions of a conversation.
- **Long texts in parts.** Split a text that is over the limit into parts,
  classify each part, and combine the results per row.
- **Locating passages.** THX-01 can also return a verbatim passage of the
  text in answer to a question, with its character offsets. That code has
  not been ported to JavaScript yet.

## Controls

In this order:

1. Table, text column, columns to keep, and the optional row filter.
2. Labels: "by description" or "by example", and their inputs as above.
   For "by description": the question, the label type, and the label list
   with name, description and, for any number of labels per row, a
   threshold.
3. **Load model**, then **Classify**. **Classify** stays disabled until the
   model has loaded. While a run is in progress, show a progress bar with
   rows done, rows total and the estimated time left, and a **Stop**
   button. Stopping keeps the results for the rows already done.
4. Optional comparison column (see "Comparing with existing labels").

Changing the table, the column choices, the filter or the labels clears
earlier results. The previous results no longer describe the current
settings, so they should not stay on screen.

## Results

- A table with one row per classified source row. It contains:
  - the source row number;
  - the kept columns;
  - the text, shortened for display;
  - the assigned label or labels;
  - one probability column per label;
  - the confidence;
  - `truncated`.
- The number of rows assigned each label, as a bar chart drawn with plain
  SVG, as `chart` does, and as a table.
- The comparison results, when a comparison column is chosen.
- A record of the settings used for the run: table, columns, filter,
  label set, label type, thresholds, model version and backend. The record
  is there so a result can be reproduced.

At most 2000 rows are rendered. The count states both numbers when it is
capped. Exports include every row.

## Exports

- The results table as CSV, with every row and every probability column:
  `textclassifier-<table name>.csv`.
- The comparison's disagreement rows as CSV.
- The label set as JSON.
- The settings record as plain text.

## Host requirements

Multi-threaded WASM needs the page to be served with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. collection2crate is deployed
on GitHub Pages, which cannot set response headers. Without them, a
browser with no WebGPU runs about seven times slower. See "Open questions".

## Testable functions

Pure, exported, testable without a DOM or a model:

- `rowsForSelection(table, { textColumn, keepColumns, filter })`: the texts
  to classify, the skipped empty rows, and the kept values.
- `buildSequence(encode, text, question)` and `probabilities(logits,
  qtype)` in `thx01.js`: input construction and probability calculation,
  checked against `thx01.fixture.json`, which `tools/make_fixture.py`
  writes by running the model's own Python code.
- `assignLabels(scores, labelSet)`.
- `compareLabels(assigned, existing)`: agreement, per-label precision and
  recall, the confusion table and the disagreement rows, checked against
  hand-worked numbers.
- `resultsTable(...)`: the export rows and columns.

One test needs the model and a browser and does not belong in `npm test`.
It runs the reference texts through the converted model and checks the
probabilities against the Python output.

## Open questions

1. **Hosting the model files**: our own Hugging Face repository, a GitHub
   release, or alongside the deployed app. 345 MB is too large for the
   GitHub Pages site itself.
2. **The CPU fallback on GitHub Pages**: accept single-threaded WASM,
   require WebGPU, or use a service worker that adds the cross-origin
   headers. A common package does this (`coi-serviceworker`), but it
   affects every other part of the host.
3. **Method for "by example"**: needs an experiment on hand-tagged data.
   Compare an embedding model plus a simple classifier against THX-01 given
   the same labels by description.
4. **Test data**: openly licensed conversation data with hand-tagged themes,
   and COOEE. Both are still to be found.
5. **The size of a typical run.** The model makes one pass per row for one
   label per row, and one pass per row per label for any number of labels.
   At about 22 ms per pass on WebGPU, 10,000 turns with 10 labels is about
   40 minutes. That is acceptable for an occasional run but may need
   batching across rows, or a cap, for larger tables.
