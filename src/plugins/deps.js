// buildDeps() — the one deps object every plugin factory receives (SPEC.md §4.7a).
//
// collection2crate-plugins has no runtime dependency on this repo: a plugin never imports
// crate.js or fs_helpers.js, it is handed the functions it declared needing.
// The same full object goes to every factory — an unused key is simply never
// read — so this stays one list rather than a per-plugin lookup table.

import * as crate from "../crate.js";
import * as fsHelpers from "../fs_helpers.js";
import * as github from "../github.js";
import { openModal } from "../ui_helpers.js";

/**
 * @returns {object} every core function a plugin may ask for
 */
export function buildDeps() {
  return {
    // crate.js
    buildFileMetadata: crate.buildFileMetadata,
    buildCrate: crate.buildCrate,
    mergeCrateInto: crate.mergeCrateInto,
    graphEntityById: crate.graphEntityById,
    loadCrateFromJson: crate.loadCrateFromJson,
    collectTypeCounts: crate.collectTypeCounts,
    addLanguageEntities: crate.addLanguageEntities,
    crateToJsonString: crate.crateToJsonString,
    crateToXlsxBytes: crate.crateToXlsxBytes,
    crateToPreviewHtml: crate.crateToPreviewHtml,
    crateToMultiPageHtml: crate.crateToMultiPageHtml,

    // fs_helpers.js
    verifyPermission: fsHelpers.verifyPermission,
    fileExists: fsHelpers.fileExists,
    statFile: fsHelpers.statFile,
    readFileBytes: fsHelpers.readFileBytes,
    readJsonFromFolder: fsHelpers.readJsonFromFolder,
    readFileTextFromDirectory: fsHelpers.readFileTextFromDirectory,
    getFileHandleAtPath: fsHelpers.getFileHandleAtPath,
    getDirectoryHandleAtPath: fsHelpers.getDirectoryHandleAtPath,
    writeFile: fsHelpers.writeFile,
    writeFileAtPath: fsHelpers.writeFileAtPath,
    removePath: fsHelpers.removePath,

    // github.js
    bustCacheUrl: github.bustCacheUrl,
    buildGitHubTreeUrl: github.buildGitHubTreeUrl,
    fetchGitHubTextFile: github.fetchGitHubTextFile,
    fetchGitHubJsonFile: github.fetchGitHubJsonFile,
    listGitHubFolder: github.listGitHubFolder,

    // ui_helpers.js
    openModal,

    // masp.js is handed over as a thunk, not as the functions themselves, so
    // ro-crate-masp (the whole validator library) stays dynamically imported
    // from this repo's tree and collection2crate-plugins never statically references it.
    loadMasp: () => import("../masp.js"),
  };
}
