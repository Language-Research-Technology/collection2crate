// Shared GitHub fetch primitives (SPEC.md §6.2).
//
// Used by main.js (the profile list and the template dropdown) and by the
// HTML output plugin (template bundles). It deliberately knows nothing about
// either, so neither has to import the other.

const RAW_HOST = "https://raw.githubusercontent.com";
const API_HOST = "https://api.github.com";

// raw.githubusercontent.com caches per-URL for minutes and will happily serve
// a profile that was pushed over five minutes ago, so every raw fetch gets a
// timestamp it has never seen before.
export function bustCacheUrl(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_cb=${Date.now()}`;
}

export function buildGitHubRawUrl(owner, repo, ref, path) {
  const clean = String(path || "").replace(/^\/+/, "");
  return `${RAW_HOST}/${owner}/${repo}/${ref}/${clean}`;
}

/** The human-facing tree URL, for "see this on GitHub" links. */
export function buildGitHubTreeUrl(owner, repo, ref, path = "") {
  const clean = String(path || "").replace(/^\/+/, "");
  return `https://github.com/${owner}/${repo}/tree/${ref}${clean ? `/${clean}` : ""}`;
}

export async function fetchGitHubTextFile(owner, repo, ref, path) {
  const url = bustCacheUrl(buildGitHubRawUrl(owner, repo, ref, path));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GitHub: ${response.status} ${response.statusText} for ${path}`);
  }
  return await response.text();
}

export async function fetchGitHubJsonFile(owner, repo, ref, path) {
  const text = await fetchGitHubTextFile(owner, repo, ref, path);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`GitHub: ${path} is not valid JSON: ${e.message}`);
  }
}

export async function fetchGitHubBinaryFile(owner, repo, ref, path) {
  const url = bustCacheUrl(buildGitHubRawUrl(owner, repo, ref, path));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GitHub: ${response.status} ${response.statusText} for ${path}`);
  }
  return await response.arrayBuffer();
}

// The Contents API is rate-limited to 60 unauthenticated requests an hour, so
// a successful listing is cached for the page's lifetime. Failures are NOT
// cached: a rate-limit blip should be retried, not remembered as the answer.
const listingCache = new Map();

export function clearGitHubListingCache() {
  listingCache.clear();
}

/**
 * The whole repository tree in one request.
 *
 * Cheaper than walking folders through the Contents API — that costs one
 * request per directory against a 60-per-hour unauthenticated budget, while
 * this costs one for the lot. Cached on the same terms as a listing: successes
 * only, for the page's lifetime.
 *
 * @returns {Promise<Array<{path: string, type: "blob"|"tree"}>>}
 */
export async function fetchGitHubTree(owner, repo, ref) {
  const key = `tree:${owner}/${repo}@${ref}`;
  if (listingCache.has(key)) return listingCache.get(key);

  const url = `${API_HOST}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        "GitHub: rate limit reached (60 unauthenticated requests/hour). Try again shortly."
      );
    }
    throw new Error(`GitHub: ${response.status} ${response.statusText} reading ${owner}/${repo}@${ref}`);
  }
  const body = await response.json();
  const entries = (body.tree || []).map((item) => ({ path: item.path, type: item.type }));
  // A very large repository comes back truncated; say so rather than quietly
  // reporting a short list as if it were the whole thing.
  if (body.truncated) {
    throw new Error(
      `GitHub: the tree for ${owner}/${repo} is too large to read in one request.`
    );
  }
  listingCache.set(key, entries);
  return entries;
}

/**
 * List one folder through the Contents API.
 * @returns {Promise<Array<{name: string, path: string, type: "file"|"dir", size: number}>>}
 */
export async function listGitHubFolder(owner, repo, ref, path = "") {
  const key = `${owner}/${repo}@${ref}:${path}`;
  if (listingCache.has(key)) return listingCache.get(key);

  const clean = String(path || "").replace(/^\/+/, "");
  const url = `${API_HOST}/repos/${owner}/${repo}/contents/${clean}?ref=${encodeURIComponent(ref)}`;
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        "GitHub: rate limit reached (60 unauthenticated requests/hour). Try again shortly."
      );
    }
    throw new Error(`GitHub: ${response.status} ${response.statusText} listing ${clean || "/"}`);
  }
  const body = await response.json();
  const entries = (Array.isArray(body) ? body : []).map((item) => ({
    name: item.name,
    path: item.path,
    type: item.type === "dir" ? "dir" : "file",
    size: item.size || 0,
  }));
  listingCache.set(key, entries);
  return entries;
}
