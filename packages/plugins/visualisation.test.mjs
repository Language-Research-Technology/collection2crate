// The pure seams of the visualisation panels: matching, counting and scaling.
//
// The panels themselves are DOM and stay untested here, as the rest of this
// repo's UI does. What is tested is the half that can be wrong while looking
// right — a window that clips a word, an n-gram that runs across a speaker
// change, a chart scale that hides the tallest bar.
//
//   node visualisation.test.mjs
import assert from "node:assert/strict";

import { documentsForSelection as documentsForConcordanceSelection, search, searchAsync } from "./plugins/concordance/index.js";
import { analyzeNgrams, tokenize } from "./plugins/ngrams/index.js";
import {
  analyzeCollocations, documentsForSelection, fisherExact,
  tokenize as tokenizeCollocations,
} from "./plugins/collocation/index.js";
import {
  analyzeSentiment, annotateSection, buildSummary, parseNrcLexiconCsv,
  documentsForSelection as documentsForSentimentSelection,
} from "./plugins/sentimentexplorer/index.js";
import {
  buildSeedDictionary, buildVocabulary, fitLDA, fitSeededLDA, topTermsPerTopic,
  documentsForSelection as documentsForTopicSelection,
  tokenize as tokenizeTopics,
} from "./plugins/topicdetector/index.js";
import { chartGeometry } from "./plugins/chart/index.js";
import {
  BUILDER_NAMES, createDefaultConfig, dataLayer, datasetsForConfig, embedOptions,
  generatePlotSpecs, layoutSpan, mapRowsFromColumns, tableToRows, validatePlotsConfig,
} from "./plugins/plots/model.js";
import { projectMapPoints } from "./plugins/plots/map.js";
import { libraryPin } from "./plugins/plots/index.js";
import { REGISTRY } from "./index.js";
import * as vega from "vega";
import { compile as compileVegaLite } from "vega-lite";

let failures = 0;
const asyncChecks = [];
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};
const checkAsync = (label, fn) => {
  asyncChecks.push((async () => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
  })());
};

const docs = (...lines) => lines.map((text, i) => ({ id: `d${i}`, source: "test.csv", speaker: "", text }));

console.log("The contract");

const deps = new Proxy({}, { get: () => () => {} });
for (const [name, factory] of Object.entries(REGISTRY)) {
  const plugin = factory(deps);
  if (!plugin.visualisation) continue;
  check(`${name}: its panel declares label, hint and render`, () => {
    const { label, hint, render } = plugin.visualisation;
    assert.equal(typeof label, "string", "a panel needs a label for the sidebar");
    assert.ok(label.length, "the label is empty");
    assert.equal(typeof hint, "string", "a panel needs a one-line hint");
    assert.equal(typeof render, "function", "a panel needs render(container, ctx)");
  });
  check(`${name}: declares no hooks — it runs during no build`, () => {
    assert.equal(Object.keys(plugin.hooks || {}).length, 0);
  });
}

console.log("\nconcordance");

check("selects all files, a text source, or chosen CSV columns", () => {
  const documents = [
    { source: "notes.txt", text: "climate notes" },
    { source: "data.csv", text: "climate fallback" },
  ];
  const tables = [{
    source: "data.csv",
    header: ["text", "note"],
    rows: [["climate report", "other climate"]],
  }];
  assert.deepEqual(
    documentsForConcordanceSelection(documents, tables, "__all__"),
    documents,
  );
  assert.deepEqual(
    documentsForConcordanceSelection(documents, tables, "notes.txt").map((document) => document.text),
    ["climate notes"],
  );
  assert.deepEqual(
    documentsForConcordanceSelection(documents, tables, "data.csv", ["note"]).map((document) => document.text),
    ["other climate"],
  );
});

check("finds every occurrence, with a window either side", () => {
  const rows = search(docs("the quick brown fox jumps over the lazy dog"), "fox", { windowSize: 2 });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { left: rows[0].left, keyword: rows[0].keyword, right: rows[0].right },
    { left: "quick brown", keyword: "fox", right: "jumps over" },
    "two words either side, and the keyword exactly as written"
  );
});

check("a window wider than the text takes what there is", () => {
  const [row] = search(docs("fox jumps"), "fox", { windowSize: 5 });
  assert.equal(row.left, "", "nothing to the left of the first word");
  assert.equal(row.right, "jumps");
});

check("case-insensitive by default, and reports what it matched", () => {
  const rows = search(docs("Fox and fox"), "fox", { windowSize: 2 });
  assert.deepEqual(rows.map((r) => r.keyword), ["Fox", "fox"],
    "each row carries the text as it appeared, not the query");
  assert.equal(search(docs("Fox and fox"), "fox", { caseSensitive: true }).length, 1);
});

check("whole word only matches whole words", () => {
  assert.equal(search(docs("the foxes ran"), "fox", { wholeWord: true }).length, 0);
  assert.equal(search(docs("the fox ran"), "fox", { wholeWord: true }).length, 1);
});

check("a literal query is not read as a pattern", () => {
  assert.equal(search(docs("a.b and axb"), "a.b").length, 1,
    "the dot is a dot unless regex is on");
  assert.equal(search(docs("a.b and axb"), "a.b", { regex: true }).length, 2);
});

check("fixed matching treats the query as an exact literal", () => {
  assert.equal(search(docs("climate change and climate"), "climate", { matchType: "fixed" }).length, 2);
  assert.equal(search(docs("climate change"), "climate change", { matchType: "fixed" }).length, 1);
});

check("glob matching treats brackets literally and supports ? and * wildcards", () => {
  assert.deepEqual(
    search(docs("woman women womxn"), "wom[ae]n", { matchType: "glob" }).map((row) => row.keyword),
    [],
    "glob metacharacters are not interpreted as regular expressions"
  );
  assert.deepEqual(
    search(docs("woman women womxn"), "wom?n", { matchType: "glob" }).map((row) => row.keyword),
    ["woman", "women", "womxn"],
    "? matches any single character",
  );
  assert.deepEqual(
    search(docs("the economy"), "the *", { matchType: "glob" }).map((row) => row.keyword),
    ["the economy"],
  );
});

check("a pattern that can match nothing still terminates", () => {
  // Would spin forever on a zero-length match without the guard.
  const rows = search(docs("aaa"), "b*", { regex: true });
  assert.ok(Array.isArray(rows), "returned rather than hanging");
});

check("an invalid pattern throws for the panel to report", () => {
  assert.throws(() => search(docs("x"), "(unclosed", { regex: true }));
});

check("searches every document and says which it came from", () => {
  const two = [
    { source: "a.csv", speaker: "CHI", text: "fox one" },
    { source: "b.csv", speaker: "MOT", text: "fox two" },
  ];
  assert.deepEqual(search(two, "fox").map((r) => [r.source, r.speaker]),
    [["a.csv", "CHI"], ["b.csv", "MOT"]]);
});

checkAsync("async search returns the same matches while reporting progress", async () => {
  const documents = Array.from({ length: 25 }, (_, index) => ({
    source: `doc-${index}.txt`, text: index % 2 ? "climate policy" : "other text",
  }));
  const progress = [];
  const rows = await searchAsync(documents, "climate", { matchType: "fixed" }, (value) => progress.push(value));
  assert.deepEqual(rows, search(documents, "climate", { matchType: "fixed" }));
  assert.deepEqual(progress, [0.4, 0.8, 1]);
});

console.log("\nngrams");

check("tokenises non-ASCII orthographies as words", () => {
  assert.deepEqual(tokenize("Yolŋu-matha ŋurra don't"), ["yolŋu-matha", "ŋurra", "don't"],
    "the whole point of not using [A-Za-z0-9]");
});

check("counts n-grams and ranks them by frequency", () => {
  const rows = analyzeNgrams(docs("a b a b", "a b"), { n: 2, minFreq: 1 });
  const ab = rows.find((r) => r.ngram === "a b");
  assert.equal(ab.count, 3);
  assert.equal(rows[0].ngram, "a b", "most frequent first");
});

check("an n-gram never spans two documents", () => {
  // "b c" would exist only by running the window across the boundary.
  const rows = analyzeNgrams(docs("a b", "c d"), { n: 2, minFreq: 1 });
  assert.deepEqual(rows.map((r) => r.ngram).sort(), ["a b", "c d"]);
});

check("minimum frequency and stopwords filter rows out", () => {
  const corpus = docs("the cat sat", "the cat ran", "the cat sat");
  assert.equal(analyzeNgrams(corpus, { n: 2, minFreq: 3 }).length, 1, "only 'the cat' occurs three times");
  const noStop = analyzeNgrams(corpus, { n: 2, minFreq: 1, removeStopwords: true });
  assert.ok(!noStop.some((r) => r.ngram.split(" ").includes("the")),
    "a stopword anywhere in the n-gram drops it");
});

check("stopwords are not removed unless asked", () => {
  const rows = analyzeNgrams(docs("the cat", "the cat"), { n: 2, minFreq: 1 });
  assert.equal(rows[0].ngram, "the cat",
    "the default keeps them: the list is English and the corpus may not be");
});

check("MI and t-score, against hand-worked numbers", () => {
  // "a b" twice in "a b c a b c": N=6 tokens, f(a)=2, f(b)=2, O=2.
  // expected = 2*2/6 = 0.666… ; MI = log2(2/0.666…) = log2(3) ≈ 1.585
  // t = (2 - 0.666…)/sqrt(2) ≈ 0.943
  const [row] = analyzeNgrams(docs("a b c a b c"), { n: 2, minFreq: 2 });
  assert.equal(row.ngram, "a b");
  assert.ok(Math.abs(row.mi - Math.log2(3)) < 1e-9, `MI was ${row.mi}`);
  assert.ok(Math.abs(row.tScore - (2 - 4 / 6) / Math.SQRT2) < 1e-9, `t was ${row.tScore}`);
});

check("no association measures for anything but bigrams", () => {
  const [row] = analyzeNgrams(docs("a b c a b c"), { n: 3, minFreq: 2 });
  assert.ok(!("mi" in row) && !("tScore" in row), "MI is defined for pairs, not triples");
});

console.log("\ncollocations");

check("tokenises Unicode words and matches nodes without case", () => {
  assert.deepEqual(tokenizeCollocations("YOLNGU-matha ŋurra don't"), ["yolngu-matha", "ŋurra", "don't"]);
  const rows = analyzeCollocations(docs("YOLNGU-matha ŋurra"), { nodes: "yolngu-matha", minFreq: 1, spanLeft: 1, spanRight: 1 });
  assert.equal(rows[0].collocate, "ŋurra");
});

check("uses one corpus stream and independent left/right windows", () => {
  const rows = analyzeCollocations(docs("left node right", "after"), {
    nodes: "node", minFreq: 1, spanLeft: 1, spanRight: 2,
  });
  assert.deepEqual(rows.map((row) => row.collocate), ["left", "right", "after"]);
});

check("handles comma-separated nodes and frequency filtering", () => {
  const rows = analyzeCollocations(docs("a x b a x b"), {
    nodes: "a, b, missing", minFreq: 2, spanLeft: 1, spanRight: 1,
  });
  assert.deepEqual(rows.map((row) => [row.node, row.collocate, row.O]), [["a", "x", 2], ["b", "x", 2]]);
});

check("returns hand-worked association measures and stable columns", () => {
  const [row] = analyzeCollocations(docs("a b c a b c"), {
    nodes: "a", minFreq: 2, spanLeft: 1, spanRight: 1,
  }).filter((candidate) => candidate.collocate === "b");
  assert.deepEqual(Object.keys(row), [
    "node", "collocate", "O", "E", "f_node", "f_collocate", "N", "OE", "MI", "MI2", "MI3",
    "G2", "tscore", "DeltaP12", "DeltaP21", "Fisher",
  ]);
  assert.equal(row.O, 2);
  assert.equal(row.E, 2 * 2 / 6);
  assert.ok(Math.abs(row.MI - Math.log2(3)) < 1e-9);
  assert.ok(Math.abs(row.tscore - (2 - 2 / 3) / Math.SQRT2) < 1e-9);
  assert.ok(Math.abs(row.Fisher - 1 / 15) < 1e-9);
});

check("Fisher exact handles a known table and large tables", () => {
  assert.ok(Math.abs(fisherExact(2, 0, 0, 4) - 1 / 15) < 1e-9);
  assert.equal(fisherExact(0, 0, 0, 2001), 1);
});

check("selects one file and combines selected CSV columns", () => {
  const documents = [
    { source: "notes.txt", text: "node note" },
    { source: "data.csv", text: "node ignored" },
  ];
  const tables = [{
    source: "data.csv",
    header: ["text", "translation", "speaker"],
    rows: [["node", "ŋurra", "CHI"]],
  }];
  assert.deepEqual(
    documentsForSelection(documents, tables, "data.csv", ["text", "translation"]).map((row) => row.text),
    ["node ŋurra"],
    "selected CSV columns become one analysis document per row"
  );
  assert.deepEqual(
    documentsForSelection(documents, tables, "notes.txt").map((row) => row.text),
    ["node note"],
    "non-CSV sources keep their existing document text"
  );
});

console.log("\nsentimentexplorer");

check("parses the LADAL NRC CSV into case-normalized word categories", () => {
  const parsed = parseNrcLexiconCsv('\uFEFF"word","sentiment"\r\n"Excellent","joy"\r\n"excellent","positive"\r\n"excellent","trust"\r\n');
  assert.deepEqual([...parsed.get("excellent")], ["joy", "positive", "trust"]);
});

check("rejects invalid or empty NRC CSV instead of returning an empty lexicon", () => {
  assert.throws(() => parseNrcLexiconCsv(""), /empty/);
  assert.throws(() => parseNrcLexiconCsv('"word","sentiment"\n"term","unknown"'), /Invalid NRC/);
});

const lexicon = new Map([
  ["excellent", new Set(["joy", "positive", "trust"])],
  ["sad", new Set(["sadness", "negative"])],
]);

check("annotates a word belonging to several categories at once", () => {
  const [row] = annotateSection(["excellent"], "s1", lexicon);
  assert.equal(row.joy, 1);
  assert.equal(row.positive, 1);
  assert.equal(row.trust, 1);
  assert.equal(row.anger, 0);
});

check("a word absent from the lexicon annotates as all zeros", () => {
  const [row] = annotateSection(["unknown"], "s1", lexicon);
  assert.ok(Object.entries(row).every(([key, value]) => key === "section" || key === "token_index" || key === "word" || value === 0));
});

check("buildSummary counts and rounds percentages per section", () => {
  const rows = [
    ...annotateSection(["excellent", "sad"], "s1", lexicon),
    ...annotateSection(["excellent"], "s2", lexicon),
  ];
  const summary = buildSummary(rows);
  const s1 = summary.find((row) => row.section === "s1");
  assert.equal(s1.total_tokens, 2);
  assert.equal(s1.joy_n, 1);
  assert.equal(s1.joy_pct, 50);
});

check("a token never crosses a section boundary", () => {
  const { annotated } = analyzeSentiment(
    [{ source: "a.txt", text: "excellent" }, { source: "b.txt", text: "sad" }],
    lexicon,
  );
  assert.deepEqual(annotated.map((row) => [row.section, row.token_index]), [["a.txt", 1], ["b.txt", 1]]);
});

check("selects one file and combines selected CSV columns, same as collocation", () => {
  const documents = [{ source: "notes.txt", text: "excellent" }];
  const tables = [{
    source: "data.csv",
    header: ["text", "note"],
    rows: [["sad", "extra"]],
  }];
  assert.deepEqual(
    documentsForSentimentSelection(documents, tables, "data.csv", ["text"]).map((row) => row.text),
    ["sad"],
  );
  assert.deepEqual(
    documentsForSentimentSelection(documents, tables, "notes.txt").map((row) => row.text),
    ["excellent"],
  );
});

check("selects multiple files at once, each keeping its own source", () => {
  const documents = [{ source: "notes.txt", text: "excellent" }];
  const tables = [
    { source: "data.csv", header: ["text", "note"], rows: [["sad", "extra"]] },
    { source: "other.csv", header: ["text"], rows: [["joy"]] },
  ];
  const rows = documentsForSentimentSelection(documents, tables, ["notes.txt", "data.csv", "other.csv"], ["text"]);
  assert.deepEqual(rows.map((row) => [row.source, row.text]), [
    ["notes.txt", "excellent"], ["data.csv", "sad"], ["other.csv", "joy"],
  ]);
});

check("an explicit empty selection means nothing, not everything", () => {
  const documents = [{ source: "notes.txt", text: "excellent" }];
  assert.deepEqual(documentsForSentimentSelection(documents, [], []), []);
  assert.deepEqual(documentsForSentimentSelection(documents, [], undefined), documents);
});

check("a per-file column Map picks a different column from each selected table", () => {
  const tables = [
    { source: "a.csv", header: ["text", "note"], rows: [["ignored", "from-a"]] },
    { source: "b.csv", header: ["translation", "text"], rows: [["from-b", "ignored"]] },
  ];
  const columns = new Map([["a.csv", ["note"]], ["b.csv", ["translation"]]]);
  const rows = documentsForSentimentSelection([], tables, ["a.csv", "b.csv"], columns);
  assert.deepEqual(rows.map((row) => [row.source, row.text]), [
    ["a.csv", "from-a"], ["b.csv", "from-b"],
  ]);
});

console.log("\ntopicdetector");

check("tokenises Unicode words and drops single characters and pure numbers", () => {
  assert.deepEqual(tokenizeTopics("Yolŋu-matha a 123 don't 2026"), ["yolŋu-matha", "don't"]);
});

check("table rows are independent documents while plain-file lines merge into one document", () => {
  const flat = [
    { source: "a.txt", text: "first line" },
    { source: "a.txt", text: "second line" },
  ];
  const tables = [{ source: "b.csv", header: ["text"], rows: [["row one"], ["row two"]] }];
  const docs = documentsForTopicSelection(flat, tables, ["a.txt", "b.csv"], []);
  assert.deepEqual(docs.map((d) => [d.source, d.label || "", d.text]), [
    ["a.txt", "", "first line second line"],
    ["b.csv", "b.csv · row 1", "row one"],
    ["b.csv", "b.csv · row 2", "row two"],
  ]);
});

check("buildVocabulary trims by frequency and drops emptied documents", () => {
  const docs = [["a", "a", "b"], ["a", "c"], ["z"]];
  const { vocabulary, documents, keptDocumentIndexes, droppedDocumentIndexes } =
    buildVocabulary(docs, { minTermFreq: 2, minDocFreq: 2 });
  assert.deepEqual(vocabulary, ["a"]);
  assert.deepEqual(keptDocumentIndexes, [0, 1]);
  assert.deepEqual(droppedDocumentIndexes, [2], "the doc with only 'z' has nothing left after trimming");
  assert.deepEqual(documents, [[0, 0], [0]]);
});

check("fitLDA is deterministic for a fixed seed", () => {
  const docs = [[0, 1, 0, 1], [1, 2, 1, 2], [0, 0, 2, 2]];
  const a = fitLDA(docs, 3, { k: 2, seed: 7, iterations: 25 });
  const b = fitLDA(docs, 3, { k: 2, seed: 7, iterations: 25 });
  assert.deepEqual(a.termTopicWeights, b.termTopicWeights);
  assert.deepEqual(a.docTopicWeights, b.docTopicWeights);
});

check("topTermsPerTopic orders most probable term first", () => {
  const vocabulary = ["apple", "banana", "cherry"];
  const weights = [[0.1, 0.7, 0.2], [0.6, 0.1, 0.3]];
  assert.deepEqual(topTermsPerTopic(weights, vocabulary, 2), [
    ["banana", "cherry"], ["apple", "cherry"],
  ]);
});

check("buildSeedDictionary drops empty topics and throws when none have words", () => {
  const dict = buildSeedDictionary(["Fruit", "Empty"], [["apple", "banana"], []]);
  assert.deepEqual(dict.map((t) => t.name), ["Fruit"]);
  assert.throws(() => buildSeedDictionary(["A", "B"], [[], []]));
});

check("fitSeededLDA pulls a seed-word-dominated document toward its topic, and an unmatched one toward 'other'", () => {
  const vocabulary = ["apple", "banana", "rocket", "engine"];
  // doc 0/1: fruit words; doc 2: unrelated to any seed word.
  const docs = [
    [0, 1, 0, 1, 0], [1, 0, 1, 0, 1],
    [2, 3, 2, 3, 2],
  ];
  const dict = buildSeedDictionary(["Fruit"], [["apple", "banana"]]);
  const result = fitSeededLDA(docs, vocabulary, dict, { seed: 3, iterations: 50 });
  assert.deepEqual(result.topicNames, ["Fruit", "other"]);
  const best = result.docTopicWeights.map((w) => w.indexOf(Math.max(...w)));
  assert.equal(best[0], 0, "a fruit-heavy document is assigned to the seeded topic");
  assert.equal(best[1], 0);
  assert.equal(best[2], 1, "a document matching no seed word falls to the residual topic");
});

console.log("\nchart");

console.log("\nplots");

check("converts table rows to unique object keys", () => {
  assert.deepEqual(tableToRows({ header: ["name", "name", ""], rows: [["Ada", "Lovelace", "x"]] }), [
    { name: "Ada", "name (2)": "Lovelace", "column 3": "x" },
  ]);
  assert.deepEqual(tableToRows({ header: ["name"], rows: [] }), []);
});

check("blank cells become null so the plots library counts them as missing", () => {
  assert.deepEqual(tableToRows({ header: ["a", "b", "c"], rows: [["", "  ", "0"], ["x"]] }), [
    { a: null, b: null, c: "0" },
    { a: "x", b: null, c: null },
  ]);
});

check("creates named datasets from loaded tables and validates config shape", () => {
  const tables = [
    { source: "_outputs/roctable/People.csv", header: ["name"], rows: [["Ada"]] },
    { source: "_outputs/roctable/Places.csv", header: ["place"], rows: [["Sydney"]] },
  ];
  const config = createDefaultConfig(tables);
  assert.deepEqual(Object.keys(config.plots.datasets), ["People", "Places"]);
  assert.deepEqual(datasetsForConfig(tables.slice(0, 1), config).missing.map(({ name }) => name), ["Places"]);
  config.futureOption = { preserved: true };
  assert.deepEqual(validatePlotsConfig(config).futureOption, { preserved: true });
});

checkAsync("generates table-backed builder specs and merges plot embed options", async () => {
  const table = { source: "people.csv", header: ["name", "group"], rows: [["Ada", "A"], ["Lin", "B"]] };
  const config = createDefaultConfig([table]);
  const datasetName = Object.keys(config.plots.datasets)[0];
  config.plots.globalConfig = { actions: false, renderer: "svg" };
  config.plots.plotList.push({
    dataset: { name: datasetName },
    makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group", title: "People" } },
    generatedSpec: {}, customSpec: {}, config: { renderer: "canvas" }, plotCardSpan: 2,
  });
  const { plots, missing } = await generatePlotSpecs(config, [table]);
  assert.deepEqual(missing, []);
  assert.equal(plots[0].spec.data.values[0].name, "Ada");
  assert.deepEqual(embedOptions(config, config.plots.plotList[0]), { actions: false, renderer: "canvas" });
  assert.equal(layoutSpan(config.plots.plotList[0]), 2);
});

checkAsync("multiple plots can reuse one configured dataset", async () => {
  const table = { source: "people.csv", header: ["name", "group"], rows: [["Ada", "A"], ["Lin", "B"]] };
  const config = createDefaultConfig([table]);
  const datasetName = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push(
    { dataset: { name: datasetName }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group" } }, customSpec: {}, config: {} },
    { dataset: { name: datasetName }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "name" } }, customSpec: {}, config: {} },
  );
  const { plots, missing } = await generatePlotSpecs(config, [table]);
  assert.deepEqual(missing, []);
  assert.equal(plots.length, 2);
  assert.deepEqual(plots.map((result) => result.spec.data.values), [
    [{ name: "Ada", group: "A" }, { name: "Lin", group: "B" }],
    [{ name: "Ada", group: "A" }, { name: "Lin", group: "B" }],
  ]);
  assert.deepEqual(plots.map((result) => result.plot.dataset.name), [datasetName, datasetName]);
});

checkAsync("a value-to-color palette becomes the color scale without mutating config", async () => {
  const table = { source: "people.csv", header: ["name", "sex"], rows: [["Ada", "Female"], ["Lin", "Male"]] };
  const config = createDefaultConfig([table]);
  const datasetName = Object.keys(config.plots.datasets)[0];
  const palette = { Female: "#ff69b4", Male: "#1e90ff" };
  config.plots.plotList.push({
    dataset: { name: datasetName },
    makeSpec: { plotFunction: "barPlotCount", args: { xVar: "name", colorVar: "sex", palette } },
    customSpec: {}, config: {},
  });
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.equal(plots[0].error, null);
  assert.deepEqual(dataLayer(plots[0].spec).encoding.color.scale, { domain: ["Female", "Male"], range: ["#ff69b4", "#1e90ff"] });
  assert.deepEqual(config.plots.plotList[0].makeSpec.args.palette, palette);
});

checkAsync("bar and box plot category order reaches the plotted layer", async () => {
  const table = { source: "people.csv", header: ["group", "age"], rows: [["A", "30"], ["B", "40"], ["C", "50"]] };
  const config = createDefaultConfig([table]);
  const name = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push(
    { dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group", sort: "descending" } } },
    { dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group", sort: ["C", "A"] } } },
    { dataset: { name }, makeSpec: { plotFunction: "boxPlot", args: { xVar: "group", yVar: "age", yType: "quantitative", sort: ["B"] } } },
  );
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.deepEqual(plots.map((result) => result.error), [null, null, null]);
  assert.deepEqual(dataLayer(plots[0].spec).encoding.x.sort, { op: "count", field: "group", order: "descending" });
  assert.deepEqual(dataLayer(plots[1].spec).encoding.x.sort, ["C", "A"]);
  assert.deepEqual(dataLayer(plots[2].spec).encoding.x.sort, ["B"]);
});

checkAsync("hiding invalid values filters blank cells from the plotted layer and keeps the warning layer", async () => {
  const table = { source: "people.csv", header: ["group"], rows: [["A"], [""]] };
  const config = createDefaultConfig([table]);
  const name = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push(
    { dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group", invalidValues: "hide" } } },
    { dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group" } } },
  );
  const { plots } = await generatePlotSpecs(config, [table]);
  const [hidden, shown] = plots.map((result) => result.spec);
  assert.deepEqual(hidden.data.values[1], { group: null });
  const [filter] = dataLayer(hidden).transform;
  assert.match(filter.filter, /group/, "the plotted layer filters on the X field");
  assert.ok(!(dataLayer(shown).transform || []).some((step) => step.filter), "the default shows missing values");
  for (const spec of [hidden, shown]) {
    assert.ok(spec.layer.some((layer) => layer.description === "_missing_values_warning"));
  }
});

checkAsync("generated specs run in Vega for column names that are not identifiers, like roctable's @id", async () => {
  const table = { source: "objects.csv", header: ["@type", "speaker age", "schema:year"], rows: [["Person", "30", "1978"], ["", "41", ""]] };
  const config = createDefaultConfig([table]);
  const name = Object.keys(config.plots.datasets)[0];
  for (const invalidValues of ["show", "hide"]) {
    config.plots.plotList.push(
      { dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "@type", invalidValues } } },
      { dataset: { name }, makeSpec: { plotFunction: "scatterPlot", args: { xVar: "speaker age", yVar: "schema:year", colorVar: "@type", invalidValues } } },
    );
  }
  const { plots } = await generatePlotSpecs(config, [table]);
  for (const result of plots) {
    assert.equal(result.error, null);
    const view = new vega.View(vega.parse(compileVegaLite(result.spec).spec), { renderer: "none" });
    await view.runAsync();
  }
});

checkAsync("bar plots of percentages render in every bar layout, with and without a color field", async () => {
  const table = { source: "people.csv", header: ["group", "sex"], rows: [["A", "F"], ["A", "M"], ["B", "F"], ["B", ""]] };
  const config = createDefaultConfig([table]);
  const name = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push({ dataset: { name }, makeSpec: { plotFunction: "barPlotPercent", args: { xVar: "group" } } });
  for (const stackBars of [undefined, "stack", "side_by_side", "stack_and_normalize"]) {
    config.plots.plotList.push({ dataset: { name }, makeSpec: { plotFunction: "barPlotPercent", args: { xVar: "group", colorVar: "sex", stackBars } } });
  }
  config.plots.plotList.push({ dataset: { name }, makeSpec: { plotFunction: "barPlotCount", args: { xVar: "group", colorVar: "sex", stackBars: "side_by_side" } } });
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.ok(BUILDER_NAMES.includes("barPlotPercent"));
  for (const result of plots) {
    assert.equal(result.error, null);
    await new vega.View(vega.parse(compileVegaLite(result.spec).spec), { renderer: "none" }).runAsync();
  }
});

checkAsync("histograms report a missing type or date bin size, and ignore dropped bin options", async () => {
  const table = { source: "people.csv", header: ["born", "age"], rows: [["1978-03-01", "30"], ["1991-01-01", "41"]] };
  const config = createDefaultConfig([table]);
  const name = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push(
    { dataset: { name }, makeSpec: { plotFunction: "histogramPlot", args: { xVar: "age" } } },
    { dataset: { name }, makeSpec: { plotFunction: "histogramPlot", args: { xVar: "born", xType: "temporal" } } },
    { dataset: { name }, makeSpec: { plotFunction: "histogramPlot", args: { xVar: "born", xType: "temporal", xTimeUnit: "year", step: 5 } } },
    { dataset: { name }, makeSpec: { plotFunction: "histogramPlot", args: { xVar: "age", xType: "quantitative", maxbins: 10, nice: true } } },
  );
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.match(plots[0].error, /quantitative or temporal/);
  assert.match(plots[1].error, /time unit/);
  assert.equal(plots[2].error, null);
  assert.equal(plots[3].error, null);
  assert.match(plots[3].warnings.join(" "), /maxbins, nice no longer apply/);
  for (const result of plots.slice(2)) await new vega.View(vega.parse(compileVegaLite(result.spec).spec), { renderer: "none" }).runAsync();
});

checkAsync("custom specs bind the selected in-memory dataset without mutating config", async () => {
  const table = { source: "people.csv", header: ["name"], rows: [["Ada"]] };
  const config = createDefaultConfig([table]);
  const datasetName = Object.keys(config.plots.datasets)[0];
  const customSpec = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", data: { name: datasetName }, mark: "bar", encoding: { x: { field: "name", type: "nominal" } } };
  config.plots.plotList.push({ dataset: { name: datasetName }, makeSpec: { plotFunction: "barPlotCount", args: {} }, customSpec, config: {} });
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.deepEqual(plots[0].spec.data.values, [{ name: "Ada" }]);
  assert.deepEqual(customSpec.data, { name: datasetName });
});

checkAsync("unknown builder entries are preserved and reported per plot", async () => {
  const table = { source: "data.csv", header: ["x"], rows: [["a"]] };
  const config = createDefaultConfig([table]);
  const datasetName = Object.keys(config.plots.datasets)[0];
  config.plots.plotList.push({ dataset: { name: datasetName }, makeSpec: { plotFunction: "futurePlot", args: {} } });
  const { plots } = await generatePlotSpecs(config, [table]);
  assert.match(plots[0].error, /unavailable/);
  assert.equal(validatePlotsConfig(config).plots.plotList[0].makeSpec.plotFunction, "futurePlot");
  assert.ok(BUILDER_NAMES.includes("plotMapHeatmap"));
});

check("the panel's library label shows the pinned ro-crate-plots commit", () => {
  assert.equal(libraryPin("github:Language-Research-Technology/ro-crate-plots#d53c3e0bdafdb7ce5eaead455f01a8bd0e5bfe3c"), "d53c3e0");
  assert.equal(libraryPin("github:Language-Research-Technology/ro-crate-plots#main"), "main");
  assert.equal(libraryPin("file:../ro-crate-plots"), "file:../ro-crate-plots");
  assert.match(libraryPin(), /^[0-9a-f]{7}$/, "package.json pins a commit");
});

check("projects map coordinates to image points", () => {
  assert.deepEqual(
    projectMapPoints([{ lat: 0, lon: 0, weight: 3 }], 2, 1, 1, 0, 0, 256),
    [{ x: 256, y: 256, weight: 3 }],
  );
});

check("maps selected source columns to map coordinates and reports invalid rows", () => {
  assert.deepEqual(mapRowsFromColumns([
    { lat_col: "-33.8", lon_col: "151.2", count: "4" },
    { lat_col: "unknown", lon_col: "0", count: "2" },
    { lat_col: null, lon_col: "", count: "1" },
  ], { latitudeField: "lat_col", longitudeField: "lon_col", weightField: "count" }), {
    data: [{ lat: -33.8, lon: 151.2, weight: 4 }],
    invalidCoordinates: 2,
  });
});

const rows = [
  { name: "one", value: "10" },
  { name: "two", value: "20" },
  { name: "three", value: "n/a" },
];

check("skips non-numeric values and counts them", () => {
  const g = chartGeometry(rows, { xColumn: "name", yColumn: "value" });
  assert.equal(g.points.length, 2);
  assert.equal(g.skipped, 1, "the panel reports this rather than plotting a zero");
});

check("the scale always includes zero", () => {
  const g = chartGeometry([{ x: "a", y: "10" }, { x: "b", y: "12" }], { xColumn: "x", yColumn: "y" });
  assert.equal(g.scale.min, 0, "a floating baseline makes bar lengths meaningless");
  assert.equal(g.scale.max, 12);
});

check("the tallest value sits at the top of the plot, zero at the bottom", () => {
  const g = chartGeometry(rows, { xColumn: "name", yColumn: "value" });
  assert.equal(Math.round(g.scale.y(20)), g.plot.margin.top, "the maximum touches the top margin");
  assert.equal(Math.round(g.scale.y(0)), g.plot.margin.top + g.plot.innerHeight, "zero sits on the axis");
});

check("negative values keep zero inside the plot", () => {
  const g = chartGeometry([{ x: "a", y: "-5" }, { x: "b", y: "5" }], { xColumn: "x", yColumn: "y" });
  const zero = g.scale.y(0);
  assert.ok(zero > g.plot.margin.top && zero < g.plot.margin.top + g.plot.innerHeight,
    "the baseline is between the extremes, not off the chart");
});

check("ticks span the scale and are labelled", () => {
  const g = chartGeometry(rows, { xColumn: "name", yColumn: "value" });
  assert.equal(g.ticks[0].value, 0);
  assert.equal(g.ticks[g.ticks.length - 1].value, 20);
  assert.equal(g.ticks[g.ticks.length - 1].label, "20");
});

check("thousands are abbreviated in tick labels", () => {
  const g = chartGeometry([{ x: "a", y: "4000" }], { xColumn: "x", yColumn: "y" });
  assert.equal(g.ticks[g.ticks.length - 1].label, "4k");
});

check("numbers written with separators still count", () => {
  const g = chartGeometry([{ x: "a", y: "1,200" }], { xColumn: "x", yColumn: "y" });
  assert.equal(g.points[0].value, 1200);
  assert.equal(g.skipped, 0);
});

check("an empty table yields no points and no division by zero", () => {
  const g = chartGeometry([], { xColumn: "x", yColumn: "y" });
  assert.equal(g.points.length, 0);
  assert.ok(Number.isFinite(g.step), `step was ${g.step}`);
});

await Promise.all(asyncChecks);

if (failures) {
  console.error(`\nvisualisation.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
