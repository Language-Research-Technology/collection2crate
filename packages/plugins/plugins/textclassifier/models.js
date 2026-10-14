// The models the Text Classifier can use (SPEC.md, "Swappable models").
//
// Each entry describes one model. load() resolves to the interface the panel
// uses, whatever the model:
//   { backend: string,
//     classify(texts, labelSet, { onProgress, shouldStop })
//       -> [{ scores: { labelName: probability }, truncated: boolean } | null] }
// A model's input format and runtime stay in its own module, imported only
// when load() is called.

export const MODELS = [
  {
    id: "thx01-web8",
    name: "THX-01, 8-bit",
    serves: "description",
    // Where the converted files are served from. Not decided yet (SPEC.md open
    // question 1), so the panel asks for it when this is empty.
    baseUrl: "",
    files: { model: "thx01_web8.onnx", tokenizer: "tokenizer.json", tokenizerConfig: "tokenizer_config.json" },
    downloadBytes: 379_000_000,
    maxTextTokens: "about 700 tokens (roughly 500 English words) with a typical label set",
    licence: "Apache 2.0",
    source: "https://huggingface.co/doofz/THX-01",
    credit: "THX-01 by HAL-X AI (Aghayev and Ahmadbayli, 2026), converted to ONNX for this panel.",
    async load({ baseUrl, onProgress }) {
      const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
      const files = Object.fromEntries(Object.entries(this.files).map(([k, f]) => [k, new URL(f, base).href]));
      const { load } = await import("./thx01.js");
      return load({ files, onProgress });
    },
  },
];

export const modelById = (id) => MODELS.find((m) => m.id === id) || MODELS[0];
