import http from "node:http";
import { loadConfig } from "../server/config.js";
import { openDb } from "../server/db.js";
import { createOutbox } from "../server/outbox.js";
import { createMailer } from "../server/mail.js";
import { createSms } from "../server/sms.js";
import { createApp } from "../server/app.js";

export async function startServer(overrides = {}) {
  const config = loadConfig({
    logMessages: false,
    devOutbox: true,
    argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 },
    login: { unlockCooldownMs: 2000 },
    otp: { resendMs: 1500, lockMs: 4000 },
    rateLimit: { registerMax: 500 },
    ...overrides,
  });
  // Each call gets a clean slate, the same guarantee SQLite's ":memory:" used
  // to give automatically - this now uses a real (but disposable) Postgres
  // test database, truncated before every test server starts.
  const testUrl = process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/registration_app_test";
  const db = openDb(testUrl);
  await db.query(await (await import("node:fs")).promises.readFile(new URL("../schema.sql", import.meta.url), "utf8"));
  await db.query("TRUNCATE TABLE sessions, verification_tokens, addresses, users RESTART IDENTITY CASCADE;");
  const outbox = createOutbox(true);
  const app = await createApp({ config, db, mailer: createMailer(config, outbox), sms: createSms(config, outbox), outbox });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, db, outbox, config, close: async () => { await new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); await db.close(); } };
}

// tiny fetch client with a cookie jar and automatic CSRF token
export function client(base) {
  const jar = new Map();
  let csrf = null;
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = decodeURIComponent(pair.slice(i + 1));
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === "") jar.delete(name); else jar.set(name, value);
    }
  };
  async function call(method, path, body, { csrf: useCsrf = true } = {}) {
    if (method !== "GET" && useCsrf && !csrf) {
      const r = await fetch(base + "/api/csrf", { headers: { cookie: cookieHeader() } });
      store(r);
      csrf = (await r.json()).token;
    }
    const headers = { cookie: cookieHeader(), "content-type": "application/json" };
    if (method !== "GET" && useCsrf) headers["x-csrf-token"] = csrf;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    store(res);
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data, headers: res.headers };
  }
  return { get: (p) => call("GET", p), post: (p, b, o) => call("POST", p, b, o), jar };
}

export const goodPayload = (over = {}) => ({
  firstName: "Juan", middleInitial: "D.", lastName: "Dela Cruz",
  birthday: "03/25/1998", email: `juan${Math.random().toString(36).slice(2, 8)}@gmail.com`,
  password: "Str0ng!Passw0rd#1", confirmPassword: "Str0ng!Passw0rd#1", mobile: "917 123 4567",
  address: { houseStreet: "Blk 12 Lot 5, Rizal St.", countryCode: "PH", state: "National Capital Region (NCR)", city: "Caloocan City", barangay: "Barangay 176", zip: "1400" },
  ...over,
});

export const lastLink = (outbox, pattern) => {
  const msg = outbox.list().find((m) => pattern.test(m.subject) || pattern.test(m.body));
  return msg?.body.match(/https?:\/\/\S+/)?.[0];
};
export const lastOtp = (outbox) => outbox.list().find((m) => m.type === "sms")?.body.match(/\b(\d{6})\b/)?.[1];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
