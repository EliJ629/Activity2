// A stand-in for the Aladhan Hijri calendar API (https://api.aladhan.com/v1/hToG/DD-MM-YYYY), so tests never touch the network.
// It converts a Hijri date to a Gregorian one with the real formula (tabular Islamic calendar), in the shape the real API answers:
//   { code: 200, status: "OK", data: { gregorian: { date: "DD-MM-YYYY" } } }
// mode: "up" | "down" (network error) | "500" | "garbage" (200, but not what we expect)
const j = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Tabular Islamic calendar -> Julian day -> Gregorian (accurate to a day, like the API's calculated dates)
function hijriToGregorian(d, m, y) {
  const jd = d + Math.ceil(29.5 * (m - 1)) + (y - 1) * 354 + Math.floor((3 + 11 * y) / 30) + 1948440 - 1;   // 1948440 = 1 Muharram 1 AH
  const l = jd + 68569, n = Math.floor((4 * l) / 146097);
  let ll = l - Math.floor((146097 * n + 3) / 4);
  const i = Math.floor((4000 * (ll + 1)) / 1461001);
  ll = ll - Math.floor((1461 * i) / 4) + 31;
  const jj = Math.floor((80 * ll) / 2447);
  const day = ll - Math.floor((2447 * jj) / 80);
  const k = Math.floor(jj / 11);
  return { day, month: jj + 2 - 12 * k, year: 100 * (n - 49) + i + k };
}

export function makeFakeAladhan({ mode = "up" } = {}) {
  const calls = [];
  async function fetchImpl(url) {
    const m = /\/hToG\/(\d{2})-(\d{2})-(\d{4})$/.exec(new URL(url).pathname);
    calls.push(m ? `${m[1]}-${m[2]}-${m[3]}` : url);
    if (mode === "down") throw new TypeError("fetch failed");
    if (mode === "500") return j(500, { code: 500 });
    if (mode === "garbage") return j(200, { hello: "world" });
    if (!m) return j(404, {});
    const g = hijriToGregorian(Number(m[1]), Number(m[2]), Number(m[3]));
    return j(200, { code: 200, status: "OK", data: { gregorian: { date: `${String(g.day).padStart(2, "0")}-${String(g.month).padStart(2, "0")}-${g.year}` } } });
  }
  return { fetchImpl, calls };
}
