// A stand-in for the PSGC address API (https://psgc.gitlab.io/api/) so tests never touch the network.
// Same endpoints and field names as the real one. The data is a small slice of the real PSGC, including the awkward parts:
// Metro Manila (no provinces, its places hang off the region, and Pateros is a municipality among 16 cities), two cities that
// belong to no province (City of Isabela in Basilan, City of Cotabato in Maguindanao), provinces with no city at all, and an
// NCR "district" the API files as "(Not a Province)". Ilocos Norte has its real 2 cities and 21 municipalities.
const j = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const place = (code, name, provinceCode, regionCode) => {
  const isCity = /city|^city of/i.test(name);          // "City of Laoag", "Quezon City"
  return { code, name, oldName: "", isCapital: false, isCity, isMunicipality: !isCity, provinceCode, districtCode: false, regionCode };
};

export function makePsgcData({ oldMaguindanao = false } = {}) {
  const provinces = [
    { code: "012800000", name: "Ilocos Norte", regionCode: "010000000" },
    { code: "064500000", name: "Negros Occidental", regionCode: "060000000" },
    { code: "074600000", name: "Negros Oriental", regionCode: "070000000" },
    { code: "076100000", name: "Siquijor", regionCode: "070000000" },                       // no city at all
    { code: "023100000", name: "Isabela", regionCode: "020000000" },
    { code: "150700000", name: "Basilan", regionCode: "150000000" },
    ...(oldMaguindanao
      ? [{ code: "153800000", name: "Maguindanao", regionCode: "150000000" }]
      : [{ code: "153800000", name: "Maguindanao del Norte", regionCode: "150000000" }, { code: "153900000", name: "Maguindanao del Sur", regionCode: "150000000" }]),
    { code: "124700000", name: "Cotabato", regionCode: "120000000" },
    { code: "137600000", name: "NCR, Fourth District (Not a Province)", regionCode: "130000000" },
  ];
  const ilocosNorte = [["01", "Adams"], ["02", "Bacarra"], ["03", "Badoc"], ["04", "Bangui"], ["05", "City of Batac"], ["06", "Burgos"], ["07", "Carasi"], ["08", "Currimao"],
    ["09", "Dingras"], ["10", "Dumalneg"], ["11", "Banna"], ["12", "City of Laoag"], ["13", "Marcos"], ["14", "Nueva Era"], ["15", "Pagudpud"], ["16", "Paoay"],
    ["17", "Pasuquin"], ["18", "Piddig"], ["19", "Pinili"], ["20", "San Nicolas"], ["21", "Sarrat"], ["22", "Solsona"], ["23", "Vintar"]]
    .map(([n, name]) => place(`0128${n}000`, name, "012800000", "010000000"));     // the 21 municipalities and 2 cities of Ilocos Norte, as the PSA lists them
  const cities = {
    "012800000": ilocosNorte,
    "064500000": [place("064501000", "City of Bacolod", "064500000", "060000000"), place("064502000", "City of Bago", "064500000", "060000000")],
    "074600000": [place("074601000", "City of Dumaguete", "074600000", "070000000")],
    "076100000": [place("076101000", "Siquijor", "076100000", "070000000"), place("076102000", "Enrique Villanueva", "076100000", "070000000")],
    "023100000": [place("023101000", "City of Ilagan", "023100000", "020000000"), place("023102000", "Alicia", "023100000", "020000000")],
    "150700000": [place("150702000", "City of Lamitan", "150700000", "150000000"), place("150701000", "Akbar", "150700000", "150000000")],
    "153800000": [place("153802000", "Datu Odin Sinsuat", "153800000", "150000000")],
    "153900000": [place("153901000", "Ampatuan", "153900000", "150000000")],
    "124700000": [place("124701000", "Alamada", "124700000", "120000000")],
  };
  const ncr = [place("137501000", "City of Caloocan", false, "130000000"), place("137404000", "Quezon City", false, "130000000"), place("133900000", "City of Manila", false, "130000000"),
    place("137605000", "Pateros", false, "130000000")];
  const isabela = place("099701000", "City of Isabela", false, "090000000");
  const cotabato = place("129804000", "City of Cotabato", false, "120000000");
  return { provinces, cities, ncr, isabela, cotabato };
}

// options (all optional):
//   oldMaguindanao ..... one province called "Maguindanao", as in older data
//   listOrphansUnderProvince ... the API files City of Isabela / Cotabato under their province
//   failOrphans ........ the lookups of those two cities fail
//   mode: "500" ........ the whole API is down
//   primary: "ok" | "empty" | "404" | "500" | "other" ... the dedicated cities / municipalities calls ("other": another province's places)
//   combined: "ok" | "empty" | "404" | "500" | "other" ... the "cities and municipalities" call
//   full: "ok" | "404" ... the list of every place in the country
//   leaky: true ........ every call that should return one province's places returns EVERY place in the country
//   noProvinceField .... places carry no provinceCode;   duplicates ... the first place of every answer is listed twice
export function makeFakePsgcApi(options = {}) {
  const data = makePsgcData(options);
  if (options.listOrphansUnderProvince) {
    data.cities["150700000"].push({ ...data.isabela, provinceCode: "150700000" });
    data.cities["153800000"].push({ ...data.cotabato, provinceCode: "153800000" });
  }
  const calls = [];
  const everything = () => [...Object.values(data.cities).flat(), ...data.ncr, data.isabela, data.cotabato];
  // how this fake API shapes every list it sends
  const out = (list) => {
    let l = options.noProvinceField ? list.map(({ provinceCode, ...rest }) => rest) : list;
    if (options.duplicates && l.length) l = [l[0], ...l];
    return j(200, l);
  };
  const failure = (how) => (how === "404" ? j(404, { error: "not found" }) : how === "500" ? j(500, { error: "oops" }) : how === "empty" ? j(200, []) : null);
  const ofKind = (list, kind) => list.filter((p) => (kind === "cities" ? p.isCity : !p.isCity));

  async function fetchImpl(url) {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    calls.push(path);
    if (options.mode === "500") return j(500, { error: "oops" });
    if (path === "/provinces/") return j(200, data.provinces);

    // the dedicated calls: .../cities/ and .../municipalities/
    let m = /^\/provinces\/(\d{9})\/(cities|municipalities)\/$/.exec(path);
    if (m) {
      const bad = failure(options.primary);
      if (bad) return bad;
      if (!data.cities[m[1]]) return j(404, { error: "not found" });
      if (options.leaky) return out(ofKind(everything(), m[2]));
      if (options.primary === "other") return out(ofKind(data.cities["064500000"], m[2]));
      return out(ofKind(data.cities[m[1]], m[2]));
    }
    m = /^\/regions\/130000000\/(cities|municipalities)\/$/.exec(path);
    if (m) {
      const bad = failure(options.primary);
      if (bad) return bad;
      return out(ofKind(options.leaky ? everything() : data.ncr, m[1]));
    }

    // the combined call
    m = /^\/provinces\/(\d{9})\/cities-municipalities\/$/.exec(path);
    if (m) {
      const bad = failure(options.combined);
      if (bad) return bad;
      if (options.leaky) return out(everything());
      if (options.combined === "other") return out(data.cities["064500000"]);
      return data.cities[m[1]] ? out(data.cities[m[1]]) : j(404, { error: "not found" });
    }
    if (path === "/regions/130000000/cities-municipalities/") {
      const bad = failure(options.combined);
      return bad || out(options.leaky ? everything() : data.ncr);
    }

    if (path === "/cities-municipalities/") return options.full === "404" ? j(404, { error: "not found" }) : out(everything());

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