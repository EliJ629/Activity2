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
const names = (list) => list.mimport test from "node:test";
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

test("the first dropdown lists provinces, plus Metro Manila, and nothing the API files under the NCR", async () => {
  await withApi({}, async ({ fetchProvinces }) => {
    const list = await fetchProvinces();
    assert.deepEqual(names(list), ["Basilan", "Cotabato", "Ilocos Norte", "Isabela", "Maguindanao del Norte", "Maguindanao del Sur", "Metro Manila", "Negros Occidental", "Negros Oriental", "Siquijor"]);
    assert.deepEqual(list.find((p) => p.name === "Metro Manila"), { code: "130000000", name: "Metro Manila" });
    assert.ok(!list.some((p) => /not a province|NCR|region/i.test(p.name)));
    assert.ok(list.every((p) => p.code && p.name));
  });
});

test("the Negros provinces are plain provinces (no region patch is needed any more)", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("064500000")), ["City of Bacolod", "City of Bago"]);
    assert.deepEqual(names(await fetchCities("074600000")), ["City of Dumaguete"]);
    assert.deepEqual(names(await fetchCities("076100000")), ["Siquijor"]);
  });
});

test("Metro Manila's cities come from the region", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }, fake) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("130000000")), ["City of Caloocan", "City of Manila", "Quezon City"]);
    assert.ok(fake.calls.includes("/regions/130000000/cities-municipalities/"));
  });
});

test("City of Isabela appears under Basilan (and nowhere else, not even the province called Isabela)", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("150700000")), ["Akbar", "City of Isabela", "City of Lamitan"]);
    assert.ok(!names(await fetchCities("023100000")).includes("City of Isabela"));
    assert.deepEqual(names(await fetchCities("023100000")), ["Alicia", "City of Ilagan"]);
  });
});

test("City of Cotabato appears under Maguindanao del Norte only", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("153800000")), ["City of Cotabato", "Datu Odin Sinsuat"]);
    assert.ok(!names(await fetchCities("153900000")).includes("City of Cotabato"));      // Maguindanao del Sur
    assert.ok(!names(await fetchCities("124700000")).includes("City of Cotabato"));      // the province called Cotabato
  });
});

test("with the older single 'Maguindanao' province, City of Cotabato goes there", async () => {
  await withApi({ oldMaguindanao: true }, async ({ fetchProvinces, fetchCities }) => {
    const list = await fetchProvinces();
    assert.ok(names(list).includes("Maguindanao") && !names(list).some((x) => /del Norte|del Sur/.test(x)));
    assert.deepEqual(names(await fetchCities("153800000")), ["City of Cotabato", "Datu Odin Sinsuat"]);
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
    assert.deepEqual(names(await fetchCities("150700000")), ["Akbar", "City of Lamitan"]);
  });
});

test("each answer is asked for once, then remembered", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }, fake) => {
    await fetchProvinces(); await fetchProvinces();
    await fetchCities("150700000"); await fetchCities("150700000");
    assert.equal(fake.calls.filter((p) => p === "/provinces/").length, 1);
    assert.equal(fake.calls.filter((p) => p === "/provinces/150700000/cities-municipalities/").length, 1);
    assert.equal(fake.calls.filter((p) => p === "/cities-municipalities/099701000/").length, 1);
  });
});

test("when the address API is down the call fails, so the form can say so", async () => {
  await withApi({ mode: "500" }, async ({ fetchProvinces, fetchCities }) => {
    await assert.rejects(fetchProvinces(), /Address API error \(500\)/);
    await assert.rejects(fetchCities("150700000"), /Address API error \(500\)/);
  });
});

const ILOCOS_NORTE = ["Adams", "Bacarra", "Badoc", "Bangui", "Banna", "City of Batac", "Burgos", "Carasi", "Currimao", "Dingras", "Dumalneg", "City of Laoag", "Marcos",
  "Nueva Era", "Pagudpud", "Paoay", "Pasuquin", "Piddig", "Pinili", "San Nicolas", "Sarrat", "Solsona", "Vintar"];

test("Ilocos Norte lists all its 21 municipalities and 2 cities, in the order people look for them", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }) => {
    const prov = (await fetchProvinces()).find((p) => p.name === "Ilocos Norte");
    assert.equal(prov.code, "012800000");
    const list = await fetchCities(prov.code);
    assert.equal(list.length, 23);
    assert.deepEqual(names(list), ILOCOS_NORTE);                       // "City of Batac" sits with the B's and "City of Laoag" with the L's
    assert.deepEqual(list.map((c) => c.code).slice(0, 2), ["012801000", "012802000"]);
  });
});

test("a combined call that comes back empty, or fails, does not leave the province's list empty", async () => {
  for (const combined of ["empty", "404", "500"]) {
    await withApi({ combined }, async ({ fetchProvinces, fetchCities }, fake) => {
      await fetchProvinces();
      assert.deepEqual(names(await fetchCities("012800000")), ILOCOS_NORTE, combined);
      assert.ok(fake.calls.includes("/provinces/012800000/cities/") && fake.calls.includes("/provinces/012800000/municipalities/"), combined);
    });
  }
});

test("if the separate calls fail too, the full list is filtered by province", async () => {
  await withApi({ combined: "500", separate: "404" }, async ({ fetchProvinces, fetchCities }, fake) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("012800000")), ILOCOS_NORTE);
    assert.ok(fake.calls.includes("/cities-municipalities/"));
    assert.deepEqual(names(await fetchCities("150700000")), ["Akbar", "City of Isabela", "City of Lamitan"]);    // the province-less city is still added
  });
});

test("the fallbacks still add the two province-less cities", async () => {
  await withApi({ combined: "empty" }, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.ok(names(await fetchCities("150700000")).includes("City of Isabela"));
    assert.ok(names(await fetchCities("153800000")).includes("City of Cotabato"));
  });
});

test("when every call fails the error is passed on; a province that really has no cities is just an empty list", async () => {
  await withApi({ combined: "500", separate: "404", full: "404" }, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    await assert.rejects(fetchCities("012800000"));
  });
  await withApi({}, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.deepEqual(await fetchCities("999900000"), []);              // unknown province code: every call answers, nothing is listed
  });
});

test("only the picked province's places are listed, even when the service sends every place in the country", async () => {
  await withApi({ leaky: true }, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("012800000")), ILOCOS_NORTE);                                  // Ilocos Norte: its 23, nothing else
    assert.deepEqual(names(await fetchCities("130000000")), ["City of Caloocan", "City of Manila", "Quezon City"]);   // Metro Manila: its own only
    assert.deepEqual(names(await fetchCities("150700000")), ["Akbar", "City of Isabela", "City of Lamitan"]);       // Basilan, with the province-less Isabela
    assert.deepEqual(names(await fetchCities("064500000")), ["City of Bacolod", "City of Bago"]);
    assert.deepEqual(names(await fetchCities("153900000")), ["Ampatuan"]);                                         // Maguindanao del Sur: no Cotabato, no Norte towns
  });
});

test("an answer that holds only another province's places is not used", async () => {
  await withApi({ combined: "other" }, async ({ fetchProvinces, fetchCities }, fake) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("012800000")), ILOCOS_NORTE);       // the combined call answered with Negros Occidental's places: ignored, the next call is used
    assert.ok(fake.calls.includes("/provinces/012800000/cities/"));
    assert.ok(!names(await fetchCities("012800000")).includes("City of Bacolod"));
  });
});

test("places with no provinceCode are placed by their PSGC code, and a place listed twice appears once", async () => {
  await withApi({ leaky: true, noProvinceField: true, duplicates: true }, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    const list = await fetchCities("012800000");
    assert.deepEqual(names(list), ILOCOS_NORTE);
    assert.equal(new Set(list.map((c) => c.code)).size, list.length);
    assert.ok(list.every((c) => c.code.startsWith("0128")));
  });
});ap((c) => c.name);

test("the first dropdown lists provinces, plus Metro Manila, and nothing the API files under the NCR", async () => {
  await withApi({}, async ({ fetchProvinces }) => {
    const list = await fetchProvinces();
    assert.deepEqual(names(list), ["Basilan", "Cotabato", "Isabela", "Maguindanao del Norte", "Maguindanao del Sur", "Metro Manila", "Negros Occidental", "Negros Oriental", "Siquijor"]);
    assert.deepEqual(list.find((p) => p.name === "Metro Manila"), { code: "130000000", name: "Metro Manila" });
    assert.ok(!list.some((p) => /not a province|NCR|region/i.test(p.name)));
    assert.ok(list.every((p) => p.code && p.name));
  });
});

test("the Negros provinces are plain provinces (no region patch is needed any more)", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("064500000")), ["City of Bacolod", "City of Bago"]);
    assert.deepEqual(names(await fetchCities("074600000")), ["City of Dumaguete"]);
    assert.deepEqual(names(await fetchCities("076100000")), ["Siquijor"]);
  });
});

test("Metro Manila's cities come from the region", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }, fake) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("130000000")), ["City of Caloocan", "City of Manila", "Quezon City"]);
    assert.ok(fake.calls.includes("/regions/130000000/cities-municipalities/"));
  });
});

test("City of Isabela appears under Basilan (and nowhere else, not even the province called Isabela)", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("150700000")), ["Akbar", "City of Isabela", "City of Lamitan"]);
    assert.ok(!names(await fetchCities("023100000")).includes("City of Isabela"));
    assert.deepEqual(names(await fetchCities("023100000")), ["Alicia", "City of Ilagan"]);
  });
});

test("City of Cotabato appears under Maguindanao del Norte only", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }) => {
    await fetchProvinces();
    assert.deepEqual(names(await fetchCities("153800000")), ["City of Cotabato", "Datu Odin Sinsuat"]);
    assert.ok(!names(await fetchCities("153900000")).includes("City of Cotabato"));      // Maguindanao del Sur
    assert.ok(!names(await fetchCities("124700000")).includes("City of Cotabato"));      // the province called Cotabato
  });
});

test("with the older single 'Maguindanao' province, City of Cotabato goes there", async () => {
  await withApi({ oldMaguindanao: true }, async ({ fetchProvinces, fetchCities }) => {
    const list = await fetchProvinces();
    assert.ok(names(list).includes("Maguindanao") && !names(list).some((x) => /del Norte|del Sur/.test(x)));
    assert.deepEqual(names(await fetchCities("153800000")), ["City of Cotabato", "Datu Odin Sinsuat"]);
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
    assert.deepEqual(names(await fetchCities("150700000")), ["Akbar", "City of Lamitan"]);
  });
});

test("each answer is asked for once, then remembered", async () => {
  await withApi({}, async ({ fetchProvinces, fetchCities }, fake) => {
    await fetchProvinces(); await fetchProvinces();
    await fetchCities("150700000"); await fetchCities("150700000");
    assert.equal(fake.calls.filter((p) => p === "/provinces/").length, 1);
    assert.equal(fake.calls.filter((p) => p === "/provinces/150700000/cities-municipalities/").length, 1);
    assert.equal(fake.calls.filter((p) => p === "/cities-municipalities/099701000/").length, 1);
  });
});

test("when the address API is down the call fails, so the form can say so", async () => {
  await withApi({ mode: "500" }, async ({ fetchProvinces, fetchCities }) => {
    await assert.rejects(fetchProvinces(), /Address API error \(500\)/);
    await assert.rejects(fetchCities("150700000"), /Address API error \(500\)/);
  });
});
