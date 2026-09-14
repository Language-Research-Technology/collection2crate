// Seam: what the Visualise panels are given (src/visualise_data.js).
//
// A misread file here is not an error — it is a chart of the wrong numbers, or
// a concordance that misses half a corpus. The parsing is pure, so all of it
// is reachable from Node; the directory scan takes a faked handle.
import assert from "node:assert/strict";

import {
  parseDelimited, documentsFromTable, documentsFromChat, documentsFromText,
  loadDirectory, isSupportedFile, scanOutputDirectories,
} from "../src/visualise_data.js";

/* ---------- delimited text ---------- */

{
  const { header, rows } = parseDelimited('a,b\n1,2\n3,4\n');
  assert.deepEqual(header, ["a", "b"]);
  assert.deepEqual(rows, [["1", "2"], ["3", "4"]]);

  const quoted = parseDelimited('name,note\n"Smith, J.","said ""hello"""\n');
  assert.deepEqual(quoted.rows, [["Smith, J.", 'said "hello"']],
    "a quoted field keeps its commas, and doubled quotes collapse to one");

  const multiline = parseDelimited('a,b\n"line one\nline two",2\n');
  assert.deepEqual(multiline.rows, [["line one\nline two", "2"]],
    "a newline inside quotes is part of the field, not a new row");

  assert.deepEqual(parseDelimited("a\tb\n1\t2\n", "\t").header, ["a", "b"],
    "tabs when asked for tabs");

  assert.deepEqual(parseDelimited("a,,c\n1,2,3\n").header, ["a", "column 2", "c"],
    "an unnamed column still gets a name, so rows keep their shape");

  assert.deepEqual(parseDelimited("").header, [], "empty text is not a table");
}

/* ---------- documents ---------- */

{
  const table = parseDelimited("speakerId,start,text\nCHI,0.0,hello there\nMOT,1.0,\nFAT,2.0,goodbye\n");
  const documents = documentsFromTable("_outputs/csv/a.csv", table);
  assert.deepEqual(documents.map((d) => d.text), ["hello there", "goodbye"],
    "a row with no text is not a document");
  assert.deepEqual(documents.map((d) => d.speaker), ["CHI", "FAT"]);
  assert.equal(documents[0].id, "_outputs/csv/a.csv#0", "id carries the row it came from");
  assert.equal(documents[1].id, "_outputs/csv/a.csv#2",
    "and keeps the original row number, not a position in the output");

  const noText = documentsFromTable("t.csv", parseDelimited("one,two\nalpha,beta\n"));
  assert.equal(noText[0].text, "alpha beta",
    "a table with no text column is still searchable, by joining the cells");
}

{
  const chat = documentsFromChat("_outputs/chat/a.cha", [
    "@Begin", "@Languages:\teng", "*CHI:\tthe dog ran", "%mor:\tdet|the n|dog v|run",
    "*MOT:\tdid it", "*XXX:\t", "@End",
  ].join("\n"));
  assert.deepEqual(chat.map((d) => [d.speaker, d.text]), [["CHI", "the dog ran"], ["MOT", "did it"]],
    "utterance tiers only — headers and %-tiers are metadata, not anybody's words");
}

{
  const text = documentsFromText("notes.txt", "first line\n\n   \nsecond line\n");
  assert.deepEqual(text.map((d) => d.text), ["first line", "second line"]);
  assert.equal(text[1].id, "notes.txt#3", "blank lines still count towards the line number");
}

/* ---------- which files count ---------- */

{
  for (const name of ["a.csv", "b.TSV", "c.cha", "d.txt", "e.md", "f.log"]) {
    assert.ok(isSupportedFile(name), `${name} should be readable`);
  }
  for (const name of ["ro-crate-preview.html", "photo.jpg", "sheet.xlsx", "noextension"]) {
    assert.ok(!isSupportedFile(name), `${name} should not be offered`);
  }
}

/* ---------- loading a directory ---------- */

{
  const files = [
    { path: "_outputs/csv/a.csv", name: "a.csv", ext: ".csv" },
    { path: "_outputs/chat/a.cha", name: "a.cha", ext: ".cha" },
    { path: "_outputs/logs/a.log", name: "a.log", ext: ".log" },
  ];
  const texts = {
    "_outputs/csv/a.csv": "text,n\nhello,1\nworld,2\n",
    "_outputs/chat/a.cha": "*CHI:\tan utterance",
    "_outputs/logs/a.log": "a log line",
  };
  const { documents, tables } = await loadDirectory(files, async (path) => texts[path]);

  assert.equal(documents.length, 4, "every readable line from every file");
  assert.equal(tables.length, 1, "only the CSV has columns to offer");
  assert.deepEqual(tables[0].header, ["text", "n"]);
  assert.deepEqual(tables[0].rows, [["hello", "1"], ["world", "2"]],
    "the same parse serves both views — the rows are not re-read from the documents");

  const warnings = [];
  const partial = await loadDirectory(
    [...files, { path: "gone.csv", name: "gone.csv", ext: ".csv" }],
    async (path) => (path === "gone.csv" ? null : texts[path]),
    (message) => warnings.push(message),
  );
  assert.equal(partial.documents.length, 4, "an unreadable file is skipped, not fatal");
  assert.match(warnings.join(" "), /gone\.csv/, "and is reported rather than swallowed");
}

/* ---------- scanning for directories worth offering ---------- */

{
  // Just enough of a directory handle: entries() and getDirectoryHandle().
  const folder = (tree) => {
    const at = (node) => ({
      async *entries() {
        for (const [name, value] of Object.entries(node)) {
          yield [name, { kind: typeof value === "object" ? "directory" : "file" }];
        }
      },
      async getDirectoryHandle(name) {
        if (typeof node[name] !== "object") throw new Error("no such dir");
        return at(node[name]);
      },
    });
    return at(tree);
  };

  const dirHandle = folder({
    _outputs: {
      csv: { "a.csv": "", "b.csv": "" },
      chat: { "a.cha": "" },
      empty: {},
    },
    "ro-crate-preview_html": { "index.html": "" },
  });

  const declared = [
    { path: "_outputs/csv", kind: "dir" },
    { path: "_outputs/chat", kind: "dir" },
    { path: "_outputs/empty", kind: "dir" },
    { path: "_outputs/never-built", kind: "dir" },
    { path: "ro-crate-preview_html", kind: "dir" },
    { path: "ro-crate-metadata.json", kind: "file" },
  ];

  const found = await scanOutputDirectories(dirHandle, declared);
  assert.deepEqual(found.map((d) => d.path), ["_outputs/chat", "_outputs/csv"],
    "offered: declared, present, and holding something readable — so the empty one, " +
    "the one no build has made yet, the HTML output and the declared file are all out"
  );
  assert.equal(found.find((d) => d.path === "_outputs/csv").count, 2);
}

console.log(
  "test-visualise-data: all tests passed (delimited parsing incl. quotes and newlines, " +
  "documents from tables/CHAT/text, supported extensions, loading a directory into both views, " +
  "directory scanning)"
);
