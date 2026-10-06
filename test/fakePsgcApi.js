// A stand-in for the PSGC address API (https://psgc.gitlab.io/api/) so tests never touch the network.
// Same endpoints and field names as the real one. The data is a small slice of the real PSGC, including the awkward parts:
// Metro Manila (no provinces, cities hang off the region), two cities that belong to no province (City of Isabela in Basilan,
// City of Cotabato in Maguindanao), and an NCR "district" the API files as "(Not a Province)".
const j = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const city = (code, name, provinceCode, regionCode) => ({ code, name, oldName: "", isCapital: false, isCity: /city|^city of/i.test(name), isMunicipality: false, provinceCode, districtCode: false, regionCode });

export function makePsgcData({ oldMaguindanao = false } = {}) {
  const provinces = [
    { code: "064500000", name: "Negros Occidental", regionCode: "060000000" },
    { code: "074600000", name: "Negros Oriental", regionCode: "070000000" },
    { code: "076100000", name: "Siquijor", regionCode: "070000000" },
    { code: "023100000", name: "Isabela", regionCode: "020000000" },
    { code: "150700000", name: "Basilan", regionCode: "150000000" },
    ...(oldMaguindanao
      ? [{ code: "153800000", name: "Maguindanao", regionCode: "150000000" }]
      : [{ code: "153800000", name: "Maguindanao del Norte", regionCode: "150000000" }, { code: "153900000", name: "Maguindanao del Sur", regionCode: "150000000" }]),
    { code: "124700000", name: "Cotabato", regionCode: "120000000" },
    { code: "137600000", name: "NCR, Fourth District (Not a Province)", regionCode: "130000000" },
  ];
  const cities = {
    "064500000": [city("064501000", "City of Bacolod", "064500000", "060000000"), city("064502000", "City of Bago", "064500000", "060000000")],
    "074600000": [city("074601000", "City of Dumaguete", "074600000", "070000000")],
    "076100000": [city("076101000", "Siquijor", "076100000", "070000000")],
    "023100000": [city("023101000", "City of Ilagan", "023100000", "020000000"), city("023102000", "Alicia", "023100000", "020000000")],
    "150700000": [city("150702000", "City of Lamitan", "150700000", "150000000"), city("150701000", "Akbar", "150700000", "150000000")],
    "153800000": [city("153802000", "Datu Odin Sinsuat", "153800000", "150000000")],
    "153900000": [city("153901000", "Ampatuan", "153900000", "150000000")],
    "124700000": [city("124701000", "Alamada", "124700000", "120000000")],
  };
  const ncr = [city("137501000", "City of Caloocan", false, "130000000"), city("137404000", "Quezon City", false, "130000000"), city("133900000", "City of Manila", false, "130000000")];
  const isabela = city("099701000", "City of Isabela", false, "090000000");
  const cotabato = city("129804000", "City of Cotabato", false, "120000000");
  return { provinces, cities, ncr, isabela, cotabato };
}

// options: { oldMaguindanao, listOrphansUnderProvince (the API puts them under their province), failOrphans (their lookups fail), mode: "up"|"500" }
export function makeFakePsgcApi(options = {}) {
  const data = makePsgcData(options);
  if (options.listOrphansUnderProvince) {
    data.cities["150700000"].push({ ...data.isabela, provinceCode: "150700000" });
    data.cities["153800000"].push({ ...data.cotabato, provinceCode: "153800000" });
  }
  const calls = [];
  async function fetchImpl(url) {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    calls.push(path);
    if (options.mode === "500") return j(500, { error: "oops" });
    if (path === "/provinces/") return j(200, data.provinces);
    let m = /^\/provinces\/(\d{9})\/cities-municipalities\/$/.exec(path);
    if (m) return data.cities[m[1]] ? j(200, data.cities[m[1]]) : j(404, { error: "not found" });
    if (path === "/regions/130000000/cities-municipalities/") return j(200, data.ncr);
    m = /^\/cities-municipalities\/(\d{9})\/$/.exec(path);
    if (m) {
      if (options.failOrphans) return j(404, { error: "not found" });
      if (m[1] === "099701000") return j(200, data.isabela);
      if (m[1] === "129804000") return j(200, data.cotabato);
      return j(404, { error: "not found" });
    }
    return j(404, { error: "not found" });
  }
  return { fetchImpl, calls };
}
