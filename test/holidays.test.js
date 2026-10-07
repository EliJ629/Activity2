import test from "node:test";
import assert from "node:assert/strict";
import { createHolidayService, loadHolidayData, assertHolidayDataReady } from "../server/holidayService.js";

const data = loadHolidayData();
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027];
const all = (year) => data[year].holidays.map(([date, name, type, note]) => ({ date, name, type, note }));
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
|2021-01-01 Fri|2021-02-12 Fri|2021-02-25 Thu|2021-04-09 Fri|2021-05-01 Sat|2021-05-13 Thu|2021-06-12 Sat|2021-07-20 Tue|2021-08-21 Sat|2021-08-30 Mon|2021-11-01 Mon|2021-11-30 Tue|2021-12-08 Wed|2021-12-25 Sat|2021-12-30 Thu
|2022-01-01 Sat|2022-02-01 Tue|2022-02-25 Fri|2022-04-09 Sat|2022-05-01 Sun|2022-05-03 Tue|2022-05-09 Mon|2022-06-12 Sun|2022-07-09 Sat|2022-08-21 Sun|2022-08-29 Mon|2022-10-31 Mon|2022-11-01 Tue|2022-11-30 Wed|2022-12-08 Thu|2022-12-25 Sun|2022-12-30 Fri
|2023-01-01 Sun|2023-01-02 Mon|2023-02-24 Fri|2023-04-10 Mon|2023-04-21 Fri|2023-05-01 Mon|2023-06-12 Mon|2023-06-28 Wed|2023-08-21 Mon|2023-08-28 Mon|2023-10-30 Mon|2023-11-01 Wed|2023-11-02 Thu|2023-11-27 Mon|2023-12-08 Fri|2023-12-25 Mon|2023-12-26 Tue|2023-12-30 Sat|2023-12-31 Sun
|2024-01-01 Mon|2024-02-09 Fri|2024-02-10 Sat|2024-04-09 Tue|2024-04-10 Wed|2024-05-01 Wed|2024-06-12 Wed|2024-06-17 Mon|2024-08-23 Fri|2024-08-26 Mon|2024-11-01 Fri|2024-11-02 Sat|2024-11-30 Sat|2024-12-08 Sun|2024-12-24 Tue|2024-12-25 Wed|2024-12-30 Mon|2024-12-31 Tue
|2025-01-01 Wed|2025-01-29 Wed|2025-04-01 Tue|2025-04-09 Wed|2025-05-01 Thu|2025-05-12 Mon|2025-06-06 Fri|2025-06-12 Thu|2025-07-27 Sun|2025-08-21 Thu|2025-08-25 Mon|2025-10-31 Fri|2025-11-01 Sat|2025-11-02 Sun|2025-11-30 Sun|2025-12-08 Mon|2025-12-24 Wed|2025-12-25 Thu|2025-12-30 Tue|2025-12-31 Wed
|2026-01-01 Thu|2026-02-17 Tue|2026-03-20 Fri|2026-04-09 Thu|2026-05-01 Fri|2026-05-27 Wed|2026-06-12 Fri|2026-08-21 Fri|2026-08-31 Mon|2026-11-01 Sun|2026-11-02 Mon|2026-11-30 Mon|2026-12-08 Tue|2026-12-24 Thu|2026-12-25 Fri|2026-12-30 Wed|2026-12-31 Thu
|2027-01-01 Fri|2027-02-06 Sat|2027-04-09 Fri|2027-05-01 Sat|2027-06-12 Sat|2027-08-21 Sat|2027-08-30 Mon|2027-11-01 Mon|2027-11-02 Tue|2027-11-30 Tue|2027-12-08 Wed|2027-12-24 Fri|2027-12-25 Sat|2027-12-30 Thu|2027-12-31 Fri`
  .split("|").map((s) => s.trim().split(/\s+/));

test("every date the government printed with a weekday is in the file, on that weekday (catches any typo)", () => {
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  assert.equal(STATED.length, 139);
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

test("Regular holidays are exactly the ten fixed by law; the Islamic holidays are Eid'l Fitr and Eid'l Adha", () => {
  const EIDS = ["Eid'l Fitr (Feast of Ramadhan)", "Eid'l Adha (Feast of Sacrifice)"];
  for (const y of YEARS) {
    assert.deepEqual(names(y, "regular").sort(), ["Araw ng Kagitingan", "Bonifacio Day", "Christmas Day", "Good Friday", "Independence Day", "Labor Day", "Maundy Thursday", "National Heroes Day", "New Year's Day", "Rizal Day"], `${y}`);
    // 2027's Eid proclamations have not been issued yet, so that year has none in the file: they are pending, with no date
    const islamic = all(y).filter((h) => h.type === "islamic").sort((a, b) => a.date.localeCompare(b.date)).map((h) => h.name);
    assert.deepEqual(islamic, y === 2027 ? [] : EIDS, `${y} Islamic holidays`);
  }
  assert.deepEqual(data[2027].pending, ["fitr", "adha"]);
  for (const y of YEARS.slice(0, 7)) assert.deepEqual(data[y].pending, [], `${y} has no pending Eid`);
});

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

test("a year with every proclamation issued is answered from the file", async () => {
  const svc = createHolidayService();
  const r = await svc.forYear(2026);
  assert.equal(r.year, 2026);
  assert.equal(r.source, "proclamations");
  assert.match(r.proclamation, /Proclamation No\. 1006/);
  assert.deepEqual(r.pending, []);
  assert.equal(r.holidays.length, 20);
  assert.equal(r.holidays.filter((h) => h.type === "regular").length, 10);
  assert.equal(r.holidays.filter((h) => h.type === "special").length, 8);
  assert.equal(r.holidays.filter((h) => h.type === "islamic").length, 2);
  assert.deepEqual(r.holidays.map((h) => h.date), [...r.holidays.map((h) => h.date)].sort());
  assert.deepEqual(svc.years(), YEARS);
});

test("a year with no list gives null", async () => {
  const svc = createHolidayService();
  for (const y of [2019, 2028, 1999, 0]) assert.equal(await svc.forYear(y), null);
});

test("2027: the Eid proclamations are pending, so Eid'l Fitr and Eid'l Adha are reported as pending and given no date", async () => {
  const r = await createHolidayService().forYear(2027);
  assert.deepEqual(r.pending, ["Eid'l Fitr (Feast of Ramadhan)", "Eid'l Adha (Feast of Sacrifice)"]);
  assert.equal(r.holidays.length, 18);
  assert.ok(!r.holidays.some((h) => h.type === "islamic"), "no guessed Eid dates");
  assert.ok(r.holidays.some((h) => h.date === "2027-11-02" && h.name === "All Souls' Day"));
  assert.match(r.proclamation, /Proclamation No\. 1427/);
});

test("a year with nothing pending reports no pending Islamic holidays", async () => {
  for (const y of YEARS.slice(0, 7)) assert.deepEqual((await createHolidayService().forYear(y)).pending, [], String(y));
});

test("All Souls' Day (November 2) is listed in 2020, 2023, 2024, 2025, 2026 and 2027, and not in 2021 and 2022 (special working days)", async () => {
  for (const y of [2020, 2023, 2024, 2025, 2026, 2027]) assert.ok(has(y, `${y}-11-02`, "All Souls' Day"), `${y}`);
  for (const y of [2021, 2022]) assert.ok(!all(y).some((h) => h.date === `${y}-11-02`), `${y}: November 2 was a special working day`);
  const sunday = all(2025).find((h) => h.date === "2025-11-02");
  assert.equal(sunday.type, "special");
  assert.match(sunday.note, /Sunday.*Proclamation No\. 727 itself names October 31 and November 1/);       // 2025 is listed, and says what it is
});

test("2021: Proclamation No. 1107 made November 2, December 24 and December 31 special WORKING days, so they are not listed (and neither are they in 2022)", async () => {
  for (const y of [2021, 2022]) {
    for (const md of ["11-02", "12-24", "12-31"]) assert.ok(!all(y).some((h) => h.date === `${y}-${md}`), `${y}-${md} is a working day`);
  }
  assert.match(data[2021].proclamation, /986.*amended by Proclamation No\. 1107/);
  assert.equal(all(2021).length, 18);
  assert.ok(has(2021, "2021-11-01", "All Saints' Day") && has(2021, "2021-12-08") && has(2021, "2021-12-25", "Christmas Day") && has(2021, "2021-12-30", "Rizal Day"));
  // the years that DO list them
  const years = (name) => YEARS.filter((y) => all(y).some((h) => h.name === name));
  assert.deepEqual(years("Christmas Eve"), [2020, 2024, 2025, 2026, 2027]);
  assert.deepEqual(years("Last Day of the Year"), [2020, 2023, 2024, 2025, 2026, 2027]);
});

test("each day the government moved says where it was first set", async () => {
  const note = (y, date) => all(y).find((h) => h.date === date)?.note || "";
  assert.match(note(2023, "2023-02-24"), /Moved from February 25 \(Saturday\) by Proclamation No\. 167/);      // EDSA anniversary
  assert.match(note(2023, "2023-04-10"), /Moved from April 9 \(Sunday\) by Proclamation No\. 90/);           // Araw ng Kagitingan
  assert.match(note(2023, "2023-11-27"), /Moved from November 30 .* Proclamation No\. 90/);                  // Bonifacio Day
  assert.match(note(2024, "2024-08-23"), /Moved from August 21/);
  assert.match(note(2023, "2023-04-21"), /Proclamation No\. 201/);                                          // Eid'l Fitr 2023
  assert.match(note(2026, "2026-03-20"), /Proclamation No\. 1189/);
  assert.match(note(2026, "2026-05-27"), /Proclamation No\. 1264/);
  assert.match(note(2025, "2025-07-27"), /Proclamation No\. 729/);
});

test("Eid'l Fitr 2025: the nationwide holiday is April 1 (Proclamation No. 839), and the note says the Muslim Eid'l Fitr was observed on March 31", async () => {
  const eid = all(2025).find((h) => h.name.startsWith("Eid'l Fitr"));
  assert.equal(eid.date, "2025-04-01");
  assert.equal(eid.type, "islamic");
  assert.match(eid.note, /Proclamation No\. 839/);
  assert.match(eid.note, /Muslim Eid'l Fitr was observed on Monday, March 31, 2025/);
  assert.match(data[2025].proclamation, /839/);
  assert.ok(!all(2025).some((h) => h.date === "2025-03-31"), "March 31 is a note on April 1, not a second holiday");
});

test("the 2024 and 2025 entries use the names asked for: the Chinese New Year bridge day and the INC anniversary", async () => {
  assert.ok(has(2024, "2024-02-09", "Additional Special Non-Working Day (Chinese New Year)"));
  assert.ok(has(2024, "2024-04-10", "Eid'l Fitr (Feast of Ramadhan)") && has(2024, "2024-06-17", "Eid'l Adha (Feast of Sacrifice)"));
  assert.ok(has(2025, "2025-07-27", "Iglesia ni Cristo (INC) Founding Anniversary"));
  assert.ok(has(2025, "2025-05-12", "National and Local Elections") && has(2025, "2025-10-31", "All Saints' Day Eve"));
  assert.ok(has(2025, "2025-04-01", "Eid'l Fitr (Feast of Ramadhan)") && has(2025, "2025-06-06", "Eid'l Adha (Feast of Sacrifice)"));
});

test("a damaged or missing file is caught at startup", () => {
  assert.throws(() => loadHolidayData("/nonexistent/ph-holidays.json"));
});

/* ---------- the browser's loader: the server first, the copy built into the page when the server can't answer ---------- */

let copyNo = 0;
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push(String(url)); return impl(String(url), opts); };
  try {
    const { loadHolidays } = await import(`../src/utils/holidayApi.js?copy=${++copyNo}`);   // a fresh copy: the loader keeps a cache
    await fn(loadHolidays, calls);
  } finally {
    globalThis.fetch = real;
  }
}
const asServer = (year) => new Response(JSON.stringify({ year, source: "proclamations", proclamation: data[year].proclamation, pending: [], holidays: all(year) }), { status: 200, headers: { "content-type": "application/json" } });
const notFound = () => new Response(JSON.stringify({ message: "Not found." }), { status: 404, headers: { "content-type": "application/json" } });

test("the loader asks the server for the year and uses its answer", async () => {
  await withFetch(async (url) => asServer(Number(/year=(\d{4})/.exec(url)[1])), async (loadHolidays, calls) => {
    const r = await loadHolidays(2026);
    assert.equal(r.source, "proclamations");
    assert.equal(r.status, 200);
    assert.equal(r.holidays.length, 20);
    assert.deepEqual(calls, ["/api/holidays?year=2026"]);
    await loadHolidays(2026);
    assert.equal(calls.length, 1);                                   // remembered
  });
});

test("when the server has no such route (an older server: 404), the page uses the copy built into it, and says which error", async () => {
  await withFetch(async () => notFound(), async (loadHolidays) => {
    const r = await loadHolidays(2026);
    assert.equal(r.source, "built-in");
    assert.equal(r.status, 404);
    assert.equal(r.holidays.length, 20);
    assert.ok(r.holidays.some((h) => h.month === 11 && h.day === 2 && h.name === "All Souls' Day" && h.type === "Special"));
    assert.ok(!r.holidays.some((h) => h.month === 2 && h.day === 25));
    assert.match(r.proclamation, /Proclamation No\. 1006/);
  });
});

test("the built-in copy is complete for every year, and a failing server is not the end for any of them", async () => {
  await withFetch(async () => new Response("oops", { status: 500 }), async (loadHolidays) => {
    for (const y of YEARS) {
      const r = await loadHolidays(y);
      assert.equal(r.source, "built-in", String(y));
      assert.equal(r.status, 500);
      assert.equal(r.holidays.length, data[y].holidays.length, String(y));
    }
    const r27 = await loadHolidays(2027);
    assert.deepEqual(r27.pending, ["Eid'l Fitr (Feast of Ramadhan)", "Eid'l Adha (Feast of Sacrifice)"]);   // no expected dates in the copy: the page says they are pending
    assert.ok(!r27.holidays.some((h) => h.type === "Islamic"));          // no guessed Eid dates
  });
});

test("when the server can't be reached at all the status is 0, and a year with no list has nothing to show", async () => {
  await withFetch(async () => { throw new TypeError("fetch failed"); }, async (loadHolidays) => {
    const r = await loadHolidays(2024);
    assert.equal(r.source, "built-in");
    assert.equal(r.status, 0);
    assert.ok(r.holidays.some((h) => h.month === 8 && h.day === 23 && h.name === "Ninoy Aquino Day"));
    const none = await loadHolidays(2030);
    assert.equal(none.source, "error");
    assert.deepEqual(none.holidays, []);
  });
});

test("the built-in copy is not kept: once the server answers again, its answer is used", async () => {
  let up = false;
  await withFetch(async () => (up ? asServer(2026) : notFound()), async (loadHolidays) => {
    assert.equal((await loadHolidays(2026)).source, "built-in");
    up = true;
    assert.equal((await loadHolidays(2026)).source, "proclamations");
  });
});

test("the built-in copy carries the notes too", async () => {
  await withFetch(async () => notFound(), async (loadHolidays) => {
    const r = await loadHolidays(2023);
    const araw = r.holidays.find((h) => h.month === 4 && h.day === 10 && h.name === "Araw ng Kagitingan");
    assert.match(araw.note, /Moved from April 9 \(Sunday\) by Proclamation No\. 90/);
    const r25 = await loadHolidays(2025);
    const souls = r25.holidays.find((h) => h.month === 11 && h.day === 2);
    assert.equal(souls.name, "All Souls' Day");
    assert.match(souls.note, /Proclamation No\. 727/);
  });
});