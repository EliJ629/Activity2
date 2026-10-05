// A stand-in for the Unified ZIP Code API (zip.jamesventura.dev) so tests never touch the network.
// It returns the same JSON shapes as the real one (see its source: github.com/0xC0000094/unified-zip-code):
//   ok:     { ok: true, query, count?, data }      data = one record (lookup?psgc=) or an array of records
//   absent: HTTP 404 { ok: false, error }          e.g. "No barangay carries the zip code 9999."
// Its data is generated from the bundled table, so a city has the same ZIPs in the fake API and in the table
// unless a test changes that on purpose.
import fs from "node:fs";

const table = JSON.parse(fs.readFileSync(new URL("../server/postal-data/ph-postal.json", import.meta.url), "utf8")).cities;
const keys = Object.keys(table);
const prefixOf = (i) => i.toString(36).toUpperCase().padStart(4, "0");           // a unique 4-character code per city
const psgcOf = (key) => (key === "133900" ? "133901001" : `${key}001`);          // Manila's barangays hang off district codes
const keyOfPsgc = (psgc) => (String(psgc).startsWith("1339") ? "133900" : String(psgc).slice(0, 6));
const record = (key, zip) => ({ code: `${prefixOf(keys.indexOf(key))}001`, barangay: "Barangay 1", municipality: table[key].n[0], province: "Test", psgc: psgcOf(key), postal: zip });

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// mode: "up" (normal) | "down" (network error) | "429" | "500" | "html" (200 but not JSON) | "wrongshape"
// override(zip) -> array of keys that "use" the zip, to make the fake API disagree with the table on purpose
export function makeFakeZipApi({ mode = "up", override = null } = {}) {
  const calls = [];
  async function fetchImpl(url) {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (mode === "down") throw new TypeError("fetch failed");
    if (mode === "429") return new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
    if (mode === "500") return new Response("oops", { status: 500 });
    if (mode === "html") return new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } });
    if (mode === "wrongshape") return json(200, { ok: true, hello: "world" });

    if (u.pathname === "/api/lookup" && u.searchParams.get("postal")) {
      const zip = u.searchParams.get("postal");
      const owners = override ? override(zip) : keys.filter((k) => table[k].z.includes(zip));
      if (!owners.length) return json(404, { ok: false, error: `No barangay carries the zip code ${zip}.` });
      return json(200, { ok: true, query: { postal: zip }, count: owners.length, data: owners.map((k) => record(k, zip)) });
    }
    if (u.pathname === "/api/lookup" && u.searchParams.get("psgc")) {
      const psgc = u.searchParams.get("psgc");
      const k = keyOfPsgc(psgc);
      if (!table[k] || psgc !== psgcOf(k)) return json(404, { ok: false, error: `No barangay carries the PSGC ${psgc}.` });
      return json(200, { ok: true, query: { psgc }, data: record(k, table[k].z[0]) });
    }
    if (u.pathname === "/api/barangays") {
      const prefix = u.searchParams.get("municipality");
      const i = keys.findIndex((_, idx) => prefixOf(idx) === prefix);
      if (i < 0) return json(404, { ok: false, error: `No municipality matches ${prefix}.` });
      const k = keys[i];
      const rows = table[k].z.map((z) => record(k, z));
      return json(200, { ok: true, query: { municipality: prefix }, count: rows.length, data: rows });
    }
    return json(404, { ok: false, error: "No such endpoint." });
  }
  return { fetchImpl, calls };
}
