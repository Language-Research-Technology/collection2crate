// Registry of every plugin this package ships, keyed by the same "name"
// each plugin's factory returns. One registry: the builders (generic-input,
// docx-input) are plugins like any other — they tap crate:build in the
// builder band (priority <= 10) and set ctx.crate, rather than living in a
// second, mutually-exclusive INPUT_REGISTRY the host dispatched on.
// collection2crate's src/plugins/index.js imports REGISTRY, filters it against its
// PLUGINS env var, and calls each selected factory with the collection2crate core
// functions it declares needing (see README.md's per-plugin dependency table) — nothing
// here imports collection2crate itself, so filtering out an entry keeps its
// whole subtree (and its dynamic imports, e.g. austlang's data pack or
// docx-input's mammoth/cheerio) out of a build that didn't ask for it.
import { createPlugin as createGenericInput } from "./plugins/generic-input/index.js";
import { createPlugin as createDocxInput } from "./plugins/docx-input/index.js";
import { createPlugin as createXlsxCrateInput } from "./plugins/xlsx-crate-input/index.js";
import { createPlugin as createAustlang } from "./plugins/austlang/index.js";
import { createPlugin as createFileFormatIdentify } from "./plugins/file-format-identify/index.js";
import { createPlugin as createTranscriptGrammar } from "./plugins/transcript-grammar/index.js";
import { createPlugin as createTextCleaner } from "./plugins/textcleaner/index.js";
import { createPlugin as createCaDataPrep } from "./plugins/ca-data-prep/index.js";
import { createPlugin as createChatExport } from "./plugins/chat-export/index.js";
import { createPlugin as createMerge } from "./plugins/merge/index.js";
import { createPlugin as createNameLookup } from "./plugins/name-lookup/index.js";
import { createPlugin as createRoctable } from "./plugins/roctable/index.js";
import { createPlugin as createValidateCrate } from "./plugins/validate-crate/index.js";
import { createPlugin as createJsonOutput } from "./plugins/ro-crate-json-output/index.js";
import { createPlugin as createXlsxOutput } from "./plugins/ro-crate-xlsx-output/index.js";
import { createPlugin as createConcordance } from "./plugins/concordance/index.js";
import { createPlugin as createNgrams } from "./plugins/ngrams/index.js";
import { createPlugin as createChart } from "./plugins/chart/index.js";
import { createPlugin as createCollocation } from "./plugins/collocation/index.js";
import { createPlugin as createSentimentExplorer } from "./plugins/sentimentexplorer/index.js";
import { createPlugin as createTopicDetector } from "./plugins/topicdetector/index.js";
import { createPlugin as createPlots } from "./plugins/plots/index.js";
import { createPlugin as createHtmlOutput } from "./plugins/ro-crate-html-output/index.js";

// Order here doubles as the default hook-execution order for plugins sharing
// a hook stage (createHookBus's priority defaults to 10 for every registration
// and Array#sort is stable, so registration order reproduces the original
// sequence). collection2crate is responsible for preserving this order when it
// filters by its PLUGINS env var. The builders come first: every one of them
// declares an explicit priority in the builder band, so the order is really
// only documentation of who assembles the crate before anyone annotates it.
export const REGISTRY = {
  "generic-input": createGenericInput,
  "docx-input": createDocxInput,
  "xlsx-crate-input": createXlsxCrateInput,
  "austlang": createAustlang,
  "file-format-identify": createFileFormatIdentify,
  // Process-page actions only (a grammar editor and tester): no hooks. Listed
  // ahead of ca-data-prep so its buttons sit above the transcript options that
  // use the grammars it saves — registry order is option order on the page.
  "transcript-grammar": createTranscriptGrammar,
  "textcleaner": createTextCleaner,
  "ca-data-prep": createCaDataPrep,
  "chat-export": createChatExport,
  "merge": createMerge,
  "name-lookup": createNameLookup,
  "roctable": createRoctable,
  "validate-crate": createValidateCrate,
  "ro-crate-json-output": createJsonOutput,
  "ro-crate-xlsx-output": createXlsxOutput,
  "ro-crate-html-output": createHtmlOutput,
  // Visualisation panels: no hooks, nothing during a build (SPEC-PLUGINS.md).
  "concordance": createConcordance,
  "ngrams": createNgrams,
  "chart": createChart,
  "sentimentexplorer": createSentimentExplorer,
  "collocation": createCollocation,
  "topicdetector": createTopicDetector,
  "plots": createPlots,
};

