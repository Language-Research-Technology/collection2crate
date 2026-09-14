// A tiny dependency-free modal helper (SPEC.md §11).
//
// Passed to plugins through deps as `openModal`, so a plugin can ask the
// person a question (generic-input's new-files confirmation, merge's mapping
// builder) without importing anything from the app.

/**
 * Open a modal.
 *
 * Two ways to fill it, both supported:
 *  - declarative: pass `body` plus `actions`, and the helper builds the
 *    footer buttons and resolves with the chosen action's `value`;
 *  - self-built: pass `render(body, close)` and build the content and its
 *    own buttons yourself, calling `close(value)` to resolve. Plugins use
 *    this shape (roctable's table config, generic-input's new-files
 *    confirmation), so it must keep working exactly as they call it.
 *
 * @param {object} args
 * @param {string} args.title
 * @param {Node|string} [args.body]          content, or HTML string
 * @param {Array<{label: string, value?: any, primary?: boolean}>} [args.actions]
 * @param {function} [args.onMount]          called with (body, { close })
 * @param {function} [args.render]           called with (body, close)
 * @param {function} [args.onDismiss]        what ✕ / backdrop / Escape resolve to
 * @param {string} [args.modalClassName]     extra class on the panel
 * @returns {Promise<any>} the chosen value, or onDismiss()'s value (null by
 *   default) if dismissed
 */
export function openModal({
  title,
  body,
  actions = [],
  onMount = null,
  render = null,
  onDismiss = null,
  modalClassName = "",
} = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", title || "Dialog");

    const panel = document.createElement("div");
    panel.className = modalClassName
      ? `modal-panel ${modalClassName}`
      : "modal-panel";

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

    panel.append(header, content);
    if (actions.length) panel.append(footer);
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
      if (event.key === "Escape") dismiss();
    }
    function dismiss() {
      close(typeof onDismiss === "function" ? onDismiss() : null);
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

    closeButton.addEventListener("click", dismiss);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) dismiss();
    });
    document.addEventListener("keydown", onKeydown, true);

    if (typeof onMount === "function") onMount(content, { close });
    if (typeof render === "function") render(content, close);
    (panel.querySelector("input, select, textarea, button") || closeButton).focus();
  });
}

/** Close every open modal — used when a new folder resets the UI. */
export function closeAllModals() {
  for (const node of document.querySelectorAll(".modal-backdrop")) node.remove();
}
