/* =========================================================
   server/app.js  -  the Express application (API + static files)
   ---------------------------------------------------------
   Requirement map
     1b  security ........ HTTPS enforcement, Argon2id, rate limit, CSRF
     2   verification .... email link (24 h) + SMS OTP (6 digits, 5 min, 3 tries, resend after 60 s)
     3   login ........... "not registered" and "unverified" notices, generic wrong-password error, lock after 3 failures,
                           OTP step texted at sign-in for an unverified phone, unlock email + 2-minute cooling period
     4   database ........ schema.sql (users / addresses / verification_tokens + sessions) - PostgreSQL
     5   landing page .... /api/me, /api/accounts (used by the modal), logout
   ========================================================= */
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import argon2 from "argon2";
import tzData from "countries-and-timezones";

import { ROOT } from "./config.js";
import { transaction, isUniqueViolation } from "./db.js";
import { sha256, newToken, nowIso, safeEqual, sign, unsign, cookieOptions, csrfHandlers, cookieParser, enforceHttps } from "./security.js";
import { verificationEmail, unlockEmail, otpSms } from "./templates.js";
import {
  validateRegistration, validateLoginEmail, validateBirthday, validateMobile,
  normalizeName, normalizeMiddleInitial, normalizeEmail, normalizeZip, canonicalEmail,
} from "../shared/validation.js";
import { getCountry } from "../shared/countries.js";
import { createPostalService, assertPostalDataReady } from "./postal.js";
import { createGeoService } from "./geo.js";
import { createHolidayService, assertHolidayDataReady } from "./holidayService.js";

const str = (v) => (typeof v === "string" ? v : "");
const ms = (isoText) => Date.parse(isoText);
const secondsUntil = (isoText) => Math.max(1, Math.ceil((ms(isoText) - Date.now()) / 1000));

// Server "today" = the earliest time zone on Earth (UTC+14), so the 13-year age
// check is never stricter than what a user in any time zone sees in the browser.
function serverToday() {
  const d = new Date(Date.now() + 14 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

// 120000 -> "2-minute", 6000 -> "6-second"
const waitLabel = (ms) => (ms >= 60000 && ms % 60000 === 0 ? `${ms / 60000}-minute` : `${Math.max(1, Math.round(ms / 1000))}-second`);

const maskEmail = (email) => {
  const [local, domain] = email.split("@");
  const shown = local.length <= 2 ? local[0] + "*" : `${local[0]}${"*".repeat(Math.min(local.length - 2, 6))}${local.at(-1)}`;
  return `${shown}@${domain}`;
};
const maskMobile = (e164) => `${e164.slice(0, -7)}${"*".repeat(3)}${e164.slice(-4)}`;

export async function createApp({ config, db, mailer, sms, outbox, postal: postalDep, geo: geoDep, holidays: holidaysDep }) {
  assertPostalDataReady(); // fail at startup, not on someone's first registration, if the ZIP table is missing
  assertHolidayDataReady(); // ... and the same for the holiday lists (server/holiday-data/ph-holidays.json)
  const postalService = postalDep ?? createPostalService(); // asks the ZIP API, falls back to the table (server/postal.js)
  const geoService = geoDep ?? createGeoService({ apiKey: config.geo.apiKey }); // state / city lists for other countries (server/geo.js)
  const holidayService = holidaysDep ?? createHolidayService(); // the government's holiday lists per year (server/holidayService.js)
  if (!geoDep) console.log(geoService.configured ? "State / city lists: using the Country State City API." : "State / city lists: NOT configured (no CSC_API_KEY) - other countries type their state and city.");
  const app = express();
  const publicDir = path.join(ROOT, "public");
  const csrf = csrfHandlers(config);

  const argonOptions = { type: argon2.argon2id, memoryCost: config.argon2.memoryCost, timeCost: config.argon2.timeCost, parallelism: config.argon2.parallelism };
  const hashPassword = (pw) => argon2.hash(pw, argonOptions);

  /* ---------- prepared statements ---------- */
  const q = {
    userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    // A VERIFIED account whose mailbox is the same once dots / +tags are ignored. This is the SQL twin of
    // canonicalEmail() in shared/validation.js (a test keeps them identical). It uses chr(64) for the
    // "@" on purpose: db.js reads any "@word" in SQL text as a named parameter.
    verifiedByCanonical: db.prepare(`SELECT id FROM users WHERE email_verified_at IS NOT NULL AND (
        CASE WHEN split_part(lower(email), chr(64), 2) IN ('gmail.com', 'googlemail.com')
             THEN replace(split_part(split_part(lower(email), chr(64), 1), '+', 1), '.', '') || chr(64) || 'gmail.com'
             ELSE split_part(split_part(lower(email), chr(64), 1), '+', 1) || chr(64) || split_part(lower(email), chr(64), 2)
        END) = ? LIMIT 1`),
    addressByUser: db.prepare("SELECT * FROM addresses WHERE user_id = ?"),
    latestToken: db.prepare("SELECT * FROM verification_tokens WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1")  };
  // Is this mailbox already owned by a verified account? "j.uan@gmail.com" and "juan+x@gmail.com" count as "juan@gmail.com".
  const mailboxTaken = async (email) => Boolean(await q.verifiedByCanonical.get(canonicalEmail(email)));
  // SQL text for the two inserts that make up registration - prepared fresh
  // against the transaction's own connection inside POST /api/register, so
  // they run on the same connection as the surrounding BEGIN/COMMIT.
  const INSERT_USER_SQL = `INSERT INTO users (id, first_name, last_name, middle_initial, birthday, password_hash, email, mobile_number, created_at, updated_at)
                            VALUES (@id, @first_name, @last_name, @middle_initial, @birthday, @password_hash, @email, @mobile_number, @now, @now)`;
  const INSERT_ADDRESS_SQL = `INSERT INTO addresses (id, user_id, house_street, country, country_code, city, state, zip_code)
                               VALUES (@id, @user_id, @house_street, @country, @country_code, @city, @state, @zip_code)`;

  /* ---------- tokens (stored hashed, single use) ---------- */
  async function insertToken(userId, type, tokenHash, ttlMs) {
    await db.prepare("UPDATE verification_tokens SET used_at = ? WHERE user_id = ? AND type = ? AND used_at IS NULL").run(nowIso(), userId, type);
    await db.prepare(`INSERT INTO verification_tokens (id, user_id, token_hash, type, expired_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), userId, tokenHash, type, nowIso(Date.now() + ttlMs), nowIso());
  }
  async function issueLinkToken(userId, type, ttlMs) {
    const raw = newToken();
    await insertToken(userId, type, sha256(raw), ttlMs);
    return raw;
  }
  async function findLinkToken(raw, type) {
    if (!raw || raw.length > 200) return { status: "invalid" };
    const row = await db.prepare("SELECT * FROM verification_tokens WHERE token_hash = ? AND type = ?").get(sha256(raw), type);
    if (!row) return { status: "invalid" };
    if (row.used_at) return { status: "used", row };
    if (ms(row.expired_at) <= Date.now()) return { status: "expired", row };
    return { status: "ok", row };
  }
  const markUsed = (id) => db.prepare("UPDATE verification_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").run(nowIso(), id);

  /* ---------- emails ---------- */
  async function sendVerificationEmail(user) {
    const raw = await issueLinkToken(user.id, "email_verify", config.emailTokenTtlMs);
    const link = `${config.baseUrl}/verify-email?token=${encodeURIComponent(raw)}`;
    await mailer.send({ to: user.email, ...verificationEmail({ appName: config.appName, firstName: user.first_name, link, ttlHours: Math.round(config.emailTokenTtlMs / 3600000) }) });
  }

  // Accounts whose lock and unlock link are being set up right now. The account is flagged locked a moment BEFORE its unlock
  // link exists, and a login arriving in that gap used to see "locked, no live link" and send a link of its own: every new link
  // cancels the older ones, so a burst of logins meant a burst of emails and only the last link working.
  const lockingNow = new Set();
  async function lockUser(user) {
    if (lockingNow.has(user.id)) return;
    lockingNow.add(user.id);
    try {
      const until = nowIso(Date.now() + config.login.unlockCooldownMs);
      await db.prepare("UPDATE users SET failed_login_attempts = ?, is_locked = TRUE, lockout_until = ?, updated_at = ? WHERE id = ?")
        .run(config.login.maxFailures, until, nowIso(), user.id);
      const raw = await issueLinkToken(user.id, "account_unlock", config.login.unlockTokenTtlMs);
      const link = `${config.baseUrl}/unlock?token=${encodeURIComponent(raw)}`;
      try {
        await mailer.send({ to: user.email, ...unlockEmail({ appName: config.appName, firstName: user.first_name, link, cooldownSeconds: Math.round(config.login.unlockCooldownMs / 1000) }) });
      } catch (err) { console.error("Could not send unlock email:", err.message); }
    } finally {
      lockingNow.delete(user.id);
    }
  }

  /* ---------- OTP (section 2c) ---------- */
  const otpHash = (userId, code) => crypto.createHmac("sha256", config.secret).update(`otp:${userId}:${code}`).digest("hex");
// AFTER
const timeZoneFor = async (userId) => {
  try {
    const a = await q.addressByUser.get(userId);
    if (!a?.country_code) return "UTC";
    const countryInfo = tzData.getCountry(a.country_code);
    return countryInfo?.timezones?.[0] || "UTC";
  } catch (err) {
    console.error("Error resolving time zone:", err.message);
    return "UTC";
  }
};
  // Shown whenever a code is refused or can't be sent because of the lock that follows 3 wrong codes
  const lockedMessage = (seconds) => `Too many wrong codes. You can request a new code in ${seconds} second${seconds === 1 ? "" : "s"}.`;
  async function otpState(user) {
    const last = await q.latestToken.get(user.id, "mobile_otp");
    const now = Date.now();
    const locked = last?.locked_until && ms(last.locked_until) > now;
    const active = Boolean(last && !last.used_at && ms(last.expired_at) > now);
    return {
      sentTo: maskMobile(user.mobile_number),
      active,
      expiresInSeconds: active ? secondsUntil(last.expired_at) : 0,
      resendInSeconds: last && ms(last.created_at) + config.otp.resendMs > now ? Math.ceil((ms(last.created_at) + config.otp.resendMs - now) / 1000) : 0,
      attemptsLeft: active ? Math.max(0, config.otp.maxAttempts - last.attempts) : config.otp.maxAttempts,
      lockedForSeconds: locked ? secondsUntil(last.locked_until) : 0,
    };
  }

async function sendOtp(user) {
    const state = await otpState(user);

    //console.log("[OTP] state:", state);

    if (state.lockedForSeconds) {
        console.log("[OTP] BLOCKED: locked");
        return {
            error: {
                status: 423,
                code: "OTP_LOCKED",
                message: lockedMessage(state.lockedForSeconds),
                retryAfter: state.lockedForSeconds
            }
        };
    }

    if (state.resendInSeconds) {
        console.log("[OTP] BLOCKED: cooldown", state.resendInSeconds);
        return {
            error: {
                status: 429,
                code: "OTP_COOLDOWN",
                message: `Please wait ${state.resendInSeconds}s before requesting another code.`,
                retryAfter: state.resendInSeconds
            }
        };
    }

    const code = String(
        crypto.randomInt(0, 10 ** config.otp.length)
    ).padStart(config.otp.length, "0");

    //console.log("[OTP] generated:", code);

    const expiresAt = new Date(Date.now() + config.otp.ttlMs);
    //console.log("[OTP] generated:", code);
    await sms.send(
        user.mobile_number,
        otpSms({
            appName: config.appName,
            code,
            expiresAt,
            timeZone: await timeZoneFor(user.id),
            ttlMinutes: Math.round(config.otp.ttlMs / 60000)
        })
    );

    console.log("[OTP] sent to SMS service/outbox");

    await insertToken(
        user.id,
        "mobile_otp",
        otpHash(user.id, code),
        config.otp.ttlMs
    );

    return { state: await otpState(user) };
    
}

  /* ---------- onboarding cookie: proves "I just verified my email / passed the password check" ---------- */
  const ONB = "onb";
  const setOnboarding = (req, res, userId) =>
    res.cookie(ONB, sign(config.secret, "onb", `${userId}.${Date.now() + 30 * 60 * 1000}`), cookieOptions(req, { maxAge: 30 * 60 * 1000 }));
  async function requireOnboarding(req, res, next) {
    const value = unsign(config.secret, "onb", req.cookies[ONB]);
    const i = value ? value.lastIndexOf(".") : -1;
    const user = i > 0 && Number(value.slice(i + 1)) > Date.now() ? await q.userById.get(value.slice(0, i)) : null;
    if (!user || !user.email_verified_at) return res.status(401).json({ code: "NO_SESSION", message: "Please sign in to continue verifying your account." });
    req.user = user;
    next();
  }

  /* ---------- sessions ---------- */
  const SID = "sid";
  // Ends the sign-in this browser is holding, if any: its session is deleted and its cookie cleared. Registering a new account and
  // finishing its verification do this, because the person at the keyboard is no longer whoever signed in here before (a session
  // lasts hours and survives closing the tab, so without this the new person would find the PREVIOUS person's dashboard).
  async function endBrowserSession(req, res) {
    const raw = req.cookies[SID];
    if (raw) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(raw));
    res.clearCookie(SID, cookieOptions(req));
  }
  async function createSession(req, res, user) {
    await db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
    // signing in replaces whoever this browser was signed in as: that person's session ends now, not hours later
    if (req.cookies[SID]) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(req.cookies[SID]));
    const raw = newToken();
    await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), user.id, sha256(raw), nowIso(Date.now() + config.sessionTtlMs), nowIso(), req.ip, String(req.get("user-agent") || "").slice(0, 255));
    res.cookie(SID, raw, cookieOptions(req, { maxAge: config.sessionTtlMs }));
  }
  async function requireAuth(req, res, next) {
    const raw = req.cookies[SID];
    const row = raw ? await db.prepare("SELECT s.id AS session_id, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?").get(sha256(raw)) : null;
    if (!row || ms(row.expires_at) <= Date.now() || !row.email_verified_at || !row.mobile_verified || row.is_locked) {
      return res.status(401).json({ code: "UNAUTHENTICATED", message: "Please sign in." });
    }
    req.user = row;
    req.sessionId = row.session_id;
    req.sessionExpiresAt = row.expires_at;
    next();
  }

  // Always a plain "YYYY-MM-DD" string, whatever form the database hands back
  // (a text column gives that already; a DATE column would arrive as a JS Date).
  const plainDate = (b) => {
    if (b instanceof Date) return `${b.getFullYear()}-${String(b.getMonth() + 1).padStart(2, "0")}-${String(b.getDate()).padStart(2, "0")}`;
    return String(b ?? "").slice(0, 10);
  };
  const publicUser = async (u, withPrivate = true) => {
    const a = await q.addressByUser.get(u.id);
    return {
      id: u.id,
      firstName: u.first_name,
      middleInitial: u.middle_initial || "",
      lastName: u.last_name,
      email: u.email,
      birthday: withPrivate ? plainDate(u.birthday) : undefined,
      mobileNumber: withPrivate ? u.mobile_number : undefined,
      emailVerified: Boolean(u.email_verified_at),
      mobileVerified: Boolean(u.mobile_verified),
      createdAt: u.created_at,
      address: a ? { houseStreet: a.house_street, country: a.country, countryCode: a.country_code, state: a.state, city: a.city, zip: a.zip_code } : null,
    };
  };

  /* ---------- rate limiting (requirement 1b-iii) ---------- */
  const limiter = (limit, windowMs, message) => rateLimit({
    windowMs, limit, standardHeaders: "draft-7", legacyHeaders: false,
    handler: (req, res) => {
      const retryAfter = Math.max(1, Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000));
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({ code: "RATE_LIMIT", message, retryAfter });
    },
  });
  const registerLimiter = limiter(config.rateLimit.registerMax, config.rateLimit.registerWindowMs, "Too many registration attempts from this network. Please try again later.");
  const loginLimiter = limiter(config.rateLimit.loginMax, 15 * 60 * 1000, "Too many sign-in attempts. Please wait a few minutes and try again.");
  const otpLimiter = limiter(config.rateLimit.otpMax, 60 * 60 * 1000, "Too many verification attempts. Please try again later.");
  const emailLinkLimiter = limiter(30, 60 * 60 * 1000, "Too many attempts. Please try again later.");
  const resendLimiter = limiter(5, 60 * 60 * 1000, "Too many requests. Please try again later.");
  const emailCheckLimiter = limiter(60, 15 * 60 * 1000, "Too many email checks. Please slow down.");
  const postalLimiter = limiter(120, 15 * 60 * 1000, "Too many postal-code checks. Please slow down.");
  const geoLimiter = limiter(200, 15 * 60 * 1000, "Too many address lookups. Please slow down.");
  const generalLimiter = limiter(config.rateLimit.generalMax, 15 * 60 * 1000, "Too many requests. Please slow down.");

  /* =====================================================
     middleware
     ===================================================== */
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  app.use(enforceHttps(config));
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        // The browser calls these public APIs directly (address, DNS). Holidays and ZIP codes come through this server.
        connectSrc: ["'self'", "https://psgc.gitlab.io", "https://dns.google"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.isProd || config.tlsConfigured ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true, preload: false }, // ignored by browsers on plain http
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cookieParser);
  app.use(express.json({ limit: "20kb" }));
  app.use("/api", (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use("/api", generalLimiter);
  app.use("/api/register", registerLimiter); // counted before anything else, so bots can't skip it
  app.use("/api", csrf.protect);

  /* =====================================================
     public endpoints
     ===================================================== */
  app.get("/api/csrf", csrf.issue);

  app.get("/api/config", (_req, res) => {
    res.json({
      appName: config.appName,
      devOutbox: outbox.enabled,
      otp: { ttlSeconds: config.otp.ttlMs / 1000, resendSeconds: config.otp.resendMs / 1000, maxAttempts: config.otp.maxAttempts },
      login: { maxFailures: config.login.maxFailures, unlockCooldownSeconds: config.login.unlockCooldownMs / 1000 },
    });
  });

  // Lets a device waiting on "Check your email", or waiting on the mobile OTP
  // step, notice - without a manual reload - once the other half of
  // verification completes, possibly on a different device. Deliberately
  // returns the same false/false whether the email doesn't exist or just
  // isn't verified yet, so this can't be used to find out which emails are
  // registered.
  app.get("/api/registration-status", async (req, res) => {
    const email = normalizeEmail(str(req.query?.email));
    const user = email ? await q.userByEmail.get(email) : null;
    res.json({ emailVerified: Boolean(user?.email_verified_at), mobileVerified: Boolean(user?.mobile_verified) });
  });

  // Live "is this email already taken?" check for the registration form. Uses the
  // same rule registration itself applies: only a VERIFIED account blocks an email
  // (an unverified earlier attempt gets replaced, see POST /api/register). Rate
  // limited, since like the 409 on registration it does say whether an email is registered.
  app.get("/api/email-available", emailCheckLimiter, async (req, res) => {
    const email = normalizeEmail(str(req.query?.email));
    res.json({ available: !(email && (await mailboxTaken(email))) });
  });

  // The postal codes of one Philippine city (for the hint under the ZIP field) and, when a ZIP is given, whether it
  // belongs to that city. It is answered by the same check registration uses, so the form and the server always agree.
  app.get("/api/ph-postal", postalLimiter, async (req, res) => {
    const cityCode = str(req.query?.cityCode);
    const found = await postalService.zipsFor(cityCode);
    if (!found) return res.status(404).json({ code: "UNKNOWN_CITY", message: "Unknown city." });
    const out = { city: found.city, zips: found.zips, source: found.source };
    const zip = normalizeZip(str(req.query?.zip));
    if (/^\d{4}$/.test(zip)) {
      const r = await postalService.check({ countryCode: "PH", zip, city: found.city, cityCode }, { verifyName: false });
      out.valid = r.status === "ok";
      if (!out.valid) out.message = r.message;
    }
    res.json(out);
  });

  // State / region and city lists for the address form (every country except the Philippines, which uses PSGC in the
  // browser). { available: false } means "no list right now" and the form falls back to typing - see server/geo.js.
  app.get("/api/geo/states", geoLimiter, async (req, res) => {
    const country = str(req.query?.country).toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || country === "PH" || !getCountry(country)) return res.status(400).json({ code: "BAD_COUNTRY", message: "Choose a country (not the Philippines) to list its states." });
    res.json(await geoService.states(country));
  });
  app.get("/api/geo/cities", geoLimiter, async (req, res) => {
    const country = str(req.query?.country).toUpperCase();
    const state = str(req.query?.state);
    if (!/^[A-Z]{2}$/.test(country) || country === "PH" || !getCountry(country) || !/^[A-Za-z0-9]{1,10}$/.test(state)) {
      return res.status(400).json({ code: "BAD_REQUEST", message: "A country (not the Philippines) and a state code are needed to list cities." });
    }
    res.json(await geoService.cities(country, state));
  });

  // The Philippine holidays of one year, as declared by the government (see server/holidayService.js for why this is not a
  // third-party holiday API): { year, proclamation, pending, holidays: [{ date, name, type: regular|special|islamic, expected? }] }
  app.get("/api/holidays", async (req, res) => {
    const raw = str(req.query?.year);
    if (!/^\d{4}$/.test(raw)) return res.status(400).json({ code: "BAD_YEAR", message: "Give a four-digit year, for example ?year=2026." });
    const year = Number(raw);
    const list = await holidayService.forYear(year);
    if (!list) {
      const years = holidayService.years();
      return res.status(404).json({ code: "NO_HOLIDAY_LIST", message: `There is no holiday list for ${year}. Available: ${years[0]} to ${years.at(-1)}.` });
    }
    res.json(list);
  });

  if (outbox.enabled) {
    const loopback = (ip) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip);
    app.get("/api/dev/outbox", (req, res) => (loopback(req.ip) ? res.json({ items: outbox.list() }) : res.status(404).end()));
    app.delete("/api/dev/outbox", (req, res) => { if (!loopback(req.ip)) return res.status(404).end(); outbox.clear(); res.json({ ok: true }); });
  }

  /* ---------- registration (section 1) ---------- */
  app.post("/api/register", async (req, res) => {
    const b = req.body ?? {};
    const a = b.address ?? {};
    const payload = {
      firstName: normalizeName(str(b.firstName)),
      middleInitial: normalizeMiddleInitial(str(b.middleInitial)),
      lastName: normalizeName(str(b.lastName)),
      birthday: str(b.birthday),
      email: normalizeEmail(str(b.email)),
      password: str(b.password),
      confirmPassword: str(b.confirmPassword),
      mobile: str(b.mobile),
      address: {
        houseStreet: str(a.houseStreet).trim().replace(/\s+/g, " "),
        countryCode: str(a.countryCode).toUpperCase(),
        state: str(a.state).trim().replace(/\s+/g, " "),
        city: str(a.city).trim().replace(/\s+/g, " "),
        cityCode: str(a.cityCode).trim(), // Philippines: the PSGC code of the chosen city (used to check the ZIP)
        zip: normalizeZip(str(a.zip)),
      },
    };
    const country = getCountry(payload.address.countryCode);
    const errors = validateRegistration(payload, { today: serverToday(), countryLabel: country?.name });
    if (!country && !errors.countryCode) errors.countryCode = "Select a valid country.";
    if (Object.keys(errors).length) return res.status(422).json({ code: "VALIDATION", message: "Please fix the highlighted fields.", errors });

    // Philippines: the ZIP has to be one of the selected city's own postal codes - answered by the ZIP API, with the
    // bundled table as the fallback if the API can't be reached (see server/postal.js)
    const zipCheck = await postalService.check({ countryCode: payload.address.countryCode, zip: payload.address.zip, city: payload.address.city, cityCode: payload.address.cityCode });
    if (zipCheck.status === "mismatch") return res.status(422).json({ code: "VALIDATION", message: "Please fix the highlighted fields.", errors: { zip: zipCheck.message } });
    if (zipCheck.status === "invalid") return res.status(422).json({ code: "VALIDATION", message: "Please fix the highlighted fields.", errors: { city: zipCheck.message } });

    const existing = await q.userByEmail.get(payload.email);
    if (await mailboxTaken(payload.email)) {
      return res.status(409).json({ code: "EMAIL_TAKEN", message: "An account with this email already exists.", errors: { email: "An account with this email already exists." } });
    }

    const birthday = validateBirthday(payload.birthday, serverToday()).iso;
    const mobile = validateMobile(payload.address.countryCode, payload.mobile).e164;
    const passwordHash = await hashPassword(payload.password);
    const id = crypto.randomUUID();
    const now = nowIso();

    try {
      await transaction(db, async (tx) => {
        // Nobody has proven ownership of this email yet if the earlier attempt was
        // never verified (e.g. the page reloaded before the email arrived) - replace
        // it with this fresh attempt instead of permanently blocking the real owner.
        // The email_verified_at IS NULL guard means this is a safe no-op if the old
        // row somehow got verified between the check above and this transaction.
        if (existing) await tx.prepare("DELETE FROM users WHERE id = ? AND email_verified_at IS NULL").run(existing.id);
        await tx.prepare(INSERT_USER_SQL)
          .run({ id, first_name: payload.firstName, last_name: payload.lastName, middle_initial: payload.middleInitial || null, birthday, password_hash: passwordHash, email: payload.email, mobile_number: mobile, now });
        await tx.prepare(INSERT_ADDRESS_SQL)
          .run({ id: crypto.randomUUID(), user_id: id, house_street: payload.address.houseStreet, country: country.name, country_code: country.code, city: payload.address.city, state: payload.address.state, zip_code: payload.address.zip });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ code: "EMAIL_TAKEN", message: "An account with this email already exists.", errors: { email: "An account with this email already exists." } });
      }
      throw err;
    }

    let emailSent = true;
    try { await sendVerificationEmail(await q.userById.get(id)); } catch (err) { emailSent = false; console.error("Could not send verification email:", err.message); }
    await endBrowserSession(req, res); // a new account is being created in this browser: whoever was signed in here is signed out
    res.status(201).json({ ok: true, email: payload.email, emailSent });
  });

  /* ---------- email verification (section 2a/2b) ---------- */
  app.post("/api/verify-email", emailLinkLimiter, async (req, res) => {
    const found = await findLinkToken(str(req.body?.token), "email_verify");
    if (found.status !== "ok") {
      // "used" gets its own code: the account is almost certainly already
      // verified (the most common real cause is an email provider's link
      // scanner clicking it before the person ever does), so the frontend
      // can point them straight to sign in instead of offering a resend that
      // would just be confusing noise at that point.
      const byStatus = {
        expired: { code: "TOKEN_EXPIRED", message: "This verification link has expired." },
        used: { code: "TOKEN_USED", message: "This verification link has already been used and cannot be reused." },
      };
      const { code, message } = byStatus[found.status] || { code: "TOKEN_INVALID", message: "This verification link is invalid." };
      return res.status(400).json({ code, message });
    }
    // claim the link in one step: if two clicks arrive at the same moment, only one gets to use it
    if (!(await markUsed(found.row.id)).changes) return res.status(400).json({ code: "TOKEN_USED", message: "This verification link has already been used and cannot be reused." });
    await db.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), found.row.user_id);
    const user = await q.userById.get(found.row.user_id);
    if (user.mobile_verified) return res.json({ ok: true, next: "login" });

    setOnboarding(req, res, user.id);
    let otp = await otpState(user);
    let smsError = false;
    try {
      const r = await sendOtp(user);
      if (r.state) otp = r.state;
    } catch (err) { smsError = true; console.error("Could not send OTP:", err.message); }
    res.json({ ok: true, next: "mobile", otp, smsError });
  });

  app.post("/api/resend-verification", resendLimiter, (req, res) => {
    const email = normalizeEmail(str(req.body?.email));
    // Always the same answer, so this can't be used to find out who is registered
    res.json({ ok: true, message: "If that email has an unverified account, we've sent a new verification link." });
    (async () => {
      const user = email ? await q.userByEmail.get(email) : null;
      if (!user || user.email_verified_at) return;
      const last = await q.latestToken.get(user.id, "email_verify");
      if (last && ms(last.created_at) + config.resendEmailCooldownMs > Date.now()) return;
      await sendVerificationEmail(user);
    })().catch((err) => console.error("Could not resend verification email:", err.message));
  });

  /* ---------- mobile OTP (section 2c) ---------- */
  app.get("/api/otp/status", requireOnboarding, async (req, res) => {
    if (req.user.mobile_verified) return res.json({ verified: true });
    res.json({ verified: false, ...(await otpState(req.user)) });
  });

  // One text-message send at a time per account: otherwise a burst of requests sent at the same moment all see
  // "no cooldown yet" and every one of them sends an SMS.
  const otpSending = new Set();
  const oneOtpSendAtATime = (req, res, next) => {
    if (otpSending.has(req.user.id)) return res.status(429).json({ code: "OTP_COOLDOWN", message: "A code is already on its way. Please wait a moment.", retryAfter: 5 });
    otpSending.add(req.user.id);
    res.on("close", () => otpSending.delete(req.user.id));
    next();
  };
  app.post("/api/otp/send", otpLimiter, requireOnboarding, oneOtpSendAtATime, async (req, res) => {
    if (req.user.mobile_verified) return res.json({ verified: true });
    try {
      const r = await sendOtp(req.user);
      if (r.error) { if (r.error.retryAfter) res.set("Retry-After", String(r.error.retryAfter)); return res.status(r.error.status).json(r.error); }
      res.json({ ok: true, ...r.state });
    } catch (err) {
      console.error("Could not send OTP:", err.message);
      res.status(502).json({ code: "SMS_FAILED", message: "We couldn't send the text message. Please try again in a moment." });
    }
  });

  app.post("/api/otp/verify", otpLimiter, requireOnboarding, async (req, res) => {
    const code = str(req.body?.code).trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ code: "OTP_FORMAT", message: "Enter the 6-digit code." });
    const user = req.user;
    const last = await q.latestToken.get(user.id, "mobile_otp");
    const now = Date.now();
    if (last?.locked_until && ms(last.locked_until) > now) {
      return res.status(423).json({ code: "OTP_LOCKED", message: lockedMessage(secondsUntil(last.locked_until)), retryAfter: secondsUntil(last.locked_until) });
    }
    if (!last || last.used_at) return res.status(400).json({ code: "OTP_NONE", message: "There is no active code. Request a new one." });
    if (ms(last.expired_at) <= now) return res.status(400).json({ code: "OTP_EXPIRED", message: "This code has expired. Request a new one." });

    // Take one of the allowed attempts BEFORE looking at the code, in a single statement. (Reading the count and writing
    // it back let a burst of guesses sent at the same moment each see "0 used" and each get a free try - the limit of 3
    // meant nothing.) If no attempt is left, the code is closed.
    const taken = await db.prepare("UPDATE verification_tokens SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND attempts < ? RETURNING attempts").get(last.id, config.otp.maxAttempts);
    if (!taken) {
      return res.status(423).json({ code: "OTP_LOCKED", message: lockedMessage(Math.ceil(config.otp.lockMs / 1000)), retryAfter: Math.ceil(config.otp.lockMs / 1000) });
    }
    const attempts = taken.attempts;
    if (!safeEqual(otpHash(user.id, code), last.token_hash)) {
      if (attempts >= config.otp.maxAttempts) {
        const until = nowIso(now + config.otp.lockMs);
        await db.prepare("UPDATE verification_tokens SET used_at = ?, locked_until = ? WHERE id = ?").run(nowIso(), until, last.id);
        return res.status(423).json({ code: "OTP_LOCKED", message: lockedMessage(secondsUntil(until)), retryAfter: secondsUntil(until) });
      }
      return res.status(400).json({ code: "OTP_WRONG", message: "That code isn't right.", attemptsLeft: config.otp.maxAttempts - attempts });
    }
    // Right code: claim it in one step, so it can't be used twice
    if (!(await markUsed(last.id)).changes) return res.status(400).json({ code: "OTP_NONE", message: "There is no active code. Request a new one." });
    await db.prepare("UPDATE users SET mobile_verified = TRUE, updated_at = ? WHERE id = ?").run(nowIso(), user.id);
    res.clearCookie(ONB, cookieOptions(req));
    await endBrowserSession(req, res); // the new account is complete: nobody else's sign-in may be left behind to greet them
    res.json({ ok: true });
  });

  /* ---------- login (section 3) ---------- */
  // What sign-in says when it can't go on. An email with no account is told so (and pointed at registration), and an email
  // that isn't verified yet is told what to do. Both are deliberate: they help people who mistyped an address or never
  // finished signing up, but they do let anyone find out whether an email is registered, which requirement 3.b.iv
  // ("generic error messages ... to prevent user enumeration attacks") asks to avoid; the sign-in rate limit is what holds
  // mass probing back. Neither counts as a failed attempt: there is no account to lock, or nothing to guess yet.
  const NOT_REGISTERED_MESSAGE = "This email is not yet registered on this website; register now to log in.";
  const UNVERIFIED_MESSAGE = "This email hasn't been verified yet. Please check your email and click the verification link we sent you, then enter the OTP we send to your mobile number to complete verification.";
  const MOBILE_PENDING_MESSAGE = "Your email is verified. Enter the OTP we sent to your mobile number to finish verifying your account.";
  const notRegisteredReply = (res) => res.status(404).json({ code: "EMAIL_NOT_REGISTERED", message: NOT_REGISTERED_MESSAGE });
  const lockedReply = (res) => res.status(423).json({
    code: "ACCOUNT_LOCKED",
    message: `Your account is locked after ${config.login.maxFailures} failed attempts in a row. We sent an unlock link to your registered email. It works after a ${waitLabel(config.login.unlockCooldownMs)} waiting period.`,
  });
  // The message stays the generic one the requirements ask for; attemptsLeft is a separate
  // field so the sign-in screen can add "locked after N more failed attempts" to it.
  const invalidReply = (res, attemptsLeft) => res.status(401).json({ code: "INVALID_CREDENTIALS", message: "Invalid email or password.", attemptsLeft });

  app.post("/api/login", loginLimiter, async (req, res) => {
    const email = normalizeEmail(str(req.body?.email));
    const password = str(req.body?.password);
    if (validateLoginEmail(email) || !password || password.length > 1024) return res.status(400).json({ code: "BAD_REQUEST", message: "Enter your email and password." });

    const user = await q.userByEmail.get(email);
    if (!user) return notRegisteredReply(res);

    // step 3: is the account locked?
    if (user.is_locked) {
      const open = await db.prepare("SELECT 1 FROM verification_tokens WHERE user_id = ? AND type = 'account_unlock' AND used_at IS NULL AND expired_at > ?").get(user.id, nowIso());
      if (!open) await lockUser(user); // the old link expired: send a fresh one
      return lockedReply(res);
    }

    // step 4: is the email verified? Checked before the password, in the order the requirements list it. Not counted as a
    // failed attempt, so nobody can lock an account that hasn't even been verified yet.
    if (!user.email_verified_at) return res.status(403).json({ code: "EMAIL_NOT_VERIFIED", message: UNVERIFIED_MESSAGE });

    // step 5: compare the password hash
    const ok = await argon2.verify(user.password_hash, password).catch(() => false);
    if (!ok) {
      // step 6: increment - in ONE statement. (Reading the count, adding one and writing it back lets guesses
      // sent at the same moment all read the same old number, so the limit of 3 could be beaten by going parallel.)
      const { failed_login_attempts: failures } = await db.prepare("UPDATE users SET failed_login_attempts = failed_login_attempts + 1, updated_at = ? WHERE id = ? RETURNING failed_login_attempts").get(nowIso(), user.id);
      if (failures >= config.login.maxFailures) {
        if (failures === config.login.maxFailures) await lockUser(user); // only the attempt that crosses the line locks it, and sends the one unlock email
        return lockedReply(res); // step 7
      }
      return invalidReply(res, config.login.maxFailures - failures);
    }
    // A correct password only counts if the account is STILL unlocked at this instant: a parallel wrong guess may have locked it
    // after this request first looked.
    const cleared = await db.prepare("UPDATE users SET failed_login_attempts = 0, updated_at = ? WHERE id = ? AND is_locked = FALSE RETURNING id").get(nowIso(), user.id);
    if (!cleared) return lockedReply(res);

    if (!user.mobile_verified) {
      // Email verified but the phone isn't: open the OTP step. Needs the correct password, because this hands out the
      // OTP-entry session and sends an SMS to the owner's phone. A code is texted now (unless one is already active, or the
      // resend / lockout rules say wait) so the screen they land on already has one waiting. If texting fails they can
      // still press "Send code" there.
      setOnboarding(req, res, user.id);
      let otpSent = false;
      if (!otpSending.has(user.id)) {
        otpSending.add(user.id);
        try {
          if (!(await otpState(user)).active) otpSent = !(await sendOtp(user)).error;
        } catch (err) {
          console.error("Could not text the OTP at sign-in:", err.message);
        } finally {
          otpSending.delete(user.id);
        }
      }
      return res.status(403).json({ code: "MOBILE_NOT_VERIFIED", message: MOBILE_PENDING_MESSAGE, otpSent });
    }

    await createSession(req, res, user); // step 8
    res.json({ ok: true, user: await publicUser(user) });
  });

  /* ---------- unlock (section 3b-iii) ---------- */
  async function unlockLookup(req, res) {
    const found = await findLinkToken(str(req.body?.token), "account_unlock");
    if (found.status !== "ok") {
      res.status(400).json({ code: found.status === "expired" ? "TOKEN_EXPIRED" : "TOKEN_INVALID", message: found.status === "expired" ? "This unlock link has expired. Try signing in again to receive a new one." : "This unlock link is invalid or was already used." });
      return null;
    }
    return { row: found.row, user: await q.userById.get(found.row.user_id) };
  }

  app.post("/api/unlock/status", emailLinkLimiter, async (req, res) => {
    const found = await unlockLookup(req, res);
    if (!found) return;
    const wait = found.user.lockout_until && ms(found.user.lockout_until) > Date.now() ? secondsUntil(found.user.lockout_until) : 0;
    res.json({ state: wait ? "cooling" : "ready", retryAfter: wait });
  });

  app.post("/api/unlock", emailLinkLimiter, async (req, res) => {
    const found = await unlockLookup(req, res);
    if (!found) return;
    const { user } = found;
    // 2-minute cooling period: the unlock cannot run before lockout_until
    if (user.lockout_until && ms(user.lockout_until) > Date.now()) {
      const retryAfter = secondsUntil(user.lockout_until);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ code: "UNLOCK_COOLDOWN", message: "For your protection, unlocking is available after a short waiting period.", retryAfter });
    }
    await transaction(db, async (tx) => {
      await tx.prepare("UPDATE users SET is_locked = FALSE, failed_login_attempts = 0, lockout_until = NULL, updated_at = ? WHERE id = ?").run(nowIso(), user.id);
      await tx.prepare("UPDATE verification_tokens SET used_at = ? WHERE user_id = ? AND type = 'account_unlock' AND used_at IS NULL").run(nowIso(), user.id);
    });
    res.json({ ok: true });
  });

  /* =====================================================
     signed-in endpoints (landing page + modal)
     ===================================================== */
  app.get("/api/me", requireAuth, async (req, res) => {
    res.json({ user: await publicUser(req.user), sessionExpiresAt: req.sessionExpiresAt });
  });

  app.post("/api/logout", async (req, res) => {
    await endBrowserSession(req, res);
    res.json({ ok: true });
  });

  // Accounts tab: active accounts, shown with masked details only
  app.get("/api/accounts", requireAuth, async (req, res) => {
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 10, 1), 50);
    const total = (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE email_verified_at IS NOT NULL AND mobile_verified = TRUE").get()).n;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
    const rows = await db.prepare(`SELECT u.id, u.first_name, u.last_name, u.email, u.created_at, a.country
                             FROM users u LEFT JOIN addresses a ON a.user_id = u.id
                             WHERE u.email_verified_at IS NOT NULL AND u.mobile_verified = TRUE
                             ORDER BY (u.id = ?) DESC, u.created_at DESC LIMIT ? OFFSET ?`).all(req.user.id, pageSize, (page - 1) * pageSize);
    res.json({
      page, pages, total,
      accounts: rows.map((r) => ({
        name: `${r.first_name} ${r.last_name[0]}.`,
        email: maskEmail(r.email),
        country: r.country || "",
        memberSince: r.created_at,
        emailVerified: true,
        mobileVerified: true,
        isYou: r.id === req.user.id,
      })),
    });
  });

  /* =====================================================
     static files + fallbacks
     ===================================================== */
  app.use("/api", (_req, res) => res.status(404).json({ message: "Not found." }));
  // The page itself (HTML, script, stylesheet) is always revalidated: the file names never change between deploys, so a browser that
  // was allowed to keep the script for an hour would go on running the OLD page after a deploy. "no-cache" still lets it keep a copy:
  // it asks "has it changed?" and an unchanged file is answered with a tiny 304. Images and fonts may be kept for an hour.
  app.use(express.static(publicDir, { index: false, maxAge: config.isProd ? "1h" : 0, setHeaders: (res, file) => { if (/\.(html|js|css)$/.test(file)) res.set("Cache-Control", "no-cache"); } }));
  app.get("/{*splat}", (_req, res) => { res.set("Cache-Control", "no-cache"); res.sendFile(path.join(publicDir, "index.html")); });

  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid request." });
    if (err.type === "entity.too.large") return res.status(413).json({ message: "Request too large." });
    console.error(err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  });

  return app;
}