/* ===== utils/dates.js ===== */
export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function startOfToday() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

export function daysInMonth(month, year) {
  return new Date(year, month, 0).getDate(); // month is 1-12
}

// "2026-03-05T10:00:00.000Z" -> "March 5, 2026"
export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// "1998-03-25" -> "March 25, 1998" (no time-zone shifting for plain dates)
export function formatPlainDate(yyyyMmDd) {
  // Reads the leading YYYY-MM-DD even if a time part follows it ("1998-03-25T00:00:00.000Z"),
  // and falls back to showing the raw value rather than a blank - so a birthday never silently disappears.
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(yyyyMmDd ?? "").trim());
  if (!m) return String(yyyyMmDd ?? "");
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${Number(m[1])}`;
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// 125 -> "2:05"
export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}