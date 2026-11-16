// The small DOM vocabulary the visualisation panels share.
//
// Panels build nodes rather than assembling HTML strings: the text they render
// is corpus text and search queries, and a panel that interpolates either into
// innerHTML is one bad document away from running it. textContent cannot.
//
// Class names come from collection2crate's own stylesheet (SPEC-PLUGINS.md,
// "Styling") so a panel looks like the rest of the app rather than a guest in
// it.

export function element(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, String(value));
  }
  node.append(...children.filter(Boolean));
  return node;
}

export const button = (label, { primary = false, onClick, title } = {}) => {
  const node = element("button", {
    className: `button${primary ? " primary" : ""}`,
    text: label,
    attrs: { type: "button", title },
  });
  if (onClick) node.addEventListener("click", onClick);
  return node;
};

/** A labelled control: the app's .field wrapper around an input or select. */
export function field(labelText, control, { inline = false } = {}) {
  return element("label", { className: `field${inline ? " inline" : ""}` }, [
    inline ? control : element("span", { className: "field-label", text: labelText }),
    inline ? element("span", { className: "field-label", text: labelText }) : control,
  ]);
}

export function checkbox(labelText, { checked = false } = {}) {
  const input = element("input", { attrs: { type: "checkbox" } });
  input.checked = checked;
  return { input, node: field(labelText, input, { inline: true }) };
}

export function numberInput({ value, min, max, width = "5em" }) {
  const input = element("input", { attrs: { type: "number", min, max, value } });
  input.style.width = width;
  return input;
}

export function select(options, { value } = {}) {
  const node = element("select");
  for (const option of options) {
    node.append(element("option", { text: option.label ?? option, attrs: { value: option.value ?? option } }));
  }
  if (value !== undefined) node.value = value;
  return node;
}

/** A table inside the app's horizontal-scroll wrapper. */
export function dataTable(headers) {
  const head = element("thead", {}, [
    element("tr", {}, headers.map((h) => element("th", { text: h.label ?? h, className: h.className }))),
  ]);
  const body = element("tbody");
  const table = element("table", { className: "data-table" }, [head, body]);
  return { body, node: element("div", { className: "table-scroll" }, [table]) };
}

export const note = (text) => element("p", { className: "empty-note", text });

export function attributionFooter({ logo, logoAlt = "", logoBackground, href, text, comment }) {
  const link = element("a", {
    className: "attribution-link",
    attrs: { href, target: "_blank", rel: "noopener noreferrer" },
  }, [
    element("img", {
      attrs: {
        src: logo,
        alt: logoAlt,
      },
    }),
    element("span", { text }),
  ]);
  const footer = element("footer", { className: "attribution-footer" }, [
    link,
    element("span", { text: comment }),
  ]);
  Object.assign(footer.style, {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    flexWrap: "wrap", gap: "0.75rem", marginTop: "2rem", paddingTop: "0.75rem",
    borderTop: "1px solid var(--border)", color: "var(--muted)", fontSize: "0.8rem",
  });
  Object.assign(link.style, {
    display: "inline-flex", alignItems: "center", gap: "0.5rem", color: "inherit",
    textDecoration: "none",
  });
  const icon = link.querySelector("img");
  Object.assign(icon.style, {
    width: "2.5rem", height: "2.5rem", objectFit: "contain", padding: "0.2rem",
    borderRadius: "3px", background: logoBackground,
  });
  return footer;
}

/** A row of results actions with a shared status line. */
export function resultsBar(countText, actions) {
  return element("div", { className: "actions" }, [
    element("span", { className: "field-hint", text: countText }),
    ...actions,
  ]);
}

/**
 * Flash a button's label to confirm something that leaves no other trace —
 * copying, mainly, where the only evidence is in a clipboard the person
 * cannot see from here.
 */
export function flashLabel(node, temporary, ms = 1500) {
  const original = node.textContent;
  node.textContent = temporary;
  setTimeout(() => { node.textContent = original; }, ms);
}
