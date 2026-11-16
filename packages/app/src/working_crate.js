// CORE — the working crate (SPEC.md §4.4a): the one RO-Crate object the UI
// shows and edits between pipeline runs, and the Describe form's view of its
// root.
//
// Isomorphic: plain data in, an ROCrate out, no DOM and no file handles —
// tests/test-working-crate.mjs drives it under Node. Writing it to the folder
// is main.js's job; this module only tracks whether that is still owed.

import { openCrate } from "./existing_crate.js";

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const refId = (v) => (v && typeof v === "object" ? v["@id"] || null : null);

let tokenCounter = 0;

/**
 * @param {object} [args]
 * @param {object|null} [args.json]  the crate as read from the folder, or null
 * @param {boolean} [args.onDisk]    whether that JSON came from the folder
 */
export function createWorkingCrate({ json = null, onDisk = false } = {}) {
  let crate = openCrate(json);
  let dirty = false;
  let saved = onDisk;
  // A token that changes on every edit or replacement, so a snapshot taken
  // from one state can tell it is stale ("Process ran on a different crate").
  let token = ++tokenCounter;
  let cache = { token: null, json: null };

  return {
    get crate() { return crate; },
    /** Unsaved changes exist. */
    get dirty() { return dirty; },
    /** The folder holds a crate file for this crate (loaded, built or saved). */
    get onDisk() { return saved; },
    get token() { return token; },

    /** Anything worth showing: a crate file, or edits to one that isn't written yet. */
    get hasContent() {
      return saved || dirty || crate.getGraph().length > 2;
    },

    /** Plain JSON for the current state, cached until the next change. */
    toJSON() {
      if (cache.token !== token) {
        cache = { token, json: JSON.parse(JSON.stringify(crate.toJSON())) };
      }
      return cache.json;
    },

    /** Record an edit made to `crate` in place. */
    touch() {
      dirty = true;
      token = ++tokenCounter;
    },

    /** The crate now matches the folder's files. */
    markSaved() {
      dirty = false;
      saved = true;
    },

    /** Swap in another crate — a build's result, typically. */
    replace(nextJson, { onDisk: nextOnDisk = true, dirty: nextDirty = false } = {}) {
      crate = openCrate(nextJson);
      saved = nextOnDisk;
      dirty = nextDirty;
      token = ++tokenCounter;
    },
  };
}

// ---------------------------------------------------------------------------
// The Describe form's view of the root (SPEC.md §5.3)
// ---------------------------------------------------------------------------

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const looksLikeId = (text) => /^(https?:|arcp:|#|\.\/)/.test(text);

/** How one root value reads in a text field: an entity's name, else its @id. */
function displayOf(value) {
  if (value && typeof value === "object") {
    const name = asArray(value.name)[0];
    return name !== undefined && name !== null && name !== "" ? String(name) : value["@id"] || "";
  }
  return value === undefined || value === null ? "" : String(value);
}

/** The text a Describe field shows for the crate's root. */
export function rootFieldText(crate, field) {
  const values = asArray(crate?.rootDataset?.[field.key]);
  return values.map(displayOf).filter((text) => text !== "").join(", ");
}

/** Every Describe field's text, keyed by property. */
export function rootFormValues(crate, fields = []) {
  const out = {};
  for (const field of fields) {
    const text = rootFieldText(crate, field);
    if (text) out[field.key] = text;
  }
  return out;
}

/**
 * The Describe fields' values as they stand on the root, in the shape
 * profileToConfig() takes — references as bare `{ "@id" }`, so nothing is
 * re-synthesised from display text.
 */
export function rootPropertiesForFields(crate, fields = []) {
  const out = {};
  for (const field of fields) {
    const values = asArray(crate?.rootDataset?.[field.key])
      .map((v) => (refId(v) ? { "@id": refId(v) } : v))
      .filter((v) => v !== "" && v !== null && v !== undefined);
    if (values.length) out[field.key] = values;
  }
  return out;
}

/**
 * Write one Describe field's text onto the root. An empty field removes the
 * property. For an entity field, a part that still reads the same as a value
 * the root already has keeps that value — its @id and the linked entity —
 * and only new text mints a `{ @id, @type, name }` entity.
 *
 * @returns {boolean} whether the root changed
 */
export function applyFieldText(crate, field, text) {
  const root = crate.rootDataset;
  const raw = String(text ?? "").trim();
  const parts = raw
    ? (field.multiple ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [raw])
    : [];
  const before = JSON.stringify(asArray(root[field.key]).map((v) => refId(v) || v));

  if (!parts.length) {
    if (root[field.key] === undefined) return false;
    delete root[field.key];
    return true;
  }

  let next;
  if (field.control === "entity") {
    const existing = asArray(root[field.key]);
    next = parts.map((part) => {
      const kept = existing.find((v) => refId(v) && (displayOf(v) === part || refId(v) === part));
      if (kept) return { "@id": refId(kept) };
      const id = looksLikeId(part) ? part : `#${slug(part)}`;
      if (crate.getEntity(id)) return { "@id": id };
      return { "@id": id, "@type": asArray(field.types)[0] || "Thing", name: part };
    });
  } else {
    next = parts;
  }

  const after = JSON.stringify(next.map((v) => refId(v) || v));
  if (after === before) return false;
  root[field.key] = next;
  return true;
}
