// Interactive modal UI for the textcleaner plugin.
// Implements folder/file discovery, one-click prebuilt cleaning, custom regexes,
// find-and-replace rules, live side-by-side preview, destination routing, batch execution,
// preset persistence, and LADAL attribution.

import {
  element,
  button,
  field,
  checkbox,
  attributionFooter,
} from "../../src/_panel.js";
import {
  cleanText,
  calculateStats,
  resolveDestinationPath,
  PREBUILT_ORDER,
  PREBUILT_RULES,
  listSavedPresets,
  loadSavedPreset,
  savePreset,
  saveProvenanceManifest,
} from "./cleaner.js";

const MODAL_CLASS = "tc-modal";

function ensureStyle() {
  if (document.getElementById("textcleaner-style")) return;
  const style = document.createElement("style");
  style.id = "textcleaner-style";
  style.textContent = `
.modal-panel.${MODAL_CLASS} { width: min(1140px, 96vw); max-height: 92vh; display: flex; flex-direction: column; }
.modal-panel.${MODAL_CLASS} .modal-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
.tc-topbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.tc-presets { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tc-grid { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.2fr); gap: 16px; margin-bottom: 16px; }
@media (max-width: 800px) { .tc-grid { grid-template-columns: 1fr; } }
.tc-panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; }
.tc-panel.tc-panel-error { border-color: var(--err); box-shadow: 0 0 0 1px var(--err); }
.tc-panel-title { margin: 0 0 10px; font-size: 14px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
.tc-badge { background: var(--accent-soft); color: var(--accent); padding: 2px 7px; border-radius: 999px; font-size: 11.5px; font-weight: normal; }
.tc-file-list { max-height: 180px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px; background: var(--panel-2); margin-top: 8px; }
.tc-file-item { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12.5px; font-family: var(--mono); cursor: pointer; }
.tc-file-item input { cursor: pointer; }
.tc-prebuilts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 6px; margin: 8px 0; }
.tc-prebuilt-item { display: flex; flex-direction: column; padding: 4px 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-2); }
.tc-prebuilt-item .field { margin: 0; }
.tc-prebuilt-desc { font-size: 11px; color: var(--muted); margin: 2px 0 0 24px; line-height: 1.3; }
.tc-prebuilt-how { margin: 3px 0 0 24px; font-size: 11px; }
.tc-prebuilt-how summary { cursor: pointer; color: var(--accent); width: fit-content; }
.tc-prebuilt-how p { margin: 4px 0 0; color: var(--muted); }
.tc-prebuilt-how ol { margin: 3px 0 0; padding-left: 18px; color: var(--muted); }
.tc-prebuilt-how code { display: block; margin-top: 3px; padding: 3px 5px; font-family: var(--mono); font-size: 11px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-sm); white-space: pre-wrap; word-break: break-all; }
.tc-textarea { font-family: var(--mono); font-size: 12px; width: 100%; box-sizing: border-box; min-height: 65px; resize: vertical; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); }
.tc-rules-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
.tc-rules-table th, .tc-rules-table td { padding: 4px 6px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
.tc-rules-table th { background: var(--panel-2); font-weight: 600; color: var(--muted); }
.tc-rules-table input[type="text"] { font-family: var(--mono); font-size: 12px; width: 100%; box-sizing: border-box; padding: 3px 6px; }
.tc-btn-remove { background: none; border: none; color: var(--err); font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1; }
.tc-btn-remove:hover { color: var(--text); }
.tc-preview-pane { margin-top: 14px; }
.tc-preview-box { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
@media (max-width: 650px) { .tc-preview-box { grid-template-columns: 1fr; } }
.tc-preview-side { display: flex; flex-direction: column; }
.tc-preview-side-title { font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 4px; display: flex; justify-content: space-between; }
.tc-preview-text { font-family: var(--mono); font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px; height: 160px; overflow-y: auto; }
.tc-stats-banner { display: flex; align-items: center; gap: 16px; padding: 6px 12px; background: var(--accent-soft); border-radius: var(--radius-sm); color: var(--accent); font-size: 12px; font-weight: 500; margin-top: 6px; flex-wrap: wrap; }
.tc-stats-banner .ok { color: var(--ok); font-weight: 600; }
.tc-output-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-top: 8px; }
.tc-progress { height: 6px; background: var(--panel-2); border-radius: 999px; overflow: hidden; margin: 10px 0; }
.tc-progress-fill { height: 100%; width: 0%; background: var(--accent); transition: width 0.2s; }
.tc-summary-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
.tc-summary-table th, .tc-summary-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); text-align: left; }
.tc-summary-table th { background: var(--panel-2); position: sticky; top: 0; }
.tc-results-scroll { max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); margin-top: 10px; }
.tc-results-scroll .tc-summary-table { margin-top: 0; }
.tc-summary-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.tc-status { font-size: 12.5px; margin: 8px 0; }
.tc-status.ok { color: var(--ok); }
.tc-status.warn { color: var(--warn); }
.tc-status.err { color: var(--err); }
`;
  document.head.append(style);
}

/** Recursively scan dirHandle for text files (.txt, .text, .md) and subfolders */
export async function scanDirectoryForText(dirHandle, currentPath = "", result = { folders: new Set([""]), files: [] }) {
  if (!dirHandle) return result;
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const relPath = currentPath ? `${currentPath}/${name}` : name;
    if (handle.kind === "directory") {
      if (name === "_config" || name === "_backups") continue;
      result.folders.add(relPath);
      try {
        await scanDirectoryForText(handle, relPath, result);
      } catch {
        // ignore unreadable folders
      }
    } else if (handle.kind === "file") {
      if (/\.(txt|text|md)$/i.test(name)) {
        result.files.push({
          name,
          path: relPath,
          folder: currentPath,
          handle,
        });
      }
    }
  }
  return result;
}

async function readFileContent(dirHandle, file, readFileTextFromDirectory) {
  if (readFileTextFromDirectory) {
    try {
      const text = await readFileTextFromDirectory(dirHandle, file.path);
      if (text != null) return text;
    } catch {
      // fallback
    }
  }
  if (file.handle && typeof file.handle.getFile === "function") {
    const f = await file.handle.getFile();
    return await f.text();
  }
  return "";
}

/** Open a folder-relative text file in a new browser tab. */
async function openFileInTab(dirHandle, relativePath) {
  // Opened before the first await so the popup keeps the click's user activation.
  const tab = window.open("", "_blank");
  if (!tab) return false;
  try {
    let current = dirHandle;
    const parts = relativePath.split("/").filter(Boolean);
    const name = parts.pop();
    for (const part of parts) current = await current.getDirectoryHandle(part);
    const file = await (await current.getFileHandle(name)).getFile();
    const url = URL.createObjectURL(new Blob([await file.text()], { type: "text/plain;charset=utf-8" }));
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  } catch {
    tab.close();
    return false;
  }
}

async function removeFileAtPath(dirHandle, relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.pop();
  let current = dirHandle;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: false });
  }
  await current.removeEntry(filename);
}

/**
 * Open the interactive TextCleaner modal.
 */
export async function openCleanerModal({
  dirHandle,
  readFileTextFromDirectory,
  writeFileAtPath,
  openModal,
  log = () => {},
}) {
  ensureStyle();

  // Initial discovery
  const scan = await scanDirectoryForText(dirHandle);
  let allFolders = Array.from(scan.folders).sort();
  let allFiles = scan.files;

  // Active state
  const state = {
    selectedFolder: "",
    includeSubfolders: false,
    selectedFiles: new Set(allFiles.filter((f) => f.folder === "").map((f) => f.path)),
    prebuilt: new Set(["tags", "whitespace"]),
    lowercase: false,
    customPatterns: "",
    replacements: [],
    destinationFolder: "cleaned",
    placementMode: "copy", // "copy" | "move" | "overwrite"
    namingMode: "preserve", // "preserve" | "suffix" | "prefix"
    suffix: "_cleaned",
    prefix: "cleaned_",
    saveManifest: true,
    destinationInUse: false,
    previewFile: allFiles[0] || null,
    previewOriginal: "",
    previewCleaned: "",
    previewStats: null,
    isProcessing: false,
    summaryResults: null,
    statusText: "",
    statusType: "",
  };

  await openModal({
    title: "Clean text files (LADAL TextCleaner)",
    modalClassName: MODAL_CLASS,
    onMount(body) {
      const scroll = element("div", { className: "modal-body" });
      body.append(scroll);

      // Top bar with presets
      const topbar = element("div", { className: "tc-topbar" });
      const presetSelect = element("select", { attrs: { "aria-label": "Saved presets" } });
      const savePresetBtn = button("Save preset as…", {
        onClick: async () => {
          const name = prompt("Name for this cleaning preset:");
          if (!name || !name.trim()) return;
          const config = {
            prebuilt: Array.from(state.prebuilt),
            lowercase: state.lowercase,
            customPatterns: state.customPatterns,
            replacements: state.replacements,
            destinationFolder: state.destinationFolder,
            placementMode: state.placementMode,
            namingMode: state.namingMode,
            suffix: state.suffix,
            prefix: state.prefix,
            selectedFolder: state.selectedFolder,
            includeSubfolders: state.includeSubfolders,
          };
          const saved = await savePreset(dirHandle, name.trim(), config, writeFileAtPath);
          if (saved) {
            log(`textcleaner: preset "${name.trim()}" saved.`, "ok");
            await refreshPresets();
            presetSelect.value = name.trim();
          }
        },
      });

      async function refreshPresets() {
        const presets = await listSavedPresets(dirHandle);
        presetSelect.replaceChildren(
          element("option", { text: "Choose a preset…", attrs: { value: "" } }),
          ...presets.map((p) => element("option", { text: p, attrs: { value: p } })),
        );
      }

      async function applyChosenPreset() {
        const chosen = presetSelect.value;
        if (!chosen) return;
        const config = await loadSavedPreset(dirHandle, chosen, readFileTextFromDirectory);
        if (!config) return;
        state.prebuilt = new Set(config.prebuilt || []);
        state.lowercase = !!config.lowercase;
        state.customPatterns = config.customPatterns || "";
        state.replacements = config.replacements || [];
        if (config.destinationFolder != null) state.destinationFolder = config.destinationFolder;
        if (config.placementMode) state.placementMode = config.placementMode;
        if (config.namingMode) state.namingMode = config.namingMode;
        if (config.suffix) state.suffix = config.suffix;
        if (config.prefix) state.prefix = config.prefix;
        if (typeof config.includeSubfolders === "boolean") state.includeSubfolders = config.includeSubfolders;
        // Only restore the scope if that folder exists in this collection.
        if (typeof config.selectedFolder === "string" && allFolders.includes(config.selectedFolder)) {
          state.selectedFolder = config.selectedFolder;
        }
        const scoped = getFilteredFiles();
        state.selectedFiles = new Set(scoped.map((f) => f.path));
        state.previewFile = scoped[0] || null;
        renderAll();
        void triggerPreview();
      }
      presetSelect.addEventListener("change", applyChosenPreset);

      topbar.append(
        element("div", { className: "tc-presets" }, [
          element("span", { className: "field-hint", text: "Preset:" }),
          presetSelect,
          savePresetBtn,
        ]),
        element("span", { className: "field-hint", text: "LADAL string normalisation pipeline" }),
      );
      // Auto-load the first saved preset, if any, once the UI is built.
      void refreshPresets().then(() => {
        if (presetSelect.options.length > 1) {
          presetSelect.selectedIndex = 1;
          return applyChosenPreset();
        }
      });

      // Main layout grid
      const grid = element("div", { className: "tc-grid" });

      // Left column: Files & Scope + Output destination
      const leftCol = element("div", { style: "display: flex; flex-direction: column; gap: 14px;" });

      // Panel 1: File discovery
      const filesPanel = element("div", { className: "tc-panel" });
      const folderSelect = element("select", { attrs: { "aria-label": "Source folder" } });
      function fillFolderOptions() {
        folderSelect.replaceChildren(
          ...allFolders.map((f) =>
            element("option", {
              text: f === "" ? "(Collection root)" : f,
              attrs: { value: f },
            }),
          ),
        );
        folderSelect.value = state.selectedFolder;
      }
      fillFolderOptions();

      const fileCountBadge = element("span", { className: "tc-badge", text: "0 files" });
      const fileListContainer = element("div", { className: "tc-file-list" });

      function getFilteredFiles() {
        const root = state.selectedFolder;
        return allFiles.filter((f) => f.folder === root
          || (state.includeSubfolders && (!root || f.folder.startsWith(`${root}/`))));
      }

      function updateFileList() {
        const filtered = getFilteredFiles();
        fileListContainer.replaceChildren();
        if (!filtered.length) {
          fileListContainer.append(element("p", { className: "field-hint", text: "No .txt, .text, or .md files found in this folder." }));
        } else {
          for (const f of filtered) {
            const cb = element("input", { attrs: { type: "checkbox" } });
            cb.checked = state.selectedFiles.has(f.path);
            cb.addEventListener("change", () => {
              if (cb.checked) state.selectedFiles.add(f.path);
              else state.selectedFiles.delete(f.path);
              updateFileCount();
            });
            const item = element("label", { className: "tc-file-item" }, [
              cb,
              element("span", { text: f.path }),
            ]);
            fileListContainer.append(item);
          }
        }
        updateFileCount();
        updatePreviewDropdown();
      }

      function updateFileCount() {
        const filtered = getFilteredFiles();
        const count = filtered.filter((f) => state.selectedFiles.has(f.path)).length;
        fileCountBadge.textContent = `${count} of ${filtered.length} selected`;
        executeBtn.textContent = `Clean ${count} selected file${count === 1 ? "" : "s"}`;
        executeBtn.disabled = count === 0 || state.isProcessing || state.destinationInUse;
        let reason = "";
        if (state.isProcessing) reason = "Cleaning is in progress.";
        else if (count === 0) reason = "Select at least one file in step 1.";
        else if (state.destinationInUse) reason = "The destination folder in step 3 is not empty. Choose another destination, or delete it and press Refresh.";
        executeBtn.title = reason;
        executeBlockedHint.textContent = state.isProcessing ? "" : reason;
        executeBlockedHint.hidden = !executeBlockedHint.textContent;
        updatePathPreview();
      }

      folderSelect.addEventListener("change", () => {
        state.selectedFolder = folderSelect.value;
        const filtered = getFilteredFiles();
        state.selectedFiles = new Set(filtered.map((f) => f.path));
        updateFileList();
        state.previewFile = filtered[0] || null;
        void triggerPreview();
      });

      const selectAllBtn = button("Select all", {
        onClick: () => {
          for (const f of getFilteredFiles()) state.selectedFiles.add(f.path);
          updateFileList();
        },
      });
      const deselectAllBtn = button("Deselect all", {
        onClick: () => {
          for (const f of getFilteredFiles()) state.selectedFiles.delete(f.path);
          updateFileList();
        },
      });

      const includeChildren = checkbox("Include subfolders", { checked: state.includeSubfolders });
      includeChildren.input.addEventListener("change", () => {
        state.includeSubfolders = includeChildren.input.checked;
        const filtered = getFilteredFiles();
        state.selectedFiles = new Set(filtered.map((f) => f.path));
        state.previewFile = filtered[0] || null;
        updateFileList();
        void triggerPreview();
      });

      const refreshBtn = button("Refresh", {
        title: "Rescan the collection folder for added, renamed or removed files",
        onClick: async () => {
          refreshBtn.disabled = true;
          try {
            const previous = new Set(allFiles.map((f) => f.path));
            const rescanned = await scanDirectoryForText(dirHandle);
            allFolders = Array.from(rescanned.folders).sort();
            allFiles = rescanned.files;
            const current = new Set(allFiles.map((f) => f.path));
            // Keep choices for files still there; new files start selected.
            state.selectedFiles = new Set(allFiles.filter((f) => state.selectedFiles.has(f.path) || !previous.has(f.path)).map((f) => f.path));
            if (!allFolders.includes(state.selectedFolder)) state.selectedFolder = "";
            if (state.previewFile && !current.has(state.previewFile.path)) state.previewFile = null;
            fillFolderOptions();
            updateFileList();
            void checkDestination();
            void triggerPreview();
            log(`textcleaner: rescanned — ${allFiles.length} text file(s) found.`, "muted");
          } catch (error) {
            log(`textcleaner: could not rescan the folder — ${error.message}`, "warn");
          } finally {
            refreshBtn.disabled = false;
          }
        },
      });

      filesPanel.append(
        element("div", { className: "tc-panel-title" }, [
          element("span", { text: "1. Source files" }),
          fileCountBadge,
        ]),
        field("Folder scope", folderSelect),
        includeChildren.node,
        element("div", { className: "actions", style: "margin: 6px 0 2px;" }, [
          selectAllBtn,
          deselectAllBtn,
          refreshBtn,
        ]),
        fileListContainer,
      );

      // Panel 2: Destination & RO-Crate routing
      const destPanel = element("div", { className: "tc-panel" });
      const destFolderInput = element("input", {
        attrs: { type: "text", value: state.destinationFolder, placeholder: "e.g. cleaned or _outputs/cleaned" },
      });
      destFolderInput.addEventListener("input", () => {
        state.destinationFolder = destFolderInput.value.trim();
        updatePathPreview();
        void checkDestination();
      });

      const placementSelect = element("select", {}, [
        element("option", { text: "Write cleaned copies (keep raw originals)", attrs: { value: "copy" } }),
        element("option", { text: "Move to destination (delete raw originals)", attrs: { value: "move" } }),
        element("option", { text: "Overwrite in place (replace originals)", attrs: { value: "overwrite" } }),
      ]);
      placementSelect.value = state.placementMode;
      placementSelect.addEventListener("change", () => {
        state.placementMode = placementSelect.value;
        if (state.placementMode === "overwrite") {
          destFolderInput.disabled = true;
          namingSelect.disabled = true;
        } else {
          destFolderInput.disabled = false;
          namingSelect.disabled = false;
        }
        updatePathPreview();
        void checkDestination();
      });

      const namingSelect = element("select", {}, [
        element("option", { text: "Preserve original filenames (clean for RO-Crate)", attrs: { value: "preserve" } }),
        element("option", { text: "Append suffix (e.g. file_cleaned.txt)", attrs: { value: "suffix" } }),
        element("option", { text: "Add prefix (e.g. cleaned_file.txt)", attrs: { value: "prefix" } }),
      ]);
      namingSelect.value = state.namingMode;

      const suffixInput = element("input", {
        attrs: { type: "text", value: state.suffix, placeholder: "_cleaned", "aria-label": "Filename suffix", style: "width: 7em;" },
      });
      suffixInput.addEventListener("input", () => {
        state.suffix = suffixInput.value.trim();
        updatePathPreview();
      });

      const prefixInput = element("input", {
        attrs: { type: "text", value: state.prefix, placeholder: "cleaned_", "aria-label": "Filename prefix", style: "width: 7em;" },
      });
      prefixInput.addEventListener("input", () => {
        state.prefix = prefixInput.value.trim();
        updatePathPreview();
      });

      const syncNamingInputs = () => {
        suffixInput.hidden = state.namingMode !== "suffix";
        prefixInput.hidden = state.namingMode !== "prefix";
      };
      namingSelect.addEventListener("change", () => {
        state.namingMode = namingSelect.value;
        syncNamingInputs();
        updatePathPreview();
      });
      syncNamingInputs();

      const pathPreviewHint = element("p", {
        className: "field-hint",
        style: "margin-top: 6px; font-family: var(--mono); color: var(--accent);",
      });

      const sameFolderWarning = element("p", {
        className: "tc-status warn",
        attrs: { role: "alert" },
      });
      sameFolderWarning.hidden = true;

      const destinationError = element("p", {
        className: "tc-status err",
        attrs: { role: "alert" },
      });
      destinationError.hidden = true;

      let destCheckToken = 0;
      // Destination just written by this run; non-empty is expected there, not an error.
      let lastRunDestination = null;
      // The destination must be empty, so nothing already there gets mixed with cleaned files.
      async function checkDestination() {
        const token = ++destCheckToken;
        const folder = state.destinationFolder.replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
        let inUse = false;
        if (state.placementMode !== "overwrite" && folder) {
          try {
            let dir = dirHandle;
            for (const part of folder.split("/")) dir = await dir.getDirectoryHandle(part);
            // eslint-disable-next-line no-unused-vars
            for await (const _entry of dir.entries()) { inUse = true; break; }
          } catch {
            inUse = false;
          }
        }
        if (token !== destCheckToken) return;
        state.destinationInUse = inUse;
        const fromThisRun = inUse && folder === lastRunDestination;
        destPanel.classList.toggle("tc-panel-error", inUse && !fromThisRun);
        destinationError.hidden = !inUse;
        destinationError.className = fromThisRun ? "tc-status" : "tc-status err";
        destinationError.setAttribute("role", fromThisRun ? "status" : "alert");
        destinationError.textContent = !inUse
          ? ""
          : fromThisRun
            ? `Cleaned files are now in "${folder}". To clean again, choose a different destination folder, or delete that folder and press Refresh.`
            : `The destination folder "${folder}" is not empty. Choose a different destination folder, or delete that folder and press Refresh.`;
        updateFileCount();
      }

      function updatePathPreview() {
        const sample = state.previewFile?.path || "sample.txt";
        const dest = resolveDestinationPath({
          sourcePath: sample,
          destinationFolder: state.destinationFolder,
          placementMode: state.placementMode,
          namingMode: state.namingMode,
          suffix: state.suffix,
          prefix: state.prefix,
        });
        pathPreviewHint.textContent = `Route: ${sample} → ${dest}`;

        const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
        const sameFolder = state.placementMode === "overwrite" ? 0 : getFilteredFiles().filter((file) => {
          if (!state.selectedFiles.has(file.path)) return false;
          const target = resolveDestinationPath({
            sourcePath: file.path,
            destinationFolder: state.destinationFolder,
            placementMode: state.placementMode,
            namingMode: state.namingMode,
            suffix: state.suffix,
            prefix: state.prefix,
          });
          return dirOf(target) === dirOf(file.path);
        }).length;
        sameFolderWarning.hidden = !sameFolder;
        sameFolderWarning.textContent = sameFolder
          ? `Warning: ${sameFolder} cleaned file(s) would be written into the same folder as the originals. ` +
            "They would sit beside the raw files (or replace them), and removing them later means deleting each one. " +
            "Choose a separate destination folder."
          : "";
      }

      const manifestCheck = checkbox("Save cleaning provenance record (_config/textcleaner/run-<timestamp>.json)", {
        checked: state.saveManifest,
      });
      manifestCheck.input.addEventListener("change", () => {
        state.saveManifest = manifestCheck.input.checked;
      });

      destPanel.append(
        element("div", { className: "tc-panel-title" }, [
          element("span", { text: "3. Output & RO-Crate destination" }),
        ]),
        field("Destination folder", destFolderInput),
        element("div", { className: "tc-output-options" }, [
          field("Placement mode", placementSelect),
          field("Naming mode", namingSelect),
        ]),
        element("div", { className: "actions", style: "margin: 6px 0;" }, [suffixInput, prefixInput]),
        pathPreviewHint,
        sameFolderWarning,
        destinationError,
        manifestCheck.node,
      );

      leftCol.append(filesPanel, destPanel);

      // Right column: Cleaning options (Prebuilt + Custom + Replace + Lowercase)
      const rightCol = element("div", { style: "display: flex; flex-direction: column; gap: 14px;" });

      const optionsPanel = element("div", { className: "tc-panel" });
      const lowercaseCheck = checkbox("Convert all text to lowercase (executed after removals & replacements)", {
        checked: state.lowercase,
      });
      lowercaseCheck.input.addEventListener("change", () => {
        state.lowercase = lowercaseCheck.input.checked;
        void triggerPreview();
      });

      // Prebuilts
      const prebuiltsWrap = element("div", { className: "tc-prebuilts" });
      for (const id of [...PREBUILT_ORDER, "whitespace"]) {
        const rule = PREBUILT_RULES[id];
        const cb = checkbox(rule.label, { checked: state.prebuilt.has(id) });
        cb.input.addEventListener("change", () => {
          if (cb.input.checked) state.prebuilt.add(id);
          else state.prebuilt.delete(id);
          void triggerPreview();
        });
        const howBody = rule.pattern
          ? [
            element("p", { text: "Uses this regex:" }),
            element("code", { text: `/${rule.pattern.source}/${rule.pattern.flags}` }),
          ]
          : [
            element("p", { text: rule.howIntro || "Steps:" }),
            element("ol", {}, (rule.steps || []).map((step) => element("li", { text: step }))),
          ];
        const box = element("div", { className: "tc-prebuilt-item" }, [
          cb.node,
          element("span", { className: "tc-prebuilt-desc", text: rule.description }),
          element("details", { className: "tc-prebuilt-how" }, [
            element("summary", { text: "How it works" }),
            ...howBody,
          ]),
        ]);
        prebuiltsWrap.append(box);
      }

      // Custom Regex
      const customRegexTextarea = element("textarea", {
        className: "tc-textarea",
        attrs: { placeholder: "One regular expression per line (matches are removed)\ne.g. \\[[A-Z0-9_]+\\]\ne.g. \\b\\d{4}-\\d{2}-\\d{2}\\b" },
      });
      customRegexTextarea.value = state.customPatterns;
      customRegexTextarea.addEventListener("input", () => {
        state.customPatterns = customRegexTextarea.value;
        void triggerPreview();
      });

      // Find / Replace dynamic table
      const rulesTable = element("table", { className: "tc-rules-table" });
      const rulesHead = element("thead", {}, [
        element("tr", {}, [
          element("th", { text: "Find", style: "width: 38%;" }),
          element("th", { text: "Replace with", style: "width: 38%;" }),
          element("th", { text: "Regex", style: "width: 10%; text-align: center;" }),
          element("th", { text: "IC", title: "Ignore Case", style: "width: 8%; text-align: center;" }),
          element("th", { text: "", style: "width: 6%;" }),
        ]),
      ]);
      const rulesBody = element("tbody");
      rulesTable.append(rulesHead, rulesBody);

      function renderRulesTable() {
        rulesBody.replaceChildren();
        state.replacements.forEach((rule, idx) => {
          const findInput = element("input", { attrs: { type: "text", value: rule.find || "", placeholder: "Find text..." } });
          const replaceInput = element("input", { attrs: { type: "text", value: rule.replace || "", placeholder: "Replace with..." } });
          const regexCb = element("input", { attrs: { type: "checkbox", title: "Match as Regular Expression" } });
          regexCb.checked = !!rule.isRegex;
          const icCb = element("input", { attrs: { type: "checkbox", title: "Ignore Case" } });
          icCb.checked = !!rule.ignoreCase;
          const removeBtn = button("×", {
            className: "tc-btn-remove",
            title: "Delete rule",
            onClick: () => {
              state.replacements.splice(idx, 1);
              renderRulesTable();
              void triggerPreview();
            },
          });

          findInput.addEventListener("input", () => {
            rule.find = findInput.value;
            void triggerPreview();
          });
          replaceInput.addEventListener("input", () => {
            rule.replace = replaceInput.value;
            void triggerPreview();
          });
          regexCb.addEventListener("change", () => {
            rule.isRegex = regexCb.checked;
            void triggerPreview();
          });
          icCb.addEventListener("change", () => {
            rule.ignoreCase = icCb.checked;
            void triggerPreview();
          });

          const tr = element("tr", {}, [
            element("td", {}, [findInput]),
            element("td", {}, [replaceInput]),
            element("td", { style: "text-align: center;" }, [regexCb]),
            element("td", { style: "text-align: center;" }, [icCb]),
            element("td", {}, [removeBtn]),
          ]);
          rulesBody.append(tr);
        });
      }

      const addRuleBtn = button("+ Add find/replace rule", {
        onClick: () => {
          state.replacements.push({ find: "", replace: "", isRegex: false, ignoreCase: false });
          renderRulesTable();
        },
      });

      optionsPanel.append(
        element("div", { className: "tc-panel-title" }, [
          element("span", { text: "2. Cleaning operations" }),
        ]),
        element("strong", { style: "font-size: 12px;", text: "Pre-built removal options:" }),
        prebuiltsWrap,
        element("div", { style: "margin: 10px 0 6px;" }, [
          element("strong", { style: "font-size: 12px;", text: "Custom regex removals (one per line):" }),
        ]),
        customRegexTextarea,
        element("div", { style: "margin: 10px 0 4px; display: flex; justify-content: space-between; align-items: center;" }, [
          element("strong", { style: "font-size: 12px;", text: "Find → Replace rules:" }),
          addRuleBtn,
        ]),
        rulesTable,
        element("div", { style: "margin-top: 10px;" }, [lowercaseCheck.node]),
      );

      rightCol.append(optionsPanel);
      grid.append(leftCol, rightCol);

      // Section 3: Live Preview Pane
      const previewPanel = element("div", { className: "tc-panel tc-preview-pane" });
      const previewFileSelect = element("select", { attrs: { "aria-label": "Select file to preview" } });
      const previewBtn = button("Refresh preview", {
        onClick: () => {
          void triggerPreview();
        },
      });

      function updatePreviewDropdown() {
        const filtered = getFilteredFiles();
        previewFileSelect.replaceChildren();
        if (!filtered.length) {
          previewFileSelect.append(element("option", { text: "(No text files available)", attrs: { value: "" } }));
          state.previewFile = null;
        } else {
          for (const f of filtered) {
            previewFileSelect.append(element("option", { text: f.path, attrs: { value: f.path } }));
          }
          if (!state.previewFile || !filtered.some((f) => f.path === state.previewFile.path)) {
            state.previewFile = filtered[0];
          }
          previewFileSelect.value = state.previewFile ? state.previewFile.path : "";
        }
        updatePathPreview();
      }

      previewFileSelect.addEventListener("change", () => {
        const path = previewFileSelect.value;
        state.previewFile = allFiles.find((f) => f.path === path) || null;
        updatePathPreview();
        void triggerPreview();
      });

      const statsBanner = element("div", { className: "tc-stats-banner" });
      statsBanner.textContent = "Select a file and click preview to inspect changes.";

      const originalTextDiv = element("div", { className: "tc-preview-text", text: "No content loaded." });
      const cleanedTextDiv = element("div", { className: "tc-preview-text", text: "No content loaded." });

      const origSideTitle = element("span", { text: "Original text" });
      const cleanSideTitle = element("span", { text: "Cleaned output" });

      const previewBox = element("div", { className: "tc-preview-box" }, [
        element("div", { className: "tc-preview-side" }, [
          element("div", { className: "tc-preview-side-title" }, [origSideTitle]),
          originalTextDiv,
        ]),
        element("div", { className: "tc-preview-side" }, [
          element("div", { className: "tc-preview-side-title" }, [cleanSideTitle]),
          cleanedTextDiv,
        ]),
      ]);

      let previewTimeout = null;
      async function triggerPreview() {
        if (!state.previewFile) {
          originalTextDiv.textContent = "(No file selected)";
          cleanedTextDiv.textContent = "";
          statsBanner.textContent = "No file selected to preview.";
          return;
        }

        clearTimeout(previewTimeout);
        previewTimeout = setTimeout(async () => {
          try {
            const raw = await readFileContent(dirHandle, state.previewFile, readFileTextFromDirectory);
            state.previewOriginal = raw;
            const cleaned = cleanText(raw, {
              prebuilt: state.prebuilt,
              customPatterns: state.customPatterns,
              replacements: state.replacements,
              lowercase: state.lowercase,
            });
            state.previewCleaned = cleaned;
            const stats = calculateStats(raw, cleaned);
            state.previewStats = stats;

            originalTextDiv.textContent = raw || "(Empty file)";
            cleanedTextDiv.textContent = cleaned || "(Empty output)";
            origSideTitle.textContent = `Original (${raw.length} chars, ${raw.split("\n").length} lines)`;
            cleanSideTitle.textContent = `Cleaned (${cleaned.length} chars, ${cleaned.split("\n").length} lines)`;

            statsBanner.replaceChildren(
              element("span", { text: `Original: ${stats.originalChars.toLocaleString()} chars` }),
              element("span", { text: "→" }),
              element("span", { text: `Cleaned: ${stats.cleanedChars.toLocaleString()} chars` }),
              element("span", {
                className: "ok",
                text: `${stats.removedChars.toLocaleString()} removed (${stats.percentRemoved}% reduction)`,
              }),
            );
          } catch (err) {
            statsBanner.textContent = `Preview error: ${err.message}`;
          }
        }, 120);
      }

      previewPanel.append(
        element("div", { className: "tc-panel-title" }, [
          element("span", { text: "4. Live side-by-side preview" }),
        ]),
        element("div", { className: "actions", style: "margin-bottom: 6px; align-items: flex-end;" }, [
          field("Preview file", previewFileSelect),
          previewBtn,
        ]),
        statsBanner,
        previewBox,
      );

      // Section 4: Execution & Batch Results Area
      const execPanel = element("div", { className: "tc-panel", style: "margin-top: 14px;" });
      const statusLine = element("p", { className: "tc-status", text: "" });
      const executeBlockedHint = element("p", { className: "field-hint", text: "" });
      executeBlockedHint.hidden = true;
      const progressBar = element("div", { className: "tc-progress", style: "display: none;" }, [
        element("div", { className: "tc-progress-fill" }),
      ]);
      const progressFill = progressBar.firstElementChild;
      const resultsContainer = element("div", { className: "tc-results-scroll" });
      resultsContainer.hidden = true;
      const summaryToggle = button("Show summary table", {
        onClick: () => {
          resultsContainer.hidden = !resultsContainer.hidden;
          summaryToggle.textContent = resultsContainer.hidden ? "Show summary table" : "Hide summary table";
        },
      });
      summaryToggle.hidden = true;

      const executeBtn = button("Clean files", {
        primary: true,
        onClick: async () => {
          const filesToClean = getFilteredFiles().filter((f) => state.selectedFiles.has(f.path));
          if (!filesToClean.length) {
            statusLine.textContent = "No files selected to clean.";
            statusLine.className = "tc-status warn";
            return;
          }

          if (state.placementMode === "overwrite") {
            const ok = confirm(`Are you sure you want to overwrite ${filesToClean.length} file(s) in place? This cannot be undone.`);
            if (!ok) return;
          }

          state.isProcessing = true;
          executeBtn.disabled = true;
          statusLine.className = "tc-status";
          statusLine.textContent = `Cleaning ${filesToClean.length} file(s)...`;
          progressBar.style.display = "block";
          progressFill.style.width = "0%";
          resultsContainer.replaceChildren();
          resultsContainer.hidden = true;
          summaryToggle.hidden = true;
          const results = [];
          const runRecords = [];
          let completed = 0;

          for (const file of filesToClean) {
            try {
              const raw = await readFileContent(dirHandle, file, readFileTextFromDirectory);
              const cleaned = cleanText(raw, {
                prebuilt: state.prebuilt,
                customPatterns: state.customPatterns,
                replacements: state.replacements,
                lowercase: state.lowercase,
              });
              const stats = calculateStats(raw, cleaned);
              const targetPath = resolveDestinationPath({
                sourcePath: file.path,
                destinationFolder: state.destinationFolder,
                placementMode: state.placementMode,
                namingMode: state.namingMode,
                suffix: state.suffix,
                prefix: state.prefix,
              });

              await writeFileAtPath(dirHandle, targetPath, cleaned);

              if (state.placementMode === "move" && targetPath !== file.path) {
                try {
                  await removeFileAtPath(dirHandle, file.path);
                } catch (delErr) {
                  log(`textcleaner: could not remove original ${file.path}: ${delErr.message}`, "warn");
                }
              }

              results.push({
                file: file.path,
                dest: targetPath,
                stats,
                status: "Cleaned",
              });

              runRecords.push({
                source: file.path,
                destination: targetPath,
                ...stats,
              });
            } catch (fileErr) {
              results.push({
                file: file.path,
                dest: "",
                stats: { originalChars: 0, cleanedChars: 0, removedChars: 0, percentRemoved: 0 },
                status: `Error: ${fileErr.message}`,
              });
            }

            completed++;
            const pct = Math.round((completed / filesToClean.length) * 100);
            progressFill.style.width = `${pct}%`;
            statusLine.textContent = `Cleaning ${completed} of ${filesToClean.length}: ${file.name}...`;
          }

          state.isProcessing = false;
          lastRunDestination = state.destinationFolder.replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
          await checkDestination();
          statusLine.className = "tc-status ok";
          statusLine.textContent = `Successfully cleaned ${completed} file(s). Target folder: "${state.destinationFolder || "(source)"}".`;
          log(`textcleaner: batch finished — ${completed} file(s) cleaned.`, "ok");

          // Save manifest if requested
          if (state.saveManifest) {
            const manifest = {
              timestamp: new Date().toISOString(),
              totalFiles: completed,
              placementMode: state.placementMode,
              namingMode: state.namingMode,
              destinationFolder: state.destinationFolder,
              options: {
                prebuilt: Array.from(state.prebuilt),
                lowercase: state.lowercase,
                customPatterns: state.customPatterns,
                replacements: state.replacements,
              },
              files: runRecords,
            };
            const manifestPath = await saveProvenanceManifest(dirHandle, manifest, writeFileAtPath);
            if (manifestPath) {
              log(`textcleaner: saved provenance manifest to ${manifestPath}`, "ok");
            }
          }

          // Render summary table
          renderSummaryTable(results);
        },
      });

      function renderSummaryTable(results) {
        resultsContainer.replaceChildren();
        const table = element("table", { className: "tc-summary-table" });
        const thead = element("thead", {}, [
          element("tr", {}, [
            element("th", { text: "Source file" }),
            element("th", { text: "Destination" }),
            element("th", { text: "Original", className: "num" }),
            element("th", { text: "Cleaned", className: "num" }),
            element("th", { text: "Removed", className: "num" }),
            element("th", { text: "% Reduction", className: "num" }),
            element("th", { text: "Status" }),
          ]),
        ]);
        const tbody = element("tbody");
        for (const r of results) {
          const destCell = element("td");
          if (r.dest && !r.status.startsWith("Error")) {
            const link = element("a", { text: r.dest, attrs: { href: "#", title: "Open the cleaned file in a new tab" } });
            link.addEventListener("click", async (event) => {
              event.preventDefault();
              if (!(await openFileInTab(dirHandle, r.dest))) log(`textcleaner: could not open ${r.dest}.`, "warn");
            });
            destCell.append(link);
          }
          tbody.append(
            element("tr", {}, [
              element("td", { text: r.file }),
              destCell,
              element("td", { className: "num", text: r.stats.originalChars.toLocaleString() }),
              element("td", { className: "num", text: r.stats.cleanedChars.toLocaleString() }),
              element("td", { className: "num", text: r.stats.removedChars.toLocaleString() }),
              element("td", { className: "num", text: `${r.stats.percentRemoved}%` }),
              element("td", { text: r.status, className: r.status.startsWith("Error") ? "tc-status err" : "tc-status ok" }),
            ]),
          );
        }
        table.append(thead, tbody);
        resultsContainer.append(table);
        resultsContainer.hidden = true;
        summaryToggle.textContent = "Show summary table";
        summaryToggle.hidden = false;
      }

      execPanel.append(
        element("div", { className: "tc-panel-title" }, [
          element("span", { text: "5. Batch execution & summary" }),
        ]),
        element("div", { className: "actions" }, [executeBtn, summaryToggle]),
        executeBlockedHint,
        statusLine,
        progressBar,
        resultsContainer,
      );

      // Attribution Footer
      const footer = attributionFooter({
        logo: "https://ladal.edu.au/images/ladal_icon_white.png",
        logoAlt: "LADAL logo",
        logoBackground: "#51247a",
        href: "https://ladal.edu.au/tutorials/string/string.html",
        text: "Language Technology and Data Analysis Laboratory (LADAL)",
        comment: "Based on Martin Schweinberger's TextCleaner tool.",
      });

      function renderAll() {
        folderSelect.value = state.selectedFolder;
        includeChildren.input.checked = state.includeSubfolders;
        updateFileList();
        renderRulesTable();
        customRegexTextarea.value = state.customPatterns;
        lowercaseCheck.input.checked = state.lowercase;
        destFolderInput.value = state.destinationFolder;
        placementSelect.value = state.placementMode;
        namingSelect.value = state.namingMode;
        suffixInput.value = state.suffix;
        prefixInput.value = state.prefix;
        syncNamingInputs();
        updatePathPreview();
        void checkDestination();
      }

      scroll.append(topbar, grid, previewPanel, execPanel, footer);

      renderAll();
      void triggerPreview();
    },
    actions: [{ label: "Close", value: null }],
  });
}
