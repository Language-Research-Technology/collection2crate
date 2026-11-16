// Pure cleaning engine for textcleaner.
// Performs text transformations, metric calculations, and path resolution deterministically
// without DOM dependencies so it can be tested directly in Node.

export const PREBUILT_ORDER = [
  "tags",
  "nonalpha",
  "punct",
  "numbers",
  "urls",
  "emails",
  "speaker",
];

export const PREBUILT_RULES = {
  tags: {
    id: "tags",
    label: "XML / HTML tags",
    description: "Removes markup tags and attributes (<...>), preserving enclosed text.",
    pattern: /<[^>]*>/g,
  },
  nonalpha: {
    id: "nonalpha",
    label: "Non-alphanumeric except spaces",
    description: "Removes symbols, punctuation, and line breaks, preserving letters, digits, and spaces (Unicode-aware).",
    pattern: /[^\p{L}\p{N} ]/gu,
  },
  punct: {
    id: "punct",
    label: "Punctuation",
    description: "Removes punctuation and symbols, preserving letters, digits, and whitespace (Unicode-aware).",
    pattern: /[^\p{L}\p{N}\s]/gu,
  },
  numbers: {
    id: "numbers",
    label: "Numbers",
    description: "Removes all digit sequences.",
    pattern: /\d+/g,
  },
  urls: {
    id: "urls",
    label: "URLs",
    description: "Removes web addresses starting with http://, https://, or www.",
    pattern: /https?:\/\/\S+|www[.]\S+/gi,
  },
  emails: {
    id: "emails",
    label: "Email addresses",
    description: "Removes standard email addresses.",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+[.][a-zA-Z]{2,}/g,
  },
  speaker: {
    id: "speaker",
    label: "Speaker labels",
    description: "Removes spoken corpus speaker turn markers like [SPEAKER_A]: or <S1A-001$A>.",
    pattern: /(\[[A-Z0-9_]+\]\s*:?|<[A-Z0-9$_-]+>\s*(<#>\s*)?)/g,
  },
  whitespace: {
    id: "whitespace",
    label: "Extra whitespace",
    description: "Collapses consecutive spaces/tabs to a single space, reduces 3+ line breaks to 2, and trims each line.",
    howIntro: "Takes three steps:",
    steps: [
      "Replaces each run of spaces or tabs ([ \\t]+) with a single space.",
      "Replaces three or more line breaks (\\n{3,}) with two.",
      "Trims whitespace from the start and end of every line.",
    ],
  },
};

export function escapeRegex(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Execute the cleaning pipeline across raw text in deterministic order:
 * 1. Prebuilt removals (tags, nonalpha, punct, numbers, urls, emails, speaker)
 * 2. Custom regular expression removals
 * 3. Find-and-replace rules
 * 4. Lowercase conversion
 * 5. Whitespace normalization & line trimming
 */
export function cleanText(text, options = {}) {
  if (text == null) return "";
  let result = String(text);

  const {
    prebuilt = [],
    customPatterns = [],
    replacements = [],
    lowercase = false,
  } = options;

  const prebuiltSet = prebuilt instanceof Set ? prebuilt : new Set(prebuilt);

  // 1. Pre-built removals in fixed order
  for (const id of PREBUILT_ORDER) {
    if (prebuiltSet.has(id)) {
      const rule = PREBUILT_RULES[id];
      if (rule?.pattern) {
        result = result.replace(rule.pattern, "");
      }
    }
  }

  // 2. Custom regex removals
  const patterns = Array.isArray(customPatterns)
    ? customPatterns
    : String(customPatterns || "").split("\n");

  for (const rawPattern of patterns) {
    const trimmed = String(rawPattern || "").trim();
    if (!trimmed) continue;
    try {
      let re;
      try {
        re = new RegExp(trimmed, "gu");
      } catch {
        re = new RegExp(trimmed, "g");
      }
      result = result.replace(re, "");
    } catch {
      // Gracefully ignore syntactically invalid user regexes
    }
  }

  // 3. Find → Replace rules
  const rules = Array.isArray(replacements) ? replacements : [];
  for (const rule of rules) {
    if (!rule || typeof rule.find !== "string" || rule.find === "") continue;
    const replaceValue = rule.replace != null ? String(rule.replace) : "";

    if (rule.isRegex) {
      try {
        const flags = rule.ignoreCase ? "gui" : "gu";
        let re;
        try {
          re = new RegExp(rule.find, flags);
        } catch {
          re = new RegExp(rule.find, rule.ignoreCase ? "gi" : "g");
        }
        result = result.replace(re, replaceValue);
      } catch {
        // Skip invalid regex
      }
    } else {
      if (rule.ignoreCase) {
        const escaped = escapeRegex(rule.find);
        const re = new RegExp(escaped, "gui");
        result = result.replace(re, () => replaceValue);
      } else {
        result = result.replaceAll(rule.find, replaceValue);
      }
    }
  }

  // 4. Convert to lowercase
  if (lowercase) {
    result = result.toLowerCase();
  }

  // 5. Extra whitespace normalization and line trimming (always last)
  if (prebuiltSet.has("whitespace")) {
    result = result.replace(/[ \t]+/g, " ");
    result = result.replace(/\n{3,}/g, "\n\n");
    result = result
      .split("\n")
      .map((line) => line.trim())
      .join("\n");
  }

  return result;
}

/**
 * Calculate original characters, cleaned characters, characters removed,
 * and percentage reduction.
 */
export function calculateStats(original = "", cleaned = "") {
  const originalChars = (original ?? "").length;
  const cleanedChars = (cleaned ?? "").length;
  const removedChars = originalChars - cleanedChars;
  const percentRemoved = originalChars === 0
    ? 0
    : Math.round(((originalChars - cleanedChars) / originalChars) * 1000) / 10;

  return {
    originalChars,
    cleanedChars,
    removedChars,
    percentRemoved,
  };
}

export const calculateReductionStats = calculateStats;

export function defaultCleaningOptions() {
  return {
    prebuilt: [],
    customPatterns: [],
    replacements: [],
    lowercase: false,
  };
}

/**
 * Compute the target file path based on source path, destination folder,
 * placement mode, and naming mode.
 */
export function resolveDestinationPath({
  sourcePath = "",
  destinationFolder = "cleaned",
  placementMode = "copy",
  namingMode = "preserve",
  suffix = "_cleaned",
  prefix = "cleaned_",
} = {}) {
  const normalizedSource = String(sourcePath).replace(/\\/g, "/").replace(/^\/+/, "");
  if (placementMode === "overwrite") {
    return normalizedSource;
  }

  const parts = normalizedSource.split("/");
  const filename = parts.pop() || "untitled.txt";
  const sourceDir = parts.join("/");

  const extMatch = filename.match(/(\.[^.]+)$/);
  const ext = extMatch ? extMatch[1] : "";
  const base = ext ? filename.slice(0, -ext.length) : filename;

  let targetFilename = filename;
  if (namingMode === "suffix") targetFilename = `${base}${suffix || "_cleaned"}${ext}`;
  else if (namingMode === "prefix") targetFilename = `${prefix || "cleaned_"}${filename}`;

  const cleanDest = String(destinationFolder || "")
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\/+|\/+$/g, "");

  if (cleanDest) {
    return `${cleanDest}/${targetFilename}`;
  }

  return sourceDir ? `${sourceDir}/${targetFilename}` : targetFilename;
}

export const CONFIG_DIR = "_config/textcleaner";

export function presetPath(name) {
  const safe = String(name || "").trim().replace(/[^\w.-]+/g, "_");
  return `${CONFIG_DIR}/${safe}.json`;
}

export async function listSavedPresets(dirHandle) {
  if (!dirHandle) return [];
  let dir = dirHandle;
  try {
    for (const part of CONFIG_DIR.split("/")) {
      dir = await dir.getDirectoryHandle(part, { create: false });
    }
  } catch {
    return [];
  }

  const names = [];
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && /\.json$/i.test(name) && !name.startsWith("run-")) {
        names.push(name.replace(/\.json$/i, ""));
      }
    }
  } catch {
    return [];
  }
  return names.sort();
}

export async function loadSavedPreset(dirHandle, name, readFileTextFromDirectory) {
  if (!dirHandle || !readFileTextFromDirectory || !name) return null;
  const path = presetPath(name);
  const text = await readFileTextFromDirectory(dirHandle, path);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function savePreset(dirHandle, name, config, writeFileAtPath) {
  if (!dirHandle || !writeFileAtPath || !name) return false;
  const path = presetPath(name);
  const json = JSON.stringify(config, null, 2) + "\n";
  await writeFileAtPath(dirHandle, path, json);
  return true;
}

export async function saveProvenanceManifest(dirHandle, manifest, writeFileAtPath) {
  if (!dirHandle || !writeFileAtPath) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${CONFIG_DIR}/run-${timestamp}.json`;
  const json = JSON.stringify(manifest, null, 2) + "\n";
  await writeFileAtPath(dirHandle, path, json);
  return path;
}
