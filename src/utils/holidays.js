/* ===== utils/holidays.js ===== */
// Philippine holidays generator (year dropdown covers 2020-2027;
// the rules below still work for any year).
// Fixed-date holidays come from law; movable ones (Holy Week, National Heroes Day)
// are calculated. Eid'l Fitr / Eid'l Adha are NOT included here because their dates
// are set by yearly proclamation (NCMF): they come from the holiday API in holidayApi.js.

export const MIN_YEAR = 2020;
export const MAX_YEAR = 2027;

// Chinese New Year became a special non-working day in 2012.
const CHINESE_NEW_YEAR = {
  2012: [1, 23], 2013: [2, 10], 2014: [1, 31], 2015: [2, 19],
  2016: [2, 8], 2017: [1, 28], 2018: [2, 16], 2019: [2, 5],
  2020: [1, 25], 2021: [2, 12], 2022: [2, 1], 2023: [1, 22],
  2024: [2, 10], 2025: [1, 29], 2026: [2, 17], 2027: [2, 6],
};

// Optional: year-specific holidays, e.g. { 2024: [{ month: 4, day: 10, name: "Eid'l Fitr", type: "Islamic" }] }
const EXTRA_HOLIDAYS = {};

// Easter Sunday (Gregorian calendar, anonymous algorithm)
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// weekday: 0 = Sunday, 1 = Monday ...
function lastWeekdayOfMonth(year, month, weekday) {
  const d = new Date(year, month, 0); // last day of the month
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
  return d;
}

function entry(date, name, type) {
  return { month: date.getMonth() + 1, day: date.getDate(), name, type };
}

// type: "Regular" | "Special" | "Islamic"
export function getHolidays(year) {
  const y = Number(year);
  const on = (m, d) => new Date(y, m - 1, d);
  const easter = easterSunday(y);
  const list = [];

  list.push(entry(on(1, 1), "New Year's Day", "Regular"));
  if (CHINESE_NEW_YEAR[y]) {
    const [m, d] = CHINESE_NEW_YEAR[y];
    list.push(entry(on(m, d), "Chinese New Year", "Special"));
  }
  list.push(entry(on(2, 25), "EDSA People Power Revolution Anniversary", "Special"));
  list.push(entry(addDays(easter, -3), "Maundy Thursday", "Regular"));
  list.push(entry(addDays(easter, -2), "Good Friday", "Regular"));
  list.push(entry(addDays(easter, -1), "Black Saturday", "Special"));
  list.push(entry(on(4, 9), "Araw ng Kagitingan", "Regular"));
  list.push(entry(on(5, 1), "Labor Day", "Regular"));
  list.push(entry(on(6, 12), "Independence Day", "Regular"));
  if (y >= 2004) list.push(entry(on(8, 21), "Ninoy Aquino Day", "Special"));
  // Last Sunday of August before 2007, last Monday from 2007 (RA 9492)
  list.push(entry(lastWeekdayOfMonth(y, 8, y >= 2007 ? 1 : 0), "National Heroes Day", "Regular"));
  list.push(entry(on(11, 1), "All Saints' Day", "Special"));
  list.push(entry(on(11, 30), "Bonifacio Day", "Regular"));
  if (y >= 2017) list.push(entry(on(12, 8), "Feast of the Immaculate Conception", "Special"));
  list.push(entry(on(12, 24), "Christmas Eve", "Special"));
  list.push(entry(on(12, 25), "Christmas Day", "Regular"));
  list.push(entry(on(12, 30), "Rizal Day", "Regular"));
  list.push(entry(on(12, 31), "Last Day of the Year", "Special"));

  if (EXTRA_HOLIDAYS[y]) list.push(...EXTRA_HOLIDAYS[y]);

  return list.sort((a, b) => a.month - b.month || a.day - b.day);
}
