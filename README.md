# Registration App

Your existing React registration project, extended to the full requirements document:
registration with server-side validation, email + SMS verification, login with account
lockout, a database, a post-login landing page with a "View More" modal, and the
API-driven Philippine holidays module.

The original project was a static page with no backend, but most of the requirements
(hashing, rate limiting, CSRF, verification emails, lockout, a database) can only be
enforced on a server. So it is now a small Node app: an Express API + PostgreSQL database
serving the React front-end. All of the original features are still there (PSGC address
API, DNS email check, Nager.Date holidays, live validation, the minimalist look).

## Run it

Needs Node.js 22 or newer, and a PostgreSQL database - either a free one from
[Neon](https://neon.tech), or a local Postgres install. Set `DATABASE_URL` in `.env`
(copy `.env.example`) before starting; the four tables are created automatically on
first boot.

```bash
npm install
npm run dev          # http://localhost:3000
```

Open http://localhost:3000 and click **Create account**. No email or SMS provider is
needed to try everything: in development the server keeps the messages it would have
sent and shows them in the **Dev inbox** button (bottom left). Click the verification
link there, then copy the 6-digit code shown for the text message.

| Command | What it does |
|---|---|
| `npm run dev` | Server + front-end rebuild on every change |
| `npm run dev:https` | Same, over HTTPS with a self-signed certificate (TLS 1.3 only) |
| `npm run build` | Bundles `src/` into `public/app.js` (a prebuilt copy is included) |
| `npm start` | Production start (see "Going to production") |
| `npm test` | 23 server + validation tests (needs a reachable Postgres - defaults to `postgresql://postgres:postgres@localhost:5432/registration_app_test`, override with `TEST_DATABASE_URL`) |
| `npm run test:e2e` | Browser test of the whole flow (needs Python + Playwright) |

## The flow

`/register` -> email with a 24-hour link -> `/verify-mobile` (SMS code) -> `/login` -> `/dashboard`

* Accounts can't sign in until **both** the email and the mobile number are verified.
* 3 wrong passwords in a row lock the account and send an unlock email. The link only
  works after a 2-minute waiting period (the unlock page shows the countdown).
* The landing page has a floating menu bar (hamburger on phones), a full-image hero
  with a dark overlay, and **View More**, which opens a modal with an Accounts tab
  and a Calendars / Holidays tab.

## Requirements map

| Requirement | Where |
|---|---|
| 1a Field rules (names, middle initial, MM/DD/YYYY birthday 13+, password, address, public email, mobile per country) | `shared/validation.js`, used by the browser **and** the server |
| Strong password suggestion | `generateStrongPassword()` + `PasswordSuggester` in `src/components/TextField.jsx` |
| Country dropdown, +prefix that follows it, ZIP per country | `shared/countries.js`, `MobileField.jsx`, `AddressFields.jsx` (uses libphonenumber-js and postal-codes-js) |
| 1b HTTPS / TLS 1.3 | `server/index.js` (`minVersion: "TLSv1.3"`), `enforceHttps` + HSTS in production |
| 1b Argon2id | `server/app.js` (`hashPassword`), settings in `server/config.js` |
| 1b Max 5 registrations per IP per hour | `registerLimiter` in `server/app.js` |
| 1b Anti-CSRF | signed double-submit token: `server/security.js` + `src/api.js` (every POST) |
| 2 Email verification, 24 h token, template | `server/templates.js`, `/api/verify-email` |
| 2 SMS OTP: 6 digits, 5 min, 3 attempts, resend after 60 s, country time zone | `sendOtp()` and `/api/otp/*` in `server/app.js`, `VerifyMobilePage` |
| 3 Login rules, generic errors, lock after 3, unlock email, 2-minute cooling | `/api/login`, `/api/unlock` in `server/app.js`, `LoginForm.jsx`, `UnlockPage` |
| 4 Database | `schema.sql` (users, addresses, verification_tokens, plus sessions) |
| 5 Landing page, floating menu, modal with tabs, mobile-first CSS | `src/components/Landing.jsx`, `Modal.jsx`, `AccountsTab.jsx`, `public/index.css` |
| 6 Holidays: Asia/Manila, 2020-2027, fetched per year, three types with badges | `src/utils/holidayApi.js`, `src/components/HolidayViewer.jsx` |

## Decisions you should know about

Where the document and the existing project disagreed, the document won:

* **Email domains**: the old project accepted any domain. The document says public
  providers only, so `shared/validation.js` has an allow-list (Gmail, Outlook,
  Hotmail, Yahoo, iCloud, and a few more; edit `PUBLIC_EMAIL_DOMAINS`). The DNS check
  is kept as an extra "domain really exists" hint.
* **Middle name -> Middle initial** (optional, "A" or "A."). First/last name minimum
  went from 1 to 2 characters, and hyphens/apostrophes are now allowed.
* **Birthday dropdowns -> MM/DD/YYYY text input** with a 13-year minimum age (this
  replaces the old "not today or later" rule).
* **Password minimum 8 -> 12** characters. Spaces are still not allowed.
* **Address**: Country is now a dropdown. For the Philippines the existing PSGC
  Region / City / Barangay dropdowns are kept; other countries use text fields. Two
  columns were added to `addresses` for this: `country_code` and `barangay`.
* **Registration page** now has a "Create account" button (the old one had no submit).
  The holidays viewer moved from that page into the landing-page modal, as specified.
* **Holiday years** are 2020-2027 (was 2026). The list is classified as Regular
  Holiday / Special Non-Working Day / Islamic Holiday. Islamic dates come from the
  holiday API; if it doesn't list them, they are looked up from the Aladhan Hijri
  calendar API and marked "Expected", because the official date is proclaimed by the NCMF.

Where the document was silent or ambiguous:

* **Accounts tab**: "accessible user accounts" is shown as a paginated directory of
  active accounts with masked details (`Juan D.`, `j******z@gmail.com`). If you only
  want a user to see their own account, change the query in `/api/accounts`.
* **Password check order**: the document checks "verified/active" before the password.
  Doing that reveals which emails exist, so the server compares the password first and
  only then reports "please verify your email". Unknown emails also lock after 3 tries
  and get the same message as real ones.
* **OTP lockout** lasts 15 minutes; **unlock links** last 60 minutes. Both are settings.
* **Extra schema**: `verification_tokens` got `created_at`, `used_at`, `attempts`,
  `locked_until`, and there is a `sessions` table so Logout really ends a session.
* **Document typos fixed**: `mobile_verfied`, `ysers`, `VACHAR`, "bycrypt", and
  "Dear:" in the email (now "Dear Juan,").
* Profile and Settings are simple read-only pages; the document doesn't define them.
* The app name defaults to "Registration App" (`APP_NAME`).

## Going to production

Set these (see `.env.example` for all of them). `npm start` refuses to run without them.

1. `NODE_ENV=production`, `APP_SECRET` (long random string), `BASE_URL=https://...`
2. `DATABASE_URL`: a PostgreSQL connection string (a Neon connection string already
   includes `sslmode=require`, which is what you want in production).
3. **TLS 1.3**: either `TLS_KEY_FILE` + `TLS_CERT_FILE` (the app serves HTTPS itself), or
   put it behind a proxy that terminates TLS 1.3 and set `TRUST_PROXY=1`. Plain HTTP
   requests are redirected or refused, and HSTS is sent.
4. **Email**: `SMTP_URL` (or `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`).
5. **SMS**: one of `SEMAPHORE_API_KEY` (Philippine numbers, pay-as-you-go),
   `TEXTBEE_API_KEY` + `TEXTBEE_DEVICE_ID` (sends through a paired Android phone, no
   per-message cost), or `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM` /
   `TWILIO_MESSAGING_SERVICE_SID`.
6. Backups: if you're on Neon, it keeps automatic point-in-time restore and branching
   built in. On a self-managed Postgres, back up with `pg_dump`.

The Dev inbox is refused in production and is only reachable from localhost otherwise.

## Limitations

* The database is PostgreSQL via the `pg` driver (works against Neon or any Postgres).
  `server/db.js` wraps it in the same `.prepare(sql).get/.all/.run` shape the app
  always used, just made async - to swap drivers again, only that file and the
  transaction / unique-error helpers it exports need to change.
* Rate limits are kept in memory, so they are per process. With several instances,
  switch `express-rate-limit` to a shared store such as Redis.
* SMTP and Twilio delivery are implemented but were not run against live providers
  here. Try them once with your own credentials.
* For the Philippines the server checks address text and ZIP format; the region / city /
  barangay values come from the PSGC dropdowns in the browser and are not re-verified
  against PSGC on the server.
* There is no password-reset flow (the document only defines the token type).
* The built-in holiday rules for the older years (2020-2022) were not audited against
  each year's proclamations; the API list is merged on top of them.

## Layout

```
schema.sql            database tables
server/               Express API, security, email/SMS drivers, templates
shared/               validation + country data used by browser AND server
src/                  React front-end (utils/, components/, App.jsx)
public/               index.html, index.css, hero image, built app.js
scripts/              build + dev scripts (esbuild)
test/                 API, validation and browser tests
```
