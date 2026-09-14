// A tiny dependency-free modal helper (SPEC.md §11).
//
// Passed to plugins through deps as `openModal`, so a plugin can ask the
// person a question (generic-input's new-files confirmation, merge's mapping
// builder) without importing anything from the app.

/**
 * Open a modal.
 *
 * @param {object} args
 * @param {string} args.title
 * @param {Node|string} args.body            content, or HTML string
 * @param {Array<{label: string, value?: any, primary?: boolean}>} [args.actions]
 * @param {function} [args.onMount]          called with the body element
 * @returns {Promise<any>} the chosen action's value, or null if dismissed
 */
export function openModal({ title, body, actions = [], onMount = null } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", title || "Dialog");

    const panel = document.createElement("div");
    panel.className = "modal-panel";

    const header = document.createElement("header");
    header.className = "modal-header";
    const heading = document.createElement("h2");
    heading.textContent = title || "";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "icon-button";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.textContent = "✕";
    header.append(heading, closeButton);

    const content = document.createElement("div");
    content.className = "modal-body";
    if (typeof body === "string") content.innerHTML = body;
    else if (body) content.append(body);

    const footer = document.createElement("footer");
    footer.className = "modal-footer";

    panel.append(header, content, footer);
    backdrop.append(panel);
    document.body.append(backdrop);

    let settled = false;
    function close(value) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      resolve(value);
    }
    function onKeydown(event) {
      if (event.key === "Escape") close(null);
    }

    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.primary ? "button primary" : "button";
      button.textContent = action.label;
      button.addEventListener("click", () => close(
        typeof action.value === "function" ? action.value() : action.value
      ));
      footer.append(button);
    }

    closeButton.addEventListener("click", () => close(null));
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener("keydown", onKeydown, true);

    if (typeof onMount === "function") onMount(content, { close });
    (panel.querySelector("input, select, textarea, button") || closeButton).focus();
  });
}

/** Close every open modal — used when a new folder resets the UI. */
export function closeAllModals() {
  for (const node of document.querySelectorAll(".modal-backdrop")) node.remove();
}
