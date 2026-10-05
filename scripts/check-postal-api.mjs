// Tries the REAL ZIP API (https://zip.jamesventura.dev) from this machine, through the same code the app uses.
//   node scripts/check-postal-api.mjs
// Each line says which source answered: "api" is the live API, "table" means it could not be reached and the
// bundled table answered instead (so registration still works). Exit code 0 only if every expectation holds.
import { createPostalService } from "../server/postal.js";

const svc = createPostalService();
const cases = [
  ["Caloocan City (Bagong Silang)", "Caloocan City", "137501000", "1428", true],
  ["Caloocan City with a Quezon City ZIP", "Caloocan City", "137501000", "1100", false],
  ["Quezon City", "Quezon City", "137404000", "1100", true],
  ["Manila", "City of Manila", "133904000", "1000", true],
  ["Cebu City", "Cebu City", "072217000", "6000", true],
  ["a ZIP nobody uses", "Caloocan City", "137501000", "9999", false],
];
let failed = 0, viaApi = 0;
for (const [label, city, cityCode, zip, expectOk] of cases) {
  const t0 = Date.now();
  const r = await svc.check({ countryCode: "PH", zip, city, cityCode });
  const good = (r.status === "ok") === expectOk;
  if (!good) failed++;
  if (r.source === "api") viaApi++;
  console.log(`${good ? "PASS" : "FAIL"}  ${label.padEnd(38)} ZIP ${zip} -> ${r.status.padEnd(8)} source=${(r.source ?? "-").padEnd(5)} ${Date.now() - t0} ms${r.message ? "\n        " + r.message : ""}`);
}
const list = await svc.zipsFor("137501000");
console.log(`\nCaloocan City's codes (source=${list?.source}): ${list ? list.zips.join(", ") : "none"}`);
console.log(viaApi === cases.length ? "\nThe ZIP API is reachable and answering." : "\nThe ZIP API could not be used for some or all of these, so the bundled table answered instead.");
process.exit(failed ? 1 : 0);
