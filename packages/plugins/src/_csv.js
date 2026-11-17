// CSV building and browser download, shared by the visualisation panels.
//
// Every panel offers the same two things to do with a result set — copy it, or
// save it — so they escape identically and produce the same file. Kept here
// rather than in each plugin for that reason, next to _progress.js.

/** Quote a field only when it has to be: a comma, quote or newline in it. */
export function csvField(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildCsvText(header, rows) {
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\n");
}

/**
 * Save text as a file the browser downloads.
 *
 * A blob and a synthetic <a download>, the same shape collection2crate's own
 * log save uses. Nothing here touches the picked folder: a panel's results are
 * one of many attempts, not crate content (SPEC-PLUGINS.md).
 */
export function downloadCsv(filename, csvText) {
  const url = URL.createObjectURL(new Blob([csvText], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Copy text, reporting whether it worked — clipboard access can be refused. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
