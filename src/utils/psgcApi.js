/* ===== utils/psgcApi.js ===== */
// Philippine address data from the free PSGC API (https://psgc.gitlab.io/api/)
// Region -> City / Municipality -> Barangay
//
// The API's data predates the Negros Island Region (NIR, created 2024 by RA 12000),
// so it returns only 17 regions. To give the full 18, NIR is added here and built
// from its provinces through the same API:
//   Negros Occidental (incl. Bacolod City), Negros Oriental, Siquijor
// Those provinces are then removed from Western Visayas and Central Visayas.
// If the API ever adds NIR itself, this patch switches off automatically.

const BASE_URL = "https://psgc.gitlab.io/api";
const cache = {};

const NIR = { code: "180000000", name: "Negros Island Region (NIR)" };
const NIR_PROVINCES = ["064500000", "074600000", "076100000"];
let apiHasNir = false;

async function getRaw(path) {
  if (cache[path]) return cache[path];
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`Address API error (${res.status})`);
  const data = await res.json();
  cache[path] = data;
  return data;
}

const toOptions = (list) =>
  list
    .map((item) => ({ code: item.code, name: item.name, provinceCode: item.provinceCode }))
    .sort((a, b) => a.name.localeCompare(b.name));

// "Ilocos Region (Region I)", "National Capital Region (NCR)", ...
function regionLabel(r) {
  if (!r.regionName || r.regionName === r.name) return r.name;
  return r.regionName.startsWith("Region") ? `${r.name} (${r.regionName})` : `${r.regionName} (${r.name})`;
}

export async function fetchRegions() {
  const data = await getRaw("/regions/");
  const regions = data.map((r) => ({ code: r.code, name: regionLabel(r) }));
  apiHasNir = regions.some((r) => /negros island/i.test(r.name));
  if (!apiHasNir) regions.push(NIR);
  return regions.sort((a, b) => a.name.localeCompare(b.name)); // 18 regions
}

export async function fetchCities(regionCode) {
  if (regionCode === NIR.code) {
    const lists = await Promise.all(
      NIR_PROVINCES.map((p) => getRaw(`/provinces/${p}/cities-municipalities/`))
    );
    return toOptions(lists.flat());
  }
  const list = toOptions(await getRaw(`/regions/${regionCode}/cities-municipalities/`));
  // Negros provinces now belong to NIR, not Western / Central Visayas
  return apiHasNir ? list : list.filter((c) => !NIR_PROVINCES.includes(c.provinceCode));
}

export async function fetchBarangays(cityCode) {
  return toOptions(await getRaw(`/cities-municipalities/${cityCode}/barangays/`));
}
