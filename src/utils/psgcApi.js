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

const byName = (a, b) => a.name.localeCompare(b.name);
const toOptions = (list) => list.map((item) => ({ code: item.code, name: item.name, provinceCode: item.provinceCode })).sort(byName);

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

export async function fetchCities(provinceCode) {
  if (provinceCode === NCR.code) return toOptions(await getRaw(`/regions/${NCR.code}/cities-municipalities/`));

  const list = toOptions(await getRaw(`/provinces/${provinceCode}/cities-municipalities/`));
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