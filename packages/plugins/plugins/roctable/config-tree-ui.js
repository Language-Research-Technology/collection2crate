// The in-app editor for a roctable config: one collapsible heading per
// discovered @type (tick to select it as a table), each unrolling to a list
// of its properties (include/expand/load_text/join), an expanded property
// further unrolling to its own one-hop sub-properties. Built the same
// "no host markup, no HTML string" way as the rest of the plugin UI: openModal's
// own `onMount`/`actions` (collection2crate SPEC.md §6.2) plus the host's
// own `.checkbox`/`.button`/`.field-hint` CSS, so this ships no markup and
// no stylesheet of its own — bar the one width override below.
//
// The working copy is mutated directly by each control's own change handler
// rather than re-derived from DOM state at the end — Save just resolves
// with whatever the working copy currently is.

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function allTypeNames(config) {
  return [...new Set([...Object.keys(config.tables || {}), ...Object.keys(config.potential_tables || {})])].sort();
}

function tableEntry(config, type) {
  return config.tables[type] || config.potential_tables[type];
}

function isSelected(config, type) {
  return Object.prototype.hasOwnProperty.call(config.tables, type);
}

function setTableSelected(config, type, selected) {
  const entry = tableEntry(config, type);
  if (selected) {
    delete config.potential_tables[type];
    config.tables[type] = entry;
  } else {
    delete config.tables[type];
    config.potential_tables[type] = entry;
  }
}

function checkboxWithLabel(text, checked, onChange) {
  const label = document.createElement("label");
  label.className = "checkbox";
  label.style.cssText = "gap:4px; font-size:13px; margin-right:14px;";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const span = document.createElement("span");
  span.textContent = text;
  label.append(input, span);
  return label;
}

function includedCount(properties) {
  const values = Object.values(properties || {});
  return { included: values.filter((p) => p.include).length, total: values.length };
}

// A one-hop expanded sub-property row: include only (rename exists in the
// config format but has no UI control yet — see docs/roctable-spec.md).
function renderSubPropertyRow(properties, name) {
  const propConfig = properties[name];
  const wrap = document.createElement("div");
  wrap.style.padding = "2px 0";
  wrap.appendChild(checkboxWithLabel(name, propConfig.include !== false, (checked) => { propConfig.include = checked; }));
  return wrap;
}

// One property of a selected/potential table: include/expand/load_text/join,
// unrolling to its own sub-properties (discoverExpandedProperties' nested
// `properties` map) when expand is checked and that map already exists —
// it only appears after the type has been through a build with expand:true
// set, so a freshly-checked expand shows a hint instead until then.
function renderPropertyRow(properties, name, onIncludeChange) {
  const propConfig = properties[name];
  const row = document.createElement("div");
  row.style.cssText = "display:flex; align-items:center; flex-wrap:wrap; padding:3px 0;";

  const subPanel = document.createElement("div");
  subPanel.style.cssText = `margin:2px 0 6px 26px; ${propConfig.expand ? "" : "display:none;"}`;

  // discoverExpandedProperties (roctable) only ever adds a `properties` key
  // once it's actually walked the crate for this property — an *absent* key
  // means "not tried yet" (still needs a discovery pass, i.e. a rebuild or
  // reopening "Configure tables…"); a `properties` key present but *empty*
  // means it was tried and found nothing to expand, which happens whenever
  // the property's actual values aren't @id references at all (e.g. a plain
  // text value like a bare author name) — expanding it can never produce
  // anything, no amount of rebuilding will change that. Collapsing both
  // into one "come back later" message would misrepresent the second case
  // as a timing issue instead of a data fact.
  function renderSubPanel() {
    subPanel.replaceChildren();
    const hint = document.createElement("div");
    hint.className = "field-hint";
    if (!propConfig.properties) {
      hint.textContent = "Sub-properties appear here after the next build re-discovers this expansion.";
      subPanel.appendChild(hint);
    } else if (!Object.keys(propConfig.properties).length) {
      hint.textContent = "No reference values found for this property in the crate — nothing to expand.";
      subPanel.appendChild(hint);
    } else {
      for (const subName of Object.keys(propConfig.properties).sort()) {
        subPanel.appendChild(renderSubPropertyRow(propConfig.properties, subName));
      }
    }
  }
  renderSubPanel();

  const includeCb = checkboxWithLabel(name, !!propConfig.include, (checked) => {
    propConfig.include = checked;
    onIncludeChange();
  });

  const expandCb = checkboxWithLabel("expand", !!propConfig.expand, (checked) => {
    propConfig.expand = checked;
    subPanel.style.display = checked ? "block" : "none";
    if (checked) renderSubPanel();
  });

  const joinSelect = document.createElement("select");
  joinSelect.disabled = !propConfig.load_text;
  const opts = [["", "(plain text)"], ["csv", "join as CSV rows"]];
  for (const [value, text] of opts) {
    const opt = document.createElement("option");
    opt.value = value; opt.textContent = text;
    joinSelect.appendChild(opt);
  }
  joinSelect.value = propConfig.join || "";
  joinSelect.addEventListener("change", () => {
    if (joinSelect.value) propConfig.join = joinSelect.value; else delete propConfig.join;
    normalizeWrap.hidden = !propConfig.load_text;
  });

  const normalizeCheckbox = document.createElement("input");
  normalizeCheckbox.type = "checkbox";
  normalizeCheckbox.checked = propConfig.normalize_whitespace === true;
  normalizeCheckbox.addEventListener("change", () => {
    if (normalizeCheckbox.checked) propConfig.normalize_whitespace = true;
    else delete propConfig.normalize_whitespace;
  });
  const normalizeLabel = document.createElement("label");
  normalizeLabel.className = "checkbox";
  normalizeLabel.style.cssText = "gap:4px; font-size:13px; margin-right:14px;";
  const normalizeText = document.createElement("span");
  normalizeText.textContent = "normalize whitespace";
  normalizeLabel.append(normalizeCheckbox, normalizeText);
  const normalizeHint = document.createElement("div");
  normalizeHint.className = "field-hint";
  normalizeHint.textContent = "Collapse spaces, tabs, and line breaks in loaded text or joined cells to single spaces.";
  const normalizeWrap = document.createElement("div");
  normalizeWrap.style.cssText = "margin:2px 0 6px 26px;";
  normalizeWrap.hidden = !propConfig.load_text;
  normalizeWrap.append(normalizeLabel, normalizeHint);

  const loadTextCb = checkboxWithLabel("load text", !!propConfig.load_text, (checked) => {
    propConfig.load_text = checked;
    joinSelect.disabled = !checked;
    if (!checked) {
      delete propConfig.join;
      delete propConfig.normalize_whitespace;
      joinSelect.value = "";
      normalizeCheckbox.checked = false;
    }
    normalizeWrap.hidden = !checked;
  });

  const joinWrap = document.createElement("span");
  joinWrap.style.cssText = "font-size:13px; display:flex; align-items:center; gap:4px;";
  const joinLabel = document.createElement("span");
  joinLabel.textContent = "join:";
  joinLabel.className = "field-hint";
  joinWrap.append(joinLabel, joinSelect);

  row.append(includeCb, expandCb, loadTextCb, joinWrap);

  const container = document.createElement("div");
  container.append(row, normalizeWrap, subPanel);
  return container;
}

// One @type heading — a checkbox (select this type as a table) plus a
// disclosure toggle unrolling to its properties. `onSelectionChange` redraws
// the whole list, since selecting/deselecting moves the type between
// config.tables/config.potential_tables — simplest to just re-render rather
// than track two possible positions for the same row.
function renderTypeRow(config, type, onSelectionChange) {
  const entry = tableEntry(config, type);
  const properties = entry.properties || {};

  const wrap = document.createElement("div");
  wrap.style.cssText = "border-bottom:1px solid var(--border); padding:6px 0;";

  const head = document.createElement("div");
  head.style.cssText = "display:flex; align-items:center; gap:8px;";

  const selectCb = document.createElement("input");
  selectCb.type = "checkbox";
  selectCb.checked = isSelected(config, type);
  selectCb.addEventListener("change", () => {
    setTableSelected(config, type, selectCb.checked);
    onSelectionChange();
  });

  // A solid disclosure triangle at body-text size. The old control was a
  // 12px ▸, which is both small and a hairline glyph — it read as
  // punctuation rather than as something to press. aria-expanded is what
  // actually tells a screen reader what it does, since the glyph says
  // nothing.
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "button subtle";
  toggle.style.cssText = "padding:0 6px; font-size:15px; line-height:1.2; min-width:26px;";
  toggle.textContent = "▶";
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "Show this type's properties";

  // The heading toggles too, so the triangle is a shortcut rather than the
  // only target — a 26px button is a small thing to have to hit for every
  // type in the list.
  const summary = document.createElement("span");
  summary.style.cssText = "font-weight:600; cursor:pointer;";

  function updateSummary() {
    const { included, total } = includedCount(properties);
    summary.textContent = `${type} — ${included}/${total} propert${total === 1 ? "y" : "ies"} shown`;
  }
  updateSummary();

  head.append(selectCb, toggle, summary);
  wrap.appendChild(head);

  const propsPanel = document.createElement("div");
  propsPanel.style.cssText = "margin:8px 0 4px 28px; display:none;";
  wrap.appendChild(propsPanel);

  let built = false;
  const toggleProperties = () => {
    const expanded = propsPanel.style.display !== "none";
    propsPanel.style.display = expanded ? "none" : "block";
    toggle.textContent = expanded ? "▶" : "▼";
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.title = expanded ? "Show this type's properties" : "Hide this type's properties";
    if (!expanded && !built) {
      built = true;
      for (const propName of Object.keys(properties).sort()) {
        propsPanel.appendChild(renderPropertyRow(properties, propName, updateSummary));
      }
    }
  };
  toggle.addEventListener("click", toggleProperties);
  summary.addEventListener("click", toggleProperties);

  return wrap;
}

// The host's modal panel is min(720px, 100%) — sized for a short
// confirmation, not a multi-column property table with four controls per
// row. openModal's modalClassName puts a class on that same panel but
// supplies no rule of its own, so this injects one override, once per page
// load, scoped to that class: two classes beat the host's single .modal-panel
// selector regardless of stylesheet order, and the host's CSS stays free of
// any one plugin's needs.
let stylesInjected = false;
function ensureWideModalStyle() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = ".modal-panel.roctable-config-modal { width: min(900px, 94vw); }";
  document.head.appendChild(style);
}

// Opens the editor and resolves to the edited config, or null if dismissed
// without an explicit Save/Cancel choice — the caller (index.js) treats
// null as "no change was confirmed", not "clear everything".
export async function openConfigTreeEditor({ config, openModal }) {
  const working = cloneConfig(config);
  ensureWideModalStyle();

  return openModal({
    title: "Configure RO-Crate tables",
    modalClassName: "roctable-config-modal",
    onMount(body) {
      const intro = document.createElement("p");
      intro.textContent = "Tick a type to export it as a table. Expand a type to choose which properties become columns, and whether each one is expanded, has its file text loaded, or joined as CSV rows.";
      body.appendChild(intro);

      const listWrap = document.createElement("div");
      listWrap.style.cssText = "max-height:420px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:4px 12px;";
      body.appendChild(listWrap);

      function renderList() {
        listWrap.replaceChildren();
        const types = allTypeNames(working);
        if (!types.length) {
          const empty = document.createElement("p");
          empty.className = "field-hint";
          empty.textContent = "No entity types were found in this crate.";
          listWrap.appendChild(empty);
          return;
        }
        for (const type of types) {
          listWrap.appendChild(renderTypeRow(working, type, renderList));
        }
      }
      renderList();
    },
    // `working` is edited in place by the rows above, so Save reads it at
    // click time rather than capturing whatever it held when the modal opened.
    actions: [
      { label: "Cancel", value: null },
      { label: "Save configuration", primary: true, value: () => working },
    ],
  });
}
