import test from "node:test";
import assert from "node:assert/strict";
import { startServer, client, goodPayload, lastLink, lastOtp, sleep, insertVerifiedUser } from "./helpers.js";
import { canonicalEmail } from "../shared/validation.js";
import { loadConfig } from "../server/config.js";
import pg from "pg";
import "../server/db.js";   // registers the date / timestamp readers
import { createPostalService } from "../server/postal.js";
import { makeFakeZipApi } from "./fakeZipApi.js";

async function registerAndVerify(s, over = {}, { mobile = true } = {}) {
  const c = client(s.base);
  const payload = goodPayload(over);
  const reg = await c.post("/api/register", payload);
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  const link = s.outbox.list().find((m) => m.type === "email" && m.to === payload.email).body.match(/https?:\/\/\S+/)[0];
  const token = new URL(link).searchParams.get("token");
  const ver = await c.post("/api/verify-email", { token });
  assert.equal(ver.status, 200);
  if (mobile) {
    const code = lastOtp(s.outbox);
    const otp = await c.post("/api/otp/verify", { code });
    assert.equal(otp.status, 200, JSON.stringify(otp.data));
  }
  return { c, payload };
}

test("CSRF: state-changing requests without a token are rejected", async () => {
  const s = await startServer();
  const c = client(s.base);
  const r = await c.post("/api/login", { email: "a@gmail.com", password: "x" }, { csrf: false });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "CSRF");
  await s.close();
});

test("registration validates every rule on the server", async () => {
  const s = await startServer();
  const c = client(s.base);
  const r = await c.post("/api/register", goodPayload({
    firstName: "J", lastName: "Cruz123", middleInitial: "AB", birthday: "09/30/2020",
    email: "juan@mycompany.com", password: "weakpass", confirmPassword: "different", mobile: "12345",
    address: { houseStreet: "", countryCode: "PH", state: "", city: "", zip: "99999" },
  }));
  assert.equal(r.status, 422);
  for (const k of ["firstName", "lastName", "middleInitial", "birthday", "email", "password", "confirmPassword", "mobile", "houseStreet", "state", "city", "zip"]) {
    assert.ok(r.data.errors[k], `expected an error for ${k}`);
  }
  assert.match(r.data.errors.birthday, /13 years/);
  assert.match(r.data.errors.email, /public email/i);
  await s.close();
});

test("register -> password is stored as Argon2id; an unverified duplicate is replaced, a verified one is refused", async () => {
  const s = await startServer();
  const c = client(s.base);
  const p = goodPayload();
  assert.equal((await c.post("/api/register", p)).status, 201);
  const row = await s.db.prepare("SELECT * FROM users WHERE email = ?").get(p.email);
  assert.match(row.password_hash, /^\$argon2id\$/);
  assert.ok(!row.password_hash.includes(p.password));
  assert.equal(row.mobile_number, "+639171234567");
  assert.equal(row.birthday, "1998-03-25");
  assert.equal(row.email_verified_at, null);
  assert.equal(row.mobile_verified, false);
  const addr = await s.db.prepare("SELECT * FROM addresses WHERE user_id = ?").get(row.id);
  assert.equal(addr.country, "Philippines");
  // the email follows section 2b
  const mail = s.outbox.list()[0];
  assert.equal(mail.subject, `Action Required: Verify your email address for ${s.config.appName}`);
  assert.match(mail.body, /^Dear Juan,/);
  assert.match(mail.body, /expire in 24 hours/);

  // Registering again before verifying replaces the abandoned attempt (e.g. a
  // reloaded page after the first email never arrived) - nobody has proven
  // ownership of the email yet, so this must succeed, not 409.
  const retry = await c.post("/api/register", { ...p, email: p.email.toUpperCase(), firstName: "Juana" });
  assert.equal(retry.status, 201, JSON.stringify(retry.data));
  const rows = await s.db.prepare("SELECT * FROM users WHERE email = ?").all(p.email);
  assert.equal(rows.length, 1); // the old row was replaced, not duplicated
  assert.equal(rows[0].first_name, "Juana");
  assert.notEqual(rows[0].id, row.id);

  // Once verified, the email is genuinely taken and a duplicate is refused.
  const token = new URL(s.outbox.list()[0].body.match(/https?:\/\/\S+/)[0]).searchParams.get("token"); // [0] = newest (outbox prepends)
  assert.equal((await c.post("/api/verify-email", { token })).status, 200);
  const dup = await c.post("/api/register", goodPayload({ email: p.email }));
  assert.equal(dup.status, 409);
  await s.close();
});

test("an unverified email is told to verify first, whatever password is typed, and it is never counted or locked", async () => {
  const s = await startServer();
  const c = client(s.base);
  const p = goodPayload();
  await c.post("/api/register", p);
  const expected = /check your email.*click the verification link.*enter the OTP.*complete verification/i;
  for (const password of [p.password, "Wrong!Password1", "x", p.password, "Wrong!Password2", "Wrong!Password3"]) {
    const r = await c.post("/api/login", { email: p.email, password });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, "EMAIL_NOT_VERIFIED");
    assert.match(r.data.message, expected);
    assert.equal(r.data.attemptsLeft, undefined);
  }
  const row = await s.db.prepare("SELECT failed_login_attempts, is_locked FROM users WHERE email = ?").get(p.email);
  assert.equal(row.failed_login_attempts, 0);       // six tries, none counted
  assert.equal(row.is_locked, false);
  await s.close();
});

test("email link: single use, expires after 24 h", async () => {
  const s = await startServer();
  const c = client(s.base);
  const p = goodPayload();
  await c.post("/api/register", p);
  const token = new URL(s.outbox.list()[0].body.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  const stored = await s.db.prepare("SELECT * FROM verification_tokens WHERE type = 'email_verify'").get();
  assert.notEqual(stored.token_hash, token); // only the hash is stored
  const ttl = Date.parse(stored.expired_at) - Date.parse(stored.created_at);
  assert.ok(Math.abs(ttl - 24 * 3600 * 1000) < 2000);
  assert.equal((await c.post("/api/verify-email", { token })).status, 200);
  assert.equal((await c.post("/api/verify-email", { token })).status, 400);

  const p2 = goodPayload();
  await c.post("/api/register", p2);
  const t2 = new URL(s.outbox.list()[0].body.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  await s.db.prepare("UPDATE verification_tokens SET expired_at = ? WHERE type='email_verify' AND used_at IS NULL").run(new Date(Date.now() - 1000).toISOString());
  const expired = await c.post("/api/verify-email", { token: t2 });
  assert.equal(expired.status, 400);
  assert.equal(expired.data.code, "TOKEN_EXPIRED");
  await s.close();
});

test("OTP: sent after email verification, 3 attempts then lockout, resend only after the cooldown", async () => {
  const s = await startServer();
  const c = client(s.base);
  const p = goodPayload();
  await c.post("/api/register", p);
  const token = new URL(s.outbox.list()[0].body.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  const ver = await c.post("/api/verify-email", { token });
  assert.equal(ver.data.next, "mobile");
  const sms = s.outbox.list().find((m) => m.type === "sms");
  assert.equal(sms.to, "+639171234567");
  assert.match(sms.body, /\b\d{6}\b/);
  assert.match(sms.body, /GMT\+8/); // Philippine time zone format
  assert.match(sms.body, /5 minutes/);
  const code = lastOtp(s.outbox);
  const wrong = code === "000000" ? "111111" : "000000";

  assert.equal((await c.post("/api/otp/send", {})).status, 429); // resend cooldown
  const w1 = await c.post("/api/otp/verify", { code: wrong });
  assert.equal(w1.status, 400); assert.equal(w1.data.attemptsLeft, 2);
  const w2 = await c.post("/api/otp/verify", { code: wrong });
  assert.equal(w2.data.attemptsLeft, 1);
  const w3 = await c.post("/api/otp/verify", { code: wrong });
  assert.equal(w3.status, 423);
  assert.equal((await c.post("/api/otp/verify", { code })).status, 423); // even the right code is refused while locked
  await sleep(1600);
  assert.equal((await c.post("/api/otp/send", {})).status, 423); // still locked (4 s lock in this test)
  await sleep(2600);
  const resend = await c.post("/api/otp/send", {});
  assert.equal(resend.status, 200, JSON.stringify(resend.data));
  const ok = await c.post("/api/otp/verify", { code: lastOtp(s.outbox) });
  assert.equal(ok.status, 200);
  assert.equal((await s.db.prepare("SELECT mobile_verified v FROM users WHERE email=?").get(p.email)).v, true);
  await s.close();
});

test("sign in, /me, accounts list (masked), logout", async () => {
  const s = await startServer();
  const { c, payload } = await registerAndVerify(s);
  await registerAndVerify(s, { firstName: "Maria", lastName: "Santos" });
  const login = await c.post("/api/login", { email: payload.email, password: payload.password });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const me = await c.get("/api/me");
  assert.equal(me.data.user.firstName, "Juan");
  assert.equal(me.data.user.address.countryCode, "PH");
  const accounts = await c.get("/api/accounts");
  assert.equal(accounts.data.total, 2);
  assert.equal(accounts.data.accounts[0].isYou, true);
  assert.ok(accounts.data.accounts.every((a) => /\*/.test(a.email) && /^\S+ \S\.$/.test(a.name)));
  await c.post("/api/logout", {});
  assert.equal((await c.get("/api/me")).status, 401);
  await s.close();
});

test("lockout: 3 failures lock the account, unlock email is sent, 2-minute cooling is enforced", async () => {
  const s = await startServer(); // cooldown shortened to 2 s for the test
  const { c, payload } = await registerAndVerify(s);
  const before = s.outbox.list().length;
  const f1 = await c.post("/api/login", { email: payload.email, password: "Bad!Password111" });
  const f2 = await c.post("/api/login", { email: payload.email, password: "Bad!Password111" });
  assert.equal(f1.status, 401); assert.equal(f2.status, 401);
  const f3 = await c.post("/api/login", { email: payload.email, password: "Bad!Password111" });
  assert.equal(f3.status, 423);
  assert.equal(f3.data.code, "ACCOUNT_LOCKED");
  assert.equal(s.outbox.list().length, before + 1);
  const mail = s.outbox.list()[0];
  assert.match(mail.subject, /locked/i);
  const token = new URL(mail.body.match(/https?:\/\/\S+/)[0]).searchParams.get("token");

  // even the correct password is refused while locked
  assert.equal((await c.post("/api/login", { email: payload.email, password: payload.password })).status, 423);
  assert.equal(s.outbox.list().length, before + 1); // no email flood

  const status = await c.post("/api/unlock/status", { token });
  assert.equal(status.data.state, "cooling");
  const early = await c.post("/api/unlock", { token });
  assert.equal(early.status, 429);
  assert.equal(early.data.code, "UNLOCK_COOLDOWN");
  await sleep(2100);
  const status2 = await c.post("/api/unlock/status", { token });
  assert.equal(status2.data.state, "ready");
  assert.equal((await c.post("/api/unlock", { token })).status, 200);
  assert.equal((await c.post("/api/unlock", { token })).status, 400); // single use
  assert.equal((await c.post("/api/login", { email: payload.email, password: payload.password })).status, 200);
  assert.equal((await s.db.prepare("SELECT failed_login_attempts n FROM users WHERE email=?").get(payload.email)).n, 0);
  await s.close();
});

test("email-available: only a VERIFIED account makes an email unavailable (same rule as registering)", async () => {
  const s = await startServer();
  const c = client(s.base);
  const p = goodPayload();
  const check = async (email) => (await c.get(`/api/email-available?email=${encodeURIComponent(email)}`)).data.available;
  assert.equal(await check(p.email), true);                       // nobody has it
  assert.equal((await c.post("/api/register", p)).status, 201);
  assert.equal(await check(p.email), true);                       // registered but never verified: registering again would replace it
  const token = new URL(s.outbox.list()[0].body.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  assert.equal((await c.post("/api/verify-email", { token })).status, 200);
  assert.equal(await check(p.email), false);                      // verified: taken
  assert.equal(await check(p.email.toUpperCase()), false);        // case does not matter
  assert.equal((await c.post("/api/register", goodPayload({ email: p.email }))).status, 409); // and registering agrees with the check
  assert.equal(await check(""), true);                            // nothing typed: nothing to block
  await s.close();
});

test("login: a wrong password reports how many attempts are left", async () => {
  const s = await startServer();
  const { c, payload } = await registerAndVerify(s);
  const bad = () => c.post("/api/login", { email: payload.email, password: "Bad!Password111" });
  const r1 = await bad(); const r2 = await bad(); const r3 = await bad();
  assert.equal(r1.status, 401); assert.equal(r2.status, 401);
  assert.equal(r1.data.message, "Invalid email or password.");   // the message itself stays generic
  assert.equal(r1.data.attemptsLeft, 2);                          // 2 more, then 1 more, then locked
  assert.equal(r2.data.attemptsLeft, 1);
  assert.equal(r3.status, 423);
  assert.equal(r3.data.code, "ACCOUNT_LOCKED");
  assert.match(r3.data.message, /locked after 3 failed attempts in a row/);
  await s.close();
});

test("a successful login resets the failure counter (only consecutive failures count)", async () => {
  const s = await startServer();
  const { c, payload } = await registerAndVerify(s);
  await c.post("/api/login", { email: payload.email, password: "Bad!Password111" });
  await c.post("/api/login", { email: payload.email, password: "Bad!Password111" });
  assert.equal((await c.post("/api/login", { email: payload.email, password: payload.password })).status, 200);
  assert.equal((await c.post("/api/login", { email: payload.email, password: "Bad!Password111" })).status, 401);
  assert.equal((await c.post("/api/login", { email: payload.email, password: "Bad!Password111" })).status, 401);
  await s.close();
});

test("an email with no account is told to register, with no attempt count and no lock", async () => {
  const s = await startServer();
  const c = client(s.base);
  for (let i = 0; i < 8; i++) {                      // well past the lock threshold of 3
    const r = await c.post("/api/login", { email: "ghost.notyet@gmail.com", password: "Whatever!123" });
    assert.equal(r.status, 404);
    assert.equal(r.data.code, "EMAIL_NOT_REGISTERED");
    assert.equal(r.data.message, "This email is not yet registered on this website; register now to log in.");
    assert.equal(r.data.attemptsLeft, undefined);
  }
  await s.close();
});

test("email verified but OTP not entered: signing in opens the OTP step and texts a code", async () => {
  const s = await startServer({ rateLimit: { registerMax: 500, loginMax: 500, otpMax: 500, generalMax: 5000 }, otp: { resendMs: 0, lockMs: 4000 } });
  const { c, payload } = await registerAndVerify(s, {}, { mobile: false });   // email verified; verify-email texted the first code
  const smsCount = () => s.outbox.list().filter((m) => m.type === "sms").length;
  const before = smsCount();

  // 1) a code is already active: signing in doesn't text another, but still opens the OTP step
  const c2 = client(s.base);
  const r1 = await c2.post("/api/login", { email: payload.email, password: payload.password });
  assert.equal(r1.status, 403);
  assert.equal(r1.data.code, "MOBILE_NOT_VERIFIED");
  assert.equal(r1.data.otpSent, false);
  assert.equal(smsCount(), before);
  assert.equal((await c2.get("/api/otp/status")).status, 200);                // the OTP-entry session was granted

  // 2) no active code (it was used up or expired): signing in texts a fresh one
  await s.db.query("UPDATE verification_tokens SET used_at = $1 WHERE type = 'mobile_otp'", [new Date().toISOString()]);
  const r2 = await c2.post("/api/login", { email: payload.email, password: payload.password });
  assert.equal(r2.data.code, "MOBILE_NOT_VERIFIED");
  assert.equal(r2.data.otpSent, true);
  assert.equal(smsCount(), before + 1);
  assert.equal((await c2.get("/api/otp/status")).data.active, true);          // the OTP screen opens with a code waiting

  // 3) a wrong password gets none of this: no OTP session, no text, and it counts as a failed attempt
  const c3 = client(s.base);
  const bad = await c3.post("/api/login", { email: payload.email, password: "Wrong!Password11" });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.attemptsLeft, 2);
  assert.equal(smsCount(), before + 1);
  assert.equal((await c3.get("/api/otp/status")).status, 401);

  // 4) entering the code finishes verification, and then signing in works
  assert.equal((await c2.post("/api/otp/verify", { code: lastOtp(s.outbox) })).status, 200);
  const done = await c2.post("/api/login", { email: payload.email, password: payload.password });
  assert.equal(done.status, 200);
  await s.close();
});

test("an email that was tried before it existed starts with all its attempts once it registers", async () => {
  const s = await startServer();
  const c = client(s.base);
  const ghost = "ghost.notyet@gmail.com";
  for (let i = 0; i < 6; i++) await c.post("/api/login", { email: ghost, password: "Whatever!123" });
  const { c: c2, payload } = await registerAndVerify(s, { email: ghost });
  const first = await c2.post("/api/login", { email: payload.email, password: "Bad!Password111" });
  assert.equal(first.status, 401);
  assert.equal(first.data.attemptsLeft, 2);
  await s.close();
});

test("rate limit: only 5 registration requests per IP per hour", async () => {
  const s = await startServer({ rateLimit: { registerMax: 5 } });
  const c = client(s.base);
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await c.post("/api/register", goodPayload())).status);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429, 429]);
  const last = await c.post("/api/register", goodPayload());
  assert.equal(last.data.code, "RATE_LIMIT");
  assert.ok(last.data.retryAfter > 3000);
  await s.close();
});

test("non-Philippine country: US ZIP + US mobile prefix, and mobile is checked against the country", async () => {
  const s = await startServer();
  const c = client(s.base);
  const us = { houseStreet: "1600 Pennsylvania Ave NW", countryCode: "US", state: "District of Columbia", city: "Washington", zip: "20500" };
  const ok = await c.post("/api/register", goodPayload({ mobile: "(202) 555-0123", address: us }));
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const wrongZip = await c.post("/api/register", goodPayload({ mobile: "(202) 555-0123", address: { ...us, zip: "1000" } }));
  assert.match(wrongZip.data.errors.zip, /format/);
  const wrongPhone = await c.post("/api/register", goodPayload({ mobile: "917 123 4567", address: us }));
  assert.ok(wrongPhone.data.errors.mobile);
  await s.close();
});

test("HTTPS is enforced in production mode", async () => {
  const s = await startServer({ isProd: true, skipProdChecks: true, secret: "test-secret", baseUrl: "https://example.test" });
  const get = await fetch(s.base + "/api/csrf", { redirect: "manual" });
  assert.equal(get.status, 308);
  assert.match(get.headers.get("location"), /^https:\/\/example\.test\//);
  const post = await fetch(s.base + "/api/login", { method: "POST" });
  assert.equal(post.status, 426);
  await s.close();
});

test("security headers are set", async () => {
  const s = await startServer();
  const r = await fetch(s.base + "/api/config");
  assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-powered-by"), null);
  await s.close();
});


/* ================= Philippine ZIP, mobile, email shape ================= */

test("registration: a Philippine ZIP must belong to the chosen city", async () => {
  const s = await startServer();
  const c = client(s.base);
  const addr = goodPayload().address;
  const wrongZip = await c.post("/api/register", goodPayload({ address: { ...addr, zip: "1100" } })); // a Quezon City ZIP
  assert.equal(wrongZip.status, 422);
  assert.match(wrongZip.data.errors.zip, /1100 isn't a postal code for Caloocan City/);
  const forged = await c.post("/api/register", goodPayload({ address: { ...addr, cityCode: "137404000" } })); // Quezon City's code, Caloocan's name
  assert.equal(forged.status, 422);
  assert.match(forged.data.errors.city, /doesn't match/);
  const noCode = await c.post("/api/register", goodPayload({ address: { ...addr, cityCode: "" } }));
  assert.equal(noCode.status, 422);
  assert.match(noCode.data.errors.city, /Choose your city/);
  const rows = await s.db.prepare("SELECT count(*) AS n FROM users").get();
  assert.equal(rows.n, 0);                                                         // none of those created an account
  assert.equal((await c.post("/api/register", goodPayload())).status, 201);       // the right ZIP for the right city does
  await s.close();
});

test("the form can ask which ZIPs a Philippine city has, and whether one it typed belongs", async () => {
  const s = await startServer();
  const c = client(s.base);
  const ok = await c.get("/api/ph-postal?cityCode=137501000");
  assert.equal(ok.status, 200);
  assert.equal(ok.data.city, "Caloocan City");
  assert.equal(ok.data.source, "api");
  assert.ok(ok.data.zips.includes("1400") && !ok.data.zips.includes("1100"));
  assert.equal(ok.data.valid, undefined);                                   // no ZIP given, nothing to judge
  const good = await c.get("/api/ph-postal?cityCode=137501000&zip=1400");
  assert.equal(good.data.valid, true);
  const bad = await c.get("/api/ph-postal?cityCode=137501000&zip=1100");   // the same check registration uses
  assert.equal(bad.data.valid, false);
  assert.match(bad.data.message, /1100 isn't a postal code for Caloocan City\. It belongs to Quezon City\./);
  assert.equal((await c.get("/api/ph-postal?cityCode=999999999")).status, 404);
  assert.equal((await c.get("/api/ph-postal")).status, 404);
  await s.close();
});

test("registration still checks the ZIP against the city when the ZIP API is down (the table answers)", async () => {
  const offline = createPostalService({ fetchImpl: makeFakeZipApi({ mode: "down" }).fetchImpl, extras: {} });
  const s = await startServer({}, { postal: offline });
  const c = client(s.base);
  const addr = goodPayload().address;
  const wrong = await c.post("/api/register", goodPayload({ address: { ...addr, zip: "1100" } }));
  assert.equal(wrong.status, 422);
  assert.match(wrong.data.errors.zip, /1100 isn't a postal code for Caloocan City/);
  assert.equal((await c.post("/api/register", goodPayload())).status, 201);
  const lookup = await c.get("/api/ph-postal?cityCode=137501000&zip=1100");
  assert.equal(lookup.data.source, "table");
  assert.equal(lookup.data.valid, false);
  await s.close();
});

test("registration: a leading 0 on a +63 mobile number and badly shaped emails are refused by the server too", async () => {
  const s = await startServer();
  const c = client(s.base);
  const zero = await c.post("/api/register", goodPayload({ mobile: "09171234567" }));
  assert.equal(zero.status, 422);
  assert.match(zero.data.errors.mobile, /Don't start with 0/);
  for (const email of ["a..b@gmail.com", ".a@gmail.com", "a.@gmail.com", `${"x".repeat(65)}@gmail.com`]) {
    const r = await c.post("/api/register", goodPayload({ email }));
    assert.equal(r.status, 422, email);
    assert.ok(r.data.errors.email, email);
  }
  await s.close();
});

/* ================= one mailbox, one account ================= */

test("an email can't be registered again as a dotted or +tagged variant of a verified mailbox", async () => {
  const s = await startServer();
  const c = client(s.base);
  const existing = ["juan.cruz@gmail.com", "maria.s@outlook.com"];
  for (const e of existing) await insertVerifiedUser(s.db, e);
  const taken = new Set(existing.map(canonicalEmail));
  const candidates = [
    "juan.cruz@gmail.com", "juancruz@gmail.com", "j.u.a.n.c.r.u.z@gmail.com", "juan.cruz+news@gmail.com", "JUAN.CRUZ@googlemail.com", // same Gmail mailbox
    "juan.cruz2@gmail.com", "juancruz@yahoo.com", "juancruz@outlook.com",                                                            // different
    "maria.s+x@outlook.com", "marias@outlook.com",                                                                                    // Outlook: +tag ignored, dots count
  ];
  for (const email of candidates) {
    const r = await c.get(`/api/email-available?email=${encodeURIComponent(email)}`);
    assert.equal(r.data.available, !taken.has(canonicalEmail(email)), email);     // the SQL rule agrees with canonicalEmail() for every one
  }
  assert.equal((await c.post("/api/register", goodPayload({ email: "juancruz+test@gmail.com" }))).status, 409);
  assert.equal((await c.post("/api/register", goodPayload({ email: "juan.cruz3@gmail.com" }))).status, 201);
  await s.close();
});

/* ================= requests sent at the same moment ================= */

const FAST = { rateLimit: { registerMax: 500, loginMax: 500, otpMax: 500, generalMax: 5000 } };

test("login: wrong passwords sent at the same moment still stop at 3 and lock the account once", async () => {
  const s = await startServer(FAST, { dbDelayMs: 25 });
  const { c, payload } = await registerAndVerify(s);
  await c.warm();
  const rs = await Promise.all(Array.from({ length: 12 }, () => c.post("/api/login", { email: payload.email, password: "Wrong!Password11" })));
  const invalid = rs.filter((r) => r.data.code === "INVALID_CREDENTIALS");
  assert.ok(invalid.length <= 2, `${invalid.length} wrong guesses were counted as ordinary tries`);
  assert.equal(new Set(invalid.map((r) => r.data.attemptsLeft)).size, invalid.length);   // no two requests shared a count
  const row = await s.db.prepare("SELECT failed_login_attempts, is_locked FROM users WHERE email = ?").get(payload.email);
  assert.equal(row.is_locked, true);
  assert.ok(row.failed_login_attempts >= 3);
  assert.equal(s.outbox.list().filter((m) => m.to === payload.email && m.body.includes("/unlock?token=")).length, 1); // one unlock email, not twelve
  await s.close();
});

test("login: the right password sent after the lock is still refused", async () => {
  const s = await startServer(FAST);
  const { c, payload } = await registerAndVerify(s);
  for (let i = 0; i < 3; i++) await c.post("/api/login", { email: payload.email, password: "Wrong!Password11" });
  const good = await c.post("/api/login", { email: payload.email, password: payload.password });
  assert.equal(good.status, 423);
  await s.close();
});

test("OTP: wrong codes sent at the same moment still stop at 3", async () => {
  const s = await startServer(FAST, { dbDelayMs: 25 });
  const { c } = await registerAndVerify(s, {}, { mobile: false });
  await c.warm();
  const real = lastOtp(s.outbox);
  const wrongCodes = Array.from({ length: 12 }, (_, i) => String((Number(real) + 1 + i) % 1000000).padStart(6, "0"));
  const rs = await Promise.all(wrongCodes.map((code) => c.post("/api/otp/verify", { code })));
  assert.equal(rs.filter((r) => r.data.code === "OTP_WRONG").length, 2);   // tries 1 and 2; the 3rd locks it and the rest are turned away
  assert.equal(rs.filter((r) => r.status === 423).length, 10);
  assert.equal((await c.post("/api/otp/verify", { code: real })).status, 423); // even the right code is refused now
  await s.close();
});

test("an email link used twice at the same moment works exactly once", async () => {
  const s = await startServer(FAST, { dbDelayMs: 25 });
  const c = client(s.base);
  const payload = goodPayload();
  assert.equal((await c.post("/api/register", payload)).status, 201);
  const token = new URL(lastLink(s.outbox, /verify/i)).searchParams.get("token");
  const clients = Array.from({ length: 6 }, () => client(s.base));
  await Promise.all(clients.map((x) => x.warm()));
  const rs = await Promise.all(clients.map((x) => x.post("/api/verify-email", { token })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.data.code === "TOKEN_USED"));
  await s.close();
});

test("OTP: a burst of text-message requests sends one SMS", async () => {
  const s = await startServer({ ...FAST, otp: { resendMs: 0, lockMs: 4000 } }, { smsDelayMs: 300 });
  const { c } = await registerAndVerify(s, {}, { mobile: false });
  await c.warm();
  const smsCount = () => s.outbox.list().filter((m) => m.type === "sms").length;
  const before = smsCount();
  const rs = await Promise.all(Array.from({ length: 8 }, () => c.post("/api/otp/send", {})));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(rs.filter((r) => r.status === 429).length, 7);
  assert.equal(smsCount() - before, 1);
  await s.close();
});

/* ================= database layout (section 4 of the requirements) ================= */

test("database columns have the types the requirements ask for", async () => {
  const s = await startServer();
  const { rows } = await s.db.query(`SELECT table_name, column_name, data_type, character_maximum_length AS len, udt_name
                                     FROM information_schema.columns WHERE table_schema = current_schema()
                                       AND table_name IN ('users', 'addresses', 'verification_tokens')`);
  const typeOf = (table, col) => {
    const r = rows.find((x) => x.table_name === table && x.column_name === col);
    if (!r) return "(missing)";
    if (r.data_type === "character varying") return `varchar(${r.len})`;
    if (r.data_type === "USER-DEFINED") return `enum:${r.udt_name}`;
    return r.data_type === "timestamp without time zone" ? "timestamp" : r.data_type;
  };
  const expected = {
    users: { id: "uuid", first_name: "varchar(50)", last_name: "varchar(50)", middle_initial: "varchar(2)", birthday: "date", password_hash: "varchar(255)",
      email: "varchar(255)", email_verified_at: "timestamp", mobile_number: "varchar(20)", mobile_verified: "boolean", failed_login_attempts: "integer",
      is_locked: "boolean", lockout_until: "timestamp", created_at: "timestamp", updated_at: "timestamp" },
    addresses: { id: "uuid", user_id: "uuid", house_street: "varchar(255)", country: "varchar(100)", city: "varchar(100)", state: "varchar(100)", zip_code: "varchar(20)" },
    verification_tokens: { id: "uuid", user_id: "uuid", token_hash: "varchar(255)", type: "enum:verification_token_type", expired_at: "timestamp" },
  };
  for (const [table, cols] of Object.entries(expected)) for (const [col, type] of Object.entries(cols)) assert.equal(typeOf(table, col), type, `${table}.${col}`);
  const labels = (await s.db.query("SELECT unnest(enum_range(NULL::verification_token_type))::text AS v")).rows.map((r) => r.v);
  assert.deepEqual(labels, ["email_verify", "mobile_otp", "password_reset", "account_unlock"]);
  const fks = (await s.db.query("SELECT conrelid::regclass::text AS t, confdeltype FROM pg_constraint WHERE contype = 'f' AND confrelid = 'users'::regclass")).rows;
  assert.ok(fks.length >= 2 && fks.every((f) => f.confdeltype === "c"));          // deleting a user deletes what hangs off it
  const unique = (await s.db.query("SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND contype = 'u' AND conname = 'users_email_key'")).rowCount;
  assert.equal(unique, 1);
  await s.close();
});

test("dates still reach the app as plain text with the real DATE / TIMESTAMP columns", async () => {
  const s = await startServer();
  const { c, payload } = await registerAndVerify(s);
  const login = await c.post("/api/login", { email: payload.email, password: payload.password });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.birthday, "1998-03-25");
  assert.match(login.data.user.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const me = await c.get("/api/me");
  assert.equal(me.data.user.birthday, "1998-03-25");
  assert.ok(Date.parse(me.data.sessionExpiresAt) > Date.now());
  await s.close();
});

/* ================= state / city lists for other countries (Country State City API, through the server) ================= */

test("GET /api/geo/states lists a country's states with their codes", async () => {
  const s = await startServer();
  const r = await client(s.base).get("/api/geo/states?country=us");          // lower case is fine
  assert.equal(r.status, 200);
  assert.equal(r.data.available, true);
  assert.deepEqual(r.data.states.map((x) => x.name), ["California", "New York", "Texas"]);
  assert.equal(r.data.states[0].code, "CA");
  await s.close();
});

test("GET /api/geo/cities lists a state's cities, each name once", async () => {
  const s = await startServer();
  const r = await client(s.base).get("/api/geo/cities?country=US&state=CA");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.cities.map((x) => x.name), ["Los Angeles", "San Francisco", "San Jose"]);
  await s.close();
});

test("the geo routes refuse the Philippines, unknown countries and odd input", async () => {
  const s = await startServer();
  const c = client(s.base);
  for (const url of ["/api/geo/states", "/api/geo/states?country=PH", "/api/geo/states?country=ZZ", "/api/geo/states?country=USA", "/api/geo/states?country=US%20",
    "/api/geo/cities?country=US", "/api/geo/cities?country=PH&state=NCR", "/api/geo/cities?country=US&state=../etc", "/api/geo/cities?country=US&state=C%27A", "/api/geo/cities?country=US&state=ABCDEFGHIJK"]) {
    const r = await c.get(url);
    assert.equal(r.status, 400, url);
    assert.ok(r.data.code && r.data.message, url);
  }
  await s.close();
});

test("without an API key the lists are simply unavailable (the form types instead), and the key never reaches the browser", async () => {
  const { createGeoService } = await import("../server/geo.js");
  const s = await startServer({}, { geo: createGeoService({ apiKey: "" }) });
  const c = client(s.base);
  assert.deepEqual((await c.get("/api/geo/states?country=US")).data, { available: false, states: [] });
  assert.deepEqual((await c.get("/api/geo/cities?country=US&state=CA")).data, { available: false, cities: [] });
  await s.close();

  const withKey = await startServer();
  const raw = await fetch(withKey.base + "/api/geo/states?country=US");
  const text = await raw.text();
  const headers = JSON.stringify([...raw.headers]);
  assert.ok(!text.includes("test-key") && !headers.includes("test-key"));
  await withKey.close();
});

test("when the API is down the route still answers, with 'unavailable'", async () => {
  const { createGeoService } = await import("../server/geo.js");
  const { makeFakeGeoApi, FAKE_KEY } = await import("./fakeGeoApi.js");
  const s = await startServer({}, { geo: createGeoService({ apiKey: FAKE_KEY, fetchImpl: makeFakeGeoApi({ mode: "500" }).fetchImpl, log: () => {} }) });
  const r = await client(s.base).get("/api/geo/states?country=US");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { available: false, states: [] });
  await s.close();
});

test("a state and city picked from the lists, even with / – ‘ in them, can be registered", async () => {
  const s = await startServer();
  const c = client(s.base);
  const au = { houseStreet: "1 Main St", countryCode: "AU", state: "South Australia", city: "Orroroo/Carrieton", zip: "5000" };
  const ok = await c.post("/api/register", goodPayload({ mobile: "412 345 678", address: au }));
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const script = await c.post("/api/register", goodPayload({ mobile: "412 345 678", address: { ...au, city: "<script>alert(1)</script>" } }));
  assert.equal(script.status, 422);
  assert.ok(script.data.errors.city);
  await s.close();
});

test("outside the Philippines the server also holds ZIPs to 4 to 8 letters or numbers", async () => {
  const s = await startServer();
  const c = client(s.base);
  const us = { houseStreet: "1600 Pennsylvania Ave NW", countryCode: "US", state: "District of Columbia", city: "Washington", zip: "20500" };
  const reg = (zip) => c.post("/api/register", goodPayload({ mobile: "(202) 555-0123", address: { ...us, zip } }));
  for (const zip of ["205", "205001234", "20500-1234", "2 0 5 0 0", "2050#"]) {
    const r = await reg(zip);
    assert.equal(r.status, 422, zip);
    assert.ok(r.data.errors.zip, zip);
  }
  assert.match((await reg("205")).data.errors.zip, /4 to 8 letters or numbers/);
  assert.match((await reg("2050#")).data.errors.zip, /letters and numbers/);
  assert.match((await reg("9021")).data.errors.zip, /format/);               // 4 digits, but not a US ZIP
  assert.equal((await reg("20500")).status, 201);
  await s.close();
});

test("login: requests that arrive while the account is being locked do not each send an unlock email", async () => {
  // With every query slowed down, the stretch between "the account is flagged locked" and "its unlock link exists" is wide
  // (about 0.2 s), so logins sent every 25 ms are sure to land inside it.
  const s = await startServer(FAST, { dbDelayMs: 100 });
  const { c, payload } = await registerAndVerify(s);
  await c.warm();
  const wrong = { email: payload.email, password: "Wrong!Password11" };
  await c.post("/api/login", wrong);
  await c.post("/api/login", wrong);                       // two wrong guesses so far
  const sent = [c.post("/api/login", wrong)];              // this one crosses the line and locks the account
  for (let i = 0; i < 40; i++) { await sleep(25); sent.push(c.post("/api/login", wrong)); }
  const rs = await Promise.all(sent);
  assert.ok(rs.filter((r) => r.status === 423).length >= 20);
  const unlocks = s.outbox.list().filter((m) => m.to === payload.email && m.body.includes("/unlock?token="));
  assert.equal(unlocks.length, 1, `${unlocks.length} unlock emails were sent`);
  await s.close();
});

/* ================= OTP lock after 3 wrong codes ================= */

test("the lock after 3 wrong OTP codes defaults to 60 seconds", () => {
  const saved = { s: process.env.OTP_LOCK_SECONDS, m: process.env.OTP_LOCK_MINUTES };
  delete process.env.OTP_LOCK_SECONDS; delete process.env.OTP_LOCK_MINUTES;
  try { assert.equal(loadConfig({}).otp.lockMs, 60_000); }
  finally { if (saved.s !== undefined) process.env.OTP_LOCK_SECONDS = saved.s; if (saved.m !== undefined) process.env.OTP_LOCK_MINUTES = saved.m; }
});

test("OTP: after 3 wrong codes a new code can't be requested until the lock is over, then it can", async () => {
  const s = await startServer({ ...FAST, otp: { resendMs: 0, lockMs: 1200 } });   // a 1.2 s lock stands in for the real 60 s
  const { c } = await registerAndVerify(s, {}, { mobile: false });
  const first = lastOtp(s.outbox);
  const wrong = (i) => String((Number(first) + 1 + i) % 1000000).padStart(6, "0");
  const smsCount = () => s.outbox.list().filter((m) => m.type === "sms").length;

  assert.equal((await c.post("/api/otp/verify", { code: wrong(0) })).data.attemptsLeft, 2);
  assert.equal((await c.post("/api/otp/verify", { code: wrong(1) })).data.attemptsLeft, 1);
  const third = await c.post("/api/otp/verify", { code: wrong(2) });
  assert.equal(third.status, 423);
  assert.equal(third.data.code, "OTP_LOCKED");
  assert.match(third.data.message, /^Too many wrong codes\. You can request a new code in \d+ seconds?\.$/);
  assert.ok(third.data.retryAfter >= 1 && third.data.retryAfter <= 2);

  // while locked: no new code, and not even the real one
  const sent = smsCount();
  const early = await c.post("/api/otp/send", {});
  assert.equal(early.status, 423);
  assert.equal(early.data.code, "OTP_LOCKED");
  assert.match(early.data.message, /request a new code in/);
  assert.equal((await c.post("/api/otp/verify", { code: first })).status, 423);
  assert.equal(smsCount(), sent);                                              // nothing was texted
  const locked = (await c.get("/api/otp/status")).data;
  assert.ok(locked.lockedForSeconds > 0);
  assert.equal(locked.active, false);

  // once the lock is over a NEW code can be requested, with 3 fresh attempts
  await sleep(1500);
  const again = await c.post("/api/otp/send", {});
  assert.equal(again.status, 200);
  assert.equal(again.data.attemptsLeft, 3);
  assert.equal(again.data.lockedForSeconds, 0);
  assert.equal(smsCount(), sent + 1);
  assert.equal((await c.post("/api/otp/verify", { code: lastOtp(s.outbox) })).status, 200);
  await s.close();
});

test("timestamps always come back as ISO text with exactly three fraction digits (Postgres drops trailing zeros)", () => {
  const read = pg.types.getTypeParser(1114);
  assert.equal(read("2026-10-06 10:01:56.67"), "2026-10-06T10:01:56.670Z");
  assert.equal(read("2026-10-06 10:01:56.5"), "2026-10-06T10:01:56.500Z");
  assert.equal(read("2026-10-06 10:01:56"), "2026-10-06T10:01:56.000Z");
  assert.equal(read("2026-10-06 10:01:56.123456"), "2026-10-06T10:01:56.123Z");   // microseconds are cut to milliseconds
  assert.equal(read("2026-10-06 10:01:56.670000"), "2026-10-06T10:01:56.670Z");
  for (const v of ["2026-10-06 10:01:56.67", "2026-10-06 10:01:56", "2026-10-06 10:01:56.5"]) assert.ok(!Number.isNaN(Date.parse(read(v))), v);
  assert.equal(pg.types.getTypeParser(1082)("2026-10-06"), "2026-10-06");                  // a DATE stays plain text
});

/* ================= holidays: the government's lists, per year ================= */

test("GET /api/holidays gives a year's holidays as the government declared them", async () => {
  const s = await startServer();
  const r = await client(s.base).get("/api/holidays?year=2026");
  assert.equal(r.status, 200);
  assert.equal(r.data.year, 2026);
  assert.equal(r.data.source, "proclamations");
  assert.match(r.data.proclamation, /Proclamation No\. 1006/);
  assert.deepEqual(r.data.pending, []);
  assert.equal(r.data.holidays.length, 20);
  const on = (date) => r.data.holidays.filter((h) => h.date === date);
  assert.deepEqual(on("2026-11-02").map((h) => [h.name, h.type]), [["All Souls' Day", "special"]]);       // a day off, which the old list did not have
  assert.deepEqual(on("2026-03-20").map((h) => h.type), ["islamic"]);                                    // Eid'l Fitr, by Proclamation No. 1189
  assert.deepEqual(on("2026-02-25"), []);                                                                // a special working day: not a holiday
  assert.deepEqual(on("2026-08-31").map((h) => [h.name, h.type]), [["National Heroes Day", "regular"]]);
  await s.close();
});

test("GET /api/holidays: a year that was moved by a later proclamation shows the final date", async () => {
  const s = await startServer();
  const r = await client(s.base).get("/api/holidays?year=2024");
  assert.ok(r.data.holidays.some((h) => h.date === "2024-08-23" && h.name === "Ninoy Aquino Day"));
  assert.ok(!r.data.holidays.some((h) => h.date === "2024-08-21"));
  await s.close();
});

test("GET /api/holidays refuses a missing or odd year, and says which years exist", async () => {
  const s = await startServer();
  const c = client(s.base);
  for (const url of ["/api/holidays", "/api/holidays?year=abc", "/api/holidays?year=2026.5", "/api/holidays?year=", "/api/holidays?year=2026;DROP"]) {
    const r = await c.get(url);
    assert.equal(r.status, 400, url);
    assert.equal(r.data.code, "BAD_YEAR", url);
  }
  for (const year of [2019, 2028, 1999]) {
    const r = await c.get(`/api/holidays?year=${year}`);
    assert.equal(r.status, 404, String(year));
    assert.equal(r.data.code, "NO_HOLIDAY_LIST");
    assert.match(r.data.message, /Available: 2020 to 2027/);
  }
  await s.close();
});

test("GET /api/holidays: 2027's Eid days come with expected dates, and the year still works when the Hijri calendar is down", async () => {
  const s = await startServer();
  const r = await client(s.base).get("/api/holidays?year=2027");
  assert.deepEqual(r.data.pending, ["Eid'l Fitr (Feast of Ramadhan)", "Eid'l Adha (Feast of Sacrifice)"]);
  assert.equal(r.data.holidays.filter((h) => h.expected && h.type === "islamic").length, 2);
  await s.close();

  const { createHolidayService } = await import("../server/holidayService.js");
  const { makeFakeAladhan } = await import("./fakeAladhan.js");
  const down = await startServer({}, { holidays: createHolidayService({ fetchImpl: makeFakeAladhan({ mode: "down" }).fetchImpl }) });
  const r2 = await client(down.base).get("/api/holidays?year=2027");
  assert.equal(r2.status, 200);
  assert.equal(r2.data.holidays.length, 18);
  assert.equal(r2.data.pending.length, 2);
  await down.close();
});

test("the browser may call only the address and DNS services directly; holidays and ZIP codes go through this server", async () => {
  const s = await startServer();
  const csp = (await fetch(s.base + "/api/csrf")).headers.get("content-security-policy");
  const connect = /connect-src ([^;]*)/.exec(csp)[1].split(" ");
  assert.deepEqual(connect.sort(), ["'self'", "https://dns.google", "https://psgc.gitlab.io"]);
  await s.close();
});