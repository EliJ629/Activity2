// Postal-code check for the Philippines: does this ZIP really belong to the city the person picked?
//
// Where the answer comes from, in this order:
//   1. server/postal-data/ph-postal-extra.json - a ZIP you added there by hand is always accepted for that city.
//   2. The Unified ZIP Code API (https://zip.jamesventura.dev - public, no key, 60 requests a minute per address,
//      source: github.com/0xC0000094/unified-zip-code). Its `lookup?postal=` call returns every barangay that uses
//      a ZIP; the ZIP belongs to the chosen city when one of those barangays has the city's PSGC code. This is the
//      same open data (PSA's PSGC + the Philippine Postal Corporation's ZIPs) the bundled table was built from.
//   3. ONLY if that API cannot be used (down, slow, rate-limited, or it answers in a shape we don't recognise):
//      the bundled table, server/postal-data/ph-postal.json. Registration then keeps working, with the same data
//      as a snapshot, instead of failing because someone else's server is down.
// Other countries: only the postal FORMAT is enforced (validateZip in shared/validation.js).
//
// The API data is a 2019 snapshot, so a ZIP created since can be missing: add it to ph-postal-extra.json,
// e.g.  { "137501": ["1422"] }  (key = the city's 6-digit key).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatZipRanges } from "../shared/validation.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = "https://zip.jamesventura.dev";

// "City of Parañaque", "Paranaque City" and "Parañaque" must compare equal.
export function normalizeCity(name) {
  return String(name ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "") // ñ -> n, é -> e
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")                           // "(Capital)", "(Pob.)"
    .replace(/\b(city|municipality) of\b/g, " ")
    .replace(/\bcity\b/g, " ")
    .replace(/\bsta\.?(?=\s)/g, "santa")
    .replace(/\bsto\.?(?=\s)/g, "santo")
    .replace(/\bgen\.?(?=\s)/g, "general")
    .replace(/\bpres\.?(?=\s)/g, "president")
    .replace(/\bdr\.?(?=\s)/g, "doctor")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

// Small spelling differences between sources ("Ozamis" / "Ozamiz") shouldn't reject a real city.
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}
const sameCity = (a, b) => {
  const x = normalizeCity(a), y = normalizeCity(b);
  return Boolean(x) && Boolean(y) && (x === y || (Math.min(x.length, y.length) >= 6 && editDistance(x, y) <= 2));
};

/* ---------- the bundled table (fallback + city names) and the hand-made additions ---------- */
let loaded = null;
function readTables() {
  if (loaded) return loaded;
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "postal-data", "ph-postal.json"), "utf8")).cities;
  let extras = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HERE, "postal-data", "ph-postal-extra.json"), "utf8"));
    for (const [key, zips] of Object.entries(raw)) {
      if (!key.startsWith("_") && Array.isArray(zips)) extras[key] = zips.filter((z) => /^\d{4}$/.test(z));
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Could not read ph-postal-extra.json:", err.message);
  }
  for (const [key, zips] of Object.entries(extras)) {
    if (base[key]) base[key].z = [...new Set([...base[key].z, ...zips])].sort();
  }
  loaded = { base, extras };
  return loaded;
}
const phTable = () => readTables().base;

// Called once at startup, so a missing or broken table stops the deploy right away instead of
// surfacing as an error on someone's first Philippine registration.
export function assertPostalDataReady() {
  const n = Object.keys(phTable()).length;
  if (n < 1000) throw new Error(`server/postal-data/ph-postal.json looks wrong (${n} cities)`);
}

// PSGC city codes are 9 digits; the first 6 identify the city/municipality. Manila's barangays hang
// off district codes (1339NN), so everything starting 1339 is Manila.
export const phCityKey = (cityCode) => (/^\d{9}$/.test(cityCode) ? (cityCode.startsWith("1339") ? "133900" : cityCode.slice(0, 6)) : "");
const keyOfPsgc = (psgc) => { const p = String(psgc ?? ""); return p.startsWith("1339") ? "133900" : p.slice(0, 6); };

// Table-only list of a city's ZIPs -> { city, zips } or null
export function phZipsFor(cityCode) {
  const entry = phTable()[phCityKey(String(cityCode ?? ""))];
  return entry ? { city: entry.n[0], zips: entry.z } : null;
}

const joinNames = (names) => (names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`);

/* ---------- the service ---------- */
// Everything the outside world can change is a parameter, so tests can use a fake API and a fake clock.
export function createPostalService({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiBase = API_BASE,
  timeoutMs = 4000,
  cacheMs = 24 * 3600 * 1000,   // the API serves a fixed snapshot, so a day is safe
  breakerMs = 60 * 1000,        // after a failure, go straight to the table for this long
  now = () => Date.now(),
  extras = null,                // tests can pass their own hand-made additions
} = {}) {
  const cache = new Map();    // key -> { at, value }
  const inflight = new Map(); // key -> Promise (parallel requests for the same thing share one call)
  let downUntil = 0;
  const handMade = () => extras ?? readTables().extras;

  // -> { kind: "ok", data } | { kind: "notfound" } | { kind: "unavailable" }
  async function apiGet(pathAndQuery) {
    if (now() < downUntil) return { kind: "unavailable" };
    let res;
    try {
      res = await fetchImpl(apiBase + pathAndQuery, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      downUntil = now() + breakerMs;
      return { kind: "unavailable" };
    }
    if (res.status === 429 || res.status >= 500) { downUntil = now() + breakerMs; return { kind: "unavailable" }; }
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (res.status === 404 && body && body.ok === false) return { kind: "notfound" };   // "No barangay carries the zip code ..."
    if (res.ok && body && body.ok === true && body.data && typeof body.data === "object") return { kind: "ok", data: body.data };
    return { kind: "unavailable" };                                                      // anything unexpected: don't guess
  }

  // Only definite answers are remembered; "unavailable" is retried next time.
  function cached(key, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return Promise.resolve(hit.value);
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const value = await load();
      if (value.kind !== "unavailable") {
        cache.set(key, { at: now(), value });
        if (cache.size > 4000) cache.delete(cache.keys().next().value);
      }
      return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const lookupZip = (zip) => cached(`zip:${zip}`, () => apiGet(`/api/lookup?postal=${encodeURIComponent(zip)}`));

  // -> { city, zips, source: "api" | "table" } or null.  For the hint under the ZIP field.
  async function zipsFor(cityCode) {
    const key = phCityKey(String(cityCode ?? ""));
    if (!key) return null;
    const entry = phTable()[key];
    const viaApi = await cached(`city:${key}`, async () => {
      // find one barangay of the city to learn the city's four-character code, then list the city's barangays
      const candidates = key === "133900" ? ["133901001", "133901002"] : [`${key}001`, `${key}002`, `${key}003`];
      let prefix = null, name = null;
      for (const psgc of candidates) {
        const r = await apiGet(`/api/lookup?psgc=${psgc}`);
        if (r.kind === "unavailable") return r;
        if (r.kind === "ok") {
          const rec = [].concat(r.data)[0];
          if (rec && rec.code) { prefix = String(rec.code).slice(0, 4); name = rec.municipality; break; }
        }
      }
      if (!prefix) return { kind: "notfound" };
      const b = await apiGet(`/api/barangays?municipality=${encodeURIComponent(prefix)}`);
      if (b.kind !== "ok") return b;
      const rows = [].concat(b.data);
      // a barangay can carry two ZIPs written "3008/3025"
      const zips = [...new Set(rows.flatMap((rec) => String(rec.postal ?? "").match(/\d{4}/g) ?? []))].sort();
      return zips.length ? { kind: "ok", zips, name } : { kind: "notfound" };
    });
    if (viaApi.kind === "ok") {
      return { city: entry?.n[0] ?? viaApi.name, zips: [...new Set([...viaApi.zips, ...(handMade()[key] ?? [])])].sort(), source: "api" };
    }
    return entry ? { city: entry.n[0], zips: entry.z, source: "table" } : null;
  }

  const bounded = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

  // -> { status: "ok" | "mismatch" | "invalid" | "unchecked", message?, source?, belongsTo?, expected? }
  async function check({ countryCode, zip, city, cityCode = "" }, { verifyName = true } = {}) {
    if (countryCode !== "PH") return { status: "unchecked" };
    const key = phCityKey(String(cityCode ?? ""));
    if (!key) return { status: "invalid", message: "Choose your city from the list so its postal codes can be checked." };
    const entry = phTable()[key];
    // the table is also how we know a city's code and name belong together
    if (entry && verifyName && !entry.n.some((n) => sameCity(city, n))) {
      return { status: "invalid", message: "The city doesn't match the one selected. Please choose it from the list again." };
    }
    const label = entry ? entry.n[0] : String(city || "this city");

    if ((handMade()[key] ?? []).includes(zip)) return { status: "ok", place: label, source: "extra" };

    const r = await lookupZip(zip);
    if (r.kind === "ok") {
      const rows = [].concat(r.data);
      if (rows.some((rec) => keyOfPsgc(rec.psgc) === key)) return { status: "ok", place: label, source: "api" };
      const belongsTo = [...new Set(rows.map((rec) => rec.municipality).filter(Boolean))];
      return mismatch(label, zip, { belongsTo, source: "api", codes: await bounded(zipsFor(cityCode), 2500) });
    }
    if (r.kind === "notfound") return mismatch(label, zip, { belongsTo: [], source: "api", codes: await bounded(zipsFor(cityCode), 2500) });

    // The API can't be used right now: answer from the bundled table instead
    if (!entry) return { status: "invalid", message: "Postal codes can't be checked for this city right now. Please try again later." };
    if (entry.z.includes(zip)) return { status: "ok", place: label, source: "table" };
    return mismatch(label, zip, { belongsTo: [], source: "table", codes: { city: label, zips: entry.z } });
  }

  function mismatch(label, zip, { belongsTo, source, codes }) {
    let message = `${zip} isn't a postal code for ${label}.`;
    if (belongsTo.length) message += ` It belongs to ${joinNames(belongsTo)}.`;
    if (codes && codes.zips.length) message += ` Its codes: ${formatZipRanges(codes.zips)}.`;
    return { status: "mismatch", message, source, belongsTo, expected: codes ? codes.zips : null };
  }

  return { check, zipsFor, _internals: { cache, isDown: () => now() < downUntil } };
}

export const _testing = { sameCity, editDistance };
