// UI, wizard, ctx assembly and schema composition — the one non-isomorphic
// module (SPEC.md §9.1). Everything here needs a browser: the File System
// Access API, the DOM, localStorage. The mitigation for that being untestable
// is architectural: as little logic lives here as possible, which is why
// plugins own their behaviour and this file mostly assembles ctx.

// Styles are linked from index.html, not imported here — see the comment
// there: importing them from JS means no styles until the module graph runs.

import { ROCrate } from "ro-crate";

import {
  GENERATED_FILENAMES, CONTROL_FILENAMES, BACKUP_DIR,
  buildFileMetadata, collectTypeCounts, crateToJsonString, crateToXlsxBytes,
  listEntities, setEntityProperty, deleteEntityProperty, addEntity,
  renameEntityId, deleteEntity, isStructuralEntity, crateToPreviewHtml,
} from "./crate.js";
import {
  walkDirectory, verifyPermission, fileExists, statFile, readJsonFromFolder,
  writeFile, removePath, backupFile, getFileHandleAtPath,
} from "./fs_helpers.js";
import { listGitHubFolder } from "./github.js";
import {
  loadProfile, profileToConfig, resolvePropertyGroups, listProfiles, fetchProfile,
  resolveBuildOptions, walkOptionSchema, uploadKeyFor,
} from "./masp.js";
import { loadDefaultProfile, DEFAULT_PROFILE_NAME } from "./default_profile.js";
import { openModal, closeAllModals } from "./ui_helpers.js";
import { buildPreviewBlobUrl, PAGE_RESOLVER_NAME } from "./preview_assets.js";
import { loadDirectory, readerFor, scanOutputDirectories } from "./visualise_data.js";
import { createHookBus, registerAllPlugins, announceAndEmit, HOOKS } from "./plugins/hooks.js";
import { runPipeline, createProgress, PIPELINE_STAGES } from "./plugins/pipeline.js";
import {
  PLUGINS, composeOptionSchema, composeSettingsSchema, composeOutputPaths,
  composeVisualisationPanels,
} from "./plugins/index.js";

export const APP_VERSION = "0.1.0";
const SETTINGS_KEY = "collection2crate.settings.v1";
const TEMPLATE_REPO = { owner: "Language-Research-Technology", repo: "rocss-templates", ref: "main" };

// ---------------------------------------------------------------------------
// Schema composition (SPEC.md §4.6)
// ---------------------------------------------------------------------------

// Core options live alongside the plugins' own, and are ordered so the
// plugins' choices read first and the core's structural ones last.
const CORE_OPTION_SCHEMA = [];

// Core settings are machine and user preferences, orthogonal to the profile —
// they are deliberately NOT gated by enabledOptionKeys (SPEC.md §5.4). Their
// controls are hand-written in the Settings template; this list is what makes
// them part of ctx.options and what persists them.
const CORE_SETTINGS_SCHEMA = [
  { key: "themeMode", type: "select", label: "Theme", default: "light" },
  { key: "topLevelFolderType", type: "select", label: "Top-level folders become", default: "object" },
  { key: "overwrite", label: "Overwrite existing output files", default: true },
  { key: "deleteOutputsBeforeBuild", label: "Delete plugin output before rebuilding", default: false },
];

const PLUGIN_OPTIONS_SCHEMA = [...composeOptionSchema(), ...CORE_OPTION_SCHEMA];
const PLUGIN_SETTINGS_SCHEMA = [...CORE_SETTINGS_SCHEMA, ...composeSettingsSchema()];
const OUTPUT_PATHS = composeOutputPaths();

// Which options belong on Process (things done to the files) and which on
// Build (what gets written). Anything a plugin adds that isn't named here
// lands on Build, which is the conservative default: a new output plugin
// shows up next to the other outputs rather than in the middle of processing.
const PROCESS_OPTION_KEYS = new Set([
  "docxInput", "xlsxCrate", "enableLanguageLookups", "identifyFileFormats",
  "processTranscriptDocuments", "generateChatFiles", "transcriptGrammarEdit", "merge",
]);

// The same set, plus every child key beneath those options — changing
// "Match Austlang alternate names" changes what Process does just as much as
// switching AUSTLANG on does, so both have to invalidate a prepared run.
const PROCESS_KEYS_DEEP = (() => {
  const keys = new Set();
  const roots = PLUGIN_OPTIONS_SCHEMA.filter((node) => PROCESS_OPTION_KEYS.has(node.key));
  walkOptionSchema(roots, (node) => keys.add(node.key));
  return keys;
})();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  dirHandle: null,
  folderName: "",
  files: [],
  filesWithMeta: [],
  profile: null,
  describeValues: {},
  describeSourceLabel: "",
  options: {},
  settings: {},
  crate: null,
  crateJson: null,
  hasBuilt: false,
  lastHtmlTemplate: null,
  // What Process left behind: the ctx its run finished with, and how many
  // options that step actually offers for this profile. Build consumes the
  // first and is gated on the second (SPEC.md §4.4).
  preparedCtx: null,
  processOptionCount: 0,
  // Choosing a new folder mid-build doesn't abort in-flight plugin work, so a
  // generation counter stops a stale run from touching the log or the UI.
  generation: 0,
  running: false,
  editDirty: false,
  selectedEntityId: null,
  // Every blob: URL handed to a preview window — the page itself, its assets,
  // and any page opened from it — revoked together when a new preview opens.
  previewRevokes: [],
};

const bus = createHookBus();
registerAllPlugins(bus, PLUGINS);

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// ---------------------------------------------------------------------------
// The log (SPEC-UI.md "Logging and progress indication")
// ---------------------------------------------------------------------------

const logPanel = $("#log-panel");
const logBody = $("#log-body");
const logStatus = $("#log-status");
const logToggle = $("#log-toggle");
const logCopy = $("#log-copy");
const logSave = $("#log-save");
const logClear = $("#log-clear");

let logCount = 0;
let framePending = false;

// Appending is synchronous, so nothing is dropped mid-burst even if a build
// throws. The expensive follow-up — scrolling and button state — is coalesced
// to once per animation frame, so hundreds of near-identical lines from a
// noisy validator don't each force a synchronous layout.
function scheduleLogWork() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    logBody.scrollTop = logBody.scrollHeight;
    const empty = logCount === 0;
    for (const button of [logCopy, logSave, logClear]) button.disabled = empty;
  });
}

function log(message, level = "info") {
  const line = document.createElement("span");
  line.className = `log-line ${level}`;
  line.textContent = message;
  logBody.append(line);
  logCount++;
  logStatus.textContent = message;
  logStatus.className = `log-status ${level}`;
  scheduleLogWork();
}

// ---------------------------------------------------------------------------
// Action buttons carry their own outcome (SPEC-UI §5)
// ---------------------------------------------------------------------------

// Primary (blue) until the button has run, green once its work completed, red
// if it failed. The colour is the outcome of the *last* press, so it clears the
// moment the button is pressed again — and on a new folder, where nothing that
// came before still applies.
function armActionButton(button) {
  button?.classList.remove("ok", "err");
}

function resetActionButtons() {
  for (const button of $$(".actions .button.primary")) armActionButton(button);
}

/**
 * Run a button's work and colour the button by how it went.
 *
 * `work` reports failure either by throwing or by resolving to null/false —
 * runStages() does the latter, since it catches and logs a failed build itself
 * rather than letting it reach a click handler.
 */
async function runAction(button, work) {
  armActionButton(button);
  try {
    const result = await work();
    button?.classList.add(result === null || result === false ? "err" : "ok");
    return result;
  } catch (error) {
    button?.classList.add("err");
    throw error;
  }
}

/** A log bound to one build run — a stale run's lines never reach the UI. */
function generationLog(generation) {
  return (message, level = "info") => {
    if (generation !== state.generation) return;
    log(message, level);
  };
}

function clearLog() {
  logBody.replaceChildren();
  logCount = 0;
  logStatus.textContent = "Ready.";
  logStatus.className = "log-status";
  setMainProgress(0);
  hideSubProgress(true);
  scheduleLogWork();
}

logToggle.addEventListener("click", () => {
  const expanded = logToggle.getAttribute("aria-expanded") === "true";
  logToggle.setAttribute("aria-expanded", String(!expanded));
  logToggle.textContent = expanded ? "Details" : "Hide";
  logBody.hidden = expanded;
  for (const button of [logCopy, logSave, logClear]) button.hidden = expanded;
  scheduleLogWork();
});

// Each line is its own span, so the panel's textContent would run them
// together — join the children instead.
const logText = () => [...logBody.children].map((line) => line.textContent).join("\n");

logCopy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(logText());
  const original = logCopy.textContent;
  logCopy.textContent = "✓";
  setTimeout(() => { logCopy.textContent = original; }, 2000);
});

logSave.addEventListener("click", () => {
  const blob = new Blob([`${logText()}\n`], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `c2c-${state.folderName || "session"}.log`;
  link.click();
  URL.revokeObjectURL(url);
});

logClear.addEventListener("click", clearLog);

// ---------------------------------------------------------------------------
// Progress bars
// ---------------------------------------------------------------------------

const progressMain = $("#progress-main");
const progressMainFill = $("#progress-main-fill");
const progressSub = $("#progress-sub");
const progressSubFill = $("#progress-sub-fill");
let subFadeTimer = null;

function setMainProgress(percent) {
  const value = Math.max(0, Math.min(100, percent));
  progressMainFill.style.width = `${value}%`;
  progressMain.setAttribute("aria-valuenow", String(Math.round(value)));
}

function setSubProgress(fraction) {
  const value = Math.max(0, Math.min(100, fraction * 100));
  clearTimeout(subFadeTimer);
  progressSub.hidden = false;
  progressSub.classList.remove("fading");
  progressSubFill.style.width = `${value}%`;
  progressSub.setAttribute("aria-valuenow", String(Math.round(value)));
}

// Fades out over two seconds, so a fast sub-step finishing doesn't just flicker
// away before anyone has seen it.
function hideSubProgress(immediate = false) {
  clearTimeout(subFadeTimer);
  if (immediate) {
    progressSub.hidden = true;
    progressSub.classList.remove("fading");
    return;
  }
  if (progressSub.hidden) return;
  progressSub.classList.add("fading");
  subFadeTimer = setTimeout(() => {
    progressSub.hidden = true;
    progressSub.classList.remove("fading");
    progressSubFill.style.width = "0%";
  }, 2000);
}

function progressUiFor(generation) {
  const guard = (fn) => (...args) => { if (generation === state.generation) fn(...args); };
  return {
    onMain: guard((percent, label) => { setMainProgress(percent); if (label) logStatus.textContent = label; }),
    onSub: guard((fraction) => setSubProgress(fraction)),
    onSubHide: guard(() => hideSubProgress()),
    onComplete: guard(() => { setMainProgress(100); hideSubProgress(); }),
    onFail: guard(() => hideSubProgress(true)),
  };
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

// State that must survive a session — input mode, theme, folder handling,
// overwrite behaviour, an uploaded template — is explicitly independent of the
// active profile (SPEC.md §1). Build options, by contrast, always reset from
// the profile at the start of each run.
function loadSettings() {
  const defaults = {};
  for (const entry of PLUGIN_SETTINGS_SCHEMA) defaults[entry.key] = entry.default;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    stored = {};
  }
  return { ...defaults, ...stored };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    log("Settings could not be saved to this browser.", "warn");
  }
}

function applyTheme() {
  if (state.settings.themeMode === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
}

// ---------------------------------------------------------------------------
// Option schema → ctx.options
// ---------------------------------------------------------------------------

/**
 * Reset build options from the profile.
 *
 * The gating itself lives in masp.js so it can be tested without a browser
 * (SPEC.md §9.1); this only decides what to feed it and where to put the answer.
 */
function resetOptionsFromProfile() {
  const { options } = resolveBuildOptions(
    PLUGIN_OPTIONS_SCHEMA,
    state.profile?.buildOptions || null,
    state.settings
  );
  state.options = options;
}

function isOptionVisible(key) {
  return new Set(state.profile?.buildOptions?.enabledOptionKeys || []).has(key);
}

// ---------------------------------------------------------------------------
// Rendering an option schema
// ---------------------------------------------------------------------------

function renderOptionTree(container, nodes, { onChange } = {}) {
  container.replaceChildren();
  let rendered = 0;
  for (const node of nodes) {
    const element = renderOptionNode(node, onChange);
    if (element) { container.append(element); rendered++; }
  }
  return rendered;
}

function renderOptionNode(node, onChange) {
  if (!isOptionVisible(node.key)) return null;

  const wrapper = document.createElement("div");
  wrapper.className = "option";
  const head = document.createElement("div");
  head.className = "option-head";
  wrapper.append(head);

  const control = buildControl(node, onChange);
  head.append(control.element);

  if (node.hint) {
    const hint = document.createElement("p");
    hint.className = "field-hint";
    hint.textContent = node.hint;
    wrapper.append(hint);
  }

  const visibleChildren = (node.children || []).filter((child) => isOptionVisible(child.key));
  if (visibleChildren.length) {
    const childBox = document.createElement("div");
    childBox.className = "option-children";
    for (const child of visibleChildren) {
      const element = renderOptionNode(child, onChange);
      if (element) childBox.append(element);
    }
    wrapper.append(childBox);
    // A checkbox parent discloses its children; anything else always shows them.
    if (control.kind === "checkbox") {
      const sync = () => {
        const open = !!state.options[node.key];
        childBox.hidden = !open;
        control.input.setAttribute("aria-expanded", String(open));
      };
      control.onAfterChange = sync;
      sync();
    }
  }
  return wrapper;
}

function buildControl(node, onChange) {
  const emit = () => { onChange?.(node); control.onAfterChange?.(); };
  const control = { kind: "checkbox", element: null, input: null, onAfterChange: null };

  if (node.type === "file") {
    control.kind = "file";
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.className = "field-label";
    span.textContent = node.label;
    const input = document.createElement("input");
    input.type = "file";
    if (node.accept) input.accept = node.accept;
    const chosen = document.createElement("span");
    chosen.className = "file-chosen";
    input.addEventListener("change", () => {
      const file = input.files?.[0] || null;
      state.options[uploadKeyFor(node.key)] = file ? { name: file.name, file, siblingFiles: [...input.files] } : null;
      state.options[node.key] = file ? file.name : null;
      chosen.textContent = file ? `✓ ${file.name}` : "";
      emit();
    });
    label.append(span, input, chosen);
    control.element = label;
    control.input = input;
    return control;
  }

  if (node.type === "select") {
    control.kind = "select";
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.className = "field-label";
    span.textContent = node.label;
    const select = document.createElement("select");
    select.dataset.optionKey = node.key;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = node.placeholder || "— none —";
    select.append(placeholder);
    select.value = state.options[node.key] || "";
    select.addEventListener("change", () => { state.options[node.key] = select.value; emit(); });
    label.append(span, select);
    control.element = label;
    control.input = select;
    return control;
  }

  if (node.type === "text") {
    control.kind = "text";
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.className = "field-label";
    span.textContent = node.label;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = node.placeholder || "";
    input.value = state.options[node.key] || "";
    input.addEventListener("input", () => { state.options[node.key] = input.value; emit(); });
    label.append(span, input);
    control.element = label;
    control.input = input;
    return control;
  }

  if (node.type === "mappingBuilder" || node.type === "collectionLabelsBuilder") {
    control.kind = "dialog";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = node.label;
    button.addEventListener("click", async () => {
      if (node.type === "mappingBuilder") await openMappingBuilder(node);
      else await openCollectionLabelsBuilder(node);
      emit();
    });
    control.element = button;
    control.input = button;
    return control;
  }

  // An action runs the plugin's own `run()` there and then, outside a build —
  // roctable's "Configure tables…" is one. It stores no value, so nothing about
  // it reaches ctx.options; the plugin does its work against the folder itself.
  if (node.type === "action") {
    control.kind = "action";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = node.label;
    button.addEventListener("click", async () => {
      if (typeof node.run !== "function") {
        log(`"${node.label}" has no action behind it.`, "warn");
        return;
      }
      button.disabled = true;
      try {
        await node.run(baseCtx(state.generation));
      } catch (e) {
        log(`${node.label}: ${e.message}`, "err");
      } finally {
        button.disabled = false;
      }
      emit();
    });
    control.element = button;
    control.input = button;
    return control;
  }

  // Default: a checkbox, which is what an option with no `type` is.
  const label = document.createElement("label");
  label.className = "field inline";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!state.options[node.key];
  const span = document.createElement("span");
  span.className = "field-label";
  span.textContent = node.label;
  input.addEventListener("change", () => { state.options[node.key] = input.checked; emit(); });
  label.append(input, span);
  control.element = label;
  control.input = input;
  return control;
}

// ---------------------------------------------------------------------------
// Option dialogs
// ---------------------------------------------------------------------------

// Reads the column headers out of the chosen merge spreadsheet and lets the
// person set a target property (and type) for each one.
async function openMappingBuilder(node) {
  const upload = state.options.mergeUpload;
  if (!upload) {
    await openModal({
      title: node.label,
      body: "<p>Choose the spreadsheet above first — this dialog reads its column headers.</p>",
      actions: [{ label: "Close", primary: true }],
    });
    return;
  }

  let headers = [];
  try {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await upload.file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    headers = (sheet?.getRow(1)?.values || []).slice(1).map((v) => String(v ?? "").trim()).filter(Boolean);
  } catch (e) {
    log(`Could not read column headers from ${upload.name}: ${e.message}`, "warn");
    return;
  }

  const existing = state.options.mergeConfigUpload
    ? JSON.parse(await state.options.mergeConfigUpload.file.text())
    : { map: {} };

  const form = document.createElement("div");
  const rows = headers.map((header) => {
    const row = document.createElement("div");
    row.className = "mapping-row";
    const name = document.createElement("span");
    name.className = "mono";
    name.textContent = header;
    const property = document.createElement("input");
    property.type = "text";
    property.placeholder = "target property";
    property.value = existing.map?.[header]?.property || "";
    const type = document.createElement("select");
    for (const option of ["Text", "Date", "URL", "Place", "Person", "Organization"]) {
      const element = document.createElement("option");
      element.value = option;
      element.textContent = option;
      type.append(element);
    }
    type.value = existing.map?.[header]?.type || "Text";
    row.append(name, property, type);
    form.append(row);
    return { header, property, type };
  });

  const result = await openModal({
    title: node.label,
    body: form,
    actions: [
      { label: "Cancel", value: null },
      { label: "Use this mapping", primary: true, value: () => {
        const map = {};
        for (const row of rows) {
          const property = row.property.value.trim();
          if (property) map[row.header] = { property, type: row.type.value };
        }
        return { ...existing, map };
      } },
    ],
  });
  if (!result) return;

  // Handed on as an upload, because that is the shape the merge plugin reads.
  const text = JSON.stringify(result, null, 2);
  state.options.mergeConfigUpload = {
    name: "merge-config.json (built here)",
    file: new File([text], "merge-config.json", { type: "application/json" }),
  };
  state.options[node.key] = `${Object.keys(result.map).length} column(s) mapped`;
  log(`Merge mapping set for ${Object.keys(result.map).length} column(s).`, "ok");
}

// Menu names and order for the generated HTML. Affects the preview only —
// the crate itself always uses each folder's own name and order.
async function openCollectionLabelsBuilder(node) {
  const folders = topLevelFolderNames();
  if (!folders.length) {
    await openModal({
      title: node.label,
      body: "<p>No top-level folders found in the picked folder yet.</p>",
      actions: [{ label: "Close", primary: true }],
    });
    return;
  }

  const order = state.options.collectionOrder?.length ? state.options.collectionOrder : folders;
  const labels = state.options.collectionLabels || {};
  const list = document.createElement("div");

  const makeRow = (folder) => {
    const row = document.createElement("div");
    row.className = "label-row";
    row.draggable = true;
    row.dataset.folder = folder;
    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    handle.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "mono";
    name.textContent = folder;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = folder;
    input.value = labels[folder] || "";
    input.setAttribute("aria-label", `Menu label for ${folder}`);
    row.append(handle, name, input);
    row.addEventListener("dragstart", () => row.classList.add("dragging"));
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      const dragging = list.querySelector(".dragging");
      if (dragging && dragging !== row) {
        const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
        list.insertBefore(dragging, after ? row.nextSibling : row);
      }
    });
    return row;
  };

  const ordered = [...order.filter((f) => folders.includes(f)), ...folders.filter((f) => !order.includes(f))];
  for (const folder of ordered) list.append(makeRow(folder));

  const result = await openModal({
    title: node.label,
    body: list,
    actions: [
      { label: "Cancel", value: null },
      { label: "Apply", primary: true, value: () => {
        const nextOrder = [];
        const nextLabels = {};
        for (const row of list.querySelectorAll(".label-row")) {
          const folder = row.dataset.folder;
          nextOrder.push(folder);
          const value = row.querySelector("input").value.trim();
          if (value) nextLabels[folder] = value;
        }
        return { order: nextOrder, labels: nextLabels };
      } },
    ],
  });
  if (!result) return;

  state.options.collectionOrder = result.order;
  state.options.collectionLabels = result.labels;
  state.options[node.key] = `${result.order.length} folder(s) ordered`;
  log(`Menu order set for ${result.order.length} collection folder(s).`, "ok");
}

function topLevelFolderNames() {
  return [...new Set(state.filesWithMeta.map((f) => f.topLevel).filter(Boolean))].sort();
}

// The template list is the same for the whole session — the folders in
// rocss-templates don't change while the app is open — and GitHub here is
// unauthenticated and rate-limited (§13), so fetch it once and reuse it.
// A failure is not cached: the next render tries again.
let templateFolderNames = null;

async function listTemplateFolders() {
  if (!templateFolderNames) {
    const entries = await listGitHubFolder(TEMPLATE_REPO.owner, TEMPLATE_REPO.repo, TEMPLATE_REPO.ref, "");
    templateFolderNames = entries.filter((entry) => entry.type === "dir").map((entry) => entry.name);
  }
  return templateFolderNames;
}

/**
 * Drop everything a previous fill appended, keeping the schema's own
 * placeholder (renderOptionTree always creates a select with exactly one
 * option). Returns that placeholder, which both callers relabel.
 */
function resetDynamicSelect(select) {
  while (select.options.length > 1) select.remove(1);
  return select.options[0];
}

const appendOption = (select, value) => {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = value;
  select.append(option);
};

/**
 * Fill in the selects whose choices come from outside the schema.
 *
 * This runs on every option change, not only when the tree is rebuilt (see
 * onOptionChanged), so it has to be idempotent — hence the reset. Each select
 * is emptied and refilled without an await in between, so two overlapping
 * calls can't interleave into a doubled list.
 */
async function populateDynamicSelects(container) {
  const homePage = container.querySelector('select[data-option-key="homePageId"]');
  if (homePage) {
    resetDynamicSelect(homePage);
    for (const folder of topLevelFolderNames()) appendOption(homePage, folder);
    homePage.value = state.options.homePageId || "";
  }

  const templates = container.querySelector('select[data-option-key="templateRepoFolder"]');
  if (!templates) return;
  try {
    const names = await listTemplateFolders();
    const placeholder = resetDynamicSelect(templates);
    for (const name of names) appendOption(templates, name);
    placeholder.textContent = "— the library's plain preview —";
    templates.value = state.options.templateRepoFolder || "";
  } catch (e) {
    resetDynamicSelect(templates).textContent = `Template list unavailable (${e.message})`;
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const VIEWS = ["select", "profile", "process", "describe", "build", "show", "edit", "visualise"];
const NAV_VIEWS = ["select", "process", "build", "show", "edit", "visualise"];

function showView(name) {
  for (const view of VIEWS) {
    const section = document.getElementById(`view-${view}`);
    if (section) section.hidden = view !== name;
  }
  for (const button of $$(".nav-button")) {
    const isCurrent = button.dataset.view === name;
    if (isCurrent) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  // The log is one element that follows the view, so it stays persistent
  // across pages rather than each page owning its own copy.
  // The log lives on Select, Process and Build only — a view with no slot
  // doesn't show it at all (SPEC-UI §6), rather than docking it to the page.
  const slot = document.querySelector(`#view-${name} [data-log-slot]`);
  if (slot) slot.append(logPanel);
  logPanel.hidden = !slot;

  if (name === "show") refreshShowView();
  if (name === "edit") refreshEditView();
  if (name === "visualise") refreshVisualiseView();
}

/** Buttons enable/disable on what currently exists in the folder. */
function refreshNav() {
  $("#context-bar").hidden = !state.dirHandle;
  $("#context-folder").textContent = state.folderName ? `📁 ${state.folderName}` : "";
  const ready = !!state.profile && !!state.dirHandle;
  // Build assembles a crate from what Process prepared, so it stays shut until
  // Process has run — unless this profile offers no processing options at all,
  // in which case there is nothing to prepare and nothing to wait for.
  const buildable = ready && (!!state.preparedCtx || state.processOptionCount === 0);
  const enabled = {
    select: true,
    process: ready,
    build: buildable,
    show: state.hasBuilt,
    edit: state.hasBuilt,
    visualise: state.hasBuilt,
  };
  for (const view of NAV_VIEWS) {
    const button = document.querySelector(`.nav-button[data-view="${view}"]`);
    if (button) button.disabled = !enabled[view];
  }
  $("#go-to-process").disabled = !state.dirHandle;
  for (const button of $$('[data-goto="build"]')) button.disabled = !buildable;
  const runBuild = $("#run-build");
  if (runBuild) runBuild.disabled = !buildable;
  const note = $("#build-needs-process");
  if (note) note.hidden = buildable;
}

for (const button of $$(".nav-button")) {
  button.addEventListener("click", () => showView(button.dataset.view));
}
for (const button of $$("[data-back-to]")) {
  button.addEventListener("click", () => showView(button.dataset.backTo));
}
for (const button of $$("[data-goto]")) {
  button.addEventListener("click", () => showView(button.dataset.goto));
}

// ---------------------------------------------------------------------------
// Select: folder and profile
// ---------------------------------------------------------------------------

function activateCard(id, handler) {
  const card = document.getElementById(id);
  card.addEventListener("click", handler);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handler(); }
  });
}

activateCard("pick-folder-card", pickFolder);
activateCard("pick-profile-card", () => showView("profile"));
$("#go-to-process").addEventListener("click", () => showView("process"));

async function pickFolder() {
  if (!window.showDirectoryPicker) {
    log("This browser has no File System Access API — use Chrome or Edge over https or localhost.", "err");
    return;
  }
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return; // The person cancelled the native dialog.
  }
  if (!(await verifyPermission(dirHandle, true))) {
    log("Read/write permission was not granted for that folder.", "err");
    return;
  }

  // Defensive reset: an in-flight build is not aborted, but a generation bump
  // stops it touching the log or the UI from here on.
  state.generation++;
  state.dirHandle = dirHandle;
  state.folderName = dirHandle.name;
  state.crate = null;
  state.crateJson = null;
  state.hasBuilt = false;
  state.describeValues = {};
  state.editDirty = false;
  closeAllModals();
  state.preparedCtx = null;
  resetActionButtons();
  setMainProgress(0);
  hideSubProgress(true);
  refreshNav();

  log(`Folder: ${dirHandle.name}`, "ok");
  await scanFolder();

  if (!state.profile) await useDefaultProfile();
  await emitFolderPicked();
  await afterProfileOrFolderChange();
}

/** Names the scan must skip: the core's own outputs plus every declared plugin path. */
function scanExclusions() {
  const names = new Set([...GENERATED_FILENAMES, ...CONTROL_FILENAMES, BACKUP_DIR]);
  for (const entry of OUTPUT_PATHS) names.add(entry.path.split("/")[0]);
  return names;
}

async function scanFolder() {
  log("Scanning folder…", "muted");
  state.files = await walkDirectory(state.dirHandle, {
    excludeTopLevel: scanExclusions(),
    onProgress: (count) => { logStatus.textContent = `Scanning… ${count} file(s)`; },
  });
  state.filesWithMeta = buildFileMetadata(state.files);
  $("#folder-summary").textContent =
    `${state.folderName} — ${state.files.length} file(s) in ${topLevelFolderNames().length} top-level folder(s).`;
  log(`Found ${state.files.length} file(s).`, "ok");

  state.hasBuilt = await fileExists(state.dirHandle, "ro-crate-metadata.json");
  refreshNav();
}

// folder:picked is where a plugin offers prefill data from whatever crate
// metadata the folder already holds — which sources count as "existing crate
// metadata" is the plugin's call, not this app's.
async function emitFolderPicked() {
  const ctx = baseCtx(state.generation);
  await announceAndEmit(bus, HOOKS.FOLDER_PICKED, ctx);
  if (ctx.crateJson) {
    state.crateJson = ctx.crateJson;
    state.describeSourceLabel = ctx.crateSourceLabel || "";
    prefillDescribeFromCrate(ctx.crateJson);
    $("#existing-crate-card").hidden = false;
    $("#existing-crate-summary").textContent = ctx.crateSourceLabel || "an existing crate";
    log(`Existing crate metadata: ${ctx.crateSourceLabel || "found"}.`, "ok");
  } else {
    $("#existing-crate-card").hidden = true;
  }
}

function prefillDescribeFromCrate(crateJson) {
  const graph = crateJson?.["@graph"] || [];
  const descriptor = graph.find((e) => e["@id"] === "ro-crate-metadata.json");
  const rootId = descriptor?.about?.["@id"] || descriptor?.about || "./";
  const root = graph.find((e) => e["@id"] === rootId);
  if (!root) return;
  const values = {};
  for (const field of state.profile?.describeFields || []) {
    const raw = root[field.key];
    if (raw === undefined) continue;
    const list = (Array.isArray(raw) ? raw : [raw]).map((v) =>
      v && typeof v === "object" ? v["@id"] || v.name || "" : String(v)
    );
    values[field.key] = list.join(", ");
  }
  state.describeValues = values;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const profileSelect = $("#profile-select");
const profileStatus = $("#profile-load-status");

async function loadProfileList() {
  try {
    const profiles = await listProfiles();
    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profile.name;
      option.textContent = profile.name;
      profileSelect.append(option);
    }
    profileStatus.textContent = `${profiles.length} profile(s) from the profile repository.`;
  } catch (e) {
    profileStatus.textContent = `Profile list unavailable (${e.message}). The bundled default still works.`;
  }
}

async function useDefaultProfile() {
  profileStatus.textContent = "Loading the bundled default…";
  state.profile = await loadDefaultProfile();
  onProfileSelected();
}

$("#apply-profile").addEventListener("click", async (event) => {
  const name = profileSelect.value;
  try {
    await runAction(event.currentTarget, async () => {
      if (!name) {
        await useDefaultProfile();
      } else {
        profileStatus.textContent = `Fetching ${name}…`;
        state.profile = await loadProfile(await fetchProfile(name));
        onProfileSelected();
      }
      await afterProfileOrFolderChange();
    });
    showView(state.dirHandle ? "process" : "select");
  } catch (e) {
    profileStatus.textContent = `Could not load ${name}: ${e.message}`;
    log(`Profile "${name}" could not be loaded: ${e.message}`, "err");
  }
});

function onProfileSelected() {
  const label = state.profile.name === DEFAULT_PROFILE_NAME
    ? `${DEFAULT_PROFILE_NAME} — minimal crate, plain preview`
    : `${state.profile.name} — ${state.profile.metadata?.description || "from the profile repository"}`;
  $("#profile-summary").textContent = label;
  profileStatus.textContent = `Using ${state.profile.name}.`;
  log(`Profile: ${state.profile.name} (root ${state.profile.rootTypes.join(", ")}).`, "ok");
  if (state.profile.configNote) log(state.profile.configNote, "warn");
  resetOptionsFromProfile();
  state.preparedCtx = null;
  refreshNav();
}

/** profile:selected — plugins named by the profile's tool-config are in play. */
async function afterProfileOrFolderChange() {
  if (!state.profile) return;
  await announceAndEmit(bus, HOOKS.PROFILE_SELECTED, baseCtx(state.generation));
  renderProcessOptions();
  renderBuildOptions();
  renderDescribeSummary();
  refreshNav();
}

// ---------------------------------------------------------------------------
// Process: Describe, then the options that act on files
// ---------------------------------------------------------------------------

activateCard("describe-card", () => { renderDescribeForm(); showView("describe"); });

function renderProcessOptions() {
  const nodes = PLUGIN_OPTIONS_SCHEMA.filter((node) => PROCESS_OPTION_KEYS.has(node.key));
  const count = renderOptionTree($("#process-options"), nodes, { onChange: onOptionChanged });
  // Only options that change what Process does count towards "Build waits for
  // Process" — a profile offering nothing here but an action (the transcript
  // grammar editor) has nothing to process.
  state.processOptionCount = nodes.filter((node) => node.type !== "action" && isOptionVisible(node.key)).length;
  $("#process-options-empty").hidden = count > 0;
  populateDynamicSelects($("#process-options"));
}

function renderBuildOptions() {
  const nodes = PLUGIN_OPTIONS_SCHEMA.filter((node) => !PROCESS_OPTION_KEYS.has(node.key));
  const count = renderOptionTree($("#build-options"), nodes, { onChange: onOptionChanged });
  $("#build-options-empty").hidden = count > 0;
  populateDynamicSelects($("#build-options"));
}

function onOptionChanged(node) {
  // Processing options decide what Process does, so changing one invalidates
  // what it left behind — Build closes again until it has been re-run.
  // An action stores no option value, so running one changes nothing Process
  // reads.
  if (!node || (node.type !== "action" && PROCESS_KEYS_DEEP.has(node.key))) {
    state.preparedCtx = null;
    refreshNav();
  }
  // Options are per-build and reset from the profile each run, so nothing is
  // persisted here — but a dependent select may now need its choices.
  populateDynamicSelects($("#process-options"));
  populateDynamicSelects($("#build-options"));
}

function renderDescribeSummary() {
  const fields = state.profile?.describeFields || [];
  const filled = fields.filter((field) => (state.describeValues[field.key] || "").trim()).length;
  $("#describe-summary").textContent = fields.length
    ? `${filled} of ${fields.length} field(s) filled in.`
    : "This profile declares no root fields.";
  // With several possible sources, "where did these values come from?"
  // deserves an answer that doesn't require opening any of them.
  $("#describe-source").textContent = state.describeSourceLabel
    ? `Prefilled from ${state.describeSourceLabel}`
    : "";
}

function renderDescribeForm() {
  const form = $("#describe-form");
  form.replaceChildren();
  const fields = state.profile?.describeFields || [];
  $("#describe-prefill-note").textContent = state.describeSourceLabel
    ? `Prefilled from ${state.describeSourceLabel}.`
    : "Fields come from the active profile's root class definition.";

  for (const field of fields) {
    const label = document.createElement("label");
    label.className = "field";
    const caption = document.createElement("span");
    caption.className = "field-label";
    caption.textContent = field.label;
    if (field.required) {
      const star = document.createElement("span");
      star.className = "field-required";
      star.textContent = "*";
      caption.append(star);
    }
    label.append(caption, describeControl(field));
    if (field.help || field.multiple) {
      const hint = document.createElement("p");
      hint.className = "field-hint";
      hint.textContent = [field.help, field.multiple ? "Multiple values: separate with commas." : ""]
        .filter(Boolean).join(" ");
      label.append(hint);
    }
    form.append(label);
  }
}

function describeControl(field) {
  const value = state.describeValues[field.key] ?? "";
  const bind = (element) => {
    element.addEventListener("input", () => { state.describeValues[field.key] = element.value; });
    element.addEventListener("change", () => { state.describeValues[field.key] = element.value; });
    return element;
  };

  if (field.control === "select") {
    const select = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— none —";
    select.append(blank);
    for (const option of field.values) {
      const element = document.createElement("option");
      const text = typeof option === "object" ? option["@id"] || option.name : String(option);
      element.value = text;
      element.textContent = text;
      select.append(element);
    }
    select.value = value;
    return bind(select);
  }
  if (field.control === "textarea") {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    return bind(textarea);
  }
  const input = document.createElement("input");
  input.type = field.control === "date" ? "date" : field.control === "url" ? "url" : "text";
  // Date inputs default to today, so a person filling the form in gets a
  // sensible datePublished without typing one.
  input.value = value || (field.control === "date" ? new Date().toISOString().slice(0, 10) : "");
  state.describeValues[field.key] = input.value;
  if (field.control === "entity") input.placeholder = `${field.types.join(" / ")} — name or identifier`;
  return bind(input);
}

$("#save-describe").addEventListener("click", async (event) => {
  await runAction(event.currentTarget, () => {
    renderDescribeSummary();
    log("Description saved for this session.", "ok");
  });
  showView("process");
});

/** Turn the form's flat strings into the root-dataset shape buildCrate wants. */
function describeValuesToRootProperties() {
  const out = {};
  for (const field of state.profile?.describeFields || []) {
    const raw = String(state.describeValues[field.key] ?? "").trim();
    if (!raw) continue;
    // Multi-valued properties take comma-separated input.
    const parts = field.multiple ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [raw];
    if (field.control === "entity") {
      // A class range synthesises a linked entity rather than storing a string.
      out[field.key] = parts.map((part) => ({
        "@id": /^(https?:|arcp:|#|\.\/)/.test(part) ? part : `#${slug(part)}`,
        "@type": field.types[0] || "Thing",
        name: part,
      }));
    } else {
      out[field.key] = parts;
    }
  }
  return out;
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------------------------------------------------------------------------
// ctx assembly
// ---------------------------------------------------------------------------

function baseCtx(generation, extra = {}) {
  const rootProperties = describeValuesToRootProperties();
  const config = state.profile ? profileToConfig(state.profile, rootProperties) : null;
  return {
    // The folder and its files.
    dirHandle: state.dirHandle,
    selectedDir: state.dirHandle,
    folderName: state.folderName,
    files: state.files,
    filesWithMeta: state.filesWithMeta,
    // Every Build option and Setting, flattened.
    options: { ...state.options, ...state.settings },
    config,
    selectedProfileData: state.profile,
    crateJson: state.crateJson,
    lastHtmlTemplate: state.lastHtmlTemplate,
    log: generationLog(generation),
    ...extra,
  };
}

function adoptCtx(ctx) {
  state.filesWithMeta = ctx.filesWithMeta || state.filesWithMeta;
  state.crate = ctx.crate || state.crate;
  if (ctx.lastHtmlTemplate) state.lastHtmlTemplate = ctx.lastHtmlTemplate;
}

// ---------------------------------------------------------------------------
// Running the pipeline
// ---------------------------------------------------------------------------

async function runStages(stages, { label, reusePrepared = false }) {
  if (!state.dirHandle) { log("Choose a folder first.", "warn"); return null; }
  if (!state.profile) { log("No profile loaded.", "warn"); return null; }
  if (state.running) { log("A run is already in progress.", "warn"); return null; }

  const generation = ++state.generation;
  state.running = true;
  setMainProgress(0);
  hideSubProgress(true);

  // A build continues the ctx Process left behind, so everything the file
  // stages put there — langById, caDataPrep, chatExport, xlsxCrate, whatever a
  // plugin invented — is still in hand when the crate is assembled. The
  // host-owned fields are refreshed over it (options and describe values can
  // have changed since), and the plugin-owned ones are carried untouched.
  const fresh = baseCtx(generation);
  const ctx = reusePrepared && state.preparedCtx
    ? Object.assign(state.preparedCtx, fresh)
    : fresh;
  ctx.progress = createProgress(progressUiFor(generation));

  try {
    // Stale plugin output is cleared by any run that will write files —
    // files:write reaches the folder just as crate:write does. The crate
    // backup belongs only to a run that rewrites the crate itself.
    if (stages.includes(HOOKS.FILES_WRITE) || stages.includes(HOOKS.CRATE_WRITE)) {
      await clearDeclaredOutputs(ctx);
    }
    if (stages.includes(HOOKS.CRATE_WRITE)) await backupCrateFiles(ctx);
    log(`${label}…`, "info");
    await runPipeline(ctx, { bus, stages, collectTypeCounts });
    if (generation !== state.generation) return null;
    adoptCtx(ctx);
    log(`${label} finished.`, "ok");
    return ctx;
  } catch (error) {
    if (generation === state.generation) log(`${label} failed: ${error.message}`, "err");
    console.error(error);
    return null;
  } finally {
    state.running = false;
  }
}

// Existing ro-crate-metadata files are moved into a dated _backups subdir
// before the new ones are written; the delete-plugin-output setting, when on,
// clears every declared plugin path first so stale output can't linger.
async function clearDeclaredOutputs(ctx) {
  if (!ctx.options.deleteOutputsBeforeBuild) return;
  let removed = 0;
  for (const entry of OUTPUT_PATHS) {
    if (await removePath(state.dirHandle, entry.path)) removed++;
  }
  ctx.log(`Deleted ${removed} declared plugin output path(s) before writing.`, removed ? "ok" : "muted");
}

async function backupCrateFiles(ctx) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const name of ["ro-crate-metadata.json", "ro-crate-metadata.xlsx"]) {
    const target = await backupFile(state.dirHandle, name, stamp);
    if (target) ctx.log(`Backed up ${name} → ${target}`, "muted");
  }
}

$("#run-process").addEventListener("click", async (event) => {
  const ctx = await runAction(event.currentTarget, () => runStages(
    [HOOKS.FILES_PREPARE, HOOKS.FILES_WRITE, HOOKS.METADATA_MERGE],
    { label: "Processing files" }
  ));
  if (!ctx) return;
  // Build runs on what this left behind, so it only opens once this has run.
  state.preparedCtx = ctx;
  renderDescribeSummary();
  refreshNav();
});

$("#run-build").addEventListener("click", async (event) => {
  const ctx = await runAction(event.currentTarget, () => runStages(
    [HOOKS.CRATE_PREPARE, HOOKS.CRATE_BUILD, HOOKS.CRATE_VALIDATE, HOOKS.CRATE_WRITE],
    { label: "Building the RO-Crate", reusePrepared: true }
  ));
  if (!ctx) return;
  state.hasBuilt = true;
  state.crateJson = ctx.crate ? JSON.parse(crateToJsonString(ctx.crate)) : state.crateJson;
  renderBuildResult(ctx);
  refreshNav();
});

function renderBuildResult(ctx) {
  const card = $("#build-result");
  const body = $("#build-result-body");
  card.hidden = false;
  const counts = Object.entries(ctx.typeCounts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type} ${n}`)
    .join(" · ");
  body.replaceChildren();
  const summary = document.createElement("p");
  summary.textContent = `${ctx.entities || 0} entities — ${counts || "no typed entities"}`;
  const when = document.createElement("p");
  when.className = "field-hint";
  when.textContent = `Built ${new Date().toLocaleString()} in ${state.folderName}.`;
  body.append(summary, when);
}

// ---------------------------------------------------------------------------
// Show: preview, JSON, spreadsheet. No hooks run in this mode.
// ---------------------------------------------------------------------------

for (const tab of $$("[data-show-tab]")) {
  tab.addEventListener("click", () => {
    for (const other of $$("[data-show-tab]")) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      document.getElementById(`show-${other.dataset.showTab}`).hidden = !selected;
    }
  });
}

async function refreshShowView() {
  const hasPreview = await fileExists(state.dirHandle, "ro-crate-preview.html");
  $("#open-preview").disabled = !hasPreview;
  $("#preview-status").textContent = hasPreview
    ? "ro-crate-preview.html is in the folder."
    : "No ro-crate-preview.html — turn on “Generate ro-crate-preview.html” and build.";
  await renderJsonViewer();
  await renderXlsxViewer();
}

// The preview window calls this when a link to another preview page is
// clicked: it holds the directory handle, so it is the only side that can turn
// a folder-relative page path into something the window can navigate to. Every
// blob it hands out is tracked, so one revoke sweep clears them all.
window[PAGE_RESOLVER_NAME] = async (path) => {
  if (!state.dirHandle || !path) return null;
  try {
    const { url, revoke } = await buildPreviewBlobUrl(state.dirHandle, path);
    state.previewRevokes.push(revoke);
    return url;
  } catch (e) {
    log(`Preview page "${path}" could not be opened: ${e.message}`, "warn");
    return null;
  }
};

function revokePreviewBlobs() {
  for (const revoke of state.previewRevokes.splice(0)) revoke();
}

$("#open-preview").addEventListener("click", async (event) => {
  await runAction(event.currentTarget, async () => {
    // The window is opened synchronously, before the first await: a popup
    // opened after one has lost the click's user activation and is blocked.
    const preview = window.open("", "_blank");
    if (!preview) {
      $("#preview-status").textContent =
        "The browser blocked the preview window — allow pop-ups for this site, then try again.";
      return false;
    }
    try {
      // The previous preview's blobs — its pages included — go now that a new
      // window is replacing it.
      revokePreviewBlobs();
      const { url, revoke } = await buildPreviewBlobUrl(state.dirHandle, "ro-crate-preview.html");
      state.previewRevokes.push(revoke);
      preview.location.href = url;
      $("#preview-status").textContent = "Opened ro-crate-preview.html in a new window.";
      return true;
    } catch (e) {
      preview.close();
      $("#preview-status").textContent = e.message;
      return false;
    }
  });
});

let jsonGraph = [];

async function renderJsonViewer() {
  const json = state.crateJson || (await readJsonFromFolder(state.dirHandle, "ro-crate-metadata.json"));
  jsonGraph = json?.["@graph"] || [];
  state.crateJson = json || state.crateJson;
  drawJson($("#json-filter").value);
}

$("#json-filter").addEventListener("input", (event) => drawJson(event.target.value));

function drawJson(filterText) {
  const viewer = $("#json-viewer");
  viewer.replaceChildren();
  const needle = filterText.trim().toLowerCase();
  const matches = jsonGraph.filter((entity) =>
    !needle || JSON.stringify(entity).toLowerCase().includes(needle)
  );
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = jsonGraph.length ? "Nothing matches that filter." : "No crate JSON in this folder yet.";
    viewer.append(empty);
    return;
  }
  for (const entity of matches.slice(0, 500)) {
    const block = document.createElement("div");
    block.className = "json-entity";
    const head = document.createElement("div");
    const id = document.createElement("span");
    id.className = "json-id";
    id.textContent = entity["@id"];
    const type = document.createElement("span");
    type.className = "json-type";
    type.textContent = `  ${[].concat(entity["@type"] || []).join(", ")}`;
    head.append(id, type);
    block.append(head);
    for (const [key, value] of Object.entries(entity)) {
      if (key === "@id" || key === "@type") continue;
      const row = document.createElement("span");
      row.className = "json-prop";
      const name = document.createElement("span");
      name.className = "json-key";
      name.textContent = `${key}: `;
      row.append(name, document.createTextNode(formatValue(value)));
      block.append(row);
    }
    viewer.append(block);
  }
  if (matches.length > 500) {
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = `Showing the first 500 of ${matches.length} entities — narrow the filter to see the rest.`;
    viewer.append(note);
  }
}

function formatValue(value) {
  return [].concat(value)
    .map((v) => (v && typeof v === "object" ? v["@id"] || JSON.stringify(v) : String(v)))
    .join(", ");
}

let xlsxSheets = [];

async function renderXlsxViewer() {
  const select = $("#xlsx-sheet");
  const table = $("#xlsx-table");
  select.replaceChildren();
  table.replaceChildren();
  const file = await statFile(state.dirHandle, "ro-crate-metadata.xlsx");
  if (!file) {
    const row = table.insertRow();
    row.insertCell().textContent = "No ro-crate-metadata.xlsx in this folder.";
    return;
  }
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  xlsxSheets = workbook.worksheets.map((sheet) => ({
    name: sheet.name,
    rows: sheet.getSheetValues().slice(1).map((row) => (row || []).slice(1).map((cell) => cellText(cell))),
  }));
  for (const sheet of xlsxSheets) {
    const option = document.createElement("option");
    option.value = sheet.name;
    option.textContent = sheet.name;
    select.append(option);
  }
  drawSheet(xlsxSheets[0]);
}

$("#xlsx-sheet").addEventListener("change", (event) => {
  drawSheet(xlsxSheets.find((sheet) => sheet.name === event.target.value));
});

function cellText(cell) {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "object") return cell.text ?? cell.result ?? cell.hyperlink ?? JSON.stringify(cell);
  return String(cell);
}

function drawSheet(sheet) {
  const table = $("#xlsx-table");
  table.replaceChildren();
  if (!sheet) return;
  const [header, ...body] = sheet.rows;
  if (header) {
    const head = table.createTHead().insertRow();
    for (const cell of header) {
      const th = document.createElement("th");
      th.textContent = cell;
      head.append(th);
    }
  }
  const tbody = table.createTBody();
  for (const row of body.slice(0, 300)) {
    const tr = tbody.insertRow();
    for (const cell of row) tr.insertCell().textContent = cell;
  }
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

$("#open-settings").addEventListener("click", openSettings);

async function openSettings() {
  const body = $("#tpl-settings").content.cloneNode(true);
  await openModal({
    title: "Settings",
    body,
    actions: [{ label: "Done", primary: true, value: true }],
    onMount: (content) => {
      const dark = content.querySelector("#setting-dark");
      dark.checked = state.settings.themeMode === "dark";
      dark.addEventListener("change", () => {
        state.settings.themeMode = dark.checked ? "dark" : "light";
        applyTheme();
        saveSettings();
      });

      bindSetting(content.querySelector("#setting-topLevelFolderType"), "topLevelFolderType");
      bindSetting(content.querySelector("#setting-overwrite"), "overwrite");
      bindSetting(content.querySelector("#setting-deleteOutputsBeforeBuild"), "deleteOutputsBeforeBuild");

      // Plugin settings compose in exactly like build options, but are never
      // gated by the profile — they are machine and user preferences.
      const host = content.querySelector("#plugin-settings");
      const schemas = composeSettingsSchema();
      if (!schemas.length) {
        const note = document.createElement("p");
        note.className = "empty-note";
        note.textContent = "No plugin settings.";
        host.append(note);
      }
      for (const entry of schemas) {
        const label = document.createElement("label");
        label.className = "field inline";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!state.settings[entry.key];
        input.addEventListener("change", () => {
          state.settings[entry.key] = input.checked;
          state.options[entry.key] = input.checked;
          saveSettings();
        });
        const span = document.createElement("span");
        span.className = "field-label";
        span.textContent = entry.label;
        label.append(input, span);
        host.append(label);
      }
    },
  });
}

function bindSetting(element, key) {
  if (!element) return;
  const isCheckbox = element.type === "checkbox";
  if (isCheckbox) element.checked = !!state.settings[key];
  else element.value = state.settings[key] ?? "";
  element.addEventListener("change", () => {
    state.settings[key] = isCheckbox ? element.checked : element.value;
    state.options[key] = state.settings[key];
    saveSettings();
  });
}

// ---------------------------------------------------------------------------
// Edit: a live ROCrate over the folder's ro-crate-metadata.json (SPEC.md §6.3).
// No hooks run in this mode.
// ---------------------------------------------------------------------------

let editCrate = null;

async function refreshEditView() {
  if (!state.dirHandle) return;
  if (!editCrate || !state.editDirty) {
    const json = await readJsonFromFolder(state.dirHandle, "ro-crate-metadata.json");
    if (!json) {
      $("#entity-editor").replaceChildren(note("No ro-crate-metadata.json in this folder — build the crate first."));
      $("#entity-list").replaceChildren();
      return;
    }
    editCrate = new ROCrate(json, { array: true, link: true });
    state.editDirty = false;
  }
  populateTypeFilter();
  renderEntityList();
  markDirty(state.editDirty);
}

function note(text) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty-note";
  paragraph.textContent = text;
  return paragraph;
}

function populateTypeFilter() {
  const select = $("#edit-type-filter");
  const current = select.value;
  select.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All types";
  select.append(all);
  const types = new Set();
  for (const entity of editCrate.getGraph()) {
    for (const type of [].concat(entity["@type"] || [])) types.add(String(type));
  }
  for (const type of [...types].sort()) {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    select.append(option);
  }
  select.value = current;
}

$("#edit-type-filter").addEventListener("change", renderEntityList);
$("#edit-text-filter").addEventListener("input", renderEntityList);

function renderEntityList() {
  const list = $("#entity-list");
  list.replaceChildren();
  const matches = listEntities(editCrate, {
    type: $("#edit-type-filter").value,
    text: $("#edit-text-filter").value,
  });
  for (const entity of matches.slice(0, 400)) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(entity["@id"] === state.selectedEntityId));
    const name = document.createElement("span");
    name.textContent = [].concat(entity.name || [])[0] || entity["@id"];
    const id = document.createElement("span");
    id.className = "entity-id";
    id.textContent = `${entity["@id"]} · ${[].concat(entity["@type"] || []).join(", ")}`;
    button.append(name, id);
    button.addEventListener("click", () => {
      state.selectedEntityId = entity["@id"];
      renderEntityList();
      renderEntityEditor();
    });
    item.append(button);
    list.append(item);
  }
  if (!matches.length) list.append(Object.assign(document.createElement("li"), { textContent: "" }), note("Nothing matches."));
}

function renderEntityEditor() {
  const host = $("#entity-editor");
  host.replaceChildren();
  const entity = editCrate.getEntity(state.selectedEntityId);
  if (!entity) { host.append(note("Choose an entity on the left to edit it.")); return; }

  const locked = isStructuralEntity(editCrate, entity["@id"]);

  const idRow = document.createElement("div");
  idRow.className = "field";
  const idLabel = document.createElement("span");
  idLabel.className = "field-label";
  idLabel.textContent = "@id";
  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.className = "mono";
  idInput.value = entity["@id"];
  idInput.disabled = locked;
  idRow.append(idLabel, idInput);
  if (locked) {
    // Structural entities encode their place in the crate; renaming one breaks
    // the crate's relationship to the folder, so the identifier is locked.
    idRow.append(Object.assign(document.createElement("p"), {
      className: "locked-note",
      textContent: "Structural entity — its identifier maps to the folder and cannot be renamed.",
    }));
  } else {
    idInput.addEventListener("change", () => {
      try {
        const renamed = renameEntityId(editCrate, entity["@id"], idInput.value.trim());
        state.selectedEntityId = renamed["@id"];
        markDirty(true);
        renderEntityList();
        renderEntityEditor();
        log(`Renamed to ${renamed["@id"]}, following every reference.`, "ok");
      } catch (e) {
        idInput.value = entity["@id"];
        log(e.message, "err");
      }
    });
  }
  host.append(idRow);

  const typeRow = document.createElement("div");
  typeRow.className = "field";
  typeRow.append(Object.assign(document.createElement("span"), { className: "field-label", textContent: "@type" }));
  const typeInput = document.createElement("input");
  typeInput.type = "text";
  typeInput.className = "mono";
  typeInput.value = [].concat(entity["@type"] || []).join(", ");
  typeInput.addEventListener("change", () => {
    entity["@type"] = typeInput.value.split(",").map((s) => s.trim()).filter(Boolean);
    markDirty(true);
    populateTypeFilter();
    renderEntityList();
  });
  typeRow.append(typeInput);
  host.append(typeRow);

  for (const property of Object.keys(entity).filter((k) => k !== "@id" && k !== "@type").sort()) {
    host.append(propertyRow(entity, property));
  }

  const addRow = document.createElement("div");
  addRow.className = "actions";
  const newProperty = document.createElement("input");
  newProperty.type = "text";
  newProperty.placeholder = "new property name";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "button";
  addButton.textContent = "Add property";
  addButton.addEventListener("click", () => {
    const key = newProperty.value.trim();
    if (!key) return;
    setEntityProperty(editCrate, entity["@id"], key, [""]);
    markDirty(true);
    renderEntityEditor();
  });
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "button danger";
  deleteButton.textContent = "Delete entity";
  deleteButton.disabled = entity["@id"] === editCrate.rootId;
  deleteButton.addEventListener("click", async () => {
    const confirmed = await openModal({
      title: "Delete entity",
      body: `<p>Delete <span class="mono">${escapeHtml(entity["@id"])}</span>? Every reference to it is removed too.</p>`,
      actions: [{ label: "Cancel", value: false }, { label: "Delete", primary: true, value: true }],
    });
    if (!confirmed) return;
    deleteEntity(editCrate, entity["@id"]);
    state.selectedEntityId = null;
    markDirty(true);
    renderEntityList();
    renderEntityEditor();
    log("Entity deleted, references cleaned up.", "ok");
  });
  addRow.append(newProperty, addButton, deleteButton);
  host.append(addRow);
}

function propertyRow(entity, property) {
  const box = document.createElement("div");
  box.append(Object.assign(document.createElement("div"), { className: "prop-name", textContent: property }));

  const values = [].concat(entity[property] ?? []);
  values.forEach((value, index) => {
    const row = document.createElement("div");
    row.className = "prop-row";
    const input = document.createElement("input");
    input.type = "text";
    input.value = value && typeof value === "object" ? value["@id"] || "" : String(value);
    input.setAttribute("aria-label", `${property} value ${index + 1}`);
    const isReference = !!(value && typeof value === "object");
    input.addEventListener("change", () => {
      const next = [].concat(entity[property] ?? []);
      next[index] = isReference ? { "@id": input.value } : input.value;
      setEntityProperty(editCrate, entity["@id"], property, next);
      markDirty(true);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button subtle";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", `Remove ${property} value ${index + 1}`);
    remove.addEventListener("click", () => {
      const next = [].concat(entity[property] ?? []).filter((_, i) => i !== index);
      if (next.length) setEntityProperty(editCrate, entity["@id"], property, next);
      else deleteEntityProperty(editCrate, entity["@id"], property);
      markDirty(true);
      renderEntityEditor();
    });
    row.append(input, remove);
    box.append(row);
  });

  const actions = document.createElement("div");
  actions.className = "actions";
  const addValue = document.createElement("button");
  addValue.type = "button";
  addValue.className = "button subtle";
  addValue.textContent = "+ value";
  addValue.addEventListener("click", () => {
    setEntityProperty(editCrate, entity["@id"], property, [...values, ""]);
    markDirty(true);
    renderEntityEditor();
  });
  const removeProperty = document.createElement("button");
  removeProperty.type = "button";
  removeProperty.className = "button subtle";
  removeProperty.textContent = "Remove property";
  removeProperty.addEventListener("click", () => {
    deleteEntityProperty(editCrate, entity["@id"], property);
    markDirty(true);
    renderEntityEditor();
  });
  actions.append(addValue, removeProperty);
  box.append(actions);
  return box;
}

$("#add-entity").addEventListener("click", async () => {
  const form = document.createElement("div");
  const id = document.createElement("input");
  id.type = "text";
  id.placeholder = "#new-entity";
  id.className = "mono";
  const type = document.createElement("input");
  type.type = "text";
  type.placeholder = "Person";
  type.className = "mono";
  form.append(
    Object.assign(document.createElement("p"), { className: "field-label", textContent: "@id" }), id,
    Object.assign(document.createElement("p"), { className: "field-label", textContent: "@type" }), type
  );
  const result = await openModal({
    title: "Add entity",
    body: form,
    actions: [
      { label: "Cancel", value: null },
      { label: "Add", primary: true, value: () => ({ id: id.value.trim(), type: type.value.trim() || "Thing" }) },
    ],
  });
  if (!result?.id) return;
  try {
    addEntity(editCrate, { "@id": result.id, "@type": result.type, name: result.id.replace(/^#/, "") });
    state.selectedEntityId = result.id;
    markDirty(true);
    populateTypeFilter();
    renderEntityList();
    renderEntityEditor();
  } catch (e) {
    log(e.message, "err");
  }
});

function markDirty(dirty) {
  state.editDirty = dirty;
  $("#dirty-badge").hidden = !dirty;
  $("#save-edits").disabled = !dirty;
}

// Saving rewrites the JSON and regenerates the xlsx and HTML if those files
// already exist, reusing the session's last template so a styled preview isn't
// silently downgraded to a plain one.
$("#save-edits").addEventListener("click", async (event) => {
  armActionButton(event.currentTarget);
  if (!editCrate) return;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await backupFile(state.dirHandle, "ro-crate-metadata.json", stamp);
    await writeFile(state.dirHandle, "ro-crate-metadata.json", crateToJsonString(editCrate));
    log("Wrote ro-crate-metadata.json.", "ok");

    if (await fileExists(state.dirHandle, "ro-crate-metadata.xlsx")) {
      await writeFile(state.dirHandle, "ro-crate-metadata.xlsx", await crateToXlsxBytes(editCrate));
      log("Regenerated ro-crate-metadata.xlsx.", "ok");
    }
    if (await fileExists(state.dirHandle, "ro-crate-preview.html")) {
      const groups = state.lastHtmlTemplate?.propertyGroups || resolvePropertyGroups(state.profile);
      await writeFile(state.dirHandle, "ro-crate-preview.html",
        await crateToPreviewHtml(editCrate, { layouts: { default: groups } }));
      log("Regenerated ro-crate-preview.html.", "ok");
    }
    state.crateJson = JSON.parse(crateToJsonString(editCrate));
    markDirty(false);
    event.currentTarget.classList.add("ok");
  } catch (e) {
    event.currentTarget.classList.add("err");
    log(`Save failed: ${e.message}`, "err");
  }
});

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------------------
// Visualise: the panel host (SPEC.md §6.4)
// ---------------------------------------------------------------------------
//
// The page owns two things and no analysis of its own: which output directory
// is loaded, and which plugin's panel is showing. Everything drawn in the
// right-hand column comes from a plugin.

const PANELS = composeVisualisationPanels();

let visDirectories = [];
let visData = { documents: [], tables: [] };
let visPanelName = PANELS[0]?.name || "";
let visDirectoryPath = "";

function renderPanelList() {
  const list = $("#vis-panel-list");
  list.replaceChildren();
  if (!PANELS.length) {
    const empty = document.createElement("li");
    empty.className = "empty-note";
    empty.textContent = "No visualisation panels in this build — none of the selected plugins offers one.";
    list.append(empty);
    return;
  }
  for (const panel of PANELS) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(panel.name === visPanelName));
    button.append(
      Object.assign(document.createElement("span"), { textContent: panel.label }),
      Object.assign(document.createElement("span"), { className: "entity-id", textContent: panel.hint || "" }),
    );
    button.addEventListener("click", () => {
      visPanelName = panel.name;
      renderPanelList();
      // Switching panels never reloads: both see the same corpus, which is
      // what makes running one through two of them a comparison.
      renderPanel();
    });
    const item = document.createElement("li");
    item.append(button);
    list.append(item);
  }
}

function renderPanel() {
  const host = $("#vis-panel");
  host.replaceChildren();
  const panel = PANELS.find((entry) => entry.name === visPanelName);
  if (!panel) {
    host.append(note("Choose a panel on the left."));
    return;
  }
  try {
    panel.render(host, { documents: visData.documents, tables: visData.tables, log });
  } catch (e) {
    // A panel that throws takes the page down with it otherwise — and the
    // panel is a plugin, so this is somebody else's bug to see, not to hide.
    host.replaceChildren(note(`The ${panel.label} panel failed to render: ${e.message}`));
    log(`Visualise: the ${panel.label} panel threw — ${e.message}`, "err");
    console.error(e);
  }
}

async function loadVisualiseDirectory(path) {
  const directory = visDirectories.find((entry) => entry.path === path);
  const status = $("#vis-data-status");
  if (!directory) {
    visData = { documents: [], tables: [] };
    renderPanel();
    return;
  }
  visDirectoryPath = path;
  status.textContent = `Reading ${directory.count} file(s) from ${path}…`;
  visData = await loadDirectory(directory.files, readerFor(state.dirHandle), log);
  status.textContent =
    `${visData.documents.length} line(s) from ${directory.count} file(s)` +
    (visData.tables.length ? `, ${visData.tables.length} table(s)` : "");
  renderPanel();
}

async function refreshVisualiseView() {
  if (!state.dirHandle) return;
  renderPanelList();

  const select = $("#vis-directory");
  visDirectories = await scanOutputDirectories(state.dirHandle, OUTPUT_PATHS);
  select.replaceChildren();

  if (!visDirectories.length) {
    $("#vis-data-status").textContent =
      "No output folders with readable files yet — process or build first.";
    select.disabled = true;
    visData = { documents: [], tables: [] };
    renderPanel();
    return;
  }

  select.disabled = false;
  for (const directory of visDirectories) {
    select.append(Object.assign(document.createElement("option"), {
      value: directory.path,
      textContent: `${directory.path} — ${directory.count} file(s)`,
    }));
  }
  // Keep the chosen folder across visits when it is still there.
  const keep = visDirectories.some((entry) => entry.path === visDirectoryPath);
  select.value = keep ? visDirectoryPath : visDirectories[0].path;
  await loadVisualiseDirectory(select.value);
}

$("#vis-directory").addEventListener("change", (event) => loadVisualiseDirectory(event.target.value));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  $("#version-tag").textContent = `v${APP_VERSION}`;
  state.settings = loadSettings();
  applyTheme();

  // c2c:loaded — the context object exists; plugins may set up shared state.
  await announceAndEmit(bus, HOOKS.C2C_LOADED, baseCtx(state.generation));

  await useDefaultProfile();
  await afterProfileOrFolderChange();
  loadProfileList();

  showView("select");
  refreshNav();
  log(`Collection2Crate v${APP_VERSION} ready — ${PLUGINS.length} plugin(s) loaded.`, "ok");

  if (!window.showDirectoryPicker) {
    log("This browser has no File System Access API. Use Chrome or Edge, over https or localhost.", "warn");
  }
}

boot().catch((error) => {
  log(`Startup failed: ${error.message}`, "err");
  console.error(error);
});
