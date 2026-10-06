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
// Eid'l Fitr and Eid'l Adha of a year whose proclamation has not been issued yet (2027 at the time of writing) are reported as
// "pending": the date is declared by the President after the moon sighting, so no date is guessed for them.
//
// Each entry in the file is [date, name, type, note?]. type is regular | special | islamic; the optional note says where a day was
// moved from, or that it is a regional Muslim holiday. To add a year, or when a new proclamation moves or adds a day: edit
// server/holiday-data/ph-holidays.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(HERE, "holiday-data", "ph-holidays.json");
const TYPES = ["regular", "special", "islamic"];

// the two holidays whose dates are proclaimed separately every year
const PENDING = {
  fitr: "Eid'l Fitr (Feast of Ramadhan)",
  adha: "Eid'l Adha (Feast of Sacrifice)",
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
    for (const entry of y.holidays) {
      const [date, name, type, note] = entry;
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(date) && date.startsWith(`${year}-`) && name && TYPES.includes(type) && entry.length <= 4 && (note === undefined || typeof note === "string");
      if (!ok) throw new Error(`server/holiday-data/ph-holidays.json: bad entry in ${year}: ${JSON.stringify(entry)}`);
    }
    for (const key of y.pending || []) if (!PENDING[key]) throw new Error(`server/holiday-data/ph-holidays.json: unknown pending holiday "${key}" in ${year}`);
  }
}

const byDate = (a, b) => a.date.localeCompare(b.date) || TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || a.name.localeCompare(b.name);

export function createHolidayService({ data = loadHolidayData() } = {}) {
  return {
    years: () => Object.keys(data).map(Number).sort((a, b) => a - b),

    // -> null when there is no list for that year
    async forYear(year) {
      const y = data[String(year)];
      if (!y) return null;
      const holidays = y.holidays.map(([date, name, type, note]) => (note ? { date, name, type, note } : { date, name, type })).sort(byDate);
      return {
        year: Number(year),
        source: "proclamations",
        proclamation: y.proclamation || "",
        pending: (y.pending || []).map((k) => PENDING[k]),     // declared later, by separate proclamation: no date yet
        holidays,
      };
    },
  };
}