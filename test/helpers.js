import { createPostalService } from "../server/postal.js";
import { makeFakeZipApi } from "./fakeZipApi.js";
import { createGeoService } from "../server/geo.js";
import { makeFakeGeoApi, FAKE_KEY } from "./fakeGeoApi.js";
import http from "node:http";
import { loadConfig } from "../server/config.js";
import { openDb } from "../server/db.js";
import { createOutbox } from "../server/outbox.js";
import { createMailer } from "../server/mail.js";
import { createSms } from "../server/sms.js";
import { createApp } from "../server/app.js";

export async function startServer(overrides = {}, { smsDelayMs = 0, dbDelayMs = 0, postal = null, geo = null } = {}) {
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
  if (dbDelayMs) { // like a database across a network (Neon, say): each query takes a moment, which is what makes "read, then write" races easy to hit
    const realQuery = db.pool.query.bind(db.pool);
    db.pool.query = async (...args) => { await new Promise((r) => setTimeout(r, dbDelayMs)); return realQuery(...args); };
  }
  const outbox = createOutbox(true);
  const sms = createSms(config, outbox);
  if (smsDelayMs) { // a slow SMS provider, so tests can send several requests while one is still in flight
    const realSend = sms.send;
    sms.send = async (...args) => { await new Promise((r) => setTimeout(r, smsDelayMs)); return realSend(...args); };
  }
  // Tests never call the real ZIP API: the server gets a fake one (test/fakeZipApi.js) unless a test brings its own
  const postalService = postal ?? createPostalService({ fetchImpl: makeFakeZipApi().fetchImpl });
  // ... and the same for the state / city lists: a fake of the Country State City API, with a key, unless a test brings its own
  const geoService = geo ?? createGeoService({ apiKey: FAKE_KEY, fetchImpl: makeFakeGeoApi().fetchImpl });
  const app = await createApp({ config, db, mailer: createMailer(config, outbox), sms, outbox, postal: postalService, geo: geoService });
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
  async function warm() { // fetch this client's CSRF token now, so later requests can all start at the same instant
    if (csrf) return;
    const r = await fetch(base + "/api/csrf", { headers: { cookie: cookieHeader() } });
    store(r);
    csrf = (await r.json()).token;
  }
  async function call(method, path, body, { csrf: useCsrf = true } = {}) {
    if (method !== "GET" && useCsrf) await warm();
    const headers = { cookie: cookieHeader(), "content-type": "application/json" };
    if (method !== "GET" && useCsrf) headers["x-csrf-token"] = csrf;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    store(res);
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data, headers: res.headers };
  }
  return { get: (p) => call("GET", p), post: (p, b, o) => call("POST", p, b, o), warm, jar };
}

export const goodPayload = (over = {}) => ({
  firstName: "Juan", middleInitial: "D.", lastName: "Dela Cruz",
  birthday: "03/25/1998", email: `juan${Math.random().toString(36).slice(2, 8)}@gmail.com`,
  password: "Str0ng!Passw0rd#1", confirmPassword: "Str0ng!Passw0rd#1", mobile: "917 123 4567",
  address: { houseStreet: "Blk 12 Lot 5, Rizal St.", countryCode: "PH", state: "Metro Manila", city: "Caloocan City", cityCode: "137501000", zip: "1400" },
  ...over,
});

export const lastLink = (outbox, pattern) => {
  const msg = outbox.list().find((m) => pattern.test(m.subject) || pattern.test(m.body));
  return msg?.body.match(/https?:\/\/\S+/)?.[0];
};
export const lastOtp = (outbox) => outbox.list().find((m) => m.type === "sms")?.body.match(/\b(\d{6})\b/)?.[1];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fully verified account inserted straight into the database (fast: no Argon2, no emails) - for tests that only need rows to exist
export async function insertVerifiedUser(db, email) {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO users (id, first_name, last_name, birthday, password_hash, email, email_verified_at, mobile_number, mobile_verified, created_at, updated_at)
     VALUES ($1, 'Test', 'User', '1990-01-01', 'x', $2, $3, '+639170000000', TRUE, $3, $3)`, [id, email, now]);
  return id;
}