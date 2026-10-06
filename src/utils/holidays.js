/* ===== utils/holidays.js ===== */
// The years the holidays tab offers. The lists themselves come from the server (GET /api/holidays?year=), which holds the
// holidays as the government declared them, year by year (server/holiday-data/ph-holidays.json, see server/holidayService.js).
// There are no holiday rules in the browser any more: the Philippine holidays are declared by proclamation each year and
// changed during the year, so a rule-based list was wrong in several years (for example it showed February 25 as a day off
// when it is a working day in 2022 and from 2025, and it lacked All Souls' Day in 2026).

export const MIN_YEAR = 2020;
export const MAX_YEAR = 2027;