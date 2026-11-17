// textcleaner: batch plain-text cleaning and normalisation based on LADAL TextCleaner.
// Interactive Process-pane action plugin for collection2crate.
// See SPEC.md and README.md for full details and citation.

import { openCleanerModal } from "./ui.js";

export {
  cleanText,
  calculateStats,
  calculateReductionStats,
  defaultCleaningOptions,
  resolveDestinationPath,
  PREBUILT_ORDER,
  PREBUILT_RULES,
  CONFIG_DIR,
  listSavedPresets,
  loadSavedPreset,
  savePreset,
  saveProvenanceManifest,
} from "./cleaner.js";

export function createPlugin(deps = {}) {
  const { readFileTextFromDirectory, writeFileAtPath, openModal } = deps;

  return {
    name: "textcleaner",
    optionSchema: {
      key: "textCleanerAction",
      type: "action",
      label: "Clean text files…",
      hint: "Batch clean and normalise text files with prebuilt removal options, custom regexes, and find-and-replace rules.",
      run: async ({ dirHandle, log = () => {} }) => {
        if (!dirHandle) {
          log("textcleaner: pick a collection folder first.", "warn");
          return;
        }
        if (!openModal) {
          log("textcleaner: the host did not provide its modal dialog API.", "warn");
          return;
        }

        try {
          await openCleanerModal({
            dirHandle,
            readFileTextFromDirectory,
            writeFileAtPath,
            openModal,
            log,
          });
        } catch (error) {
          log(`textcleaner: ${error.message}`, "err");
        }
      },
    },
    outputPaths: [{ path: "_config/textcleaner", kind: "dir" }],
  };
}
