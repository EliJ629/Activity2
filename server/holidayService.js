// Philippine nationwide holidays, as declared by the government, served by GET /api/holidays?year=YYYY
//
// Why this is a data file and not a holiday API: the holidays of the Philippines are not a rule. Every year the President
// declares them by proclamation, and then changes them: in 2024 Ninoy Aquino Day was moved from August 21 to the 23rd, in 2023
// April 9 and November 30 were moved to Mondays, in 2026 All Souls' Day is a day off while the EDSA anniversary is a working day,
// and the Eid dates are proclaimed separately each year. The services checked for this app got it wrong:
//   * Nager.Date (what the app used before) has no Philippine data outside a few entries hard-coded for 2025 (see its
//     PhilippinesHolidayProvider.cs): no All Souls' Day, no Eid, no Black Saturday for 2026, and so on;
//   * Calendarific and similar mix in observances (the June solstice) and mislabel the government's categories;
//   * the Official Gazette, which publishes the real lists, blocks automated requests.
// So the lists in server/holiday-data/ph-holidays.json are copied from the proclamations, year by year (2020-2027), and test/
// holidays.test.js checks every date against the weekdays and rules the proclamations themselves state.
//
// What is still fetched live: for a year whose Eid'l Fitr / Eid'l Adha proclamation has not been issued yet (2027 at the time of
// writing), the expected dates are looked up from the Aladhan Hijri calendar API and marked "expected". Every other year is
// answered from the file, so nothing here depends on an outside service being up.
//
// To add a year, or when a new proclamation moves or adds a day: edit server/holiday-data/ph-holidays.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(HERE, "holiday-data", "ph-holidays.json");
const HIJRI_API = "https://api.aladhan.com/v1/hToG";
const TYPES = ["regular", "special", "islamic"];

// the two holidays whose dates are proclaimed separately every year (first day of Shawwal, tenth of Dhu al-Hijjah)
const ISLAMIC = {
  fitr: { name: "Eid'l Fitr (Feast of Ramadhan)", hMonth: 10, hDay: 1 },
  adha: { name: "Eid'l Adha (Feast of Sacrifice)", hMonth: 12, hDay: 10 },
};

export function loadHolidayData(file = DATA_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!raw || typeof raw.years !== "object") throw new Error(`${file} has no "years"`);
  return raw.years;
}

// Fail at startup, not on someone's first visit to the holidays tab, if the file is missing or damaged
export function assertHolidayDataReady() {
  const years = loadHolidayData();
  for (const [year, y] of Object.entries(years)) {
    if (!Array.isArray(y.holidays) || y.holidays.length < 10) throw new Error(`server/holiday-data/ph-holidays.json: year ${year} looks wrong`);
    for (const [date, name, type] of y.holidays) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(`${year}-`) || !name || !TYPES.includes(type)) {
        throw new Error(`server/holiday-data/ph-holidays.json: bad entry in ${year}: ${JSON.stringify([date, name, type])}`);
      }
    }
  }
}

const byDate = (a, b) => a.date.localeCompare(b.date) || TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || a.name.localeCompare(b.name);

export function createHolidayService({
  data = loadHolidayData(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 4000,
  cacheMs = 24 * 60 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  const expectedCache = new Map();   // "2027:fitr" -> { at, date }
  const inflight = new Map();
  let pausedUntil = 0;

  // "20-03-2026" -> "2026-03-20"
  async function hijriToGregorian(day, month, hijriYear) {
    const res = await fetchImpl(`${HIJRI_API}/${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${hijriYear}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Hijri API ${res.status}`);
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((await res.json())?.data?.gregorian?.date || "");
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }

  // The Gregorian date, in `year`, of an Islamic holiday; null when the API can't say (the holiday is then simply not shown)
  function expectedDate(year, key) {
    const id = `${year}:${key}`;
    const hit = expectedCache.get(id);
    if (hit && now() - hit.at < cacheMs) return Promise.resolve(hit.date);
    if (inflight.has(id)) return inflight.get(id);
    if (now() < pausedUntil) return Promise.resolve(null);
    const p = (async () => {
      const { hMonth, hDay } = ISLAMIC[key];
      const guess = Math.floor((year - 621.5708) * 1.030684);             // approximate Hijri year
      try {
        for (const hy of [guess, guess + 1]) {
          const date = await hijriToGregorian(hDay, hMonth, hy);
          if (date && date.startsWith(`${year}-`)) { expectedCache.set(id, { at: now(), date }); return date; }
        }
        return null;
      } catch {
        pausedUntil = now() + 60 * 1000;                                   // leave the API alone for a minute after a failure
        return null;
      }
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  return {
    years: () => Object.keys(data).map(Number).sort((a, b) => a - b),

    // -> null when there is no list for that year
    async forYear(year) {
      const y = data[String(year)];
      if (!y) return null;
      const holidays = y.holidays.map(([date, name, type]) => ({ date, name, type }));
      const pending = (y.pending || []).filter((k) => ISLAMIC[k]);
      for (const key of pending) {
        const date = await expectedDate(Number(year), key);
        if (date) holidays.push({ date, name: ISLAMIC[key].name, type: "islamic", expected: true });
      }
      return {
        year: Number(year),
        source: "proclamations",
        proclamation: y.proclamation || "",
        pending: pending.map((k) => ISLAMIC[k].name),     // declared later, by separate proclamation
        holidays: holidays.sort(byDate),
      };
    },
  };
}