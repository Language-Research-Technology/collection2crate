// The "include in the RO-Crate" checkbox for the files ca-data-prep
// and chat-export generate (src/_crate_outputs.js). Real ro-crate; the plugins'
// crate:build handlers are driven with a hand-built ctx.
//
//   node crate-outputs.test.mjs
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import { REGISTRY } from "./index.js";
import {
  outputsInCrateOption, includeOutputs, removeOutputEntities,
} from "./src/_crate_outputs.js";
import { buildRoCrateMetadata } from "./plugins/ca-data-prep/process.js";
import { OUTPUTS_OPTION_KEY as CSV_KEY } from "./plugins/ca-data-prep/index.js";
import { OUTPUTS_OPTION_KEY as CHAT_KEY } from "./plugins/chat-export/index.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};
const noop = () => {};
const ids = (crate) => crate.getGraph().map((e) => e["@id"]).sort();
const refs = (v) => [].concat(v ?? []).map((x) => (x && typeof x === "object" ? x["@id"] : x));

// The real core helper, so the plugins' merge path is exercised properly. This
// repo has no dependency on collection2crate, so the check that needs it is
// skipped when the sibling checkout isn't there.
const { mergeCrateInto } = await import("../collection2crate/src/crate.js").catch(() => ({}));
const deps = new Proxy({}, {
  get: (_t, key) => (key === "mergeCrateInto" && mergeCrateInto ? mergeCrateInto : noop),
  has: () => true,
});

const record = {
  baseName: "interview", objectId: "#interview", annotationId: "#interview-annotation",
  docxId: "transcripts/interview.docx", docxName: "interview.docx",
  csvDirName: "_outputs/csv", csvName: "interview.csv", csvId: "_outputs/csv/interview.csv",
  speakerRefs: [], persons: [],
};

console.log("The option");

await check("both plugins offer it as a child of their own option", () => {
  const find = (name, parentKey, key) => {
    const schema = REGISTRY[name](deps).optionSchema;
    assert.equal(schema.key, parentKey);
    const child = (schema.children || []).find((c) => c.key === key);
    assert.ok(child, `${name} has no ${key} child`);
    return child;
  };
  for (const node of [
    find("ca-data-prep", "processTranscriptDocuments", CSV_KEY),
    find("chat-export", "generateChatFiles", CHAT_KEY),
  ]) {
    assert.equal(node.type, undefined, "no type: collection2crate renders a checkbox");
    assert.match(node.label, /^Include .* in the RO-Crate$/);
    assert.equal(node.stage, "build", "changing it doesn't discard a Process run");
  }
});

await check("only a ticked box includes the files", () => {
  assert.equal(includeOutputs({ k: true }, "k"), true);
  assert.equal(includeOutputs({ k: false }, "k"), false, "unticked, or forced off because the profile doesn't offer it");
  assert.equal(includeOutputs({}, "k"), false);
  assert.equal(outputsInCrateOption("k", "the X files").label, "Include the X files in the RO-Crate");
});

console.log("\nRemoving output entities");

await check("removes entities under the directories, with every reference and orphaned annotation", () => {
  const crate = new ROCrate({ array: true, link: true });
  crate.rootDataset.hasPart = [{ "@id": "#doc" }, { "@id": "./_outputs/chat/doc.cha" }];
  crate.addEntity({ "@id": "#doc", "@type": "RepositoryObject",
    hasPart: [{ "@id": "doc.docx" }, { "@id": "_outputs/csv/doc.csv" }, { "@id": "./_outputs/chat/doc.cha" }],
    "ldac:mainText": { "@id": "_outputs/csv/doc.csv" } });
  crate.addEntity({ "@id": "doc.docx", "@type": "File" });
  crate.addEntity({ "@id": "_outputs/csv/doc.csv", "@type": "File" });
  crate.addEntity({ "@id": "./_outputs/chat/doc.cha", "@type": "File" });
  crate.addEntity({ "@id": "#note", "@type": "Annotation", annotationOf: { "@id": "#doc" }, annotationBody: { "@id": "_outputs/csv/doc.csv" } });
  crate.addEntity({ "@id": "_outputs/csv-notes.txt", "@type": "File" });

  assert.equal(removeOutputEntities(crate, ["_outputs/csv"]), 2, "the CSV and the annotation whose body it was");
  assert.deepEqual(ids(crate), ["./", "#doc", "./_outputs/chat/doc.cha", "_outputs/csv-notes.txt", "doc.docx", "ro-crate-metadata.json"].sort(),
    "a sibling whose name merely starts the same way stays");
  const doc = crate.getEntity("#doc");
  assert.deepEqual(refs(doc.hasPart), ["doc.docx", "./_outputs/chat/doc.cha"]);
  assert.equal(doc["ldac:mainText"], undefined, "a property left with nothing is removed");

  assert.equal(removeOutputEntities(crate, ["_outputs/chat/"]), 1, "a ./ prefix on the @id and a trailing slash on the dir both match");
  assert.deepEqual(refs(crate.rootDataset.hasPart), ["#doc"]);
  assert.equal(removeOutputEntities(null, ["x"]), 0);
});

console.log("\nca-data-prep");

await check("buildRoCrateMetadata without outputs describes the document and nothing generated", () => {
  const crate = buildRoCrateMetadata("C", [record], undefined, { includeOutputs: false });
  assert.ok(crate.getEntity("#interview"));
  assert.ok(crate.getEntity("transcripts/interview.docx"));
  assert.equal(crate.getEntity("_outputs/csv/interview.csv"), undefined);
  assert.equal(crate.getEntity("#interview-annotation"), undefined);
  const object = crate.getEntity("#interview");
  assert.deepEqual(refs(object.hasPart), ["transcripts/interview.docx"]);
  assert.equal(object["ldac:mainText"], undefined);
  const withOutputs = buildRoCrateMetadata("C", [record]);
  assert.ok(withOutputs.getEntity("_outputs/csv/interview.csv"), "the default still includes them");
});

const caCtx = ({ options = {}, ...extra }) => ({
  log: noop, config: {},
  caDataPrep: { files: [{}], documentRecords: [record] },
  ...extra,
  options: { processTranscriptDocuments: true, ...options },
});

await check("the transcript crate declares its prefixes in one context entry", () => {
  const context = buildRoCrateMetadata("c", [{ ...record, persons: [] }]).toJSON()["@context"];
  const objects = context.filter((entry) => entry && typeof entry === "object");
  assert.equal(objects.filter((entry) => "ldac" in entry || "pcdm" in entry).length, 1, JSON.stringify(context));
});

await check("ticked: the CSV is in the crate", async () => {
  const ctx = caCtx({ crate: null, options: { [CSV_KEY]: true } });
  await REGISTRY["ca-data-prep"](deps).hooks["crate:build"].handler(ctx);
  assert.ok(ctx.crate.getEntity("_outputs/csv/interview.csv"));
});

await check("unticked, on an existing crate: an earlier build's CSV entities are taken out", async () => {
  if (!mergeCrateInto) return console.log("       (skipped: collection2crate checkout not beside this repo)");
  const existing = buildRoCrateMetadata("C", [record]);
  const ctx = caCtx({ crate: existing, existingCrate: { "@graph": [] }, options: { [CSV_KEY]: false } });
  await REGISTRY["ca-data-prep"](deps).hooks["crate:build"].handler(ctx);
  assert.equal(ctx.crate, existing, "the run's crate is kept");
  assert.equal(existing.getEntity("_outputs/csv/interview.csv"), undefined);
  assert.equal(existing.getEntity("#interview-annotation"), undefined);
  assert.deepEqual(refs(existing.getEntity("#interview").hasPart), ["transcripts/interview.docx"]);
});

console.log("\nchat-export");

const chatCtx = (crate, options = {}) => ({
  log: noop, crate,
  options: { generateChatFiles: true, ...options },
  chatExport: { files: [{}], documentRecords: [{ baseName: "interview", chatDirName: "_outputs/chat", chatName: "interview.cha" }] },
});

await check("ticked: the .cha is added", async () => {
  const crate = new ROCrate({ array: true, link: true });
  await REGISTRY["chat-export"](deps).hooks["crate:build"].handler(chatCtx(crate, { [CHAT_KEY]: true }));
  assert.ok(crate.getEntity("_outputs/chat/interview.cha"));
  assert.equal(crate.getGraph().some((e) => e["@id"].startsWith("./_outputs")), false, "no ./ ids");
});

await check("ticked: an earlier build's ./ id is replaced by the plain one, references kept", async () => {
  const crate = new ROCrate({ array: true, link: true });
  crate.rootDataset.hasPart = [{ "@id": "./_outputs/chat/interview.cha" }];
  crate.addEntity({ "@id": "#interview", "@type": "RepositoryObject", hasPart: [{ "@id": "interview.docx" }, { "@id": "./_outputs/chat/interview.cha" }] });
  crate.addEntity({ "@id": "./_outputs/chat/interview.cha", "@type": "File", name: "interview.cha", encodingFormat: "text/plain", isPartOf: { "@id": "#interview" } });
  await REGISTRY["chat-export"](deps).hooks["crate:build"].handler(chatCtx(crate, { [CHAT_KEY]: true }));
  const ids = crate.getGraph().map((e) => e["@id"]);
  assert.ok(ids.includes("_outputs/chat/interview.cha"));
  assert.ok(!ids.includes("./_outputs/chat/interview.cha"));
  assert.deepEqual(refs(crate.getEntity("#interview").hasPart), ["interview.docx", "_outputs/chat/interview.cha"]);
  assert.deepEqual(refs(crate.rootDataset.hasPart), ["_outputs/chat/interview.cha"]);
  assert.deepEqual(refs(crate.getEntity("_outputs/chat/interview.cha").isPartOf), ["#interview"]);
});

await check("unticked: nothing is added, and an earlier build's .cha entity is removed", async () => {
  const crate = new ROCrate({ array: true, link: true });
  const handler = REGISTRY["chat-export"](deps).hooks["crate:build"].handler;
  await handler(chatCtx(crate, { [CHAT_KEY]: true }));
  crate.rootDataset.hasPart = [{ "@id": "_outputs/chat/interview.cha" }];
  await handler(chatCtx(crate, { [CHAT_KEY]: false }));
  assert.equal(crate.getEntity("_outputs/chat/interview.cha"), undefined);
  assert.equal(crate.rootDataset.hasPart, undefined);
});

console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
