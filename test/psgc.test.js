import test from "node:test";
import assert from "node:assert/strict";
import { makeFakePsgcApi } from "./fakePsgcApi.js";

// A fresh copy of the module for every test (it keeps a cache of answers in module scope)
let n = 0;
async function withApi(options, fn) {
  const fake = makeFakePsgcApi(options);
  const real = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  try {
    const api = await import(`../src/utils/psgcApi.js?copy=${++n}`);
    await fn(api, fake);
  } finally {
    globalThis.fetch = real;
  }
}
const names = (list) => list.map((c) => c.name);

const ILOCOS_CITIES = ["City of Batac", "City of Laoag"];
const ILOCOS_MUNICIPALITIES = ["Adams", "Bacarra", "Badoc", "Bangui", "Banna", "Burgos", "Carasi", "Currimao", "Dingras", "Dumalneg", "Marcos", "Nueva Era", "Pagudpud",
  "Paoay", "Pasuquin", "Piddig", "Pinili", "San Nicolas", "Sarrat", "Solsona", "Vintar"];

/* ---------- the province list ---------- */

test("the first dropdown lists provinces, plus Metro Manila, and nothing the API files under the NCR", async () => {
  await withApi({}, async ({ fetchProvinces }) => {
    const list = await fetchProvinces();
    assert.deepEqual(names(list), ["Basilan", "Cotabato", "Ilocos Norte", "Isabela", "Maguindanao del Norte", "Maguindanao del Sur", "Metro Manila", "Negros Occidental", "Negros Oriental", "Siquijor"]);
    assert.deepEqual(list.find((p) => p.name === "Metro Manila"), { code: "130000000", name: "Metro Manila" });
    assert.ok(!list.some((p) => /not a province|NCR|region/i.test(p.name)));
    assert.ok(list.every((p) => p.code && p.name));
  });
});

/* ---------- the City list holds CITIES ---------- */

test("Ilocos Norte has 2 cities, as Google says: fetchCities gives exactly those", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities, fetchPlaces }) => {
    const prov = (await fetchProvinces()).find((p) => p.name === "Ilocos Norte");
    assert.equal(prov.code, "012800000");
    const cities = await fetchCities(prov.code);
    assert.deepEqual(names(cities), ILOCOS_CITIES);
    assert.deepEqual(cities.map((c) => c.code), ["012805000", "012812000"]);
    assert.ok(cities.every((c) => c.kind === "city"));
    const places = await fetchPlaces(prov.code);
    assert.ok(ILOCOS_CITIES.every((c) => names(places).includes(c)));                                   // and both are in the dropdown
  });
});

test("fetchMunicipalities gives Ilocos Norte's 21 municipalities, and neither Batac nor Laoag", async () => {
  await withApi({}, async ({ fetchProvinces, fetchMunicipalities }) => {
    await fetchProvinces();
    const list = await fetchMunicipalities("012800000");
    assert.deepEqual(names(list), ILOCOS_MUNICIPALITIES);                               // 21, and neither Batac nor Laoag
    assert.ok(list.every((c) => c.kind === "municipality"));
  });
});

test("a province with no city lists its municipalities instead, so nobody is shut out", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities, fetchPlaces }, fake) => {
    await fetchProvinces();
    assert.deepEqual(await fetchCities("076100000"), []);                                // Siquijor has no city
    assert.ok(!fake.calls.includes("/cities-municipalities/"));                          // settled without downloading the whole country's list
    const places = await fetchPlaces("076100000");
    assert.deepEqual(names(places), ["Enrique Villanueva", "Siquijor"]);
    assert.ok(places.every((c) => c.kind === "municipality"));
    assert.deepEqual(names(await fetchPlaces("153900000")), ["Ampatuan"]);              // Maguindanao del Sur: no city of its own
  });
});

test("Negros: plain provinces (no region patch is needed any more)", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("064500000")), ["City of Bacolod", "City of Bago"]);
    assert.deepEqual(names(await fetchCities("074600000")), ["City of Dumaguete"]);
  });
});

test("Metro Manila: its cities, and Pateros as its one municipality", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities, fetchMunicipalities }, fake) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("130000000")), ["City of Caloocan", "City of Manila", "Quezon City"]);
    assert.deepEqual(names(await fetchMunicipalities("130000000")), ["Pateros"]);
    assert.ok(fake.calls.includes("/regions/130000000/cities/"));
  });
});

/* ---------- the two cities that belong to no province ---------- */

test("City of Isabela appears under Basilan (and nowhere else, not even the province called Isabela)", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities, fetchMunicipalities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("150700000")), ["City of Isabela", "City of Lamitan"]);
    assert.deepEqual(names(await fetchMunicipalities("150700000")), ["Akbar"]);          // a city is not a municipality
    assert.deepEqual(names(await fetchCities("023100000")), ["City of Ilagan"]);
  });
});

test("City of Cotabato appears under Maguindanao del Norte only", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities, fetchMunicipalities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("153800000")), ["City of Cotabato"]);
    assert.deepEqual(await fetchCities("153900000"), []);                                // Maguindanao del Sur
    assert.deepEqual(await fetchCities("124700000"), []);                                // the province called Cotabato
    assert.ok(!names(await fetchMunicipalities("153800000")).includes("City of Cotabato"));
  });
});

test("with the older single 'Maguindanao' province, City of Cotabato goes there", async () => {
  await withApi({ oldMaguindanao: true }, async ({ fetchProvinces, fetchCities }) => {
    const list = await fetchProvinces();
    assert.ok(names(list).includes("Maguindanao") && !names(list).some((x) => /del Norte|del Sur/.test(x)));
    assert.deepEqual(names(await fetchCities("153800000")), ["City of Cotabato"]);
  });
});

test("a city the API already lists under its province is not added twice", async () => {
  await withApi({ listOrphansUnderProvince: true }, async ({ fetchProvinces, fetchCities }, fake) => {
    await fetchProvinces();
    assert.equal(names(await fetchCities("150700000")).filter((x) => x === "City of Isabela").length, 1);
    assert.equal(names(await fetchCities("153800000")).filter((x) => x === "City of Cotabato").length, 1);
    assert.ok(!fake.calls.some((p) => p.startsWith("/cities-municipalities/")));          // nothing extra was asked for
  });
});

test("if the lookup for such a city fails, the rest of the province's list still works", async () => {
  await withApi({ failOrphans: true }, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("150700000")), ["City of Lamitan"]);
  });
});

/* ---------- only the picked province's places, whatever the service sends ---------- */

test("only the picked province's cities are listed, even when the service sends every place in the country", async () => {
  await withApi({ leaky: true }, async ({ fetchProvinces, fetchCities, fetchMunicipalities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("012800000")), ILOCOS_CITIES);
    assert.deepEqual(names(await fetchMunicipalities("012800000")), ILOCOS_MUNICIPALITIES);
    assert.deepEqual(names(await fetchCities("130000000")), ["City of Caloocan", "City of Manila", "Quezon City"]);
    assert.deepEqual(names(await fetchMunicipalities("130000000")), ["Pateros"]);
    assert.deepEqual(names(await fetchCities("150700000")), ["City of Isabela", "City of Lamitan"]);
    assert.deepEqual(names(await fetchCities("064500000")), ["City of Bacolod", "City of Bago"]);
    assert.deepEqual(await fetchCities("153900000"), []);
  });
});

test("an answer that holds only another province's places is not used", async () => {
  await withApi({ primary: "other" }, async ({ fetchProvinces, fetchCities }, fake) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("012800000")), ILOCOS_CITIES);              // the dedicated call answered with Negros Occidental's: ignored
    assert.ok(fake.calls.includes("/provinces/012800000/cities-municipalities/"));      // the next call was used
  });
});

test("places with no provinceCode are placed by their PSGC code, and a place listed twice appears once", async () => {
  await withApi({ leaky: true, noProvinceField: true, duplicates: true }, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    const list = await fetchCities("012800000");
    assert.deepEqual(names(list), ILOCOS_CITIES);
    assert.equal(new Set(list.map((c) => c.code)).size, list.length);
  });
});

/* ---------- a call that is empty or fails is not the end ---------- */

test("when the dedicated call is empty or fails, the combined call (filtered to cities) takes over", async () => {
  for (const primary of ["empty", "404", "500"]) {
    await withApi({ primary }, async ({ fetchProvinces, fetchCities, fetchMunicipalities }, fake) => {
      await fetchProvinces();
      assert.deepEqual(names(await fetchCities("012800000")), ILOCOS_CITIES, primary);
      assert.deepEqual(names(await fetchMunicipalities("012800000")), ILOCOS_MUNICIPALITIES, primary);
      assert.ok(fake.calls.includes("/provinces/012800000/cities-municipalities/"), primary);
    });
  }
});

test("if the combined call fails too, the full list is filtered by province and kind", async () => {
  await withApi({ primary: "404", combined: "500" }, async ({ fetchProvinces, fetchCities }, fake) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("012800000")), ILOCOS_CITIES);
    assert.ok(fake.calls.includes("/cities-municipalities/"));
    assert.deepEqual(names(await fetchCities("150700000")), ["City of Isabela", "City of Lamitan"]);    // the province-less city is still added
  });
});

test("the fallbacks still add the two province-less cities", async () => {
  await withApi({ primary: "empty" }, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.ok(names(await fetchCities("150700000")).includes("City of Isabela"));
    assert.ok(names(await fetchCities("153800000")).includes("City of Cotabato"));
  });
});

test("when every call fails the error is passed on; a province nothing is listed for is just an empty list", async () => {
  await withApi({ primary: "500", combined: "500", full: "404" }, async ({ fetchProvinces, fetchCities, fetchPlaces }) => {
    await fetchProvinces();
    await assert.rejects(fetchCities("012800000"));
    await assert.rejects(fetchPlaces("012800000"));
  });
  await withApi({}, async ({ fetchProvinces, fetchCities, fetchPlaces }) => {
    await fetchProvinces();
    assert.deepEqual(await fetchCities("999900000"), []);              // unknown province code: every call answers, nothing is listed
    assert.deepEqual(await fetchPlaces("999900000"), []);
  });
});

test("each answer is asked for once, then remembered", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }, fake) => {
    await fetchProvinces(); await fetchProvinces();
    await fetchCities("150700000"); await fetchCities("150700000");
    assert.equal(fake.calls.filter((p) => p === "/provinces/").length, 1);
    assert.equal(fake.calls.filter((p) => p === "/provinces/150700000/cities/").length, 1);
    assert.equal(fake.calls.filter((p) => p === "/cities-municipalities/099701000/").length, 1);
  });
});

test("when the address API is down the call fails, so the form can say so", async () => {
  await withApi({ mode: "500" }, async ({ fetchProvinces, fetchCities }) => {
    await assert.rejects(fetchProvinces(), /Address API error \(500\)/);
    await assert.rejects(fetchCities("150700000"), /Address API error \(500\)/);
  });
});

/* ---------- the Municipality/City dropdown: ONE merged list, sorted by name ---------- */

const ILOCOS_MERGED = ["Adams", "Bacarra", "Badoc", "Bangui", "Banna", "City of Batac", "Burgos", "Carasi", "Currimao", "Dingras", "Dumalneg", "City of Laoag", "Marcos",
  "Nueva Era", "Pagudpud", "Paoay", "Pasuquin", "Piddig", "Pinili", "San Nicolas", "Sarrat", "Solsona", "Vintar"];

test("the dropdown is one merged list of a province's cities and municipalities, sorted by name", async () => {
  await withApi({}, async ({ fetchProvinces, fetchPlaces }) => {
    await fetchProvinces();
    const places = await fetchPlaces("012800000");
    assert.deepEqual(names(places), ILOCOS_MERGED);                                          // 2 cities + 21 municipalities, in one list
    assert.equal(places.filter((p) => p.kind === "city").length, 2);
    assert.equal(places.filter((p) => p.kind === "municipality").length, 21);
    assert.equal(new Set(places.map((p) => p.code)).size, 23);
    assert.ok(names(places).indexOf("City of Laoag") < names(places).indexOf("Marcos") && names(places).indexOf("Dumalneg") < names(places).indexOf("City of Laoag"));   // "City of Laoag" sits under L
  });
});

test("Metro Manila's dropdown: its cities and Pateros, merged and sorted", async () => {
  await withApi({}, async ({ fetchProvinces, fetchPlaces }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchPlaces("130000000")), ["City of Caloocan", "City of Manila", "Pateros", "Quezon City"]);
  });
});

test("Basilan's dropdown has City of Isabela merged in with its other places", async () => {
  await withApi({}, async ({ fetchProvinces, fetchPlaces }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchPlaces("150700000")), ["Akbar", "City of Isabela", "City of Lamitan"]);
    assert.deepEqual(names(await fetchPlaces("153800000")), ["City of Cotabato", "Datu Odin Sinsuat"]);     // Maguindanao del Norte
  });
});

test("even when the service sends every place in the country, the dropdown holds only the picked province's own", async () => {
  await withApi({ leaky: true }, async ({ fetchProvinces, fetchPlaces }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchPlaces("012800000")), ILOCOS_MERGED);
    assert.deepEqual(names(await fetchPlaces("064500000")), ["City of Bacolod", "City of Bago"]);
  });
});

test("SHOW_MUNICIPALITIES is on, so the dropdown holds both kinds (turn it off in psgcApi.js for cities only)", async () => {
  await withApi({}, async ({ SHOW_MUNICIPALITIES }) => {
    assert.equal(SHOW_MUNICIPALITIES, true);
  });
});