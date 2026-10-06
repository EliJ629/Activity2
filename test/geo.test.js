import test from "node:test";
import assert from "node:assert/strict";
import { createGeoService } from "../server/geo.js";
import { makeFakeGeoApi, FAKE_KEY } from "./fakeGeoApi.js";

const make = (apiOpts = {}, opts = {}) => {
  const api = makeFakeGeoApi(apiOpts);
  const logged = [];
  const svc = createGeoService({ apiKey: FAKE_KEY, fetchImpl: api.fetchImpl, log: (m) => logged.push(m), ...opts });
  return { api, svc, logged };
};

test("states of a country: code and name, sorted, asked for with the key (and only of the right host)", async () => {
  const { api, svc } = make();
  const r = await svc.states("US");
  assert.equal(r.available, true);
  assert.deepEqual(r.states, [{ code: "CA", name: "California" }, { code: "NY", name: "New York" }, { code: "TX", name: "Texas" }]);
  assert.deepEqual(api.calls.map((c) => c.path), ["/countries/US/states"]);
  assert.equal(api.calls[0].key, FAKE_KEY);
  assert.equal(api.calls[0].host, "api.countrystatecity.in");
  assert.equal(api.calls[0].accept, "application/json");
});

test("cities of a state: sorted, and a name listed twice is shown once", async () => {
  const { svc } = make();
  const r = await svc.cities("US", "CA");
  assert.equal(r.available, true);
  assert.deepEqual(r.cities.map((c) => c.name), ["Los Angeles", "San Francisco", "San Jose"]);
  assert.deepEqual((await svc.cities("US", "TX")).cities.map((c) => c.name), ["Austin", "Dallas", "O'Fallon", "St. Louis"]);
});

test("awkward real place names come through untouched", async () => {
  const { svc } = make();
  assert.equal((await svc.states("IT")).states[0].name, "Friuli\u2013Venezia Giulia");
  assert.equal((await svc.cities("AU", "SA")).cities.find((c) => c.name.includes("/")).name, "Orroroo/Carrieton");
  assert.equal((await svc.cities("AF", "BDS")).cities[0].name.startsWith("\u2018"), true);
});

test("the API may wrap the list as { data: [...] }; that works too", async () => {
  const { svc } = make({ mode: "envelope" });
  assert.equal((await svc.states("US")).states.length, 3);
});

test("a country with no states, or one the API doesn't know, is 'available' but empty (the form then lets people type)", async () => {
  const { svc } = make();
  assert.deepEqual(await svc.states("VA"), { available: true, states: [] });
  assert.deepEqual(await svc.states("ZZ"), { available: true, states: [] });          // 404 "Country not found"
  assert.deepEqual(await svc.cities("US", "ZZ"), { available: true, cities: [] });    // 404 "State not found"
});

test("no key: nothing is asked of the API and the answer says so", async () => {
  const api = makeFakeGeoApi();
  const svc = createGeoService({ apiKey: "", fetchImpl: api.fetchImpl });
  assert.equal(svc.configured, false);
  assert.deepEqual(await svc.states("US"), { available: false, states: [] });
  assert.deepEqual(await svc.cities("US", "CA"), { available: false, cities: [] });
  assert.equal(api.calls.length, 0);
});

test("every way the API can fail leads to 'not available', never an error", async () => {
  for (const mode of ["down", "401", "403", "429", "500", "html", "wrongshape"]) {
    const { svc } = make({ mode });
    assert.deepEqual(await svc.states("US"), { available: false, states: [] }, mode);
    assert.deepEqual(await svc.cities("US", "CA"), { available: false, cities: [] }, mode);
  }
});

test("after a failure the API is left alone for a while (longer for a refused key or a used-up quota), then tried again", async () => {
  let clock = 1_000_000;
  for (const [mode, pauseMs] of [["down", 60_000], ["500", 60_000], ["429", 600_000], ["401", 600_000], ["403", 600_000]]) {
    const down = makeFakeGeoApi({ mode });
    const up = makeFakeGeoApi();
    let current = down;
    const svc = createGeoService({ apiKey: FAKE_KEY, fetchImpl: (...a) => current.fetchImpl(...a), now: () => clock, log: () => {} });
    assert.equal((await svc.states("US")).available, false, mode);
    const first = down.calls.length;
    await svc.states("GB"); await svc.states("IT");
    assert.equal(down.calls.length, first, `${mode}: no more calls while paused`);
    clock += pauseMs - 1000;
    await svc.states("GB");
    assert.equal(down.calls.length, first, `${mode}: still paused just before the end`);
    clock += 2000; current = up;                                 // the pause is over and the API is back
    assert.equal((await svc.states("US")).available, true, mode);
  }
});

test("a refused key is reported once, clearly", async () => {
  let clock = 0;
  const { api, logged } = make({ mode: "401" }, { now: () => clock });
  const svc = createGeoService({ apiKey: "wrong", fetchImpl: api.fetchImpl, now: () => clock, log: (m) => logged.push(m) });
  await svc.states("US"); clock += 700_000; await svc.states("US"); clock += 700_000; await svc.states("US");
  assert.equal(logged.length, 1);
  assert.match(logged[0], /refused the request \(HTTP 401\).*CSC_API_KEY/);
});

test("answers are remembered for a day, parallel requests share one call, and failures are not remembered", async () => {
  let clock = 5_000_000;
  const api = makeFakeGeoApi();
  const svc = createGeoService({ apiKey: FAKE_KEY, fetchImpl: api.fetchImpl, now: () => clock });
  await Promise.all([svc.states("US"), svc.states("US"), svc.states("US")]);
  assert.equal(api.calls.length, 1);
  await svc.states("US");
  assert.equal(api.calls.length, 1);                              // remembered
  clock += 24 * 3600 * 1000 + 1;
  await svc.states("US");
  assert.equal(api.calls.length, 2);                              // a day later: asked again

  let current = makeFakeGeoApi({ mode: "down" });
  const flaky = createGeoService({ apiKey: FAKE_KEY, fetchImpl: (...a) => current.fetchImpl(...a), now: () => clock, log: () => {} });
  assert.equal((await flaky.states("GB")).available, false);
  clock += 61_000; current = makeFakeGeoApi();
  assert.equal((await flaky.states("GB")).available, true);       // the earlier failure wasn't kept
});
