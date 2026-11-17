// Which documents a text-analysis panel analyses, given the sources and
// table columns a person picked (concordance, collocation, sentimentexplorer,
// topicdetector).
//
// A panel is handed `documents` (text from every loaded file, one entry per
// paragraph or line, each with a `source`) and `tables` (each loaded CSV/TSV
// as `{ source, header, rows }`). A selected source that is a table becomes
// one document per row, built from the chosen columns; any other source
// contributes its own documents.

/** The source value a panel's "All files" option uses. */
export const ALL_SOURCES = "__all__";

const sameSource = (documents, source) =>
  source == null ? documents : documents.filter((document) => document.source === source);

const rowDocumentWithIndex = (source, index, text) => ({ id: `${source}#${index}`, source, speaker: "", text });

/**
 * Build the documents to analyse for a selection.
 *
 * @param {object[]} documents  every loaded file's documents, each with `source` and `text`
 * @param {object[]} tables  loaded tables, each `{ source, header, rows }`
 * @param {string|string[]|null|undefined} sources  what is selected:
 *   - a single source name, or a list of them;
 *   - `ALL_SOURCES` (alone or in a list), `null`/`undefined`, or an empty
 *     string means every loaded file;
 *   - an empty list means nothing is selected, so no documents.
 * @param {string[]|Map<string, string[]>} [columns]  which columns of a table
 *   supply its text: one list for every selected table, or a `Map` from
 *   source to its own list. A table with no columns chosen uses all of its
 *   header.
 * @param {object} [options]
 * @param {(documents: object[], source: string|null) => object[]} [options.fileDocuments]
 *   the documents a non-table source contributes (`source` is `null` for
 *   every file). Defaults to that source's own documents, as loaded.
 * @param {(source: string, index: number, text: string) => object} [options.rowDocument]
 *   the document for one table row (`index` from 0). Defaults to
 *   `{ id: "<source>#<index>", source, speaker: "", text }`. Rows whose text
 *   is blank are skipped either way.
 * @returns {object[]} the documents, in selection order
 */
export function documentsForSelection(documents, tables, sources, columns = [],
  { fileDocuments = sameSource, rowDocument = rowDocumentWithIndex } = {}) {
  const loaded = documents || [];
  const list = Array.isArray(sources) ? sources : sources ? [sources] : null;
  if (!list || list.includes(ALL_SOURCES)) return fileDocuments(loaded, null);

  const result = [];
  for (const source of list) {
    const table = (tables || []).find((candidate) => candidate.source === source);
    if (!table) {
      result.push(...fileDocuments(loaded, source));
      continue;
    }
    const chosen = columns instanceof Map ? columns.get(source) : columns;
    const useColumns = new Set(chosen && chosen.length ? chosen : table.header);
    table.rows.forEach((cells, index) => {
      const text = table.header
        .map((column, columnIndex) => useColumns.has(column) ? cells[columnIndex] || "" : "")
        .filter(Boolean)
        .join(" ");
      if (text.trim()) result.push(rowDocument(source, index, text));
    });
  }
  return result;
}
