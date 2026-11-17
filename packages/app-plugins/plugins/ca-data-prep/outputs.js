// What ca-data-prep makes from a parsed transcript: the CSV, the speakers'
// Person entities, and the crate. The parsing itself is shared with
// chat-export and lives in lib/_transcript.js.
import { ROCrate } from "ro-crate";
import { transcriptMediaType } from "../../lib/_transcript.js";

// "#AA" and "Year of birth" → "#AA-year-of-birth".
const propertyValueId = (entityId, label) => `${entityId}-${String(label).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "property"}`;

export function buildSpeakerPersonEntities(speakerMap) {
  const entities = [];

  for (const [speakerID, details] of speakerMap.entries()) {
    const entityId = details.optionalCode ? details.optionalCode : `#${speakerID}`;
    const entity = {
      "@id": entityId,
      "@type": "Person",
      name: details.name || details.label || speakerID,
    };

    if (details.alternateName) entity.alternateName = details.alternateName;
    if (details.affiliation) entity.affiliation = details.affiliation;
    if (details.optionalCode) entity.identifier = details.optionalCode;
    entities.push(entity);

    // Fields a transcript grammar's own labels read from the declaration
    // ("Role", "Age"): name/value pairs, each its own PropertyValue entity.
    const extra = Object.entries(details.extra || {}).filter(([, value]) => String(value ?? "").trim());
    if (extra.length) {
      entity.additionalProperty = extra.map(([label]) => ({ "@id": propertyValueId(entityId, label) }));
      for (const [label, value] of extra) {
        entities.push({ "@id": propertyValueId(entityId, label), "@type": "PropertyValue", name: label, value: String(value).trim() });
      }
    }
  }

  return entities;
}

/**
 * The transcript CSV. `extraColumns` are the labels of a grammar's own
 * fields, each a column after the four every transcript has, filled from
 * `row.extra`.
 */
export function toCsv(rows, extraColumns = []) {
  const output = [["turnNumber", "speakerID", "text", "section", ...extraColumns.map(escapeCsv)].join(",")];
  for (const row of rows) {
    const turnNumber = escapeCsv(row.turnNumber || "");
    const speakerID = escapeCsv(row.speakerID || "");
    const text = escapeCsv(row.text || "");
    const section = escapeCsv(row.section || "MAIN");
    const extra = extraColumns.map((label) => `,${escapeCsv(row.extra?.[label] ?? "")}`).join("");
    output.push(`${turnNumber},${speakerID},${text},${section}${extra}`);
  }
  return output.join("\n") + "\n";
}

export function escapeCsv(value) {
  const stringValue = String(value ?? "");
  if (/[",\n]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

// conformsTo defaults to the LDAC Collection profile's own identity (this
// function always builds a RepositoryCollection root) rather than hardcoding
// it — the caller (ca-data-prep's "crate:build" hook) passes through
// whichever profile the user actually selected, so a crate built here still
// reflects that choice instead of silently overwriting it. The default only
// matters when nothing was selected (e.g. calling this directly, as tests do).
export function buildRoCrateMetadata(collectionName, documents, conformsTo = "https://w3id.org/ldac/profile#Collection", { includeOutputs = true } = {}) {
  const crate = new ROCrate({ array: true, link: true });
  // One entry for both prefixes: merged into a seeded crate, each entry
  // would otherwise sit in its @context as one more object.
  crate.addContext({ ldac: "https://w3id.org/ldac/terms#", pcdm: "http://pcdm.org/models#" });

  crate.rootDataset["@id"] = "./";
  crate.rootDataset["@type"] = ["Dataset", "RepositoryCollection"];
  crate.rootDataset.name = collectionName;
  crate.rootDataset.conformsTo = { "@id": conformsTo };
  crate.descriptor.about = { "@id": "./" };

  const collectionEntity = {
    "@id": "./collection",
    "@type": "RepositoryCollection",
    name: collectionName,
    hasMember: documents.map((document) => ({ "@id": document.objectId })),
  };

  crate.addEntity(collectionEntity);
  crate.rootDataset.hasMember = documents.map((document) => ({ "@id": document.objectId }));

  for (const document of documents) {
    // Without its outputs, a document is its source file and its speakers: no CSV
    // file, so no main text or annotation pointing at one.
    const objectEntity = {
      "@id": document.objectId,
      "@type": "RepositoryObject",
      name: document.baseName,
      ...(includeOutputs ? { "ldac:mainText": { "@id": document.csvId } } : {}),
      hasPart: [
        { "@id": document.docxId },
        ...(includeOutputs ? [{ "@id": document.csvId }] : []),
      ],
      speaker: document.speakerRefs,
    };

    const csvFileEntity = {
      "@id": document.csvId,
      "@type": "File",
      name: document.csvName,
      encodingFormat: "text/csv",
      annotationOf: { "@id": document.docxId },
      isPartOf: { "@id": document.objectId },
    };

    const annotationEntity = {
      "@id": document.annotationId,
      "@type": "Annotation",
      annotationOf: { "@id": document.objectId },
      annotationBody: { "@id": document.csvId },
    };

    crate.addEntity(objectEntity);
    if (includeOutputs) crate.addEntity(annotationEntity);
    crate.addEntity({
      "@id": document.docxId,
      "@type": "File",
      name: document.docxName,
      encodingFormat: document.sourceEncodingFormat || transcriptMediaType(document.docxName),
    });
    if (includeOutputs) crate.addEntity(csvFileEntity);

    for (const person of document.persons) crate.addEntity(person);
  }

  return crate;
}
