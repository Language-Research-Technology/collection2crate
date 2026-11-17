// Reading an .xlsx that is *itself* an RO-Crate, and folding it into a build.
//
// Distinct from the merge plugin (../merge/xlsx.js), which reads an arbitrary
// spreadsheet and needs a mapping config to say what each column means. Here
// the workbook already carries RO-Crate structure — ro-crate-excel's own
// sheet layout, an @context sheet, entity-per-row sheets — so there is
// nothing to map: workbookToCrate() hands back a graph directly.
//
// Two things come out of that graph: the root dataset's properties, which
// seed the Describe-step config, and every other entity, which is merged into
// the crate the folder scan produced.
import { ROCrate } from "ro-crate";

export const FOLDER_XLSX_NAME = "additional-ro-crate-metadata.xlsx";

const DESCRIPTOR_ID = "ro-crate-metadata.json";
const ROOT_ID = "./";

// Root properties not carried over by seedRootDataset. @type and conformsTo
// belong to the profile; hasPart belongs to the folder scan. pcdm:hasMember is
// here for a different reason: it IS carried over, but not at crate:prepare —
// buildCrate assigns rootDataset["pcdm:hasMember"] from the folder scan after
// the config is applied, so a seeded value would be silently overwritten.
// applyCollectionMembership() handles it at crate:build instead.
const STRUCTURAL_ROOT_PROPS = new Set([
  "@id", "@type", "hasPart", "pcdm:hasMember", "conformsTo",
]);

export const MEMBERSHIP_PROP = "pcdm:hasMember";

function asArray(v) {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
}

// Compare a crate value against the flattened form this module produces, so
// "the spreadsheet says the same thing" doesn't count as a change worth
// reporting. Reference objects compare by @id; ro-crate hands back arrays for
// everything, hence the normalisation on both sides.
function valuesEqual(a, b) {
  const flatten = (v) =>
    asArray(v)
      .map((x) => (x && typeof x === "object" && x["@id"] ? `@id:${x["@id"]}` : String(x)))
      .join(" ");
  return flatten(a) === flatten(b);
}

function isEmpty(v) {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmpty);
  if (typeof v === "string") return v.trim() === "";
  return false;
}

// ro-crate-excel is a heavy dependency (ExcelJS plus the whole crate
// round-tripper) — callers reach this through a dynamic import, so it stays
// out of the main bundle.
export async function readCrateFromXlsxBytes(bytes) {
  // The bare "ro-crate-excel" specifier resolves to the package's main
  // index, which pulls in shelljs/fs-extra (Node-only) — broken in a
  // browser bundle, where it silently leaves Workbook undefined instead of
  // a constructor. src/crate.js's static import already established the
  // fix: go through the package's clean lib/workbook.js entry instead,
  // which is also the one Vite's optimizeDeps.include actually pre-bundles.
  const { default: Workbook } = await import("ro-crate-excel/lib/workbook.js");
  const workbook = new Workbook();
  await workbook.loadExcelFromBuffer(bytes);
  if (!workbook.crate) throw new Error("the spreadsheet did not parse as an RO-Crate");
  return new ROCrate(workbook.crate.toJSON(), { array: true, link: true });
}

// The collection-level properties worth carrying into the build, as a plain
// object shaped like config.rootDataset. Reference values are flattened back
// to {"@id": …} — the linked entity itself arrives separately via
// mergeCrateEntities, and leaving the resolved object here would nest a copy
// of the whole entity inside the root.
export function rootPropertiesFromCrate(crate) {
  const root = crate.rootDataset;
  if (!root) return {};
  const out = {};
  for (const [key, rawValue] of Object.entries(root)) {
    if (STRUCTURAL_ROOT_PROPS.has(key)) continue;
    const values = asArray(rawValue).map((v) =>
      v && typeof v === "object" && v["@id"] ? { "@id": v["@id"] } : v
    );
    if (isEmpty(values)) continue;
    out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}

// Fill gaps in `target` from `source`, leaving anything the user already
// supplied alone. Returns the keys actually taken, for the build log: a
// workbook silently overwriting typed-in Describe values would be the worst
// possible behaviour here.
export function seedRootDataset(target, source) {
  const taken = [];
  for (const [key, value] of Object.entries(source)) {
    if (!isEmpty(target[key])) continue;
    target[key] = value;
    taken.push(key);
  }
  return taken;
}

// Copy every non-root, non-descriptor entity from `source` into `target`.
//
// The spreadsheet wins on every property it states, and properties it doesn't
// mention are left alone. That follows how ro-crate-excel merges a workbook's
// RootDataset sheet into an existing crate (`crate.rootDataset[prop] =
// newRoot.item[prop]` — per-property assignment, untouched properties kept),
// and it's what makes the workbook authoritative about what a file belongs to:
// gap-filling let the folder scan's isPartOf win simply by being written first.
//
// Deliberately NOT ro-crate's addEntity({replace: true}), which Crate-O uses
// for the same job. That drops every property the incoming entity omits — here
// it would throw away the encodingFormat and contentSize the folder scan
// worked out, which no spreadsheet supplies. Crate-O has no scan behind it, so
// it loses nothing; we would.
export function mergeCrateEntities(target, source, log = () => {}) {
  let added = 0;
  let enriched = 0;
  let remapped = 0;

  // The workbook is authored as a standalone crate, so by RO-Crate convention
  // an entity's memberOf points at its own root as "./" — the source's own
  // root id, not necessarily the target's. The target's root can carry a
  // different, persistent @id (an ARCP/Handle URI set in the Describe step),
  // so a memberOf: "./" copied over verbatim would silently point at an
  // entity the target crate doesn't have. Rewrite it to the target's actual
  // root id instead. Scoped to memberOf specifically — it's the one property
  // whose meaning ("belongs to the crate's root collection") is fixed by
  // convention; other reference-valued properties say what they say and
  // aren't assumed to mean "the root".
  const sourceRootId = source.rootDataset?.["@id"] || ROOT_ID;
  const targetRootId = target.rootDataset?.["@id"];
  const remapRoot = (ref) => {
    if (ref && typeof ref === "object" && (ref["@id"] === ROOT_ID || ref["@id"] === sourceRootId)
      && targetRootId && targetRootId !== ref["@id"]) {
      remapped++;
      return { "@id": targetRootId };
    }
    return ref;
  };

  for (const entity of source.entities()) {
    const id = entity["@id"];
    if (!id || id === DESCRIPTOR_ID || id === ROOT_ID) continue;
    if (id === source.rootDataset?.["@id"]) continue;

    const flat = {};
    for (const [key, rawValue] of Object.entries(entity)) {
      if (key === "@id") continue;
      const values = asArray(rawValue).map((v) => {
        if (!(v && typeof v === "object" && v["@id"])) return v;
        return key === "memberOf" ? remapRoot({ "@id": v["@id"] }) : { "@id": v["@id"] };
      });
      if (!isEmpty(values)) flat[key] = values.length === 1 ? values[0] : values;
    }

    const existing = target.getEntity(id);
    if (!existing) {
      target.addEntity({ "@id": id, ...flat });
      added++;
      continue;
    }
    let changed = false;
    for (const [key, value] of Object.entries(flat)) {
      if (valuesEqual(existing[key], value)) continue;
      existing[key] = value;
      changed = true;
    }
    if (changed) enriched++;
  }

  log(`Spreadsheet crate: added ${added} entit(ies), enriched ${enriched}.`, "muted");
  if (remapped) log(`Spreadsheet crate: remapped ${remapped} memberOf reference(s) from the workbook's own root ("${sourceRootId}") to the crate's root ("${targetRootId}").`, "muted");
  return { added, enriched, remapped };
}

// Properties whose values are external identifiers by convention — a licence
// URL, a profile or spec URI, a media type. RO-Crate says referenced entities
// should be described, but nobody writes a contextual entity for
// creativecommons.org/licenses/by/4.0 or w3id.org/ro/crate/1.2, so warning
// about them buries the references that do matter (an #LDaCA author, a ROR
// publisher) under noise nobody will act on.
const EXTERNAL_REF_PROPS = new Set([
  "conformsTo", "license", "encodingFormat", "url", "sameAs", "identifier",
  "isBasedOn", "citation",
]);

// Entities that define the crate's vocabulary rather than describe its
// subject: the rdf:Property definitions a custom: namespace needs, term sets,
// and the like. A profile describes the data, not the scaffolding, so
// checking their properties against it produces only noise.
const VOCABULARY_TYPES = new Set([
  "rdf:Property", "rdfs:Class", "DefinedTerm", "DefinedTermSet", "ItemList",
  "PropertyValue",
]);

// Replace the folder scan's idea of what the collection contains with the
// workbook's.
//
// buildCrate() makes one member per top-level folder, which for a collection
// described in a spreadsheet is the wrong answer twice over: the members
// become "about", "files" and friends, and the entities the workbook actually
// describes — the entries — are left orphaned, present in the graph but
// belonging to nothing. A preview template drawing a card per member then
// shows the folder structure instead of the collection.
//
// Replaces rather than unions, because the two describe the same thing and the
// workbook is the authored answer: the folder objects aren't additional
// members, they're the scan's guess at the members. Media files still reach
// their entry through the isPartOf links the workbook carries.
//
// Only members the target crate actually has an entity for are kept, so a
// workbook referencing something it never described can't produce a card
// pointing at nothing.
export function applyCollectionMembership(target, source, log = () => {}) {
  const sourceMembers = asArray(source.rootDataset?.[MEMBERSHIP_PROP])
    .map((m) => (m && typeof m === "object" ? m["@id"] : m))
    .filter(Boolean);
  if (!sourceMembers.length) return null;

  const kept = sourceMembers.filter((id) => target.getEntity(id));
  const missing = sourceMembers.filter((id) => !target.getEntity(id));
  if (!kept.length) {
    log(`Spreadsheet lists ${sourceMembers.length} collection member(s) but the crate has none of them — keeping the folder structure.`, "warn");
    return null;
  }

  const replaced = asArray(target.rootDataset[MEMBERSHIP_PROP]).length;
  target.rootDataset[MEMBERSHIP_PROP] = kept.map((id) => ({ "@id": id }));
  log(`Collection members from the spreadsheet: ${kept.join(", ")} (replacing ${replaced} from the folder scan).`, "muted");
  for (const id of missing) {
    log(`  ! Spreadsheet lists "${id}" as a member but never describes it — left out.`, "warn");
  }
  return { kept, missing, replaced };
}

// Structural problems a MASP profile can't express, reported as warnings
// rather than errors (profile-rule failures are what count as errors — see
// validateBuiltCrate in ../../masp.js).
//
//  - a reference to an @id with no entity behind it. RO-Crate says
//    referenced entities should be described; the birds profile deliberately
//    leaves author/publisher unconstrained so this surfaces here instead of
//    failing the crate.
//  - a property no rule in the profile mentions. Not wrong — profiles are
//    not closed-world — but worth seeing, since it's usually a typo or a
//    property that belongs in the profile and isn't there yet.
export function collectWarnings(crate, validator = null) {
  const warnings = [];
  const known = knownPropertyNames(validator);
  const ids = new Set();
  for (const entity of crate.entities()) ids.add(entity["@id"]);

  for (const entity of crate.entities()) {
    const entityId = entity["@id"];
    const types = asArray(entity["@type"]).map(String);
    const isVocabulary = types.some((t) => VOCABULARY_TYPES.has(t));
    // The metadata descriptor is crate housekeeping written by the tooling,
    // not something the author controls — don't grade it against the profile.
    const isDescriptor = entityId === DESCRIPTOR_ID;

    for (const [key, rawValue] of Object.entries(entity)) {
      if (key === "@id" || key === "@type") continue;

      for (const value of asArray(rawValue)) {
        if (EXTERNAL_REF_PROPS.has(key)) break;
        const ref = value && typeof value === "object" ? value["@id"] : null;
        if (ref && !ids.has(ref)) {
          warnings.push({
            entity: entityId,
            property: key,
            message: `${entityId} · ${key} references "${ref}", which has no entity in the spreadsheet — it should be described, not just pointed at.`,
          });
        }
      }

      if (known.size && !known.has(key) && !isVocabulary && !isDescriptor && !/^rdfs?:/.test(key)) {
        warnings.push({
          entity: entityId,
          property: key,
          message: `${entityId} · ${key} is not a property the profile describes — check the spelling, or add it to the profile.`,
        });
      }
    }
  }
  return warnings;
}

// Every property name any rule in the profile mentions, across all classes.
// Empty set when the validator can't be introspected, which switches the
// unknown-property warning off rather than flooding the report.
function knownPropertyNames(validator) {
  const names = new Set();
  if (!validator) return names;
  try {
    validator.ensureParsed();
    for (const rule of Object.values(validator.rules?.properties || {})) {
      if (rule.propertyName) names.add(rule.propertyName);
    }
  } catch {
    return new Set();
  }
  return names;
}
