/* ===== utils/psgcApi.js ===== */
// Philippine address data from the free PSGC API (https://psgc.gitlab.io/api/)
// Province -> City / Municipality
//
// Two things in the official data need care so that nobody's home is missing from the lists:
//
//  1. Metro Manila (the NCR) has no provinces: its 17 cities hang directly off the region. It is added to the province
//     list as "Metro Manila", and its cities are read from the region.
//  2. Two cities belong to no province in the PSGC, although each lies inside one: City of Isabela (Basilan) and City of
//     Cotabato (Maguindanao del Norte). A plain "cities of this province" call never returns them, so each is fetched by
//     its own code and added to the province it lies in. (If the API ever lists them under the province itself, they are
//     simply not added twice.)
//
// The old region dropdown also needed a patch for the Negros Island Region (2024); provinces are not affected by it, so
// that patch is gone.
//
// Only places that belong to the picked province are ever shown. Whatever a call returns is filtered: an entry the API files
// under another province (or none) is dropped, so a stray or oversized response cannot put other places in the list.
//
// A province's cities are read with the API's "cities and municipalities of this province" call. If that comes back empty
// or fails, the cities call and the municipalities call are tried separately, and last the full list of every city and
// municipality is filtered by province, so one odd response for one province cannot leave its list empty.

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
// Does this city / municipality belong to this province? The API says so itself in provinceCode. If it doesn't say, the PSGC
// code does: a place's code starts with its province's (Ilocos Norte 012800000 -> Laoag 012812000). A place with provinceCode
// false belongs to no province (Metro Manila's cities, Isabela and Cotabato) and is handled on its own.
const belongsTo = (city, provinceCode) => {
  if (city.provinceCode === false) return false;
  if (city.provinceCode) return String(city.provinceCode) === String(provinceCode);
  return String(city.code).startsWith(String(provinceCode).slice(0, 4));
};

const byName = (a, b) => sortKey(a.name).localeCompare(sortKey(b.name)) || a.name.localeCompare(b.name);
const toOptions = (list) => {
  const seen = new Set();
  return list
    .filter((item) => item && item.code && item.name && !seen.has(item.code) && seen.add(item.code))   // each place once
    .map((item) => ({ code: item.code, name: item.name, provinceCode: item.provinceCode }))
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
  return provinces.sort(byName);
}

// The raw cities and municipalities of one province, trying the combined call first. Only when EVERY call fails is the
// error passed on (so the form can say the list could not be loaded); an empty answer from all of them is an empty province.
async function citiesOfProvince(provinceCode) {
  let lastError = null;
  let answered = false;
  const attempt = async (paths) => {
    try {
      const parts = await Promise.all(paths.map((p) => getRaw(p)));
      answered = true;
      const list = parts.flat().filter((c) => belongsTo(c, provinceCode));   // an answer full of other provinces' places counts as empty
      return list.length ? list : null;
    } catch (err) {
      lastError = err;
      return null;
    }
  };
  return (
    (await attempt([`/provinces/${provinceCode}/cities-municipalities/`])) ||
    (await attempt([`/provinces/${provinceCode}/cities/`, `/provinces/${provinceCode}/municipalities/`])) ||
    (await attempt(["/cities-municipalities/"])) ||
    (answered ? [] : Promise.reject(lastError || new Error("Address API error")))
  );
}

export async function fetchCities(provinceCode) {
  // Metro Manila: the region's places, and only the NCR ones (their codes start with 13)
  if (provinceCode === NCR.code) return toOptions((await getRaw(`/regions/${NCR.code}/cities-municipalities/`)).filter((c) => String(c.code).startsWith("13")));

  const list = toOptions(await citiesOfProvince(provinceCode));
  const name = provinceNames.get(provinceCode) || "";
  const allNames = [...provinceNames.values()];
  for (const extra of PROVINCELESS_CITIES) {
    if (!extra.inProvince(name, allNames) || list.some((c) => c.code === extra.code)) continue;
    try {
      list.push(...toOptions([await getRaw(`/cities-municipalities/${extra.code}/`)]));
    } catch {
      // if this one lookup fails the rest of the list still works
    }
  }
  return list.sort(byName);
}