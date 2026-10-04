import test from "node:test";
import assert from "node:assert/strict";
import { startServer, client, goodPayload, lastLink, lastOtp, sleep } from "./helpers.js";

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
    address: { houseStreet: "", countryCode: "PH", state: "", city: "", barangay: "", zip: "99999" },
  }));
  assert.equal(r.status, 422);
  for (const k of ["firstName", "lastName", "middleInitial", "birthday", "email", "password", "confirmPassword", "mobile", "houseStreet", "state", "city", "barangay", "zip"]) {
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

test("an unverified account cannot sign in; a wrong password gets the generic message, an unregistered email is told so", async () => {
  const s = await startServer();
  const c = client(s.base);
  const p = goodPayload();
  await c.post("/api/register", p);
  const good = await c.post("/api/login", { email: p.email, password: p.password });
  assert.equal(good.status, 403);
  assert.equal(good.data.code, "EMAIL_NOT_VERIFIED");
  const bad = await c.post("/api/login", { email: p.email, password: "Wrong!Password1" });
  const unknown = await c.post("/api/login", { email: "nobody@gmail.com", password: "Wrong!Password1" });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.message, "Invalid email or password.");   // a real account with a wrong password stays generic
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.code, "EMAIL_NOT_REGISTERED");
  assert.equal(unknown.data.message, "This email is not yet registered on this website.");
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

test("an unregistered email is told so - no attempt count, no lock - and registering it later starts clean", async () => {
  const s = await startServer();
  const c = client(s.base);
  const ghost = "ghost.notyet@gmail.com";
  // well past the lock threshold of 3: nothing is counted and nothing locks, there is no account
  for (let i = 0; i < 6; i++) {
    const r = await c.post("/api/login", { email: ghost, password: "Whatever!123" });
    assert.equal(r.status, 404);
    assert.equal(r.data.code, "EMAIL_NOT_REGISTERED");
    assert.equal(r.data.message, "This email is not yet registered on this website.");
    assert.equal(r.data.attemptsLeft, undefined);
    assert.doesNotMatch(r.data.message, /lock/i);
  }
  // once that email really registers, the earlier tries must not count against it
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
  const us = { houseStreet: "1600 Pennsylvania Ave NW", countryCode: "US", state: "District of Columbia", city: "Washington", barangay: "", zip: "20500" };
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