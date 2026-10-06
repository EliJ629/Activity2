/* =========================================================
   server/config.js  -  every setting comes from environment
   variables (see .env.example). Nothing secret is hard-coded.
   ========================================================= */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try { process.loadEnvFile(path.join(ROOT, ".env")); } catch { /* no .env file: fine */ }

const env = process.env;
const num = (key, fallback) => (env[key] !== undefined && env[key] !== "" ? Number(env[key]) : fallback);
const flag = (key, fallback) => (env[key] === undefined || env[key] === "" ? fallback : ["1", "true", "yes", "on"].includes(env[key].toLowerCase()));

export function loadConfig(overrides = {}) {
  const isProd = (env.NODE_ENV || "development") === "production";
  const port = num("PORT", 3000);

  const cfg = {
    isProd,
    port,
    appName: env.APP_NAME || "Registration App",
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
    // PostgreSQL connection string (e.g. a Neon connection string, or a local
    // "postgresql://user:pass@localhost:5432/dbname" for development).
    databaseUrl: env.DATABASE_URL || "",
    secret: env.APP_SECRET || "",
    trustProxy: env.TRUST_PROXY ? (Number.isNaN(Number(env.TRUST_PROXY)) ? env.TRUST_PROXY : Number(env.TRUST_PROXY)) : false,

    // Transport security (requirement 1b-i: HTTPS / TLS 1.3)
    tls: {
      keyFile: env.TLS_KEY_FILE || "",
      certFile: env.TLS_CERT_FILE || "",
      devSelfSigned: flag("DEV_HTTPS", false),
      httpRedirectPort: num("HTTP_REDIRECT_PORT", 0),
    },

    // Password hashing (requirement 1b-ii: Argon2id with a high work factor)
    argon2: {
      memoryCost: num("ARGON2_MEMORY_KIB", 65536), // 64 MiB
      timeCost: num("ARGON2_TIME_COST", 3),
      parallelism: num("ARGON2_PARALLELISM", 1),
    },

    // Rate limiting (requirement 1b-iii: max 5 registration requests per IP per hour)
    rateLimit: {
      registerMax: num("REGISTER_LIMIT_PER_HOUR", 5),
      registerWindowMs: num("REGISTER_WINDOW_MS", 60 * 60 * 1000),
      loginMax: num("LOGIN_LIMIT_PER_15_MIN", 30),
      otpMax: num("OTP_LIMIT_PER_HOUR", 20),
      generalMax: num("GENERAL_LIMIT_PER_15_MIN", 600),
    },

    // Verification (section 2)
    emailTokenTtlMs: num("EMAIL_TOKEN_TTL_HOURS", 24) * 3600 * 1000,
    resendEmailCooldownMs: num("RESEND_EMAIL_COOLDOWN_SECONDS", 60) * 1000,
    otp: {
      length: 6,
      ttlMs: num("OTP_TTL_MINUTES", 5) * 60 * 1000,
      maxAttempts: num("OTP_MAX_ATTEMPTS", 3),
      resendMs: num("OTP_RESEND_SECONDS", 60) * 1000,
      lockMs: num("OTP_LOCK_SECONDS", 60) * 1000, // after 3 wrong codes: entry and "Resend OTP" stay locked this long, then a new code can be sent
    },

    // Login lockout (section 3)
    login: {
      maxFailures: num("MAX_FAILED_LOGINS", 3),
      unlockCooldownMs: num("UNLOCK_COOLDOWN_SECONDS", 120) * 1000, // 2-minute cooling period
      unlockTokenTtlMs: num("UNLOCK_TOKEN_TTL_MINUTES", 60) * 60 * 1000,
    },
    sessionTtlMs: num("SESSION_HOURS", 8) * 3600 * 1000,

    // Delivery
    // Brevo (brevo.com, ex-Sendinblue): sends email over HTTPS, not SMTP.
    // Preferred over SMTP when both are set, since many hosts (Render's free
    // tier included) block outbound SMTP ports 25/465/587 entirely - no SMTP
    // configuration can work around that, only a different transport can.
    // Chosen over Resend specifically because Brevo's free tier only needs a
    // single verified sender address to send to any recipient; Resend's free
    // tier requires verifying an owned domain before it'll send to anyone
    // other than the account holder, which doesn't fit this app at all.
    brevo: {
      apiKey: env.BREVO_API_KEY || "",
      senderEmail: env.BREVO_SENDER_EMAIL || "",
      senderName: env.BREVO_SENDER_NAME || "",
    },
    smtp: {
      url: env.SMTP_URL || "",
      host: env.SMTP_HOST || "",
      port: num("SMTP_PORT", 587),
      secure: flag("SMTP_SECURE", false),
      user: env.SMTP_USER || "",
      pass: env.SMTP_PASS || "",
      from: env.MAIL_FROM || "",
    },
    // Country State City API (https://countrystatecity.in, free plan): the state and city dropdowns for every country except
    // the Philippines. Optional - without a key those fields are simply typed. Keep the key on the server only.
    geo: {
      apiKey: env.CSC_API_KEY || "",
    },
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || "",
      authToken: env.TWILIO_AUTH_TOKEN || "",
      from: env.TWILIO_FROM || "",
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID || "",
    },
    // Semaphore (semaphore.co): SMS gateway for Philippine numbers. Preferred
    // over Twilio when both are set, since this app is Philippines-only.
    semaphore: {
      apiKey: env.SEMAPHORE_API_KEY || "",
      senderName: env.SEMAPHORE_SENDER_NAME || "", // optional: a registered sender name instead of "Semaphore"
    },
    // TextBee (textbee.dev): sends through a paired Android phone's own SIM
    // and carrier plan, so there's no per-message charge at all. Preferred
    // over both Semaphore and Twilio when configured.
    textbee: {
      apiKey: env.TEXTBEE_API_KEY || "",
      deviceId: env.TEXTBEE_DEVICE_ID || "",
    },
    // Development helper: shows emails / SMS codes in the app instead of sending them.
    devOutbox: flag("DEV_OUTBOX", !isProd && !env.SMTP_URL && !env.SMTP_HOST),
    logMessages: flag("LOG_MESSAGES", !isProd),
  };

  // Test / embedding overrides (deep merge one level)
  for (const [key, value] of Object.entries(overrides)) {
    cfg[key] = value && typeof value === "object" && !Array.isArray(value) ? { ...cfg[key], ...value } : value;
  }

  cfg.geoConfigured = Boolean(cfg.geo.apiKey);
  cfg.brevoConfigured = Boolean(cfg.brevo.apiKey && cfg.brevo.senderEmail);
  cfg.smtpConfigured = Boolean(cfg.smtp.url || cfg.smtp.host);
  cfg.mailConfigured = cfg.brevoConfigured || cfg.smtpConfigured;
  cfg.mailProvider = cfg.brevoConfigured ? "Brevo" : cfg.smtpConfigured ? (cfg.smtp.url ? "SMTP_URL" : cfg.smtp.host) : "";
  cfg.semaphoreConfigured = Boolean(cfg.semaphore.apiKey);
  cfg.twilioConfigured = Boolean(cfg.twilio.accountSid && cfg.twilio.authToken && (cfg.twilio.from || cfg.twilio.messagingServiceSid));
  cfg.textbeeConfigured = Boolean(cfg.textbee.apiKey && cfg.textbee.deviceId);
  cfg.smsConfigured = cfg.textbeeConfigured || cfg.semaphoreConfigured || cfg.twilioConfigured;
  cfg.smsProvider = cfg.textbeeConfigured ? "TextBee" : cfg.semaphoreConfigured ? "Semaphore" : cfg.twilioConfigured ? "Twilio" : "";
  cfg.tlsConfigured = Boolean(cfg.tls.keyFile && cfg.tls.certFile) || cfg.tls.devSelfSigned;

  // Secret used to sign cookies and hash OTP codes
  if (!cfg.secret) {
    if (cfg.isProd) throw new Error("APP_SECRET is required in production (use a long random string).");
    const file = path.join(ROOT, "data", ".dev-secret");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    cfg.secret = fs.readFileSync(file, "utf8").trim();
  }

  if (cfg.isProd && !overrides.skipProdChecks) {
    const problems = [];
    if (cfg.devOutbox) problems.push("DEV_OUTBOX must be off in production.");
    if (!cfg.tlsConfigured && !cfg.trustProxy) problems.push("Production requires HTTPS: set TLS_KEY_FILE + TLS_CERT_FILE, or TRUST_PROXY when a reverse proxy terminates TLS 1.3.");
    if (!cfg.baseUrl.startsWith("https://")) problems.push("BASE_URL must start with https:// in production.");
    if (!cfg.databaseUrl) problems.push("Configure DATABASE_URL (a PostgreSQL connection string, e.g. from Neon).");
    if (!cfg.mailConfigured) problems.push("Configure BREVO_API_KEY+BREVO_SENDER_EMAIL (or SMTP_URL / SMTP_HOST) so verification emails can be sent.");
    if (!cfg.smsConfigured) problems.push("Configure TEXTBEE_API_KEY+TEXTBEE_DEVICE_ID (or SEMAPHORE_API_KEY, or the TWILIO_* variables) so OTP text messages can be sent.");
    if (problems.length) throw new Error("Cannot start in production:\n - " + problems.join("\n - "));
  }
  return cfg;
}