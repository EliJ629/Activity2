/* ===== utils/holidayApi.js ===== */
// Philippine holidays of one year, from this app's own API: GET /api/holidays?year=YYYY
//
// If the server can't answer (it is down, or it is an older version without this route), the page does not stay empty: it falls
// back to the copy of the same government lists that is built into the page (server/holiday-data/ph-holidays.json, bundled at
// build time), and says so, with the error code.
//
// The server answers with the holidays the government declared for that year (regular holidays, special non-working days,
// Eid'l Fitr and Eid'l Adha), after every later proclamation that moved or added a day. For a year whose Eid proclamation is
// still to come (2027 at the moment), the answer lists them as "pending": no date is guessed for them.
//
// Every holiday is classified as:
//   Regular  - Regular Holiday
//   Special  - Special Non-Working Day
//   Islamic  - Islamic Holiday (Eid'l Fitr, Eid'l Adha)

import { api } from "../api.js";
import HOLIDAY_FILE from "../../server/holiday-data/ph-holidays.json" with { type: "json" };

export const HOLIDAY_TYPES = {
  Regular: { label: "Regular Holiday", plural: "Regular Holidays" },
  Special: { label: "Special Non-Working Day", plural: "Special Non-Working Days" },
  Islamic: { label: "Islamic Holiday", plural: "Islamic Holidays" },
};

const TYPE_OF = { regular: "Regular", special: "Special", islamic: "Islamic" };
const PENDING_NAMES = { fitr: "Eid'l Fitr (Feast of Ramadhan)", adha: "Eid'l Adha (Feast of Sacrifice)" };
const holidayCache = {};

// [{ date: "2026-03-20", name, type, note? }] -> [{ month, day, name, type, note }] in date order
const shape = (list) => list
  .map(({ date, name, type, note }) => {
    const [, month, day] = date.split("-").map(Number);       // "2026-03-20"
    return { month, day, name, type: TYPE_OF[type] || "Special", note: note || "" };
  })
  .sort((a, b) => a.month - b.month || a.day - b.day);

// The same lists, from the copy built into the page (null for a year that has no list)
function builtInCopy(year) {
  const y = HOLIDAY_FILE.years[String(year)];
  if (!y) return null;
  return {
    holidays: shape(y.holidays.map(([date, name, type, note]) => ({ date, name, type, note }))),
    proclamation: y.proclamation || "",
    pending: (y.pending || []).map((k) => PENDING_NAMES[k]).filter(Boolean),
  };
}

// Returns { holidays: [{ month, day, name, type, note }], source, proclamation, pending, status }
//   source "proclamations" - answered by the server
//   source "built-in"      - the server could not answer (status = its HTTP error, 0 = not reachable); the copy built into the page
//   source "error"         - nothing to show (a year with no list)
export async function loadHolidays(year) {
  if (holidayCache[year]) return holidayCache[year];
  try {
    const r = await api(`/holidays?year=${encodeURIComponent(year)}`);
    const result = { holidays: shape(r.holidays), source: "proclamations", proclamation: r.proclamation || "", pending: r.pending || [], status: 200 };
    if (!result.pending.length) holidayCache[year] = result;       // a year still waiting for Eid proclamations is asked for again later
    return result;
  } catch (err) {
    const copy = builtInCopy(year);                                 // not cached: the next pick of the year asks the server again
    const status = err && Number.isInteger(err.status) ? err.status : 0;
    return copy ? { ...copy, source: "built-in", status } : { holidays: [], source: "error", proclamation: "", pending: [], status };
  }
}