// Merge giving merged Places coordinates, in a crate built as ours are
// ({ array: true, link: true }, so a Place's `geo` is an array). Offline —
// every place name is in the lookup's own records, and fetch is a stub that
// fails the test if anything reaches the network.
//
//   node merge-place-geometry.test.mjs
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import ExcelJS from "exceljs";
import { mergeXlsxIntoCrate } from "./plugins/merge/xlsx.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

const realFetch = globalThis.fetch;
const fetched = [];
globalThis.fetch = async (input) => { fetched.push(String(input)); throw new Error("offline"); };

const geoIds = (entity) => [].concat(entity?.geo ?? []).map((g) => g["@id"]);

async function mergePlaces() {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Sheet1").addRows([
    ["@id", "location"],
    ["a.txt", "Mount Isa"],
    ["b.txt", "Yarrabah"],
  ]);
  const bytes = await book.xlsx.writeBuffer();

  const crate = new ROCrate({ array: true, link: true });
  crate.addEntity({ "@id": "a.txt", "@type": "File", name: "a.txt" });
  crate.addEntity({ "@id": "b.txt", "@type": "File", name: "b.txt" });
  // Mount Isa already has coordinates, in a Geometry merge wouldn't name itself.
  crate.addEntity({ "@id": "#mount-isa-point", "@type": "Geometry", asWKT: "POINT(0 0)" });
  crate.addEntity({ "@id": "#place-mount-isa", "@type": "Place", name: "Mount Isa", geo: { "@id": "#mount-isa-point" } });

  const logs = [];
  const result = await mergeXlsxIntoCrate(crate, bytes,
    { mapping: [{ source: "location", target: "contentLocation", type: "Place" }],
      placeLookup: { providers: [], records: {
        "Mount Isa": { latitude: -20.73, longitude: 139.49 },
        Yarrabah: { latitude: -16.91, longitude: 145.87 },
      } } },
    (message) => logs.push(message), (c, id) => c.getEntity(id));
  return { crate, result, logs };
}

console.log("merge place geometry");

const { crate, result, logs } = await mergePlaces();

await check("a Place's existing geo link is kept, and that Geometry updated", () => {
  assert.deepEqual(geoIds(crate.getEntity("#place-mount-isa")), ["#mount-isa-point"]);
  assert.equal(crate.getEntity("#location-mount-isa"), undefined, "no second Geometry is made");
  const geometry = crate.getEntity("#mount-isa-point");
  assert.equal(geometry.asWKT[0] ?? geometry.asWKT, "POINT(139.49 -20.73)");
});

await check("a Place without coordinates gets a new Geometry", () => {
  assert.deepEqual(geoIds(crate.getEntity("#place-yarrabah")), ["#location-yarrabah"]);
  assert.ok(crate.getEntity("#location-yarrabah"));
});

await check("only Places that had no Geometry count as given coordinates", () => {
  assert.equal(result.enrichedPlaces, 1);
  assert.ok(logs.includes("Merge: added Geometry coordinates for 1 place reference."), logs.join("\n"));
});

await check("nothing reached the network", () => assert.deepEqual(fetched, []));

globalThis.fetch = realFetch;
if (failures) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
