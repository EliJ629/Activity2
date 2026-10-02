/* ===== utils/holidayApi.js ===== */
// Philippine holidays from the free Nager.Date API (no API key needed)
// https://date.nager.at/api/v3/PublicHolidays/{year}/PH
//
// The API list is merged with the built-in rules in holidays.js so the
// result includes every holiday either source knows about. If the API can't be
// reached, the built-in list is used on its own.
//
// Every holiday is classified as:
//   Regular  - Regular Holiday
//   Special  - Special Non-Working Day
//   Islamic  - Islamic Holiday (Eid'l Fitr, Eid'l Adha, ...)
//
// Islamic dates are proclaimed yearly by the NCMF. If the holiday API doesn't
// list them, the dates are looked up from the free Aladhan Hijri calendar API
// and marked "expected" (calculated, subject to the official proclamation).

import { getHolidays } from "./holidays.js";

const API_URL = "https://date.nager.at/api/v3/PublicHolidays";
const HIJRI_API_URL = "https://api.aladhan.com/v1/hToG";
const holidayCache = {};

export const HOLIDAY_TYPES = {
  Regular: { label: "Regular Holiday", plural: "Regular Holidays" },
  Special: { label: "Special Non-Working Day", plural: "Special Non-Working Days" },
  Islamic: { label: "Islamic Holiday", plural: "Islamic Holidays" },
};

const ISLAMIC_NAME = /(eid|eidl|eidul|adha|fitr|fitar|mawlid|maulid|isra|mi'?raj|amun jadid|hijri|islamic|muslim)/i;

// Regular holidays fixed by law (RA 9492 and the Eid holidays). Every other
// non-Islamic day off is a Special Non-Working Day.
const REGULAR_NAMES = [
  /^new year'?s day$/i, /maundy|holy thursday/i, /good friday|holy friday/i,
  /day of valor|araw ng kagitingan|bataan/i, /labou?r day/i, /independence day/i,
  /national heroes/i, /bonifacio/i, /^christmas day$/i, /rizal/i,
];

export function classifyHoliday(name, knownType) {
  if (ISLAMIC_NAME.test(name)) return "Islamic";
  if (knownType) return knownType;
  return REGULAR_NAMES.some((re) => re.test(name)) ? "Regular" : "Special";
}

async function fetchApiHolidays(year) {
  const res = await fetch(`${API_URL}/${year}/PH`);
  if (!res.ok) throw new Error(`Holiday API error (${res.status})`);
  const data = await res.json();
  return data
    .filter((h) => h.global !== false) // nationwide holidays only
    .filter((h) => !(Array.isArray(h.types) && h.types.length && h.types.every((t) => t === "Observance")))
    .map((h) => {
      const [, m, d] = h.date.split("-").map(Number); // "2026-01-01"
      return { month: m, day: d, name: h.name, type: classifyHoliday(h.name) };
    });
}

// Gregorian date of a Hijri date through the free Aladhan API (null when unavailable)
async function hijriToGregorian(day, month, hijriYear) {
  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  const res = await fetch(`${HIJRI_API_URL}/${dd}-${mm}-${hijriYear}`);
  if (!res.ok) return null;
  const json = await res.json();
  const text = json?.data?.gregorian?.date; // "20-03-2026"
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text || "");
  return m ? { day: Number(m[1]), month: Number(m[2]), year: Number(m[3]) } : null;
}

async function islamicFallback(year, have) {
  const wanted = [
    { key: "fitr", test: /fitr|fitar/i, name: "Eid'l Fitr (expected)", hMonth: 10, hDay: 1 },   // 1 Shawwal
    { key: "adha", test: /adha/i, name: "Eid'l Adha (expected)", hMonth: 12, hDay: 10 },        // 10 Dhu al-Hijjah
  ].filter((w) => !have.some((h) => h.type === "Islamic" && w.test.test(h.name)));

  const guess = Math.floor((year - 621.5708) * 1.030684); // approximate Hijri year
  const found = [];
  for (const w of wanted) {
    for (const hy of [guess, guess + 1]) {
      try {
        const g = await hijriToGregorian(w.hDay, w.hMonth, hy);
        if (g && g.year === year) { found.push({ month: g.month, day: g.day, name: w.name, type: "Islamic", expected: true }); break; }
      } catch { /* ignore: the holiday simply isn't shown */ }
    }
  }
  return found;
}

// Returns { holidays: [...], source: "api" | "local" }
export async function loadHolidays(year) {
  if (holidayCache[year]) return holidayCache[year];

  const local = getHolidays(year);
  let result;

  try {
    const api = await fetchApiHolidays(year);
    // Merge: keep the built-in entry when both sources have the same date,
    // add every API date the built-in list doesn't have.
    const byDate = new Map(local.map((h) => [`${h.month}-${h.day}`, h]));
    for (const h of api) {
      const key = `${h.month}-${h.day}`;
      if (!byDate.has(key)) byDate.set(key, h);
    }
    const merged = [...byDate.values()];
    const extra = await islamicFallback(Number(year), merged);
    for (const h of extra) if (!byDate.has(`${h.month}-${h.day}`)) merged.push(h);
    const holidays = merged.sort((a, b) => a.month - b.month || a.day - b.day);
    result = { holidays, source: "api" };
    holidayCache[year] = result; // only cache successful API results, so a failed call is retried later
  } catch {
    result = { holidays: local, source: "local" };
  }

  return result;
}
