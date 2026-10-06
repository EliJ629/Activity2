/* ===== components/HolidayViewer.jsx ===== */
// Year selector (2020-2027) + month calendar + holiday cards.
// The holidays of the picked year are fetched from this app's API (GET /api/holidays) each time the year changes: the holidays
// the government declared for that year, from its proclamations.
import { useEffect, useMemo, useState } from "react";
import { MIN_YEAR, MAX_YEAR } from "../utils/holidays.js";
import { loadHolidays, HOLIDAY_TYPES } from "../utils/holidayApi.js";
import { MONTHS, WEEKDAYS, daysInMonth } from "../utils/dates.js";

const YEARS = Array.from({ length: MAX_YEAR - MIN_YEAR + 1 }, (_, i) => MAX_YEAR - i);
const TYPE_KEYS = ["Regular", "Special", "Islamic"];

// Today's date in the Philippines (Asia/Manila), whatever the device's time zone is
function manilaToday() {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date()).split("-").map(Number);
  return { y, m, d };
}

// Format: "Month Day, Year – Holiday Name"  e.g. "January 1, 2026 – New Year's Day"
export function formatHoliday(h, year) {
  return `${MONTHS[h.month - 1]} ${h.day}, ${year} – ${h.name}`;
}

const weekdayOf = (year, h) => WEEKDAYS[new Date(year, h.month - 1, h.day).getDay()];

export function Badge({ type }) {
  return <span className={`badge badge--${type.toLowerCase()}`}>{HOLIDAY_TYPES[type].label}</span>;
}

function Calendar({ year, month, holidays, today }) {
  const first = new Date(year, month - 1, 1).getDay();
  const total = daysInMonth(month, year);
  const byDay = {};
  holidays.filter((h) => h.month === month).forEach((h) => { (byDay[h.day] ||= []).push(h); });
  const cells = [...Array(first).fill(null), ...Array.from({ length: total }, (_, i) => i + 1)];

  return (
    <div className="cal" role="grid" aria-label={`${MONTHS[month - 1]} ${year}`}>
      <div className="cal__head" role="row">
        {WEEKDAYS.map((w) => <span key={w} role="columnheader" aria-label={w}>{w.slice(0, 3)}</span>)}
      </div>
      <div className="cal__body">
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} className="cal__cell cal__cell--empty" role="gridcell" aria-hidden="true" />;
          const hs = byDay[d] || [];
          const isToday = today.y === year && today.m === month && today.d === d;
          const label = `${MONTHS[month - 1]} ${d}, ${year}${hs.length ? ": " + hs.map((h) => `${h.name} (${HOLIDAY_TYPES[h.type].label})`).join(", ") : ""}`;
          return (
            <span key={d} role="gridcell" aria-label={label} title={hs.length ? label : undefined}
              className={`cal__cell${hs.length ? " has-holiday" : ""}${isToday ? " is-today" : ""}`}>
              <span className="cal__num">{d}</span>
              {hs.map((h) => <span key={h.name} className={`cal__dot cal__dot--${h.type.toLowerCase()}`} data-testid="cal-dot" />)}
              {hs[0] && <span className={`cal__label cal__label--${hs[0].type.toLowerCase()}`}>{hs[0].name}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function HolidayViewer() {
  const today = useMemo(manilaToday, []);
  const initialYear = Math.min(MAX_YEAR, Math.max(MIN_YEAR, today.y));
  const [year, setYear] = useState(String(initialYear));
  const [month, setMonth] = useState(today.y === initialYear ? today.m : 1);
  const [filter, setFilter] = useState("All");
  const [scope, setScope] = useState("month"); // "month" | "year"
  const [state, setState] = useState({ holidays: [], source: "", proclamation: "", pending: [], loading: true });
  const [attempt, setAttempt] = useState(0);                  // "Try again" asks for the same year once more

  // Asynchronous request each time a year is selected
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    loadHolidays(year).then((r) => {
      if (!cancelled) setState({ ...r, loading: false });
    });
    return () => { cancelled = true; };
  }, [year, attempt]);

  const counts = Object.fromEntries(TYPE_KEYS.map((t) => [t, state.holidays.filter((h) => h.type === t).length]));
  const visible = state.holidays.filter((h) => filter === "All" || h.type === filter);
  const listed = scope === "month" ? visible.filter((h) => h.month === month) : visible;
  const hasExpected = state.holidays.some((h) => h.expected);

  const changeMonth = (delta) => {
    const next = month + delta;
    if (next < 1) setMonth(12); else if (next > 12) setMonth(1); else setMonth(next);
  };

  return (
    <section className="holidays" aria-labelledby="holidays-title">
      <div className="holidays__header">
        <h2 className="card__title" id="holidays-title">Philippine Holidays</h2>
        <div className="holidays__year-pick">
          <label className="field__label" htmlFor="holiday-year">Year</label>
          <select id="holiday-year" className="field__select holidays__year" value={year}
            onChange={(e) => { setYear(e.target.value); if (Number(e.target.value) !== today.y) setMonth(1); else setMonth(today.m); }}>
            {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      <div className="legend" role="group" aria-label="Filter by holiday type">
        <button type="button" className={`chip${filter === "All" ? " is-active" : ""}`} aria-pressed={filter === "All"} onClick={() => setFilter("All")}>
          All <span className="chip__count">{state.holidays.length}</span>
        </button>
        {TYPE_KEYS.map((t) => (
          <button key={t} type="button" className={`chip chip--${t.toLowerCase()}${filter === t ? " is-active" : ""}`} aria-pressed={filter === t} onClick={() => setFilter(t)}>
            <span className={`cal__dot cal__dot--${t.toLowerCase()}`} aria-hidden="true" /> {HOLIDAY_TYPES[t].plural} <span className="chip__count">{counts[t]}</span>
          </button>
        ))}
      </div>

      {state.loading ? (
        <p className="holidays__status" role="status">Loading holidays...</p>
      ) : state.source === "error" ? (
        <div className="holidays__status" role="alert">
          <p>The holidays for {year} could not be loaded. Please check your connection and try again.</p>
          <button type="button" className="btn btn--secondary" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
        </div>
      ) : (
        <>
          <div className="cal-nav">
            <button type="button" className="icon-btn" onClick={() => changeMonth(-1)} aria-label="Previous month">&lsaquo;</button>
            <select className="field__select cal-nav__month" aria-label="Month" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m} {year}</option>)}
            </select>
            <button type="button" className="icon-btn" onClick={() => changeMonth(1)} aria-label="Next month">&rsaquo;</button>
          </div>
          <Calendar year={Number(year)} month={month} holidays={visible} today={today} />

          <div className="scope" role="group" aria-label="List range">
            <button type="button" className={`chip${scope === "month" ? " is-active" : ""}`} aria-pressed={scope === "month"} onClick={() => setScope("month")}>{MONTHS[month - 1]}</button>
            <button type="button" className={`chip${scope === "year" ? " is-active" : ""}`} aria-pressed={scope === "year"} onClick={() => setScope("year")}>Whole {year}</button>
          </div>

          {listed.length === 0 ? (
            <p className="holidays__status">No holidays{filter !== "All" ? ` of this type` : ""} in {scope === "month" ? MONTHS[month - 1] : year}.</p>
          ) : (
            <ul className="holiday-list" data-testid="holiday-list">
              {listed.map((h) => (
                <li key={`${h.month}-${h.day}-${h.name}`} className={`holiday-item holiday-item--${h.type.toLowerCase()}`}>
                  <span className="holiday-item__text">{formatHoliday(h, year)}</span>
                  <span className="holiday-item__meta">
                    <span className="holiday-item__weekday">{weekdayOf(Number(year), h)}</span>
                    <Badge type={h.type} />
                    {h.expected && <span className="badge badge--note">Expected date</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="holidays__source">
            Source: the government's proclamations (Official Gazette){state.proclamation ? `: ${state.proclamation}` : ""}. Every nationwide holiday
            declared for {year} is listed; special working days (not a day off) and local holidays are not. Time zone: Asia/Manila.
            {state.pending.length > 0 && ` ${state.pending.join(" and ")} for ${year} will be declared by separate proclamation${hasExpected ? "; the dates marked \"Expected\" are calculated from the Hijri calendar until then" : ""}.`}
          </p>
        </>
      )}
    </section>
  );
}