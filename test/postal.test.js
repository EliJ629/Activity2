import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createPostalService, phZipsFor, phCityKey, normalizeCity, _testing } from "../server/postal.js";
import { makeFakeZipApi } from "./fakeZipApi.js";

const CAL = { city: "Caloocan City", cityCode: "137501000" };
const ask = (svc, zip, where = CAL) => svc.check({ countryCode: "PH", zip, ...where });
const service = (opts = {}, apiOpts = {}) => {
  const api = makeFakeZipApi(apiOpts);
  return { api, svc: createPostalService({ fetchImpl: api.fetchImpl, extras: {}, ...opts }) };
};

test("the ZIP API decides: a ZIP is accepted only for the city that uses it", async () => {
  const { svc } = service();
  for (const [zip, where] of [["1400", CAL], ["1100", { city: "Quezon City", cityCode: "137404000" }], ["1200", { city: "Makati City", cityCode: "137602000" }],
    ["6000", { city: "Cebu City", cityCode: "072217000" }], ["8000", { city: "Davao City", cityCode: "112402000" }]]) {
    const r = await ask(svc, zip, where);
    assert.equal(r.status, "ok", `${zip} ${where.city}`);
    assert.equal(r.source, "api");
  }
  const wrong = await ask(svc, "1100");                       // a real ZIP, but Quezon City's
  assert.equal(wrong.status, "mismatch");
  assert.equal(wrong.source, "api");
  assert.match(wrong.message, /^1100 isn't a postal code for Caloocan City\. It belongs to Quezon City\. Its codes: 1400, /);
  assert.deepEqual(wrong.belongsTo, ["Quezon City"]);
  assert.equal((await ask(svc, "1400", { city: "Quezon City", cityCode: "137404000" })).status, "mismatch");
});

test("a ZIP that no barangay uses (the API answers 404) is refused", async () => {
  const { svc } = service();
  const r = await ask(svc, "9999");
  assert.equal(r.status, "mismatch");
  assert.equal(r.source, "api");
  assert.match(r.message, /^9999 isn't a postal code for Caloocan City\./);
});

test("when the API says no, the bundled table does not overrule it", async () => {
  // the fake API insists 1400 belongs only to Quezon City, although the table lists it for Caloocan
  const { svc } = service({}, { override: (zip) => (zip === "1400" ? ["137404"] : undefined) });
  const r = await ask(svc, "1400");
  assert.equal(r.status, "mismatch");
  assert.equal(r.source, "api");
});

test("Manila's district-coded barangays all resolve to Manila", async () => {
  const { svc } = service();
  for (const code of ["133901000", "133904000", "133914000"]) assert.equal((await ask(svc, "1000", { city: "City of Manila", cityCode: code })).status, "ok", code);
  assert.equal((await ask(svc, "1100", { city: "City of Manila", cityCode: "133904000" })).status, "mismatch");
});

test("the city name and its code must agree, and the code must be real, before the API is even asked", async () => {
  const { svc, api } = service();
  assert.equal((await ask(svc, "1400", { city: "Cebu City", cityCode: "137501000" })).status, "invalid");
  assert.equal((await ask(svc, "1400", { city: "Caloocan City", cityCode: "" })).status, "invalid");
  assert.equal((await ask(svc, "1400", { city: "Caloocan City", cityCode: "13750100" })).status, "invalid");
  assert.equal(api.calls.length, 0);
  const fake = await ask(svc, "1400", { city: "Caloocan City", cityCode: "999999999" });   // a made-up code can't switch the check off
  assert.notEqual(fake.status, "ok");
  // the form's own lookups skip the name check (it only has the code)
  assert.equal((await svc.check({ countryCode: "PH", zip: "1400", city: "", cityCode: "137501000" }, { verifyName: false })).status, "ok");
});

test("city names match however the source spells them", async () => {
  const { svc } = service();
  for (const name of ["Caloocan City", "City of Caloocan", "caloocan", "CALOOCAN CITY"]) assert.equal((await ask(svc, "1400", { city: name, cityCode: "137501000" })).status, "ok", name);
  assert.equal(normalizeCity("City of Parañaque"), normalizeCity("Paranaque City"));
  assert.equal(_testing.sameCity("Ozamis City", "Ozamiz City"), true);
  assert.equal(_testing.sameCity("Caloocan", "Calamba"), false);
});

test("other countries are not checked here (only their postal format applies)", async () => {
  const { svc, api } = service();
  assert.equal((await svc.check({ countryCode: "US", zip: "90210", city: "Anywhere" })).status, "unchecked");
  assert.equal(api.calls.length, 0);
});

test("a ZIP you added to ph-postal-extra.json is accepted even if the API doesn't know it", async () => {
  const { svc } = service({ extras: { "137501": ["1422"] } });
  const r = await ask(svc, "1422");
  assert.equal(r.status, "ok");
  assert.equal(r.source, "extra");
  assert.equal((await ask(svc, "1422", { city: "Quezon City", cityCode: "137404000" })).status, "mismatch");   // only for that city
});

test("if the API can't be used, the bundled table answers instead", async () => {
  for (const mode of ["down", "429", "500", "html", "wrongshape"]) {
    const { svc } = service({}, { mode });
    const ok = await ask(svc, "1400");
    assert.equal(ok.status, "ok", mode);
    assert.equal(ok.source, "table", mode);
    const bad = await ask(svc, "1100");
    assert.equal(bad.status, "mismatch", mode);
    assert.equal(bad.source, "table", mode);
    assert.match(bad.message, /Its codes: 1400, /);
  }
});

test("after a failure the API is left alone for a while, then tried again", async () => {
  let clock = 1_000_000;
  const down = makeFakeZipApi({ mode: "down" });
  const up = makeFakeZipApi();
  let current = down;
  const svc = createPostalService({ fetchImpl: (...a) => current.fetchImpl(...a), extras: {}, now: () => clock, breakerMs: 60_000 });
  assert.equal((await ask(svc, "1400")).source, "table");
  const callsAfterFirst = down.calls.length;
  assert.equal((await ask(svc, "1100")).source, "table");
  assert.equal((await ask(svc, "1428")).source, "table");
  assert.equal(down.calls.length, callsAfterFirst);          // no further attempts while paused
  clock += 61_000; current = up;                             // a minute later, and the API is back
  assert.equal((await ask(svc, "1400")).source, "api");
});

test("answers are remembered, and parallel requests for one ZIP make one call", async () => {
  const { svc, api } = service();
  await Promise.all([ask(svc, "1400"), ask(svc, "1400"), ask(svc, "1400")]);
  assert.equal(api.calls.filter((c) => c.includes("postal=1400")).length, 1);
  await ask(svc, "1400");
  assert.equal(api.calls.filter((c) => c.includes("postal=1400")).length, 1);
});

test("a city's ZIP list comes from the API, and from the table when the API is down", async () => {
  const { svc } = service();
  const viaApi = await svc.zipsFor("137501000");
  assert.equal(viaApi.source, "api");
  assert.equal(viaApi.city, "Caloocan City");
  assert.ok(viaApi.zips.includes("1400") && viaApi.zips.includes("1428") && !viaApi.zips.includes("1100"));
  const manila = await svc.zipsFor("133904000");
  assert.equal(manila.source, "api");
  assert.ok(manila.zips.includes("1000"));
  const { svc: offline } = service({}, { mode: "down" });
  const viaTable = await offline.zipsFor("137501000");
  assert.equal(viaTable.source, "table");
  assert.ok(viaTable.zips.includes("1400"));
  assert.equal(await svc.zipsFor("000000000"), null);
  assert.equal(await svc.zipsFor(""), null);
});

test("the bundled table is complete and well-formed (it is the fallback)", () => {
  const { cities } = JSON.parse(fs.readFileSync(new URL("../server/postal-data/ph-postal.json", import.meta.url), "utf8"));
  const keys = Object.keys(cities);
  assert.ok(keys.length >= 1600, `only ${keys.length} cities`);
  for (const k of keys) {
    assert.match(k, /^\d{6}$/, k);
    assert.ok(cities[k].n.length >= 1, `${k} has no name`);
    assert.ok(cities[k].z.length >= 1, `${k} has no ZIP`);
  }
  assert.equal(phCityKey("137501000"), "137501");
  assert.equal(phCityKey("133999000"), "133900");
  assert.equal(phZipsFor("137602000").city, "Makati City");
  assert.equal(phZipsFor("000000000"), null);
});

test("it reads the REAL API's responses (copied from zip.jamesventura.dev), including a barangay with two ZIPs", async () => {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  const baliuag = (code, barangay, psgc) => ({ code, barangay, municipality: "Baliuag", province: "Bulacan", psgc, postal: "3006" });
  const sanRafael = (code, barangay, psgc, postal) => ({ code, barangay, municipality: "San Rafael", province: "Bulacan", psgc, postal });
  const real = {
    "/api/lookup?postal=3006": json(200, { ok: true, query: { postal: "3006" }, count: 3, data: [
      baliuag("BC03001", "Bagong Nayon", "031403001"), baliuag("BC03002", "Barangca", "031403002"), baliuag("BC03014", "Poblacion", "031403014")] }),
    "/api/lookup?postal=9999": json(404, { ok: false, error: "No barangay carries the zip code 9999." }),
    "/api/lookup?psgc=031422001": json(200, { ok: true, query: { psgc: "031422001" }, data: sanRafael("BC23001", "Bma-Balagtas", "031422001", "3008") }),
    "/api/barangays?municipality=BC23": json(200, { ok: true, query: { municipality: "BC23" }, count: 3, data: [
      sanRafael("BC23002", "Banca-Banca", "031422002", "3008"), sanRafael("BC23005", "Cruz na Daan", "031422005", "3008/3025"), sanRafael("BC23023", "Poblacion", "031422023", "3008")] }),
  };
  const seen = [];
  const svc = createPostalService({ extras: {}, fetchImpl: async (url, init) => {
    const u = new URL(url); const key = u.pathname + u.search; seen.push({ key, host: u.host, accept: init?.headers?.accept });
    return (real[key] ?? json(404, { ok: false, error: "No such thing." })).clone();
  } });
  const baliuagWhere = { city: "Baliuag", cityCode: "031403000" };
  assert.equal((await ask(svc, "3006", baliuagWhere)).status, "ok");
  const wrong = await ask(svc, "3006", { city: "San Rafael", cityCode: "031422000" });
  assert.equal(wrong.status, "mismatch");
  assert.match(wrong.message, /^3006 isn't a postal code for San Rafael\. It belongs to Baliuag\./);
  assert.match((await ask(svc, "9999", baliuagWhere)).message, /^9999 isn't a postal code for Baliuag\./);
  const list = await svc.zipsFor("031422000");
  assert.deepEqual(list.zips, ["3008", "3025"]);      // "3008/3025" is two ZIPs
  assert.equal(list.source, "api");
  assert.ok(seen.every((c) => c.host === "zip.jamesventura.dev" && c.accept === "application/json"));
});

/* ---------- a city with exactly these ZIPs (ph-postal-only.json): Naic, Cavite has 4110 only ---------- */

const NAIC = { city: "Naic", cityCode: "042115000" };

test("Naic, Cavite has only 4110: the real data file says so, even with the ZIP API down", async () => {
  const api = makeFakeZipApi({ mode: "down" });
  const svc = createPostalService({ fetchImpl: api.fetchImpl, extras: {} });          // reads the real ph-postal-only.json
  assert.deepEqual(await svc.zipsFor("042115000"), { city: "Naic", zips: ["4110"], source: "override" });
  assert.deepEqual(phZipsFor("042115000"), { city: "Naic", zips: ["4110"] });          // the bundled table agrees (it used to say 4110 and 4135)
  assert.deepEqual(await ask(svc, "4110", NAIC), { status: "ok", place: "Naic", source: "override" });
  const wrong = await ask(svc, "4135", NAIC);
  assert.equal(wrong.status, "mismatch");
  assert.equal(wrong.message, "4135 isn't a postal code for Naic. Its codes: 4110.");
  assert.deepEqual(wrong.expected, ["4110"]);
});

test("an 'exactly these ZIPs' city beats the ZIP API, the table and the hand-made additions", async () => {
  // the fake API insists that 4135 AND 4110 belong to Naic; a hand-made addition adds 4135 as well
  const { api, svc } = service({ only: { "042115": ["4110"] }, extras: { "042115": ["4135"] } }, { override: (zip) => (zip === "4135" || zip === "4110" ? ["042115"] : undefined) });
  assert.equal((await ask(svc, "4110", NAIC)).status, "ok");
  assert.equal((await ask(svc, "4135", NAIC)).status, "mismatch");
  assert.deepEqual((await svc.zipsFor("042115000")).zips, ["4110"]);
  assert.equal(api.calls.length, 0, "such a city is answered without asking the API");
});

test("other cities are not affected by that file", async () => {
  const api = makeFakeZipApi({ mode: "down" });
  const svc = createPostalService({ fetchImpl: api.fetchImpl, extras: {} });
  const cal = await svc.zipsFor("137501000");
  assert.equal(cal.source, "table");
  assert.ok(cal.zips.includes("1400") && cal.zips.length > 1);
  assert.equal((await ask(svc, "1400")).status, "ok");
});