// Country -> state / region -> city lists for every country except the Philippines (which uses the PSGC dropdowns).
//
// Source: the Country State City API (https://api.countrystatecity.in/v1), whose data is the open database at
// github.com/dr5hn/countries-states-cities-database.
// Its free "Community" plan includes exactly the two calls used here: states of a country, and cities of a state
// (3,000 requests a month, 100 a day). The data is open under ODbL, which requires attribution (shown under the address).
//
// The API key stays on the server (the provider says never to put it in browser code): the browser asks this server
// (/api/geo/states, /api/geo/cities), and this server asks the API. Answers are cached for a day, parallel requests for the
// same list share one call, and after a failure the API is left alone for a while, so the free quota isn't wasted and a
// problem on their side can't slow every page. If there is no key, or the API can't be used, the answer says so
// ({ available: false }) and the form falls back to typing the state and city, so registration is never blocked.
//
// Not used for the ZIP / postal code: no worldwide API maps a ZIP to a city (the Philippines does, see server/postal.js).

const API_BASE = "https://api.countrystatecity.in/v1";
const MINUTE = 60 * 1000;

const byName = (a, b) => a.name.localeCompare(b.name);

export function createGeoService({
  apiKey = "",
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiBase = API_BASE,
  timeoutMs = 5000,
  cacheMs = 24 * 60 * MINUTE,   // countries and states barely change, cities a little more often (the provider refreshes them every 6-12 h)
  now = () => Date.now(),
  log = (...args) => console.error(...args),
} = {}) {
  const configured = Boolean(apiKey);
  const cache = new Map();      // path -> { at, value }
  const inflight = new Map();   // path -> Promise
  let pausedUntil = 0;
  let warned = false;

  const pause = (ms) => { pausedUntil = now() + ms; };

  // -> { kind: "ok", rows } | { kind: "notfound" } | { kind: "unavailable" }
  async function apiGet(path) {
    if (!configured || now() < pausedUntil) return { kind: "unavailable" };
    let res;
    try {
      res = await fetchImpl(apiBase + path, { headers: { "X-CSCAPI-KEY": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      pause(MINUTE);
      return { kind: "unavailable" };
    }
    if (res.status === 401 || res.status === 403) {   // wrong key, or an endpoint the plan doesn't include
      if (!warned) { warned = true; log(`Country State City API refused the request (HTTP ${res.status}): check CSC_API_KEY and the plan. State and city lists are switched off for now.`); }
      pause(10 * MINUTE);
      return { kind: "unavailable" };
    }
    if (res.status === 429) { pause(10 * MINUTE); return { kind: "unavailable" }; }   // daily / monthly quota used up
    if (res.status >= 500) { pause(MINUTE); return { kind: "unavailable" }; }
    if (res.status === 404) return { kind: "notfound" };
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;   // a bare array, or { data: [...] }
    return res.ok && rows ? { kind: "ok", rows } : { kind: "unavailable" };                    // anything unexpected: don't guess
  }

  // Only definite answers are remembered ("unavailable" is retried next time)
  function cached(path, shape) {
    const hit = cache.get(path);
    if (hit && now() - hit.at < cacheMs) return Promise.resolve(hit.value);
    if (inflight.has(path)) return inflight.get(path);
    const p = (async () => {
      const r = await apiGet(path);
      const value = r.kind === "ok" ? { available: true, list: shape(r.rows) } : r.kind === "notfound" ? { available: true, list: [] } : { available: false, list: [] };
      if (r.kind !== "unavailable") {
        cache.set(path, { at: now(), value });
        if (cache.size > 3000) cache.delete(cache.keys().next().value);
      }
      return value;
    })().finally(() => inflight.delete(path));
    inflight.set(path, p);
    return p;
  }

  // [{ code: "CA", name: "California" }, ...] sorted by name
  const shapeStates = (rows) => rows
    .filter((r) => r && r.name && (r.iso2 || r.id))
    .map((r) => ({ code: String(r.iso2 || r.id), name: String(r.name).trim() }))
    .sort(byName);

  // [{ name: "Los Angeles" }, ...] sorted, one entry per name
  const shapeCities = (rows) => {
    const seen = new Set();
    return rows
      .filter((r) => r && r.name)
      .map((r) => ({ name: String(r.name).trim() }))
      .filter((c) => c.name && !seen.has(c.name) && seen.add(c.name))
      .sort(byName);
  };

  return {
    configured,
    async states(country) {
      const r = await cached(`/countries/${encodeURIComponent(country)}/states`, shapeStates);
      return { available: r.available, states: r.list };
    },
    async cities(country, state) {
      const r = await cached(`/countries/${encodeURIComponent(country)}/states/${encodeURIComponent(state)}/cities`, shapeCities);
      return { available: r.available, cities: r.list };
    },
    _internals: { cache, isPaused: () => now() < pausedUntil },
  };
}
