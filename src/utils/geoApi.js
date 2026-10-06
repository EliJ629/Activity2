/* ===== utils/geoApi.js ===== */
// State / region and city lists for every country except the Philippines (the Philippines uses psgcApi.js).
// They come from this app's own server (/api/geo/...), which asks the Country State City API with a key the browser never
// sees. Both functions always resolve: an empty list means "no list available" (no key on the server, a quota used up, the
// API down, or a country with no states in the data), and the address form then lets people type the state and city.

import { api } from "../api.js";

const cache = new Map();

async function load(path, pick) {
  if (cache.has(path)) return cache.get(path);
  try {
    const r = await api(path);
    const list = r && r.available ? pick(r) : [];
    if (list.length) cache.set(path, list);   // only real lists are kept, so a failed lookup is tried again next time
    return list;
  } catch {
    return [];
  }
}

// -> [{ code: "CA", name: "California" }, ...]
export const fetchGeoStates = (country) =>
  load(`/geo/states?country=${encodeURIComponent(country)}`, (r) => r.states.map((s) => ({ code: s.code, name: s.name })));

// -> [{ code: "Los Angeles", name: "Los Angeles" }, ...]   (a city's name is its code: the server lists each name once)
export const fetchGeoCities = (country, state) =>
  load(`/geo/cities?country=${encodeURIComponent(country)}&state=${encodeURIComponent(state)}`, (r) => r.cities.map((c) => ({ code: c.name, name: c.name })));
