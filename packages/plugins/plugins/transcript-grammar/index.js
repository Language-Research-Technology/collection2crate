// transcript-grammar: define a transcript's layout by marking up a sample,
// and save the regular expressions that markup implies as standing
// configuration for parsing other documents in the same format.
//
// This plugin taps no build stage. It offers two actions, which
// collection2crate shows on its Process page (they are about how files are
// read, so main.js lists transcriptGrammarEdit in PROCESS_OPTION_KEYS) and
// runs there and then, outside a build:
//
//   Define a transcript grammar…  — the three-step editor in ui.js: source
//                                   document → regions → row markup → save.
//   Test a transcript grammar…    — parse another document with a saved one.
//
// Grammars live at _config/transcript-grammar/<name>.json — standing
// configuration, so under _config/ (collection2crate issue #81's per-plugin
// directory convention, as roctable uses it) and kept by "Delete plugin
// output before rebuilding". The file holds the patterns and the field
// structure only; the sample text it was marked up from is never written.
//
// The grammar itself — generation, parsing, and reading saved grammars from
// the folder — is src/_transcript_grammar.js, shared with ca-data-prep and
// chat-export, which parse with a saved grammar when one is chosen.
import {
  GRAMMAR_CONFIG_DIR, GRAMMAR_VERSION, grammarPath, listSavedGrammars, loadSavedGrammar, textToLines,
} from "../../src/_transcript_grammar.js";
import { openGrammarEditor, openGrammarTester } from "./ui.js";

export const CONFIG_DIR = GRAMMAR_CONFIG_DIR;

let writeFileAtPath, readFileTextFromDirectory, openModal;

export function createPlugin(deps) {
  ({ writeFileAtPath, readFileTextFromDirectory, openModal } = deps);
  return plugin;
}

const listGrammars = listSavedGrammars;
const loadGrammar = (dirHandle, name) => loadSavedGrammar(dirHandle, name, readFileTextFromDirectory);

// A .docx goes through ca-data-prep's own mammoth extraction, so the lines
// marked up here are exactly the lines that plugin reads. Imported on demand:
// mammoth is heavy and most visits to the Build panel never open the editor.
export async function readDocument(file) {
  if (/\.docx$/i.test(file.name || "")) {
    const { extractDocumentText } = await import("../ca-data-prep/process.js");
    const text = await extractDocumentText(await file.arrayBuffer());
    return textToLines(text, { paragraphs: true });
  }
  return textToLines(await file.text());
}

const plugin = {
  name: "transcript-grammar",
  optionSchema: {
    key: "transcriptGrammarEdit",
    type: "action",
    label: "Define a transcript grammar…",
    hint: `Mark up a sample transcript — its header metadata, speaker info and main regions, then the fields inside speaker and content rows — and save the patterns to ${CONFIG_DIR}/<name>.json for parsing other documents.`,
    run: async ({ dirHandle, log }) => {
      if (!dirHandle) { log("transcript-grammar: pick a folder first — grammars are saved into it.", "warn"); return; }
      const grammars = await listGrammars(dirHandle);
      const outcome = await openGrammarEditor({
        openModal,
        grammars,
        loadGrammar: (name) => loadGrammar(dirHandle, name),
        readDocument,
      });
      if (!outcome) { log("transcript-grammar: nothing saved.", "muted"); return; }
      const { grammar, sourceName } = outcome;
      const saved = {
        ...grammar,
        version: GRAMMAR_VERSION,
        generatedBy: "collection2crate transcript-grammar",
        markedUpFrom: sourceName || null,
        savedAt: new Date().toISOString(),
      };
      const path = grammarPath(grammar.name);
      await writeFileAtPath(dirHandle, path, JSON.stringify(saved, null, 2) + "\n");
      log(`transcript-grammar: saved ${path}. Choose "${grammar.name}" under "Transcript grammar" (transcript processing) to parse with it.`, "ok");
    },
    children: [
      {
        key: "transcriptGrammarTest",
        type: "action",
        label: "Test a transcript grammar…",
        hint: "Parse another document with a saved grammar and see what it finds and what it misses.",
        run: async ({ dirHandle, log }) => {
          if (!dirHandle) { log("transcript-grammar: pick a folder first.", "warn"); return; }
          const grammars = await listGrammars(dirHandle);
          if (!grammars.length) {
            log(`transcript-grammar: no grammars in ${CONFIG_DIR}/ yet — define one first.`, "warn");
            return;
          }
          await openGrammarTester({
            openModal,
            grammars,
            loadGrammar: (name) => loadGrammar(dirHandle, name),
            readDocument,
            log,
          });
        },
      },
    ],
  },
  outputPaths: [{ path: CONFIG_DIR, kind: "dir" }],
};
