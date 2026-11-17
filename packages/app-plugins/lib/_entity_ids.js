// The @id given to an entity made from a name — a Person or Place merged from
// a spreadsheet cell, or found in a file's text by name-lookup. One scheme, so
// the same name reaches the same entity whichever plugin met it first:
// "John Smith" → "#john_smith", a Place "Mount Isa" → "#place-mount-isa".

export function slugifyEntityValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generatedEntityId(type, value) {
  const slug = slugifyEntityValue(value).replace(/-/g, "_") || "entity";
  if (type === "Place") return `#place-${slugifyEntityValue(value) || "place"}`;
  return `#${slug}`;
}

// The @id of the Geometry a Place's `geo` names, if any. `geo` is an array in
// crates built with { array: true } (as ours are), a single object otherwise.
export function placeGeoId(placeEntity) {
  return String([].concat(placeEntity?.geo ?? [])[0]?.["@id"] || "").trim();
}

// The Geometry holding a Place's coordinates: the one it already names, else
// "#location-…" beside a "#place-…" @id.
export function generatedGeometryId(placeEntity, placeName) {
  const explicit = placeGeoId(placeEntity);
  if (explicit) return explicit;
  const placeId = String(placeEntity?.["@id"] || "").trim();
  if (placeId.startsWith("#place-")) return `#location-${placeId.slice("#place-".length)}`;
  const slug = slugifyEntityValue(placeName || placeId.replace(/^#/, "")) || "place";
  return `#location-${slug}`;
}
