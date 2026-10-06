/* ===== utils/psgcApi.js ===== */
// Philippine address data from the free PSGC API (https://psgc.gitlab.io/api/)
// Province -> City
//
// The City list holds CITIES only (Ilocos Norte: City of Batac, City of Laoag), the way "the cities of a province" is
// normally meant. Most places are municipalities, not cities (1,488 of 1,634), and 29 of the 82 provinces have no city at
// all, so nobody is shut out:
//   * a province with no city lists its municipalities instead (fetchPlaces), and
//   * a person whose place is a municipality can switch the list to municipalities (the switch under the City field).
//
// Only places that belong to the picked province are ever shown. Whatever a call returns is filtered: an entry the API files
// under another province (or none), or of the other kind, is dropped, so a stray or oversized response cannot put other
// places in the list.
//
// Two more things in the official data need care so that nobody's home is missing from the lists:
//  1. Metro Manila (the NCR) has no provinces: its cities hang directly off the region. It is added to the province list
//     as "Metro Manila", and its cities (16) and municipality (Pateros) are read from the region.
//  2. Two cities belong to no province in the PSGC, although each lies inside one: City of Isabela (Basilan) and City of
//     Cotabato (Maguindanao del Norte). A plain "cities of this province" call never returns them, so each is fetched by its
//     own code and added to the province it lies in. (If the API ever lists them under the province itself, they are simply
//     not added twice.)
//
// A call that comes back empty or fails is not the end: the dedicated cities / municipalities call is tried first, then the
// combined "cities and municipalities" call, then the full list of every place, each filtered the same way. Only when every
// call fails is the error passed on (the form then says the list could not be loaded).

const BASE_URL = "https://psgc.gitlab.io/api";
const cache = {};

const NCR = { code: "130000000", name: "Metro Manila" };

const PROVINCELESS_CITIES = [
  { code: "099701000", inProvince: (name) => /^basilan$/i.test(name) },                       // City of Isabela
  {                                                                                           // City of Cotabato
    code: "129804000",
    inProvince: (name, all) => /^maguindanao/i.test(name) && (!all.some((n) => /del norte/i.test(n)) || /del norte/i.test(name)),
  },
];

const provinceNames = new Map(); // province code -> name, filled by fetchProvinces (fetchCities needs it)

async function getRaw(path) {
  if (cache[path]) return cache[path];
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`Address API error (${res.status})`);
  const data = await res.json();
  cache[path] = data;
  return data;
}

// Listed by the name people look for: "City of Laoag" is found under L, not under C
const sortKey = (name) => name.replace(/^(city|municipality) of\s+/i, "");
const byName = (a, b) => sortKey(a.name).localeCompare(sortKey(b.name)) || a.name.localeCompare(b.name);

// Does this place belong to this province? The API says so itself in provinceCode. If it doesn't say, the PSGC code does: a
// place's code starts with its province's (Ilocos Norte 012800000 -> Laoag 012812000). A place with provinceCode false
// belongs to no province (Metro Manila's cities, Isabela and Cotabato) and is handled on its own.
const belongsTo = (place, provinceCode) => {
  if (place.provinceCode === false) return false;
  if (place.provinceCode) return String(place.provinceCode) === String(provinceCode);
  return String(place.code).startsWith(String(provinceCode).slice(0, 4));
};
const inNcr = (place) => String(place.code).startsWith("13");

// Is it the kind asked for ("cities" or "municipalities")? The API says so in isCity. If it doesn't say, an answer from the
// dedicated cities / municipalities call is trusted (it can only hold that kind); an answer from the other calls is not.
const isKind = (place, kind, strict) => (typeof place.isCity === "boolean" ? (kind === "cities") === place.isCity : !strict);

const toOptions = (list, kind) => {
  const seen = new Set();
  return list
    .filter((item) => item && item.code && item.name && !seen.has(item.code) && seen.add(item.code))   // each place once
    .map((item) => ({ code: item.code, name: item.name, provinceCode: item.provinceCode, kind: kind === "cities" ? "city" : "municipality" }))
    .sort(byName);
};

export async function fetchProvinces() {
  const data = await getRaw("/provinces/");
  const provinces = data
    // anything the API files under the NCR (code 13...) or calls "(Not a Province)" is replaced by the single Metro Manila entry
    .filter((p) => !String(p.code).startsWith("13") && !/not a province/i.test(p.name))
    .map((p) => ({ code: p.code, name: p.name }));
  provinceNames.clear();
  provinces.forEach((p) => provinceNames.set(p.code, p.name));
  provinces.push(NCR);
  return provinces.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
}

// The raw places of one kind in one scope (a province, or the NCR). `primary` is the dedicated call for the kind, `combined`
// the call that holds both kinds. An empty answer from one call is not final: the next is tried. The exception is the
// combined call showing the province's places with none of this kind (a province with no city): that IS the answer, so the
// whole-country list is not downloaded to double-check it.
async function loadPlaces(kind, { primary, combined, inScope }) {
  let lastError = null;
  let answered = false;
  const attempt = async (path, strict, finalIfNoneOfKind = false) => {
    try {
      const data = await getRaw(path);
      answered = true;
      const here = data.filter((p) => inScope(p));
      const list = here.filter((p) => isKind(p, kind, strict));
      if (list.length) return list;
      return finalIfNoneOfKind && here.some((p) => typeof p.isCity === "boolean") ? [] : null;
    } catch (err) {
      lastError = err;
      return null;
    }
  };
  return (
    (await attempt(primary, false)) ||
    (await attempt(combined, true, true)) ||
    (await attempt("/cities-municipalities/", true)) ||
    (answered ? [] : Promise.reject(lastError || new Error("Address API error")))
  );
}

const placesOf = (provinceCode, kind) =>
  provinceCode === NCR.code
    ? loadPlaces(kind, { primary: `/regions/${NCR.code}/${kind}/`, combined: `/regions/${NCR.code}/cities-municipalities/`, inScope: inNcr })
    : loadPlaces(kind, { primary: `/provinces/${provinceCode}/${kind}/`, combined: `/provinces/${provinceCode}/cities-municipalities/`, inScope: (p) => belongsTo(p, provinceCode) });

// The CITIES of a province (Ilocos Norte: City of Batac, City of Laoag), or of Metro Manila
export async function fetchCities(provinceCode) {
  const list = toOptions(await placesOf(provinceCode, "cities"), "cities");
  if (provinceCode === NCR.code) return list;

  const name = provinceNames.get(provinceCode) || "";
  const allNames = [...provinceNames.values()];
  for (const extra of PROVINCELESS_CITIES) {
    if (!extra.inProvince(name, allNames) || list.some((c) => c.code === extra.code)) continue;
    try {
      list.push(...toOptions([await getRaw(`/cities-municipalities/${extra.code}/`)], "cities"));
    } catch {
      // if this one lookup fails the rest of the list still works
    }
  }
  return list.sort(byName);
}

// The MUNICIPALITIES of a province (Ilocos Norte: its 21), or Metro Manila's one (Pateros)
export async function fetchMunicipalities(provinceCode) {
  return toOptions(await placesOf(provinceCode, "municipalities"), "municipalities");
}

// What the City dropdown lists. The key is a province code, or "<code>|m" when the person asked for municipalities.
// Cities by default; a province that has no city at all lists its municipalities, so its people are not stuck.
export async function fetchPlaces(key) {
  const [code, mode] = String(key).split("|");
  if (mode === "m") return fetchMunicipalities(code);
  const cities = await fetchCities(code);
  return cities.length ? cities : fetchMunicipalities(code);
}