/* =========================================================
   shared/validation.js
   ---------------------------------------------------------
   ONE set of rules used by BOTH the browser (live form
   validation) and the server (the authoritative check).
   Every rule here comes from the requirements document.
   ========================================================= */
import postalCodes from "postal-codes-js";
import { parsePhoneNumberFromString, getCountryCallingCode, validatePhoneNumberLength } from "libphonenumber-js/mobile";

/* ---------- names ---------- */
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 50;

// Letters (any language, incl. accented), spaces, hyphens and apostrophes only.
// Each separator must sit between letters, so "O'Brien", "Mary-Jane" and
// "De la Cruz" pass but "--", "'x" or "Ana-" do not.
const NAME_PATTERN = /^[\p{L}\p{M}]+(?:[ '\-][\p{L}\p{M}]+)*$/u;

export function normalizeName(value) {
  return String(value ?? "").replace(/[\u2018\u2019]/g, "'").trim().replace(/\s+/g, " ");
}

export function validateName(value, label) {
  const v = normalizeName(value);
  if (!v) return `${label} is required.`;
  if (v.length < NAME_MIN_LENGTH) return `${label} must be at least ${NAME_MIN_LENGTH} characters.`;
  if (v.length > NAME_MAX_LENGTH) return `${label} must be ${NAME_MAX_LENGTH} characters or less (currently ${v.length}).`;
  if (/\d/.test(v)) return `${label} must not contain numbers.`;
  if (!NAME_PATTERN.test(v)) return `${label} may contain only letters, spaces, hyphens and apostrophes.`;
  return "";
}

// Optional. One letter with an optional period: "A" or "A." (max 2 characters).
export function normalizeMiddleInitial(value) {
  return String(value ?? "").trim();
}
export function validateMiddleInitial(value) {
  const v = normalizeMiddleInitial(value);
  if (!v) return "";
  if (!/^\p{L}\.?$/u.test(v)) return "Middle initial must be one letter with an optional period (e.g. A or A.).";
  return "";
}

/* ---------- birthday: MM/DD/YYYY text only ---------- */
export const MIN_AGE = 13;
export const MIN_BIRTH_YEAR = 1900;

// Returns { y, m, d } when the text is a real calendar date, otherwise null.
export function parseBirthday(text) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text ?? ""));
  if (!match) return null;
  const m = Number(match[1]);
  const d = Number(match[2]);
  const y = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

export function todayParts(date = new Date()) {
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

// Full years between the birth date and `today` ({ y, m, d }).
export function ageOn(birth, today) {
  let age = today.y - birth.y;
  if (today.m < birth.m || (today.m === birth.m && today.d < birth.d)) age -= 1;
  return age;
}

const isFuture = (b, t) => b.y > t.y || (b.y === t.y && (b.m > t.m || (b.m === t.m && b.d > t.d)));

// Returns { error, iso } where iso is YYYY-MM-DD when valid.
export function validateBirthday(text, today = todayParts()) {
  const raw = String(text ?? "");
  if (!raw.trim()) return { error: "Birthday is required.", iso: "" };
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return { error: "Use the format MM/DD/YYYY (e.g. 03/25/1998).", iso: "" };
  const birth = parseBirthday(raw);
  if (!birth) return { error: "That date doesn't exist on the calendar.", iso: "" };
  if (birth.y < MIN_BIRTH_YEAR) return { error: `Year must be ${MIN_BIRTH_YEAR} or later.`, iso: "" };
  if (isFuture(birth, today)) return { error: "Birthday can't be in the future.", iso: "" };
  if (ageOn(birth, today) < MIN_AGE) return { error: `You must be at least ${MIN_AGE} years old to register.`, iso: "" };
  const iso = `${birth.y}-${String(birth.m).padStart(2, "0")}-${String(birth.d).padStart(2, "0")}`;
  return { error: "", iso };
}

/* ---------- email ---------- */
export const EMAIL_MAX_LENGTH = 254;
export const EMAIL_LOCAL_MAX_LENGTH = 64; // the part before the @ (RFC 5321)

// Before the @: letters, digits and . _ % + - ; it can't start or end with a dot or contain two
// dots in a row ("a..b@", ".a@" and "a.@" are not real addresses). After it: dot-separated
// labels that don't start or end with a hyphen, ending in a 2+ letter extension.
const EMAIL_PATTERN = /^(?!\.)(?!.*\.\.)[a-z0-9._%+-]*[a-z0-9_%+-]@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

// Public mailbox providers only. Custom, school and corporate domains are blocked.
// Add more providers here if you need them.
export const PUBLIC_EMAIL_DOMAINS = [
  "gmail.com", "googlemail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.com.ph", "yahoo.co.uk", "ymail.com", "rocketmail.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "zoho.com", "mail.com", "yandex.com",
];

export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

// The same mailbox can be written many ways: Gmail ignores dots and "+tag" in the part before
// the @ ("j.uan+x@gmail.com" is "juan@gmail.com"), and the other big providers ignore "+tag".
// This is the one form used to decide whether an email is "already registered", so a second
// account can't be made for a mailbox that is already taken just by adding a dot or a +tag.
// (The address is still stored and used exactly as typed.)  The SQL twin of this lives in
// server/app.js - keep them identical; a test compares them.
export function canonicalEmail(value) {
  const v = normalizeEmail(value);
  const at = v.lastIndexOf("@");
  if (at < 1) return v;
  let local = v.slice(0, at).split("+")[0];
  let domain = v.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

export function emailDomain(value) {
  return normalizeEmail(value).split("@")[1] || "";
}

export function isPublicEmailDomain(domain) {
  return PUBLIC_EMAIL_DOMAINS.includes(String(domain).toLowerCase());
}

// Format + public-domain rule. Uniqueness is checked by the server against the database.
export function validateEmail(value) {
  const v = normalizeEmail(value);
  if (!v) return "Email is required.";
  if (v.length > EMAIL_MAX_LENGTH) return "Email is too long.";
  if (!EMAIL_PATTERN.test(v) || v.split("@")[0].length > EMAIL_LOCAL_MAX_LENGTH) return "Enter a valid email address (e.g. juan@gmail.com).";
  if (!isPublicEmailDomain(emailDomain(v))) return "Use a public email provider such as Gmail, Outlook, Yahoo or iCloud. Custom and company domains aren't accepted.";
  return "";
}

/* ---------- password ---------- */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// Also drives the live checklist under the password field
export const PASSWORD_RULES = [
  { id: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (p) => p.length >= PASSWORD_MIN_LENGTH },
  { id: "lower", label: "1 lowercase letter", test: (p) => /[a-z]/.test(p) },
  { id: "upper", label: "1 uppercase letter", test: (p) => /[A-Z]/.test(p) },
  { id: "number", label: "1 number", test: (p) => /\d/.test(p) },
  { id: "special", label: "1 special character", test: (p) => /[^A-Za-z0-9\s]/.test(p) },
];

export function validatePassword(p) {
  if (!p) return "Password is required.";
  if (p.length > PASSWORD_MAX_LENGTH) return `Password must be ${PASSWORD_MAX_LENGTH} characters or less.`;
  if (/\s/.test(p)) return "Password must not contain spaces.";
  const failed = PASSWORD_RULES.filter((r) => !r.test(p));
  if (failed.length) return `Password needs: ${failed.map((r) => r.label.toLowerCase()).join(", ")}.`;
  return "";
}

// Strong password suggestion. Uses the cryptographic random generator
// (crypto.getRandomValues) and rejection sampling so every character is
// equally likely. Look-alike characters (0/O, 1/l/I) are left out.
const POOLS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  number: "23456789",
  special: "!@#$%^&*-_=+?",
};

function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % max;
}

export function generateStrongPassword(length = 16) {
  const len = Math.max(length, PASSWORD_MIN_LENGTH);
  const all = Object.values(POOLS).join("");
  const chars = Object.values(POOLS).map((pool) => pool[randomInt(pool.length)]); // one of each class
  while (chars.length < len) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { // Fisher-Yates shuffle
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/* ---------- address ---------- */
// House & street: alphanumeric with standard punctuation (. , ' # / & ( ) -)
export function validateHouseStreet(value) {
  const v = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!v) return "House number and street are required.";
  if (v.length < 3) return "House number and street must be at least 3 characters.";
  if (v.length > 255) return "House number and street must be 255 characters or less.";
  if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,'#/&()\-]*$/u.test(v)) return "Use letters, numbers and standard punctuation only (. , ' # / & ( ) -).";
  return "";
}

// State / city typed as text (or chosen from the PSGC dropdowns for the Philippines)
export function validateLocality(value, label) {
  const v = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!v) return `${label} is required.`;
  if (v.length < 2) return `${label} must be at least 2 characters.`;
  if (v.length > 100) return `${label} must be 100 characters or less.`;
  // Letters, digits and the punctuation real place names use: . , ' ( ) - / & [ ] and the typographic quotes, dashes and
  // middle dot they are often written with (Pul-e 'Alam, Friuli-Venezia Giulia, Orroroo/Carrieton, Bikini & Kili).
  // Anything that could be markup or code (< > " { } ; = | \\ $ ...) is still refused. A name may start with an apostrophe
  // ('Ali Sabieh).
  if (!/^[\p{L}\p{M}\p{N}'\u2018\u2019`][\p{L}\p{M}\p{N} .,'\u2018\u2019`\u201C\u201D()\[\]\-\u2013\u2014/&\u00B7]*$/u.test(v)) return `${label} contains characters that aren't allowed.`;
  return "";
}

// ZIP / postal code must match the selected country's format.
// postal-codes-js knows every country's format; a few countries have no postal
// system, so for those we accept a plain 2-10 character code.
export function normalizeZip(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function countryHasPostalFormat(countryCode) {
  return postalCodes.validate(countryCode, "@@@@@@@@") !== true;
}

// ["1400","1402","1403","1406"] -> "1400, 1402-1403, 1406": runs of consecutive codes are shown as a range
export function formatZipRanges(zips) {
  const nums = [...new Set((zips || []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (nums[j + 1] === nums[j] + 1) j++;
    out.push(j === i ? String(nums[i]).padStart(4, "0") : `${String(nums[i]).padStart(4, "0")}-${String(nums[j]).padStart(4, "0")}`);
    i = j;
  }
  return out.join(", ");
}

// Outside the Philippines the ZIP is typed (the Philippines picks it from the chosen city's own list), and it has to be
// 4 to 8 letters or numbers. One space or hyphen may sit between the groups (SW1A 1AA, 100-0001, 01310-100) and isn't
// counted. On top of that the country's own format still applies where it has one (a US ZIP is 5 digits, so "ABCD" fails).
// Known consequence of the 4-8 bound: a 9-digit US ZIP+4 and the 3-digit codes of Iceland or the Faroe Islands are refused.
export const OTHER_ZIP_MIN = 4;
export const OTHER_ZIP_MAX = 8;
function validateOtherZip(v) {
  if (!/^[A-Z0-9]+(?:[ -][A-Z0-9]+)?$/.test(v)) return "ZIP / postal code can only have letters and numbers, with at most one space or hyphen in the middle.";
  const count = v.replace(/[ -]/g, "").length;
  if (count < OTHER_ZIP_MIN || count > OTHER_ZIP_MAX) return `ZIP / postal code must be ${OTHER_ZIP_MIN} to ${OTHER_ZIP_MAX} letters or numbers.`;
  return "";
}
export function validateZip(countryCode, value) {
  const v = normalizeZip(value);
  if (!v) return "ZIP / postal code is required.";
  if (countryCode !== "PH") {
    const bad = validateOtherZip(v);
    if (bad) return bad;
  }
  if (countryHasPostalFormat(countryCode)) {
    return postalCodes.validate(countryCode, v) === true ? "" : "This ZIP / postal code doesn't match the format used in the selected country.";
  }
  return "";   // a country with no postal format: the 4 to 8 rule above is the whole check
}

/* ---------- mobile number ---------- */
export function dialCode(countryCode) {
  try { return getCountryCallingCode(countryCode); } catch { return ""; }
}

// Countries where a valid MOBILE number really does start with 0 after the country code:
// Burkina Faso, Benin, Congo, Cote d'Ivoire, Gabon and Tajikistan. Found by asking the phone
// library for valid mobile numbers beginning with 0 in all 245 countries, with two different
// search methods; a test repeats the search so this list can't quietly go stale. Everywhere
// else (the Philippines included) a leading 0 is just the local "trunk" habit and isn't part
// of the number, so it is not accepted.
const ZERO_START_MOBILE_COUNTRIES = new Set(["BF", "BJ", "CG", "CI", "GA", "TJ"]);
export const allowsLeadingZero = (countryCode) => ZERO_START_MOBILE_COUNTRIES.has(countryCode);

// How many digits the mobile input accepts after the +prefix. The Philippines
// is exactly 10 (the requirements document's own example: "10 digits following
// +63"). Elsewhere it is the longest length the phone library treats as
// possible for that country - deliberately a little loose, because that data
// also covers non-mobile lines; the full numbering-plan check still runs on
// every submit, so this only stops obviously over-long input.
const maxDigitsCache = new Map();
export function maxMobileDigits(countryCode) {
  if (countryCode === "PH") return 10;
  if (maxDigitsCache.has(countryCode)) return maxDigitsCache.get(countryCode);
  const dial = dialCode(countryCode);
  let max = 0;
  if (dial) {
    for (let len = 1; len <= 15 - dial.length; len++) {
      if (validatePhoneNumberLength(`+${dial}${"9".repeat(len)}`, countryCode) === undefined) max = len;
    }
  }
  const result = max || 15; // unknown country: only the E.164 ceiling applies
  maxDigitsCache.set(countryCode, result);
  return result;
}

// Turns whatever was typed or pasted into digits only, capped to the country's limit. A number
// pasted with its country code ("+63 917 123 4567") has the code dropped, since it is already
// shown as the prefix. A leading 0 is dropped as it is typed, except in the few countries above
// where mobile numbers start with 0.
export function cleanMobileInput(raw, countryCode) {
  const strip = (d) => (allowsLeadingZero(countryCode) ? d : d.replace(/^0+/, ""));
  let digits = strip(String(raw ?? "").replace(/\D/g, ""));
  const dial = dialCode(countryCode);
  const max = maxMobileDigits(countryCode);
  if (dial && digits.length > max && digits.startsWith(dial)) digits = strip(digits.slice(dial.length));
  return digits.slice(0, max);
}

// `national` is what the user typed after the +prefix. It must be a valid MOBILE number in the
// selected country's national numbering plan (Philippines: 10 digits after +63, starting with 9)
// and must not start with 0, except in the countries whose mobile numbers do.
export function validateMobile(countryCode, national, countryLabel = "the selected country") {
  const raw = String(national ?? "").trim();
  if (!raw) return { error: "Mobile number is required.", e164: "" };
  if (!countryCode || !dialCode(countryCode)) return { error: "Select a country first.", e164: "" };
  if (!/^[\d\s\-().]+$/.test(raw)) return { error: "Mobile number may contain digits only.", e164: "" };
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0") && !allowsLeadingZero(countryCode)) {
    return { error: countryCode === "PH"
      ? "Don't start with 0 - +63 already replaces it. Enter 10 digits (e.g. 917 123 4567)."
      : `Don't start the number with 0 - the +${dialCode(countryCode)} prefix already replaces it.`, e164: "" };
  }
  const parsed = parsePhoneNumberFromString(`+${dialCode(countryCode)}${digits}`);
  if (parsed && parsed.isValid()) return { error: "", e164: parsed.number };
  const hint = countryCode === "PH" ? "Enter 10 digits after +63 (e.g. 917 123 4567)." : `Enter a valid mobile number for ${countryLabel}.`;
  return { error: hint, e164: "" };
}

/* ---------- whole registration form ---------- */
// payload = {
//   firstName, middleInitial, lastName, birthday, email, password, confirmPassword, mobile,
//   address: { houseStreet, countryCode, state, city, zip }
// }
// Returns an object of { fieldName: "message" } (empty when everything is valid).
export function validateRegistration(p, { today = todayParts(), countryLabel } = {}) {
  const e = {};
  const a = p.address || {};

  const first = validateName(p.firstName, "First name");
  const last = validateName(p.lastName, "Last name");
  const middle = validateMiddleInitial(p.middleInitial);
  if (first) e.firstName = first;
  if (middle) e.middleInitial = middle;
  if (last) e.lastName = last;

  const birthday = validateBirthday(p.birthday, today);
  if (birthday.error) e.birthday = birthday.error;

  const email = validateEmail(p.email);
  if (email) e.email = email;

  const pw = validatePassword(p.password);
  if (pw) e.password = pw;
  if (!p.confirmPassword) e.confirmPassword = "Please confirm your password.";
  else if (p.confirmPassword !== p.password) e.confirmPassword = "Passwords do not match.";

  const street = validateHouseStreet(a.houseStreet);
  if (street) e.houseStreet = street;
  if (!a.countryCode) e.countryCode = "Select a country.";
  const state = validateLocality(a.state, "State / region");
  if (state) e.state = state;
  const city = validateLocality(a.city, "City");
  if (city) e.city = city;
  if (a.countryCode) {
    const zip = validateZip(a.countryCode, a.zip);
    if (zip) e.zip = zip;
  } else if (!String(a.zip ?? "").trim()) {
    e.zip = "ZIP / postal code is required.";
  }

  const mobile = validateMobile(a.countryCode, p.mobile, countryLabel);
  if (mobile.error) e.mobile = mobile.error;

  return e;
}

/* ---------- login ---------- */
// Client-side checks only: the password is deliberately NOT length-checked
// here so the response can't be used to learn anything about the password policy.
export function validateLoginEmail(value) {
  const v = normalizeEmail(value);
  if (!v) return "Email is required.";
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(v)) return "Enter a valid email address (e.g. user@domain.com).";
  return "";
}
export function validateLoginPassword(value) {
  return value ? "" : "Password is required.";
}
