// THX-01 for the Text Classifier panel: input construction, probabilities, and
// the onnxruntime-web session. A port of the model's own Python code
// (thx01/common.py build_sequence, thx01/agent.py _head_budget and _decode),
// checked against thx01.fixture.json, which tools/make_fixture.py writes from
// that code.
//
// Everything above load() is pure and runs in Node for the tests; load()
// imports onnxruntime-web and the tokenizer on demand, so neither is fetched
// until someone asks for the model.

export const ORT_VERSION = "1.30.0";
const ORT_WASM_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const CACHE_NAME = "textclassifier-models-v1";

export const SPECIAL_IDS = { cls: 2, sep: 1, mask: 4, pad: 0 };
const MASK_TOKEN = "<mask>";
export const MAX_LEN = 1024;
const HEAD_MAX_LEN = 256;
const MAX_OPTION_TOKENS = 48;
const QTYPES = { choice: 0, score: 1, noul: 2 };
const TEMPERATURE = [2.55, 3.05, 2.0];
const TEMPERATURE_BY_OPTIONS = {
  "noul:2": 2.0, "choice:3-5": 2.55, "choice:6-10": 2.3, "score:3-5": 3.05, "choice:11+": 2.55,
};
// Above this many options the Python code runs a two-round tournament, which
// is not ported. The panel refuses larger label sets for "one label per row".
export const MAX_CHOICE_OPTIONS = 24;

// The JavaScript tokenizers split a run of spaces or tabs differently from the
// Rust tokenizer the model was trained with. Collapsing each run to one space
// makes the token IDs identical, and loses nothing a classifier needs.
export const normaliseText = (text) => String(text ?? "").replace(/[ \t]+/g, " ");

// Python renders a structured criterion with json.dumps(separators=(", ", ": ")).
const pythonJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}: ${pythonJson(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
};
const renderCriterion = (value) => (typeof value === "string" ? value : pythonJson(value));

/** Public question shape ({ type, instructions, criteria }) to the internal one. */
export function toInternal(question) {
  let crit = question.criteria;
  if (question.type === "choice" && Array.isArray(crit)) crit = Object.fromEntries(crit.map((c) => [c, null]));
  const ins = typeof question.instructions === "string" ? question.instructions : JSON.stringify(question.instructions);
  return { t: question.type, ins, crit };
}

export function renderOptions(q) {
  if (q.t === "choice") {
    return Object.entries(q.crit).map(([key, value]) => (value == null || value === "" ? key : `${key}: ${renderCriterion(value)}`));
  }
  if (q.t === "score") return q.crit.map((c, i) => `level ${i}: ${renderCriterion(c)}`);
  const crit = q.crit || {};
  const said = (value) => value != null && value !== "";
  return [
    "false: " + (said(crit.false) ? renderCriterion(crit.false) : "no, the statement does not hold"),
    "true: " + (said(crit.true) ? renderCriterion(crit.true) : "yes, the statement holds"),
  ];
}

/** Token budget for the question and its options; grows for long option lists. */
export function headBudget(encode, q) {
  const need = 24 + renderOptions(q).reduce((sum, option) => sum + Math.min(MAX_OPTION_TOKENS + 1, encode(" " + option).length + 1), 0);
  return Math.min(Math.max(HEAD_MAX_LEN, need), MAX_LEN / 2);
}

/**
 * The part of the input that does not depend on the text:
 * [CLS] <type> question: <ins> [SEP] [MASK] option0 [MASK] option1 … [SEP]
 * `markers` are the [MASK] positions the model scores.
 */
export function buildHead(encode, question) {
  const q = toInternal(question);
  const budget = headBudget(encode, q);
  const mask = (s) => String(s).replaceAll(MASK_TOKEN, " ");
  let optionIds = renderOptions(q).map((option) => [SPECIAL_IDS.mask, ...encode(" " + mask(option)).slice(0, MAX_OPTION_TOKENS)]);
  const total = () => optionIds.reduce((sum, o) => sum + o.length, 0);
  let optionBudget = budget - total();
  if (optionBudget < 16) {
    const per = Math.max(4, Math.floor((budget - 16) / Math.max(1, optionIds.length)));
    optionIds = optionIds.map((o) => o.slice(0, per));
    optionBudget = budget - total();
  }
  const questionIds = encode(`${q.t} question: ${mask(q.ins)}`).slice(0, Math.max(8, optionBudget));
  const ids = [SPECIAL_IDS.cls, ...questionIds, SPECIAL_IDS.sep];
  const markers = [];
  for (const option of optionIds) {
    markers.push(ids.length);
    ids.push(...option);
  }
  ids.push(SPECIAL_IDS.sep);
  return { ids, markers, qtype: QTYPES[q.t], q };
}

/** Head + text + [SEP], cut to MAX_LEN. `truncated` is true when text was cut off. */
export function assemble(head, textIds) {
  const room = Math.max(0, MAX_LEN - head.ids.length - 1);
  const ids = [...head.ids, ...textIds.slice(0, room), SPECIAL_IDS.sep].slice(0, MAX_LEN);
  return { ids, markers: head.markers.filter((m) => m < MAX_LEN), truncated: textIds.length > room };
}

/** Python's build_sequence: the whole input for one text and one question. */
export function buildSequence(encode, text, question) {
  return assemble(buildHead(encode, question), encode(String(text).replaceAll(MASK_TOKEN, " ")));
}

function temperatureFor(qtype, k) {
  const name = Object.keys(QTYPES).find((key) => QTYPES[key] === qtype);
  const size = k <= 2 ? "2" : k <= 5 ? "3-5" : k <= 10 ? "6-10" : "11+";
  const t = TEMPERATURE_BY_OPTIONS[`${name}:${size}`] ?? TEMPERATURE[qtype];
  return Math.min(5, Math.max(0.5, t));
}

/** Raw option logits to calibrated probabilities (softmax with a fitted temperature). */
export function probabilities(logits, qtype) {
  const k = logits.length;
  const t = temperatureFor(qtype, k);
  const z = Array.from(logits, (v) => v / t);
  const max = Math.max(...z);
  const e = z.map((v) => Math.exp(v - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

/** The model questions a label set asks of each text. */
export function questionsFor(labelSet) {
  if (labelSet.type === "single") {
    return [{
      key: "choice",
      question: {
        type: "choice",
        instructions: labelSet.question,
        criteria: Object.fromEntries(labelSet.labels.map((l) => [l.name, l.description])),
      },
    }];
  }
  // Any number of labels: one yes/no question per label, as a plain statement
  // the model judges true or false. Of the wordings tried on a small hand-labelled
  // set, this one separated matching from non-matching labels best; the framing
  // question made it worse, so it is not used here.
  return labelSet.labels.map((label) => ({
    key: label.name,
    question: {
      type: "noul",
      instructions: label.description
        ? `The text is about ${label.name}: ${label.description}.`
        : `The text is about ${label.name}.`,
    },
  }));
}

/** One text's scores from its questions' probabilities: label name -> probability. */
export function scoresFromProbabilities(labelSet, perQuestion) {
  if (labelSet.type === "single") {
    return Object.fromEntries(labelSet.labels.map((label, i) => [label.name, perQuestion.choice[i]]));
  }
  return Object.fromEntries(labelSet.labels.map((label) => [label.name, perQuestion[label.name][1]]));
}

// ---- runtime (browser only)

async function cachedBytes(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch { /* no Cache API: download every time */ }
  const hit = cache && await cache.match(url).catch(() => null);
  const response = hit || await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || 0;
  const chunks = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total, Boolean(hit));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (cache && !hit) {
    try {
      await cache.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(received) } }));
    } catch { /* storage full or refused: it still works for this session */ }
  }
  return bytes;
}

async function webgpuAvailable() {
  try { return Boolean(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { return false; }
}

/**
 * Download and start THX-01. `files` are URLs for the model and tokenizer.
 * Returns the model interface the panel uses: { backend, classify }.
 */
export async function load({ files, onProgress, preferBackend }) {
  const [ort, { Tokenizer }] = await Promise.all([import("onnxruntime-web/webgpu"), import("@huggingface/tokenizers")]);
  ort.env.wasm.wasmPaths = ORT_WASM_URL;
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

  const progress = { tokenizer: [0, 0], model: [0, 0] };
  const report = (part) => (received, total, cached) => {
    progress[part] = [received, total];
    onProgress?.({
      received: progress.tokenizer[0] + progress.model[0],
      total: progress.tokenizer[1] + progress.model[1],
      cached,
    });
  };
  const [tokenizerBytes, configBytes, modelBytes] = await Promise.all([
    cachedBytes(files.tokenizer, report("tokenizer")),
    cachedBytes(files.tokenizerConfig),
    cachedBytes(files.model, report("model")),
  ]);
  const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
  const tokenizer = new Tokenizer(decode(tokenizerBytes), decode(configBytes));
  const encode = (text) => tokenizer.encode(normaliseText(text), { add_special_tokens: false }).ids;

  const backends = preferBackend ? [preferBackend] : (await webgpuAvailable() ? ["webgpu", "wasm"] : ["wasm"]);
  let session = null;
  let backend = null;
  let lastError = null;
  for (const candidate of backends) {
    try {
      session = await ort.InferenceSession.create(modelBytes, { executionProviders: [candidate], graphOptimizationLevel: "all" });
      backend = candidate;
      break;
    } catch (error) { lastError = error; }
  }
  if (!session) throw lastError;
  const threads = backend === "wasm" ? ort.env.wasm.numThreads : null;
  return {
    backend: backend === "wasm" ? `CPU (WASM, ${threads} thread${threads === 1 ? "" : "s"})` : "GPU (WebGPU)",
    encode,
    classify: (texts, labelSet, options) => classify({ ort, session, encode }, texts, labelSet, options),
  };
}

const BATCH_SEQUENCES = 16;

/**
 * Classify `texts` against `labelSet`. Returns one result per text, in order:
 * { scores: { label: probability }, truncated } — or null for texts not reached
 * because shouldStop() returned true.
 */
async function classify({ ort, session, encode }, texts, labelSet, { onProgress, shouldStop } = {}) {
  const questions = questionsFor(labelSet).map((q) => ({ ...q, head: buildHead(encode, q.question) }));
  const results = new Array(texts.length).fill(null);
  // Shortest first, so each batch pads to a similar length.
  const textIds = texts.map((text) => encode(String(text).replaceAll(MASK_TOKEN, " ")));
  const order = texts.map((_, i) => i).sort((a, b) => textIds[a].length - textIds[b].length);
  const textsPerBatch = Math.max(1, Math.floor(BATCH_SEQUENCES / questions.length));
  let done = 0;
  for (let start = 0; start < order.length; start += textsPerBatch) {
    if (shouldStop?.()) break;
    const batch = order.slice(start, start + textsPerBatch);
    const items = [];
    for (const index of batch) {
      for (const q of questions) items.push({ index, q, ...assemble(q.head, textIds[index]) });
    }
    const logits = await runBatch(ort, session, items);
    const perText = new Map(batch.map((index) => [index, { probs: {}, truncated: false }]));
    items.forEach((item, row) => {
      const entry = perText.get(item.index);
      entry.probs[item.q.key] = probabilities(logits[row].slice(0, item.markers.length), item.q.head.qtype);
      entry.truncated ||= item.truncated;
    });
    for (const [index, entry] of perText) {
      results[index] = { scores: scoresFromProbabilities(labelSet, entry.probs), truncated: entry.truncated };
    }
    done += batch.length;
    onProgress?.(done, texts.length);
  }
  return results;
}

async function runBatch(ort, session, items) {
  const B = items.length;
  const L = Math.max(...items.map((it) => it.ids.length));
  const K = Math.max(...items.map((it) => it.markers.length));
  const ids = new BigInt64Array(B * L);
  const attention = new BigInt64Array(B * L);
  const markers = new BigInt64Array(B * K);
  const qtype = new BigInt64Array(B);
  items.forEach((item, i) => {
    item.ids.forEach((id, j) => { ids[i * L + j] = BigInt(id); attention[i * L + j] = 1n; });
    item.markers.forEach((m, j) => { markers[i * K + j] = BigInt(m); });
    qtype[i] = BigInt(item.q.head.qtype);
  });
  const output = await session.run({
    input_ids: new ort.Tensor("int64", ids, [B, L]),
    attention_mask: new ort.Tensor("int64", attention, [B, L]),
    marker_pos: new ort.Tensor("int64", markers, [B, K]),
    qtype: new ort.Tensor("int64", qtype, [B]),
  });
  const data = output.logits.data;
  return items.map((_, i) => data.slice(i * K, (i + 1) * K));
}
