// Word tokens for the text-analysis panels (collocation, ngrams,
// sentimentexplorer, topicdetector), so they all split text the same way.
//
// A token is a run of Unicode letters, combining marks and digits, joined
// across an apostrophe (straight or curly) or a hyphen: "don't", "Yolŋu-matha".
// Not `\w` or `[A-Za-z0-9]`, which would silently split or drop non-English
// letters such as ŋ.

const TOKEN = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;

/**
 * Split text into word tokens.
 *
 * @param {string} text  anything; null and undefined count as empty
 * @param {object} [options]
 * @param {boolean} [options.lowercase=true]  lowercase every token
 *   (`toLocaleLowerCase`), for case-insensitive counting
 * @returns {string[]} the tokens, in order
 */
export function tokenize(text, { lowercase = true } = {}) {
  const tokens = String(text || "").match(TOKEN) || [];
  return lowercase ? tokens.map((token) => token.toLocaleLowerCase()) : tokens;
}
