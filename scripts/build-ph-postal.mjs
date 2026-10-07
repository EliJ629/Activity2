// Builds server/postal-data/ph-postal.json: which 4-digit ZIP codes belong to which Philippine city / municipality.
//
//   node scripts/build-ph-postal.mjs            (downloads the two sources below, needs internet)
//   node scripts/build-ph-postal.mjs a.csv b.json   (use local copies instead)
//
// Sources (both open data, see server/postal-data/NOTICE.md for licences and attribution):
//   1. unified-zip-codes.csv  - every barangay with its PSGC code and PHLPost ZIP  (MIT, James Ventura)
//   2. postal-codes-2024.json - GeoNames ZIP list joined to PSA 2024 PSGC city codes (data CC BY 4.0, (c) GeoNames)
// A city's allowed ZIPs are the union of both, keyed by the first 6 digits of its PSGC code.
// (Manila is the one exception: its barangays hang off district codes 1339NN, all rolled up into 133900.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCity, _testing } from "../server/postal.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL_1 = "https://raw.githubusercontent.com/0xC0000094/unified-zip-code/main/data/unified-zip-codes.csv";
const URL_2 = "https://raw.githubusercontent.com/kon2raya24/ph-postal-php/main/data/postal-codes-2024.json";

const read = async (arg, url) => (arg ? fs.readFileSync(arg, "utf8") : (await fetch(url)).text());
const [csvText, jsonText] = await Promise.all([read(process.argv[2], URL_1), read(process.argv[3], URL_2)]);

// minimal CSV reader that understands quoted fields (some names contain commas)
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

const cities = new Map(); // key -> { names:Set, zips:Set }
const city = (key) => { if (!cities.has(key)) cities.set(key, { names: new Set(), zips: new Set() }); return cities.get(key); };
const zipsIn = (s) => String(s ?? "").match(/(?<!\d)\d{4}(?!\d)/g) ?? []; // "1400/1402", "1720 BF Homes 1/1718 BF Homes 2" -> 4-digit codes

const [head, ...body] = parseCsv(csvText).filter((r) => r.length > 1);
const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
for (const r of body) {
  const psgc = r[col.psgc]; if (!/^\d{9}$/.test(psgc) || psgc.startsWith("000000")) continue; // a few Cebu City barangays have no PSGC
  const c = city(psgc.startsWith("1339") ? "133900" : psgc.slice(0, 6));
  c.names.add(r[col.municipality].trim());
  for (const z of zipsIn(r[col.postal])) c.zips.add(z);
}
let added = 0, skipped = 0;
for (const e of JSON.parse(jsonText).postal_codes) {
  if (!e.cityMunCode || !/^\d{4}$/.test(e.zip)) continue;
  const key = String(e.cityMunCode);
  // The second source rolls hundreds of Metro Manila barangays up into "Manila" ("Baesa", "Sangandaan" are in
  // Caloocan) and sometimes joins a locality to the wrong parent. Only trust an entry whose place name really is
  // the city's own name (or one of its spellings) - a district label such as Davao's "Toril" is fine -
  // otherwise Manila would end up accepting Quezon City's ZIP codes.
  const known = cities.get(key);
  if (!known || ![...known.names].some((n) => normalizeCity(n) === normalizeCity(e.cityMun))) { skipped++; continue; }
  if (!known.zips.has(e.zip)) added++;
  known.zips.add(e.zip);
}

// Cities whose ZIP list is exactly the one given (Naic, Cavite: 4110 only; the open data also lists 4135 for it). They come from the
// list built into server/postal.js and from server/postal-data/ph-postal-only.json, so a rebuild keeps the corrections.
const only = { ..._testing.BUILT_IN_ONLY };
try {
  for (const [key, zips] of Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, "server/postal-data/ph-postal-only.json"), "utf8")))) {
    if (!key.startsWith("_") && Array.isArray(zips) && zips.length) only[key] = zips.filter((z) => /^\d{4}$/.test(z));
  }
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
for (const [key, zips] of Object.entries(only)) if (cities.has(key)) cities.get(key).zips = new Set(zips);

const out = {
  _meta: {
    generated: new Date().toISOString().slice(0, 10),
    cities: cities.size,
    sources: [
      "unified-zip-codes.csv - github.com/0xC0000094/unified-zip-code (MIT, (c) 2019 James Ventura); ZIPs from PHLPost, codes from PSA PSGC",
      "postal-codes-2024.json - github.com/kon2raya24/ph-postal-php (MIT); ZIP data derived from GeoNames (CC BY 4.0, (c) GeoNames, geonames.org)",
    ],
  },
  cities: Object.fromEntries([...cities].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { n: [...v.names].sort(), z: [...v.zips].sort() }])),
};
fs.mkdirSync(path.join(ROOT, "server/postal-data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "server/postal-data/ph-postal.json"), JSON.stringify(out));
console.log(`wrote server/postal-data/ph-postal.json: ${cities.size} cities/municipalities, ${added} extra ZIPs contributed by source 2 (${skipped} entries from it ignored as unmatched)`);
