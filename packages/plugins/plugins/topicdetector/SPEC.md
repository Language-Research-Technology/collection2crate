# TopicDetector plugin specification

Implement a visualisation-only plugin named `topicdetector`. It is the
JavaScript counterpart of LADAL's `TopicDetector` Shiny app in
the [SLCLADAL/tools repository](https://github.com/SLCLADAL/tools), specifically
the [TopicDetector section](https://github.com/SLCLADAL/tools#-topicdetector--unsupervised--seeded-lda-topic-modelling).

## Plugin contract

- Export `createPlugin()` from `index.js`.
- Return `{ name: "topicdetector", visualisation: { ... } }`.
- The plugin must declare no hooks and must not run during a build.
- The visualisation label should be `Topic Detector` and its hint should
  explain that it finds and names latent topics across documents with LDA,
  in two stages: an unsupervised exploration pass, then a seeded refinement
  pass a person guides with topic names and seed words.
- Implement the pure analysis functions as exported functions so the corpus
  building, LDA fitting and seeded-topic assignment are testable without a
  DOM — see "Pure engine" below for the exact functions expected.
- Read the host-provided `ctx.documents`; do not upload files or read the
  filesystem directly.
- Follow the same file/column selection this repo's `collocation` and
  `sentimentexplorer` plugins already provide: a multi-select of loaded
  files (all selected by default), and — for whichever selected files are
  CSV/TSV tables — one column multi-select per selected table (not one
  shared list), each defaulting to that table's own `text` column when
  present, else every column. Reuse or closely mirror
  `documentsForSelection(documents, tables, sources, columns)` from
  `sentimentexplorer/index.js`, including its `Map<source, string[]>` form
  for per-file column choices.
- Unlike `sentimentexplorer`, a document here is **one whole file** (matching
  the R app's `load_corpus`, one document per uploaded file), not a
  per-section merge of the selected sources' documents. Do not add a
  "Sections" renaming/merging step; the working document set from the
  file/column selection already **is** the corpus, one document per
  currently selected file (or, when a selected file is a CSV/TSV table with
  columns chosen, its rows become the file's document text, still counted
  as that one file's single document by concatenating all its selected rows
  — LDA operates over documents, not database rows).

## The two-stage workflow

Preserve the R app's two explicit stages and its narrative: run an
unsupervised pass to explore the corpus, use its output to seed a guided
pass, then read that guided pass's per-document topic assignments.

### Stage 1 — Unsupervised LDA

1. **Preprocessing.** Tokenise every document (Unicode-aware words, as the
   other plugins here do — not `[A-Za-z0-9]`), lowercase, and drop tokens
   that are a single character or contain no letters. Offer a stopword list
   toggle; ship at least an English list (mirroring `ngrams`' stopword
   list), defaulting **on** — unlike `ngrams`, where English-only defaults
   are explicitly off; document why: `topicmodels`/`quanteda`'s own default
   here is stopwords on, and unlike n-gram frequency counts, a person is
   about to name topics from their top terms, where "the", "and" drowning
   out content words is the more likely failure. If stemming is added, use
   a simple, tested, documented affix-stripping stemmer (e.g. a compact
   Porter-style stemmer) rather than a heavy dependency, defaulting on to
   match the R app; if a full stemmer is out of scope for a first pass,
   ship the toggle disabled and explain in-panel that stemming is not yet
   implemented rather than silently ignoring the setting.
2. **Vocabulary trimming.** Drop terms below a minimum term frequency and a
   minimum document frequency (both configurable, default `2`, matching the
   R app's `min_termfreq`/`min_docfreq`). Drop any document left with zero
   tokens after trimming, and report how many were dropped — an empty
   corpus after trimming is a validation failure, not a silent empty model.
3. **Model.** Fit a collapsed Gibbs-sampling LDA (symmetric Dirichlet
   priors, e.g. alpha = 50/k, beta = 0.1, matching common defaults) over the
   trimmed document-term counts, for a configurable `k` (number of topics,
   default 5, range 2–30) and a configurable random seed (for repeatable
   results — same seed, same sampler path, same output). Run a fixed,
   documented number of iterations (e.g. a few hundred) sufficient for the
   sampler to stabilise on realistic browser-sized corpora; note the
   iteration count as a constant a later pass can tune, not a hidden magic
   number.
4. **Output.** For each topic, the top N terms by their fitted
   topic-term weight (configurable, default 10, range 5–25), most
   probable first — the JavaScript equivalent of the R app's `beta` matrix
   top-N per topic. Also expose the full term-topic weights, since the
   panel needs them to auto-populate seed words with more than just the
   displayed top N if the seeded stage wants to fall back on them.

### Stage 2 — Seeded LDA

1. **Seed dictionary.** After stage 1 runs, show one card per topic,
   pre-filled with a generated name (`Topic 1`, `Topic 2`, …) and its
   stage-1 top terms as comma-separated seed words — editable text, exactly
   like the R app's per-topic name/seed-words inputs. A person can rename a
   topic, edit its seed words, or leave a topic with no seed words (that
   topic is dropped from the seeded run; keep at least one topic with seed
   words as a validation requirement, matching the R app's check).
2. **Model.** Using the same trimmed document-term data from stage 1 (do
   not rebuild it), assign each document a topic distribution biased toward
   its seed words: increase the effective topic-term prior weight for a
   topic's seed words for that topic, add one extra **residual** topic
   (label it `other`, matching `residual = TRUE`) with a neutral prior to
   catch content that matches no seed dictionary, and run the same style of
   Gibbs sampler to convergence. Use the same random seed control as stage
   1, defaulting to the stage-1 seed, and expose it separately if the panel
   wants to explore run-to-run variation deliberately.
3. **Output.** Per topic: its own top N terms (same N as stage 1, or its
   own control), like the R app's `top_df`. Per document: its dominant
   ("best") topic and every topic's probability for that document — a
   document-by-topic probability matrix (the R app's `theta`), rounded to 4
   decimal places for display, full precision retained in the pure result.

## Pure engine

Export at least:

- `tokenize(text)` — Unicode-aware tokenisation, following this repo's
  existing pattern (`\p{L}\p{M}\p{N}` with an optional internal apostrophe
  or hyphen), then drop single-character and no-letter tokens.
- `buildVocabulary(documentsTokens, { minTermFreq, minDocFreq, stopwords })`
  — the trimmed vocabulary and each document's filtered token list, plus
  which documents were dropped as empty.
- `fitLDA(documentsTokens, vocabulary, { k, seed, iterations, alpha, beta })`
  — runs the unsupervised collapsed Gibbs sampler; returns per-topic
  term weights (over the full vocabulary) and per-document topic
  assignments/counts, from which top terms and any other view can be
  derived.
- `topTermsPerTopic(termTopicWeights, vocabulary, n)` — the top N terms per
  topic, most probable first.
- `buildSeedDictionary(topicNames, seedWordsPerTopic)` — parses and
  validates the per-topic name/seed-words input into the structure
  `fitSeededLDA` consumes; throws (for the panel to report) when every
  topic has no seed words.
- `fitSeededLDA(documentsTokens, vocabulary, seedDictionary, { seed,
  iterations, alpha, beta, seedBoost })` — the guided pass described above,
  returning per-topic top terms and a document-by-topic probability matrix
  (including the residual `other` topic).

All of the above must be deterministic for a fixed seed (no `Math.random()`
without a seeded PRNG) — reproducibility is part of the R app's contract via
its `seed` inputs and must survive translation.

## Controls

The panel should provide, in this order:

1. File and column selection (see "Plugin contract" above).
2. Preprocessing: a stopwords toggle (default on, English list), a stemming
   toggle (documented as not yet implemented if shipped disabled — see
   Stage 1 above), minimum term frequency and minimum document frequency
   (both default 2).
3. Unsupervised LDA controls: `k` (default 5, range 2–30), a random seed
   (default any fixed constant, e.g. 1234), top terms per topic (default
   10, range 5–25), and a "Run unsupervised LDA" button.
4. The seed dictionary cards (only after stage 1 has run), pre-filled as
   described above, each independently editable.
5. A "Run seeded LDA" button, disabled or clearly explained as unavailable
   until stage 1 has produced a seed dictionary to edit.
6. Downloads (see below).

Do not re-run either stage automatically on every keystroke; only on its own
button. Changing the file/column selection after a stage has run must clear
both stages' results rather than showing stale output next to a new corpus,
matching how `sentimentexplorer` clears results on selection change.

## Results panel

Follow this repo's shared heading style (`sectionHeading`/
`.sentiment-section-heading`-equivalent — reuse or copy the small injected
stylesheet pattern) so Stage 1 and Stage 2 read as clearly separated
sections, each internally consistent with the other visualisation panels
here:

- **Stage 1 — Unsupervised LDA.** Stat chips (documents in the model,
  vocabulary size, `k`). A table of top terms per topic (one column per
  topic, one row per rank), mirroring the R app's wide `top_terms` table.
- **Stage 2 — Seeded LDA.** Stat chips (documents, topics including
  residual, documents assigned to a non-residual topic). A top-terms table
  per seeded topic. A document-assignment table: one row per document, its
  best topic, and every topic's probability column. A topic-frequency
  chart (count and percentage of documents per topic, following this
  repo's existing hand-built DOM/SVG bar approach — no chart library). A
  topic-probability heatmap (documents by topic, shaded by probability);
  if a heatmap is a larger lift than a first pass warrants, ship the
  document-assignment table as the authoritative source of the same
  numbers and note the heatmap as a follow-up, rather than shipping a
  broken or misleading one.
- A citation block for this tool (Schweinberger, matching the other plugins'
  citation pattern) and, if any external topic-modelling reference is worth
  crediting the way `sentimentexplorer` credits the NRC lexicon, include it;
  otherwise this tool's own citation is the only one required.
- A parameters view recording the file/column selection, preprocessing
  options, stage 1's `k`/seed/top-N, and the final seed dictionary used for
  stage 2, for reproducibility.

## Exports

Following this repo's existing convention (CSV only, no Excel dependency):

- Copy or download the stage 1 top-terms table as CSV.
- Copy or download the stage 2 top-terms table as CSV.
- Copy or download the full document-assignment table as CSV — every row
  and every topic probability column, not only what is rendered.
- Download the analysis parameters as a plain-text record.
- Chart/heatmap image export (PNG/PDF) is optional and only worth adding if
  the chosen rendering approach supports it cleanly, following the same
  qualification already used for `collocation` and `sentimentexplorer`.

## Testable seam

Add focused tests, once implemented, for:

- Tokenisation and vocabulary trimming (min term/doc frequency, empty
  documents dropped and reported).
- `fitLDA` determinism for a fixed seed, and that its topic-term weights
  sum sensibly (e.g. each topic's weights form a valid distribution over
  the vocabulary).
- `topTermsPerTopic` ordering (most probable term first) against a
  hand-built small term-topic weight matrix.
- `buildSeedDictionary` validation (throws when no topic has seed words;
  drops topics with none; keeps at least the residual topic).
- `fitSeededLDA` assigning a document whose tokens are dominated by one
  topic's seed words to that topic with high probability, on a small,
  hand-constructed corpus.
- The residual `other` topic catching a document that matches no seed
  dictionary.

The plugin should be registered in the package registry as `topicdetector`,
matching this folder's name, the same way `sentimentexplorer` is registered
next to its own visualisation implementation.
