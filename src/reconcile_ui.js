// The reconcile prompt (SPEC-UI.md §7, SPEC.md §4.4a): after a folder is
// picked, the files that are new to the existing crate and the file entities
// the folder no longer has, each with a two-way choice.
//
// Browser-only, but holds no state of its own: it takes the reconcile result
// and the current choices, and resolves to the new choices (or null when
// dismissed, which leaves the caller's choices as they were).

const FILTER_THRESHOLD = 20;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

// One list: rows of path + segmented toggle, "all" buttons, and a filter box
// once the list is long. `offSet` holds the rows set to the non-default
// choice (Ignore / Keep), mutated in place.
function renderSection({ title, hint, items, onLabel, offLabel, offSet, onChange }) {
  const count = el("span", { class: "reconcile-count" });
  const heading = el("h3", { class: "reconcile-heading" }, `${title} `, count);
  const rows = [];

  const list = el("ul", { class: "reconcile-list", role: "list" });
  for (const item of items) {
    const onButton = el("button", { type: "button", class: "segment", text: onLabel });
    const offButton = el("button", { type: "button", class: "segment", text: offLabel });
    const sync = () => {
      const off = offSet.has(item);
      onButton.setAttribute("aria-pressed", String(!off));
      offButton.setAttribute("aria-pressed", String(off));
    };
    onButton.addEventListener("click", () => { offSet.delete(item); sync(); onChange(); });
    offButton.addEventListener("click", () => { offSet.add(item); sync(); onChange(); });
    sync();
    const row = el("li", { class: "reconcile-row" },
      el("span", { class: "reconcile-path mono", title: item, text: item }),
      el("span", { class: "segmented", role: "group", "aria-label": item }, onButton, offButton),
    );
    rows.push({ item, row, sync });
    list.append(row);
  }

  const setAll = (off) => {
    for (const { item, row, sync } of rows) {
      if (row.hidden) continue; // "all" means all the filter is showing
      if (off) offSet.add(item); else offSet.delete(item);
      sync();
    }
    onChange();
  };
  const bulk = el("div", { class: "actions reconcile-bulk" },
    el("button", { type: "button", class: "button subtle", text: `${onLabel} all` }),
    el("button", { type: "button", class: "button subtle", text: `${offLabel} all` }),
  );
  bulk.children[0].addEventListener("click", () => setAll(false));
  bulk.children[1].addEventListener("click", () => setAll(true));

  let filter = null;
  if (items.length > FILTER_THRESHOLD) {
    filter = el("input", { type: "search", placeholder: "Filter paths…", "aria-label": `Filter ${title.toLowerCase()}` });
    filter.addEventListener("input", () => {
      const needle = filter.value.trim().toLowerCase();
      for (const { item, row } of rows) row.hidden = !!needle && !item.toLowerCase().includes(needle);
    });
  }

  const refreshCount = () => {
    count.textContent = `(${items.length - offSet.size} of ${items.length} to ${onLabel.toLowerCase()})`;
  };
  refreshCount();

  const section = el("section", { class: "reconcile-section" },
    heading, el("p", { class: "field-hint", text: hint }), bulk, filter, list);
  return { section, refreshCount };
}

/**
 * @param {object} args
 * @param {{ newFiles: string[], missingFiles: string[] }} args.result
 * @param {{ ignore?: string[], keep?: string[] }} args.choices  current choices
 * @param {string} args.sourceLabel  where the existing crate was read from
 * @param {Function} args.openModal
 * @returns {Promise<{ ignore: string[], keep: string[] } | null>}
 */
export function openReconcileModal({ result, choices = {}, sourceLabel = "the existing crate", openModal }) {
  const ignore = new Set(choices.ignore || []);
  const keep = new Set(choices.keep || []);

  return openModal({
    title: "Files have changed since the crate was written",
    modalClassName: "reconcile-modal",
    onMount(body) {
      body.append(el("p", {
        text: `Comparing the folder with ${sourceLabel}. Choose what the next build does with each file.`,
      }));
      const sections = [];
      const onChange = () => sections.forEach((s) => s.refreshCount());
      if (result.newFiles.length) {
        sections.push(renderSection({
          title: "New files",
          hint: "In the folder but not in the crate. An ignored file is left out of this build, and you'll be asked again next time.",
          items: result.newFiles, onLabel: "Add", offLabel: "Ignore", offSet: ignore, onChange,
        }));
      }
      if (result.missingFiles.length) {
        sections.push(renderSection({
          title: "Missing files",
          hint: "In the crate but no longer in the folder. A kept entity stays in the crate as it is; the build log will warn about it.",
          items: result.missingFiles, onLabel: "Remove", offLabel: "Keep", offSet: keep, onChange,
        }));
      }
      body.append(...sections.map((s) => s.section));
    },
    actions: [
      { label: "Cancel", value: null },
      { label: "Confirm", primary: true, value: () => ({ ignore: [...ignore], keep: [...keep] }) },
    ],
  });
}
