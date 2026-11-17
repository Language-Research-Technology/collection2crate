// Which merge config a run uses: the one uploaded in the merge options, else
// merge-config.json in the folder, else merge's bundled default. Shared so
// name-lookup places names with the same preferences (placeMatchRegion,
// placeLookup) a merge would.
import MERGE_CONFIG from "../plugins/merge/merge_config.json" with { type: "json" };

/**
 * @param {object} options          ctx.options
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {function} readJsonFromFolder  collection2crate's, from deps
 * @returns {Promise<{ config: object, source: string }>}
 */
export async function resolveMergeConfig(options, dirHandle, readJsonFromFolder) {
  const upload = options?.mergeConfigUpload;
  if (upload) {
    const text = await upload.file.text();
    try { return { config: JSON.parse(text), source: `uploaded (${upload.name})` }; }
    catch (e) { throw new Error(`uploaded merge config "${upload.name}" is not valid JSON: ${e.message}`); }
  }
  const fromFolder = dirHandle ? await readJsonFromFolder(dirHandle, "merge-config.json") : null;
  if (fromFolder) return { config: fromFolder, source: "merge-config.json from folder" };
  return { config: MERGE_CONFIG, source: "bundled default" };
}
