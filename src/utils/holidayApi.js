/* ===== utils/holidayApi.js ===== */
// Philippine holidays of one year, from this app's own API: GET /api/holidays?year=YYYY
//
// The server answers with the holidays the government declared for that year (regular holidays, special non-working days,
// Eid'l Fitr and Eid'l Adha), after every later proclamation that moved or added a day. For a year whose Eid proclamation is
// still to come, the server adds expected dates calculated from the Hijri calendar and marks them "expected".
//
// Every holiday is classified as:
//   Regular  - Regular Holiday
//   Special  - Special Non-Working Day
//   Islamic  - Islamic Holiday (Eid'l Fitr, Eid'l Adha)

import { api } from "../api.js";

export const HOLIDAY_TYPES = {
  Regular: { label: "Regular Holiday", plural: "Regular Holidays" },
  Special: { label: "Special Non-Working Day", plural: "Special Non-Working Days" },
  Islamic: { label: "Islamic Holiday", plural: "Islamic Holidays" },
};

const TYPE_OF = { regular: "Regular", special: "Special", islamic: "Islamic" };
const holidayCache = {};

// Returns { holidays: [{ month, day, name, type, expected }], source: "proclamations" | "error", proclamation, pending }
export async function loadHolidays(year) {
  if (holidayCache[year]) return holidayCache[year];
  try {
    const r = await api(`/holidays?year=${encodeURIComponent(year)}`);
    const holidays = r.holidays
      .map(({ date, name, type, expected }) => {
        const [, month, day] = date.split("-").map(Number);       // "2026-03-20"
        return { month, day, name, type: TYPE_OF[type] || "Special", expected: Boolean(expected) };
      })
      .sort((a, b) => a.month - b.month || a.day - b.day);
    const result = { holidays, source: "proclamations", proclamation: r.proclamation || "", pending: r.pending || [] };
    if (!result.pending.length) holidayCache[year] = result;       // a year still waiting for Eid proclamations is asked for again later
    return result;
  } catch {
    return { holidays: [], source: "error", proclamation: "", pending: [] };   // not cached: the next pick of the year tries again
  }
}