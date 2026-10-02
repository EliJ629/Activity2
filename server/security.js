/* =========================================================
   server/security.js  -  CSRF, signed cookies, sessions, tokens
   ========================================================= */
import crypto from "node:crypto";

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

const hmac = (secret, value) => crypto.createHmac("sha256", secret).update(value).digest("base64url");

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- signed values (used for the CSRF cookie and the onboarding cookie) ---------- */
export function sign(secret, purpose, value) {
  return `${value}.${hmac(secret, `${purpose}:${value}`)}`;
}
export function unsign(secret, purpose, signed) {
  const str = String(signed || "");
  const i = str.lastIndexOf(".");
  if (i < 1) return null;
  const value = str.slice(0, i);
  return safeEqual(str.slice(i + 1), hmac(secret, `${purpose}:${value}`)) ? value : null;
}

/* ---------- cookies ---------- */
export function cookieOptions(req, extra = {}) {
  return { httpOnly: true, sameSite: "lax", secure: Boolean(req.secure), path: "/", ...extra };
}

/* ---------- CSRF (requirement 1b-iv) ----------
   Signed double-submit token. GET /api/csrf sets an HttpOnly cookie holding
   "random.signature" and returns the same string in the JSON body. Every
   state-changing request must send it back in the X-CSRF-Token header. A
   cross-site page can neither read the token nor forge a valid signature. */
export function csrfHandlers(config) {
  const COOKIE = "csrf";
  return {
    issue(req, res) {
      const token = sign(config.secret, "csrf", crypto.randomBytes(24).toString("base64url"));
      res.cookie(COOKIE, token, cookieOptions(req, { maxAge: 12 * 3600 * 1000 }));
      res.json({ token });
    },
    protect(req, res, next) {
      if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
      const cookie = req.cookies[COOKIE];
      const header = req.get("x-csrf-token");
      if (!cookie || !header || !safeEqual(cookie, header) || !unsign(config.secret, "csrf", cookie)) {
        return res.status(403).json({ code: "CSRF", message: "Security check failed. Please reload the page and try again." });
      }
      next();
    },
  };
}

/* ---------- minimal cookie parser (avoids one more dependency) ---------- */
export function cookieParser(req, _res, next) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
  }
  req.cookies = out;
  next();
}

/* ---------- HTTPS enforcement (requirement 1b-i) ---------- */
export function enforceHttps(config) {
  return (req, res, next) => {
    if (!config.isProd || req.secure) return next();
    if (req.method === "GET" || req.method === "HEAD") {
      return res.redirect(308, `${config.baseUrl}${req.originalUrl}`);
    }
    return res.status(426).json({ message: "HTTPS is required." });
  };
}
