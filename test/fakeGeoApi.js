// A stand-in for the Country State City API (api.countrystatecity.in/v1) so tests never touch the network.
// Same shapes as the real one: a bare JSON array of { id, name, iso2, ... } for states and { id, name, ... } for cities,
// HTTP 401 { error: "Unauthorized. You shouldn't be here." } for a missing / wrong key, 404 { error: "Country not found." }.
// Some of the names are deliberately awkward (en dash, slash, a leading quote mark) because real data has them.
export const FAKE_KEY = "test-key";

const DATA = {
  US: { states: { CA: "California", TX: "Texas", NY: "New York" },
    cities: { CA: ["Los Angeles", "San Francisco", "San Jose", "San Jose"], TX: ["Austin", "Dallas", "O'Fallon", "St. Louis"], NY: ["Winston-Salem", "Buffalo"] } },
  IT: { states: { 36: "Friuli\u2013Venezia Giulia", 62: "Lazio" }, cities: { 36: ["Trieste", "Udine"], 62: ["Rome"] } },
  AU: { states: { SA: "South Australia" }, cities: { SA: ["Orroroo/Carrieton", "Adelaide"] } },
  AF: { states: { BDS: "Badakhshan" }, cities: { BDS: ["Pul-e \u2018Alam", "\u2018Alaqahdari Dishu"] } },
  GB: { states: { ENG: "England", SCT: "Scotland" }, cities: { ENG: ["London", "Manchester"], SCT: ["Edinburgh"] } },
  VA: { states: {}, cities: {} },   // a country with no states in the data
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// mode: "up" | "down" (network error) | "401" | "403" | "429" | "500" | "html" (200 but not JSON) | "wrongshape" | "envelope" ({ data: [...] })
export function makeFakeGeoApi({ mode = "up" } = {}) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    calls.push({ path: u.pathname.replace(/^\/v1/, ""), key: init.headers?.["X-CSCAPI-KEY"], accept: init.headers?.accept, host: u.host });
    if (mode === "down") throw new TypeError("fetch failed");
    if (mode === "401") return json(401, { error: "Unauthorized. You shouldn't be here." });
    if (mode === "403") return json(403, { error: "Endpoint not included in this plan.", upgradeUrl: "https://app.countrystatecity.in/pricing" });
    if (mode === "429") return json(429, { status: "error", message: "Daily usage limit exceeded." });
    if (mode === "500") return new Response("oops", { status: 500 });
    if (mode === "html") return new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } });
    if (mode === "wrongshape") return json(200, { hello: "world" });
    if (init.headers?.["X-CSCAPI-KEY"] !== FAKE_KEY) return json(401, { error: "Unauthorized. You shouldn't be here." });

    const wrap = (rows) => json(200, mode === "envelope" ? { data: rows, total: rows.length } : rows);
    let m = /^\/v1\/countries\/([A-Z]{2})\/states$/.exec(u.pathname);
    if (m) {
      const c = DATA[m[1]];
      if (!c) return json(404, { error: "Country not found." });
      return wrap(Object.entries(c.states).map(([iso2, name], i) => ({ id: 1000 + i, name, iso2, country_code: m[1], latitude: "0", longitude: "0", timezone: "UTC" })));
    }
    m = /^\/v1\/countries\/([A-Z]{2})\/states\/([A-Za-z0-9]+)\/cities$/.exec(u.pathname);
    if (m) {
      const c = DATA[m[1]];
      if (!c) return json(404, { error: "Country not found." });
      if (!c.states[m[2]]) return json(404, { error: "State not found." });
      return wrap((c.cities[m[2]] || []).map((name, i) => ({ id: 5000 + i, name, latitude: "0", longitude: "0" })));
    }
    return json(404, { error: "Not found." });
  }
  return { fetchImpl, calls };
}
