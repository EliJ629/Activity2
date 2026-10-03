/* =========================================================
   server/app.js  -  the Express application (API + static files)
   ---------------------------------------------------------
   Requirement map
     1b  security ........ HTTPS enforcement, Argon2id, rate limit, CSRF
     2   verification .... email link (24 h) + SMS OTP (6 digits, 5 min, 3 tries, resend after 60 s)
     3   login ........... generic errors, lock after 3 failures, unlock email + 2-minute cooling period
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
  normalizeName, normalizeMiddleInitial, normalizeEmail, normalizeZip,
} from "../shared/validation.js";
import { getCountry } from "../shared/countries.js";

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

export async function createApp({ config, db, mailer, sms, outbox }) {
  const app = express();
  const publicDir = path.join(ROOT, "public");
  const csrf = csrfHandlers(config);

  const argonOptions = { type: argon2.argon2id, memoryCost: config.argon2.memoryCost, timeCost: config.argon2.timeCost, parallelism: config.argon2.parallelism };
  const hashPassword = (pw) => argon2.hash(pw, argonOptions);
  // Verified when the email doesn't exist, so response time doesn't reveal which emails are registered
  const dummyHash = await hashPassword(crypto.randomBytes(16).toString("hex"));

  /* ---------- prepared statements ---------- */
  const q = {
    userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    addressByUser: db.prepare("SELECT * FROM addresses WHERE user_id = ?"),
    latestToken: db.prepare("SELECT * FROM verification_tokens WHERE user_id = ? AND type = ? ORDER BY created_at DESC, seq DESC LIMIT 1"),
  };
  // SQL text for the two inserts that make up registration - prepared fresh
  // against the transaction's own connection inside POST /api/register, so
  // they run on the same connection as the surrounding BEGIN/COMMIT.
  const INSERT_USER_SQL = `INSERT INTO users (id, first_name, last_name, middle_initial, birthday, password_hash, email, mobile_number, created_at, updated_at)
                            VALUES (@id, @first_name, @last_name, @middle_initial, @birthday, @password_hash, @email, @mobile_number, @now, @now)`;
  const INSERT_ADDRESS_SQL = `INSERT INTO addresses (id, user_id, house_street, country, country_code, city, state, barangay, zip_code)
                               VALUES (@id, @user_id, @house_street, @country, @country_code, @city, @state, @barangay, @zip_code)`;

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

  async function lockUser(user) {
    const until = nowIso(Date.now() + config.login.unlockCooldownMs);
    await db.prepare("UPDATE users SET failed_login_attempts = ?, is_locked = TRUE, lockout_until = ?, updated_at = ? WHERE id = ?")
      .run(config.login.maxFailures, until, nowIso(), user.id);
    const raw = await issueLinkToken(user.id, "account_unlock", config.login.unlockTokenTtlMs);
    const link = `${config.baseUrl}/unlock?token=${encodeURIComponent(raw)}`;
    try {
      await mailer.send({ to: user.email, ...unlockEmail({ appName: config.appName, firstName: user.first_name, link, cooldownSeconds: Math.round(config.login.unlockCooldownMs / 1000) }) });
    } catch (err) { console.error("Could not send unlock email:", err.message); }
  }

  /* ---------- OTP (section 2c) ---------- */
  const otpHash = (userId, code) => crypto.createHmac("sha256", config.secret).update(`otp:${userId}:${code}`).digest("hex");
  const timeZoneFor = async (userId) => {
    const a = await q.addressByUser.get(userId);
    return tzData.getCountry(a?.country_code || "")?.timezones?.[0] || "UTC";
  };

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
    if (state.lockedForSeconds) return { error: { status: 423, code: "OTP_LOCKED", message: "Too many wrong codes. Try again later.", retryAfter: state.lockedForSeconds } };
    if (state.resendInSeconds) return { error: { status: 429, code: "OTP_COOLDOWN", message: `Please wait ${state.resendInSeconds}s before requesting another code.`, retryAfter: state.resendInSeconds } };
    const code = String(crypto.randomInt(0, 10 ** config.otp.length)).padStart(config.otp.length, "0");
    const expiresAt = new Date(Date.now() + config.otp.ttlMs);
    await sms.send(user.mobile_number, otpSms({ appName: config.appName, code, expiresAt, timeZone: await timeZoneFor(user.id), ttlMinutes: Math.round(config.otp.ttlMs / 60000) }));
    await insertToken(user.id, "mobile_otp", otpHash(user.id, code), config.otp.ttlMs);
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
  async function createSession(req, res, user) {
    await db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
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

  const publicUser = async (u, withPrivate = true) => {
    const a = await q.addressByUser.get(u.id);
    return {
      id: u.id,
      firstName: u.first_name,
      middleInitial: u.middle_initial || "",
      lastName: u.last_name,
      email: u.email,
      birthday: withPrivate ? u.birthday : undefined,
      mobileNumber: withPrivate ? u.mobile_number : undefined,
      emailVerified: Boolean(u.email_verified_at),
      mobileVerified: Boolean(u.mobile_verified),
      createdAt: u.created_at,
      address: a ? { houseStreet: a.house_street, country: a.country, countryCode: a.country_code, state: a.state, city: a.city, barangay: a.barangay || "", zip: a.zip_code } : null,
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
        // The browser calls these public APIs directly (address, DNS, holidays)
        connectSrc: ["'self'", "https://psgc.gitlab.io", "https://dns.google", "https://date.nager.at", "https://api.aladhan.com"],
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
        barangay: str(a.barangay).trim().replace(/\s+/g, " "),
        zip: normalizeZip(str(a.zip)),
      },
    };
    const country = getCountry(payload.address.countryCode);
    const errors = validateRegistration(payload, { today: serverToday(), countryLabel: country?.name });
    if (!country && !errors.countryCode) errors.countryCode = "Select a valid country.";
    if (Object.keys(errors).length) return res.status(422).json({ code: "VALIDATION", message: "Please fix the highlighted fields.", errors });

    const existing = await q.userByEmail.get(payload.email);
    if (existing && existing.email_verified_at) {
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
          .run({ id: crypto.randomUUID(), user_id: id, house_street: payload.address.houseStreet, country: country.name, country_code: country.code, city: payload.address.city, state: payload.address.state, barangay: payload.address.barangay || null, zip_code: payload.address.zip });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ code: "EMAIL_TAKEN", message: "An account with this email already exists.", errors: { email: "An account with this email already exists." } });
      }
      throw err;
    }

    let emailSent = true;
    try { await sendVerificationEmail(await q.userById.get(id)); } catch (err) { emailSent = false; console.error("Could not send verification email:", err.message); }
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
        used: { code: "TOKEN_USED", message: "This link has already been used." },
      };
      const { code, message } = byStatus[found.status] || { code: "TOKEN_INVALID", message: "This verification link is invalid." };
      return res.status(400).json({ code, message });
    }
    await markUsed(found.row.id);
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

  app.post("/api/otp/send", otpLimiter, requireOnboarding, async (req, res) => {
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
      return res.status(423).json({ code: "OTP_LOCKED", message: "Too many wrong codes. Please try again later.", retryAfter: secondsUntil(last.locked_until) });
    }
    if (!last || last.used_at) return res.status(400).json({ code: "OTP_NONE", message: "There is no active code. Request a new one." });
    if (ms(last.expired_at) <= now) return res.status(400).json({ code: "OTP_EXPIRED", message: "This code has expired. Request a new one." });

    if (!safeEqual(otpHash(user.id, code), last.token_hash)) {
      const attempts = last.attempts + 1;
      if (attempts >= config.otp.maxAttempts) {
        const until = nowIso(now + config.otp.lockMs);
        await db.prepare("UPDATE verification_tokens SET attempts = ?, used_at = ?, locked_until = ? WHERE id = ?").run(attempts, nowIso(), until, last.id);
        return res.status(423).json({ code: "OTP_LOCKED", message: "Too many wrong codes. Verification is locked for a while.", retryAfter: secondsUntil(until) });
      }
      await db.prepare("UPDATE verification_tokens SET attempts = ? WHERE id = ?").run(attempts, last.id);
      return res.status(400).json({ code: "OTP_WRONG", message: "That code isn't right.", attemptsLeft: config.otp.maxAttempts - attempts });
    }
    await markUsed(last.id);
    await db.prepare("UPDATE users SET mobile_verified = TRUE, updated_at = ? WHERE id = ?").run(nowIso(), user.id);
    res.clearCookie(ONB, cookieOptions(req));
    res.json({ ok: true });
  });

  /* ---------- login (section 3) ---------- */
  // Failed attempts for emails that are NOT registered are counted too, so the
  // "account locked" answer looks identical for real and unknown emails.
  const shadow = new Map();
  const shadowLocked = (email) => (shadow.get(email)?.until || 0) > Date.now();
  function shadowFail(email) {
    const now = Date.now();
    const s = shadow.get(email) || { count: 0, until: 0, last: 0 };
    if (now - s.last > 15 * 60 * 1000) s.count = 0;
    s.count += 1;
    s.last = now;
    if (s.count >= config.login.maxFailures) s.until = now + 30 * 60 * 1000;
    shadow.set(email, s);
    if (shadow.size > 5000) for (const [k, v] of shadow) if (now - v.last > 30 * 60 * 1000) shadow.delete(k);
  }
  const lockedReply = (res) => res.status(423).json({
    code: "ACCOUNT_LOCKED",
    message: `Your account is locked after ${config.login.maxFailures} failed sign-in attempts. We sent an unlock link to your registered email. It works after a ${waitLabel(config.login.unlockCooldownMs)} waiting period.`,
  });
  const invalidReply = (res) => res.status(401).json({ code: "INVALID_CREDENTIALS", message: "Invalid email or password." });

  app.post("/api/login", loginLimiter, async (req, res) => {
    const email = normalizeEmail(str(req.body?.email));
    const password = str(req.body?.password);
    if (validateLoginEmail(email) || !password || password.length > 1024) return res.status(400).json({ code: "BAD_REQUEST", message: "Enter your email and password." });

    const user = await q.userByEmail.get(email);
    if (!user) {
      if (shadowLocked(email)) return lockedReply(res);
      await argon2.verify(dummyHash, password).catch(() => false);
      shadowFail(email);
      return shadowLocked(email) ? lockedReply(res) : invalidReply(res);
    }

    // step 3: is the account locked?
    if (user.is_locked) {
      const open = await db.prepare("SELECT 1 FROM verification_tokens WHERE user_id = ? AND type = 'account_unlock' AND used_at IS NULL AND expired_at > ?").get(user.id, nowIso());
      if (!open) await lockUser(user); // the old link expired: send a fresh one
      return lockedReply(res);
    }

    // step 5: compare the password hash
    const ok = await argon2.verify(user.password_hash, password).catch(() => false);
    if (!ok) {
      const failures = user.failed_login_attempts + 1; // step 6: increment
      if (failures >= config.login.maxFailures) { await lockUser(user); return lockedReply(res); } // step 7
      await db.prepare("UPDATE users SET failed_login_attempts = ?, updated_at = ? WHERE id = ?").run(failures, nowIso(), user.id);
      return invalidReply(res);
    }
    await db.prepare("UPDATE users SET failed_login_attempts = 0, updated_at = ? WHERE id = ?").run(nowIso(), user.id);

    // step 4: verified + active. Checked after the password so status is only ever shown to the real owner.
    if (!user.email_verified_at) return res.status(403).json({ code: "EMAIL_NOT_VERIFIED", message: "Please verify your email address first. Check your inbox for the verification link." });
    if (!user.mobile_verified) {
      setOnboarding(req, res, user.id);
      return res.status(403).json({ code: "MOBILE_NOT_VERIFIED", message: "Please verify your mobile number to finish setting up your account." });
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
    const raw = req.cookies[SID];
    if (raw) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(raw));
    res.clearCookie(SID, cookieOptions(req));
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
  app.use(express.static(publicDir, { index: false, maxAge: config.isProd ? "1h" : 0, setHeaders: (res, file) => { if (file.endsWith(".html")) res.set("Cache-Control", "no-cache"); } }));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid request." });
    if (err.type === "entity.too.large") return res.status(413).json({ message: "Request too large." });
    console.error(err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  });

  return app;
}