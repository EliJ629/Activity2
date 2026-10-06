import test from "node:test";
import assert from "node:assert/strict";
import { createHolidayService, loadHolidayData, assertHolidayDataReady } from "../server/holidayService.js";
import { makeFakeAladhan } from "./fakeAladhan.js";

const data = loadHolidayData();
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027];
const all = (year) => data[year].holidays.map(([date, name, type]) => ({ date, name, type }));
const has = (year, date, name) => all(year).some((h) => h.date === date && (!name || h.name === name));
const names = (year, type) => all(year).filter((h) => h.type === type).map((h) => h.name);

// Easter Sunday (anonymous Gregorian algorithm), as an ISO date shifted by `plus` days
function easter(year, plus = 0) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  const dt = new Date(Date.UTC(year, month - 1, day + plus));
  return dt.toISOString().slice(0, 10);
}
const lastMonday = (year, month) => { const d = new Date(Date.UTC(year, month, 0)); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

/* ---------- the file itself ---------- */

test("the holiday file passes its startup check and has every year from 2020 to 2027", () => {
  assertHolidayDataReady();
  assert.deepEqual(Object.keys(data).map(Number).sort(), YEARS);
  for (const y of YEARS) assert.ok(data[y].proclamation.startsWith("Proclamation No."), `year ${y} names its proclamation`);
});

test("every entry is a real date inside its year, with a name and a known type, and nothing is listed twice", () => {
  for (const y of YEARS) {
    const seen = new Set();
    for (const { date, name, type } of all(y)) {
      assert.ok(date.startsWith(`${y}-`) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date, `${y} ${date}`);
      assert.ok(name.length > 2 && ["regular", "special", "islamic"].includes(type), `${y} ${date} ${name}`);
      assert.ok(!seen.has(`${date}|${name}`), `${y}: ${date} ${name} listed twice`);
      seen.add(`${date}|${name}`);
    }
  }
});

// Each of these is a date, with the weekday the Official Gazette / the proclamation / the Palace release prints next to it
const STATED = `2020-01-01 Wed|2020-01-25 Sat|2020-02-25 Tue|2020-04-09 Thu|2020-05-01 Fri|2020-05-25 Mon|2020-06-12 Fri|2020-07-31 Fri|2020-08-21 Fri|2020-08-31 Mon|2020-11-01 Sun|2020-11-02 Mon|2020-11-30 Mon|2020-12-08 Tue|2020-12-24 Thu|2020-12-25 Fri|2020-12-30 Wed|2020-12-31 Thu
|2021-01-01 Fri|2021-02-12 Fri|2021-02-25 Thu|2021-04-09 Fri|2021-05-01 Sat|2021-05-13 Thu|2021-06-12 Sat|2021-07-20 Tue|2021-08-21 Sat|2021-08-30 Mon|2021-11-01 Mon|2021-11-02 Tue|2021-11-30 Tue|2021-12-08 Wed|2021-12-24 Fri|2021-12-25 Sat|2021-12-30 Thu|2021-12-31 Fri
|2022-01-01 Sat|2022-02-01 Tue|2022-02-25 Fri|2022-04-09 Sat|2022-05-01 Sun|2022-05-03 Tue|2022-05-09 Mon|2022-06-12 Sun|2022-07-09 Sat|2022-08-21 Sun|2022-08-29 Mon|2022-10-31 Mon|2022-11-01 Tue|2022-11-30 Wed|2022-12-08 Thu|2022-12-25 Sun|2022-12-30 Fri
|2023-01-01 Sun|2023-01-02 Mon|2023-02-24 Fri|2023-04-10 Mon|2023-04-21 Fri|2023-05-01 Mon|2023-06-12 Mon|2023-06-28 Wed|2023-08-21 Mon|2023-08-28 Mon|2023-10-30 Mon|2023-11-01 Wed|2023-11-02 Thu|2023-11-27 Mon|2023-12-08 Fri|2023-12-25 Mon|2023-12-26 Tue|2023-12-30 Sat|2023-12-31 Sun
|2024-01-01 Mon|2024-02-09 Fri|2024-02-10 Sat|2024-04-09 Tue|2024-04-10 Wed|2024-05-01 Wed|2024-06-12 Wed|2024-06-17 Mon|2024-08-23 Fri|2024-08-26 Mon|2024-11-01 Fri|2024-11-02 Sat|2024-11-30 Sat|2024-12-08 Sun|2024-12-24 Tue|2024-12-25 Wed|2024-12-30 Mon|2024-12-31 Tue
|2025-01-01 Wed|2025-01-29 Wed|2025-04-01 Tue|2025-04-09 Wed|2025-05-01 Thu|2025-05-12 Mon|2025-06-06 Fri|2025-06-12 Thu|2025-07-27 Sun|2025-08-21 Thu|2025-08-25 Mon|2025-10-31 Fri|2025-11-01 Sat|2025-11-30 Sun|2025-12-08 Mon|2025-12-24 Wed|2025-12-25 Thu|2025-12-30 Tue|2025-12-31 Wed
|2026-01-01 Thu|2026-02-17 Tue|2026-03-20 Fri|2026-04-09 Thu|2026-05-01 Fri|2026-05-27 Wed|2026-06-12 Fri|2026-08-21 Fri|2026-08-31 Mon|2026-11-01 Sun|2026-11-02 Mon|2026-11-30 Mon|2026-12-08 Tue|2026-12-24 Thu|2026-12-25 Fri|2026-12-30 Wed|2026-12-31 Thu
|2027-01-01 Fri|2027-02-06 Sat|2027-04-09 Fri|2027-05-01 Sat|2027-06-12 Sat|2027-08-21 Sat|2027-08-30 Mon|2027-11-01 Mon|2027-11-02 Tue|2027-11-30 Tue|2027-12-08 Wed|2027-12-24 Fri|2027-12-25 Sat|2027-12-30 Thu|2027-12-31 Fri`
  .split("|").map((s) => s.trim().split(/\s+/));

test("every date the government printed with a weekday is in the file, on that weekday (catches any typo)", () => {
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  assert.equal(STATED.length, 141);
  for (const [date, wd] of STATED) {
    const y = Number(date.slice(0, 4));
    assert.ok(has(y, date), `${date} should be a holiday`);
    assert.equal(WD[new Date(`${date}T00:00:00Z`).getUTCDay()], wd, date);
  }
});

/* ---------- the legal rules ---------- */

test("Holy Week follows Easter, and National Heroes Day is the last Monday of August, in every year", () => {
  for (const y of YEARS) {
    assert.ok(has(y, easter(y, -3), "Maundy Thursday"), `${y} Maundy Thursday ${easter(y, -3)}`);
    assert.ok(has(y, easter(y, -2), "Good Friday"), `${y} Good Friday`);
    assert.ok(has(y, easter(y, -1), "Black Saturday"), `${y} Black Saturday`);
    assert.ok(has(y, lastMonday(y, 8), "National Heroes Day"), `${y} National Heroes Day ${lastMonday(y, 8)}`);
  }
});

test("the holidays fixed by law are on their dates, except where the government moved them", () => {
  const MOVED = { "04-09": { 2023: "2023-04-10" }, "11-30": { 2023: "2023-11-27" }, "08-21": { 2024: "2024-08-23" } };   // Araw ng Kagitingan, Bonifacio Day, Ninoy Aquino Day
  const fixed = [["01-01", "New Year's Day"], ["04-09", "Araw ng Kagitingan"], ["05-01", "Labor Day"], ["06-12", "Independence Day"], ["11-30", "Bonifacio Day"], ["12-25", "Christmas Day"], ["12-30", "Rizal Day"],
    ["08-21", "Ninoy Aquino Day"], ["11-01", "All Saints' Day"], ["12-08", "Feast of the Immaculate Conception of Mary"]];
  for (const y of YEARS) {
    for (const [md, name] of fixed) {
      const date = MOVED[md]?.[y] || `${y}-${md}`;
      assert.ok(has(y, date, name), `${y} ${name} on ${date}`);
      if (MOVED[md]?.[y]) assert.ok(!has(y, `${y}-${md}`, name), `${y} ${name} is NOT on ${y}-${md} (it was moved)`);
    }
  }
});

test("Regular holidays are exactly the ten fixed by law; Eid'l Fitr and Eid'l Adha are the Islamic ones", () => {
  for (const y of YEARS) {
    assert.deepEqual(names(y, "regular").sort(), ["Araw ng Kagitingan", "Bonifacio Day", "Christmas Day", "Good Friday", "Independence Day", "Labor Day", "Maundy Thursday", "National Heroes Day", "New Year's Day", "Rizal Day"], `${y}`);
    // 2027's Eid proclamations have not been issued yet, so that year has none in the file (the service adds expected dates)
    const islamic = all(y).filter((h) => h.type === "islamic").sort((a, b) => a.date.localeCompare(b.date)).map((h) => h.name);
    assert.deepEqual(islamic, y === 2027 ? [] : ["Eid'l Fitr (Feast of Ramadhan)", "Eid'l Adha (Feast of Sacrifice)"], `${y} Islamic holidays`);
  }
  assert.deepEqual(data[2027].pending, ["fitr", "adha"]);
  for (const y of YEARS.slice(0, 7)) assert.deepEqual(data[y].pending, [], `${y} has no pending Eid`);
});

/* ---------- what the old list got wrong ---------- */

test("2026: All Souls' Day is a day off, and the EDSA anniversary (a special WORKING day) is not listed", () => {
  assert.ok(has(2026, "2026-11-02", "All Souls' Day"));
  assert.ok(!all(2026).some((h) => h.date === "2026-02-25"));
  assert.ok(has(2026, "2026-03-20", "Eid'l Fitr (Feast of Ramadhan)") && has(2026, "2026-05-27", "Eid'l Adha (Feast of Sacrifice)"));
  assert.ok(has(2026, "2026-02-17", "Chinese New Year") && has(2026, "2026-04-04", "Black Saturday") && has(2026, "2026-12-24", "Christmas Eve"));
  assert.equal(all(2026).length, 20);                                                    // 10 regular + 2 Eid + 8 special
});

test("2022: November 2, December 24 and December 31 were special WORKING days, so they are not listed; the election day and October 31 are", () => {
  for (const d of ["2022-11-02", "2022-12-24", "2022-12-31"]) assert.ok(!all(2022).some((h) => h.date === d), d);
  assert.ok(has(2022, "2022-05-09", "National and Local Elections") && has(2022, "2022-10-31"));
});

test("moved and added days are the final ones: Ninoy Aquino Day 2024 on Aug 23, 2023's extra days, 2025's election day and July 27", () => {
  assert.ok(has(2024, "2024-08-23", "Ninoy Aquino Day") && !has(2024, "2024-08-21"));
  assert.ok(has(2024, "2024-02-09") && has(2024, "2024-02-10", "Chinese New Year"));
  assert.ok(has(2023, "2023-01-02") && has(2023, "2023-10-30") && has(2023, "2023-12-26") && has(2023, "2023-02-24", "EDSA People Power Revolution Anniversary"));
  assert.ok(has(2025, "2025-05-12", "National and Local Elections") && has(2025, "2025-07-27") && has(2025, "2025-10-31", "All Saints' Day Eve"));
  assert.ok(!all(2025).some((h) => h.date === "2025-02-25"));
  assert.ok(has(2025, "2025-04-01", "Eid'l Fitr (Feast of Ramadhan)") && has(2025, "2025-06-06", "Eid'l Adha (Feast of Sacrifice)"));
});

test("2020: Araw ng Kagitingan and Maundy Thursday fall on the same day, and both are listed", () => {
  assert.ok(has(2020, "2020-04-09", "Araw ng Kagitingan") && has(2020, "2020-04-09", "Maundy Thursday"));
});

/* ---------- the service ---------- */

test("a year with every proclamation issued is answered from the file, with no outside call", async () => {
  const aladhan = makeFakeAladhan();
  const svc = createHolidayService({ fetchImpl: aladhan.fetchImpl });
  const r = await svc.forYear(2026);
  assert.equal(r.year, 2026);
  assert.equal(r.source, "proclamations");
  assert.match(r.proclamation, /Proclamation No\. 1006/);
  assert.deepEqual(r.pending, []);
  assert.equal(r.holidays.length, 20);
  assert.equal(r.holidays.filter((h) => h.type === "regular").length, 10);
  assert.equal(r.holidays.filter((h) => h.type === "special").length, 8);
  assert.equal(r.holidays.filter((h) => h.type === "islamic").length, 2);
  assert.ok(!r.holidays.some((h) => h.expected));
  assert.deepEqual(r.holidays.map((h) => h.date), [...r.holidays.map((h) => h.date)].sort());
  assert.equal(aladhan.calls.length, 0);
  assert.deepEqual(svc.years(), YEARS);
});

test("a year with no list gives null", async () => {
  const svc = createHolidayService({ fetchImpl: makeFakeAladhan().fetchImpl });
  for (const y of [2019, 2028, 1999, 0]) assert.equal(await svc.forYear(y), null);
});

test("2027: the Eid proclamations are pending, so their expected dates are looked up from the Hijri calendar and marked as expected", async () => {
  const aladhan = makeFakeAladhan();
  const svc = createHolidayService({ fetchImpl: aladhan.fetchImpl });
  const r = await svc.forYear(2027);
  assert.deepEqual(r.pending, ["Eid'l Fitr (Feast of Ramadhan)", "Eid'l Adha (Feast of Sacrifice)"]);
  const expected = r.holidays.filter((h) => h.expected);
  assert.equal(expected.length, 2);
  assert.ok(expected.every((h) => h.type === "islamic"));
  const [fitr, adha] = [expected.find((h) => /Fitr/.test(h.name)), expected.find((h) => /Adha/.test(h.name))];
  assert.ok(fitr.date >= "2027-03-08" && fitr.date <= "2027-03-11", fitr.date);       // 1 Shawwal 1448: around 9-10 March 2027
  assert.ok(adha.date >= "2027-05-15" && adha.date <= "2027-05-18", adha.date);       // 10 Dhu al-Hijjah 1448: around 16-17 May 2027
  assert.equal(r.holidays.length, 18 + 2);
  assert.ok(aladhan.calls.length >= 2);
});

test("expected Eid dates are asked for once a day, then remembered", async () => {
  let clock = 1_000_000;
  const aladhan = makeFakeAladhan();
  const svc = createHolidayService({ fetchImpl: aladhan.fetchImpl, now: () => clock });
  await svc.forYear(2027);
  const first = aladhan.calls.length;
  await svc.forYear(2027); await svc.forYear(2027);
  assert.equal(aladhan.calls.length, first);
  clock += 24 * 3600 * 1000 + 1;
  await svc.forYear(2027);
  assert.ok(aladhan.calls.length > first);
});

test("when the Hijri calendar API is down or answers nonsense, the year is still served, with the Eid days listed as pending", async () => {
  for (const mode of ["down", "500", "garbage"]) {
    const svc = createHolidayService({ fetchImpl: makeFakeAladhan({ mode }).fetchImpl });
    const r = await svc.forYear(2027);
    assert.equal(r.holidays.length, 18, mode);
    assert.ok(!r.holidays.some((h) => h.type === "islamic"), mode);
    assert.equal(r.pending.length, 2, mode);
  }
});

test("after a failure the Hijri API is left alone for a minute, then tried again", async () => {
  let clock = 5_000_000;
  const down = makeFakeAladhan({ mode: "down" });
  let current = down;
  const svc = createHolidayService({ fetchImpl: (...a) => current.fetchImpl(...a), now: () => clock });
  await svc.forYear(2027);
  const calls = down.calls.length;
  await svc.forYear(2027);
  assert.equal(down.calls.length, calls);                       // paused
  clock += 61_000; current = makeFakeAladhan();
  assert.equal((await svc.forYear(2027)).holidays.filter((h) => h.expected).length, 2);
});

test("a damaged or missing file is caught at startup", () => {
  assert.throws(() => loadHolidayData("/nonexistent/ph-holidays.json"));
});
