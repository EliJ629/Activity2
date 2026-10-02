/* =========================================================
   server/index.js  -  starts the server
     production ... HTTPS only (TLS 1.3 minimum), or behind a TLS 1.3 proxy (TRUST_PROXY)
     DEV_HTTPS=1 .. HTTPS with an automatic self-signed certificate (TLS 1.3)
     default dev .. plain http://localhost (browsers treat localhost as secure)
   ========================================================= */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { loadConfig, ROOT } from "./config.js";
import { openDb } from "./db.js";
import { createOutbox } from "./outbox.js";
import { createMailer } from "./mail.js";
import { createSms } from "./sms.js";
import { createApp } from "./app.js";

// Some hosts (Render included) assign a local-looking IPv6 interface to the
// container even though outbound IPv6 traffic never actually routes anywhere.
// dns.setDefaultResultOrder("ipv4first") only changes the order dns.lookup()
// returns results in - it does nothing for libraries that resolve IPv4 and
// IPv6 separately and pick between them themselves, which is exactly what
// nodemailer does: it resolves both, then picks one address AT RANDOM. On a
// host with a local IPv6 interface, that is a real coin flip between an
// address that works and one that fails with ENETUNREACH - confirmed by
// tracing nodemailer's own resolver directly, not guessed at. The fix that
// actually works is to stop IPv6 resolution from ever succeeding in the
// first place, for every resolver instance (dns.Resolver is what nodemailer,
// and most other libraries, actually instantiate and call).
dns.setDefaultResultOrder("ipv4first");
const noIPv6 = (hostname, optionsOrCallback, maybeCallback) => {
  const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
  if (typeof callback === "function") {
    queueMicrotask(() => callback(Object.assign(new Error(`IPv6 lookups are disabled: ${hostname}`), { code: "ENOTFOUND", hostname })));
  }
};
dns.resolve6 = noIPv6;
if (dns.Resolver) dns.Resolver.prototype.resolve6 = noIPv6;

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`\nConfiguration error: ${err.message}\n`);
  process.exit(1);
}
if (!config.databaseUrl) {
  console.error("\nConfiguration error: DATABASE_URL is not set in .env.\nThis app needs a PostgreSQL connection string - e.g. one from Neon (neon.tech), or a local Postgres: postgresql://user:pass@localhost:5432/dbname\n");
  process.exit(1);
}
const db = openDb(config.databaseUrl);
// Idempotent: every statement in schema.sql is CREATE TABLE/INDEX IF NOT
// EXISTS, so running it on every boot is safe and keeps "just works" dev
// setup - a brand new Neon database gets its tables on first `npm run dev`.
try {
  await db.query(fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8"));
} catch (err) {
  console.error(`\nCould not reach or set up the database: ${err.message}\nCheck that DATABASE_URL in .env is correct and the database is reachable.\n`);
  process.exit(1);
}
const outbox = createOutbox(config.devOutbox);
const app = await createApp({ config, db, mailer: createMailer(config, outbox), sms: createSms(config, outbox), outbox });

console.log(config.mailConfigured
  ? `Email: sending via ${config.mailProvider === "Brevo" ? "Brevo" : `SMTP (${config.mailProvider})`}.`
  : "Email: NOT configured (no BREVO_API_KEY+BREVO_SENDER_EMAIL or SMTP_URL/SMTP_HOST in .env) - verification links will only appear in the Dev Inbox, not in real inboxes.");
console.log(config.smsConfigured
  ? `SMS: sending via ${config.smsProvider}.`
  : "SMS: NOT configured (no SEMAPHORE_API_KEY or TWILIO_* vars in .env) - OTP codes will only appear in the Dev Inbox, not as real text messages.");

let tlsOptions = null;
if (config.tls.keyFile && config.tls.certFile) {
  tlsOptions = { key: fs.readFileSync(config.tls.keyFile), cert: fs.readFileSync(config.tls.certFile) };
} else if (config.tls.devSelfSigned) {
  const dir = path.join(ROOT, "data", "certs");
  const keyFile = path.join(dir, "dev-key.pem");
  const certFile = path.join(dir, "dev-cert.pem");
  if (!fs.existsSync(certFile)) {
    const selfsigned = (await import("selfsigned")).default;
    const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
      days: 365, keySize: 2048, algorithm: "sha256",
      extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] }],
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
    fs.writeFileSync(certFile, pems.cert);
  }
  tlsOptions = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

const shutdown = (server) => () => server.close(() => { db.close(); process.exit(0); });

if (tlsOptions) {
  const server = https.createServer({ ...tlsOptions, minVersion: "TLSv1.3" }, app); // TLS 1.3 only
  server.listen(config.port, () => console.log(`HTTPS (TLS 1.3) listening on ${config.baseUrl.startsWith("https") ? config.baseUrl : `https://localhost:${config.port}`}`));
  if (config.tls.httpRedirectPort) {
    http.createServer((req, res) => {
      res.writeHead(308, { Location: `${config.baseUrl}${req.url}` });
      res.end();
    }).listen(config.tls.httpRedirectPort);
  }
  process.on("SIGINT", shutdown(server)).on("SIGTERM", shutdown(server));
} else {
  const server = http.createServer(app);
  server.listen(config.port, () => {
    console.log(`Listening on http://localhost:${config.port}`);
    if (!config.isProd) console.log("Development mode over plain HTTP. Use `npm run dev:https` to test TLS 1.3.");
    else console.log("Behind a TLS-terminating proxy (TRUST_PROXY). Requests that are not HTTPS are refused.");
  });
  process.on("SIGINT", shutdown(server)).on("SIGTERM", shutdown(server));
}