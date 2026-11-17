// A document's text: a .docx through mammoth, a .txt decoded. Shared by
// ca-data-prep and chat-export (through lib/_transcript.js), name-lookup and
// transcript-grammar, so every plugin reads a document the same way.
//
// mammoth is heavy: import this module on demand where a build may not need
// it, as transcript-grammar does.
import mammoth from "mammoth";

export async function resolveMammothArrayBuffer(docxSource) {
  if (!docxSource) return null;

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(docxSource)) {
    return docxSource.buffer.slice(docxSource.byteOffset, docxSource.byteOffset + docxSource.byteLength);
  }

  if (docxSource instanceof ArrayBuffer) {
    return docxSource;
  }

  if (ArrayBuffer.isView(docxSource)) {
    const view = docxSource;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  if (docxSource && typeof docxSource.arrayBuffer === "function") {
    return await docxSource.arrayBuffer();
  }

  if (docxSource && typeof docxSource.buffer !== "undefined" && docxSource.buffer instanceof ArrayBuffer) {
    const view = docxSource;
    const bytes = new Uint8Array(view.buffer, view.byteOffset || 0, view.byteLength || view.buffer.byteLength);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  return null;
}

// mammoth swaps its unzip implementation through package.json's "browser"
// field: the browser build reads only { arrayBuffer }, the Node build only
// { buffer } / { path }. Decide by runtime rather than by calling and catching.
// Probing is what this used to do, and it is expensive in a way that doesn't
// show up in tests: mammoth rejects through bluebird, which reports every
// deliberate miss to the console as an unhandled rejection, so a four-document
// folder filled the browser console with errors from a build that worked.
const IN_BROWSER = typeof window !== "undefined" && typeof window.document !== "undefined";

function toArrayBuffer(docxBuffer) {
  if (docxBuffer instanceof ArrayBuffer) return docxBuffer;
  if (ArrayBuffer.isView(docxBuffer)) {
    const bytes = new Uint8Array(docxBuffer.buffer, docxBuffer.byteOffset, docxBuffer.byteLength);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return new Uint8Array(docxBuffer || []).buffer;
}

// Buffer can exist in a bundled browser build too (node polyfills), which is
// why the runtime decides the shape and this only decides how to carry it.
function mammothOptions(arrayBuffer, forBrowser) {
  if (forBrowser) return { arrayBuffer };
  if (typeof Buffer !== "undefined") return { buffer: Buffer.from(arrayBuffer) };
  return { buffer: new Uint8Array(arrayBuffer) };
}

export async function callMammothExtractRawText(docxBuffer) {
  const arrayBuffer = toArrayBuffer(docxBuffer);
  try {
    return await mammoth.extractRawText(mammothOptions(arrayBuffer, IN_BROWSER));
  } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : String(error);
    if (!/Could not find file in options/i.test(message)) throw error;
    // The runtime guess was wrong — an exotic bundle, or jsdom in a test.
    // One retry with the other shape, rather than failing on a readable file.
    return await mammoth.extractRawText(mammothOptions(arrayBuffer, !IN_BROWSER));
  }
}

export async function extractDocumentText(docxSource) {
  if (!docxSource) return "";

  const mammothBuffer = await resolveMammothArrayBuffer(docxSource);
  if (!mammothBuffer) return "";

  const result = await callMammothExtractRawText(mammothBuffer);
  return result.value || "";
}

/**
 * Decode a plain-text file: UTF-8 unless a byte-order mark says UTF-16. The
 * mark itself is dropped, so it can't end up in front of the first header.
 */
export function decodePlainText(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let encoding = "utf-8";
  if (view[0] === 0xff && view[1] === 0xfe) encoding = "utf-16le";
  else if (view[0] === 0xfe && view[1] === 0xff) encoding = "utf-16be";
  return new TextDecoder(encoding).decode(view);
}

/**
 * Give plain text the shape mammoth gives a .docx: each line a paragraph,
 * ended by a blank line. Everything downstream — the line numbers in the log
 * (paragraphNumbersByLine), a saved grammar's reader (documentLines) — then
 * treats a .txt line exactly as it treats a .docx paragraph, so a line
 * number in the log is that line's number in the file.
 */
export function plainTextAsParagraphs(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  // A file's final newline ends its last line; it doesn't start another.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => `${line}\n\n`).join("");
}
