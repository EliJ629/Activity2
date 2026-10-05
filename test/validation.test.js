import test from "node:test";
import assert from "node:assert/strict";
import * as v from "../shared/validation.js";

const today = { y: 2026, m: 9, d: 30 };

test("names: letters, spaces, hyphens, apostrophes; 2-50 characters", () => {
  for (const ok of ["Juan", "De la Cruz", "Mary-Jane", "O'Brien", "José María", "Ñoño", "Li"]) assert.equal(v.validateName(ok, "x"), "", ok);
  for (const bad of ["", "J", "Juan3", "Juan_", "Ana-", "-Ana", "A--B", "'Ana", "Juan!", "a".repeat(51)]) assert.notEqual(v.validateName(bad, "x"), "", bad);
  assert.equal(v.validateName("a".repeat(50), "x"), "");
});

test("middle initial: optional, one letter with an optional period", () => {
  for (const ok of ["", "A", "A.", "ñ"]) assert.equal(v.validateMiddleInitial(ok), "", ok);
  for (const bad of ["AB", "A..", "1", ".", "A.B"]) assert.notEqual(v.validateMiddleInitial(bad), "", bad);
});

test("birthday: strict MM/DD/YYYY, real calendar date, at least 13 years old", () => {
  assert.equal(v.validateBirthday("03/25/1998", today).iso, "1998-03-25");
  assert.equal(v.validateBirthday("02/29/2000", today).error, "");          // leap day
  assert.match(v.validateBirthday("02/29/2001", today).error, /doesn't exist/);
  assert.match(v.validateBirthday("13/01/2000", today).error, /doesn't exist/);
  for (const bad of ["3/25/1998", "03-25-1998", "1998-03-25", "03/25/98", "03/25/1998 "]) assert.match(v.validateBirthday(bad, today).error, /MM\/DD\/YYYY/, bad);
  assert.equal(v.validateBirthday("09/30/2013", today).error, "");           // turns 13 today
  assert.match(v.validateBirthday("10/01/2013", today).error, /13 years/);   // tomorrow
  assert.match(v.validateBirthday("01/01/2030", today).error, /future/);
  assert.match(v.validateBirthday("01/01/1899", today).error, /1900/);
});

test("password: 12+ chars with upper, lower, number and special", () => {
  assert.equal(v.validatePassword("Str0ng!Passw0rd"), "");
  for (const bad of ["", "Short1!a", "alllowercase123!", "ALLUPPERCASE123!", "NoNumbersHere!!", "NoSpecial12345A", "Has Space 1234!A"]) assert.notEqual(v.validatePassword(bad), "", bad);
  assert.notEqual(v.validatePassword("Aa1!" + "x".repeat(130)), "");
});

test("generated passwords always satisfy every rule and differ each time", () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const pw = v.generateStrongPassword();
    assert.equal(v.validatePassword(pw), "", pw);
    assert.ok(pw.length >= 12);
    assert.ok(!/[0O1lI]/.test(pw), "look-alike characters are excluded");
    seen.add(pw);
  }
  assert.equal(seen.size, 300);
});

test("email: public providers only", () => {
  for (const ok of ["a@gmail.com", "A.B+tag@Outlook.com", "x@yahoo.com", "x@icloud.com", "x@yahoo.com.ph"]) assert.equal(v.validateEmail(ok), "", ok);
  for (const bad of ["", "nope", "a@company.com", "a@school.edu.ph", "a@gmail.com.evil.com", "a@@gmail.com", "a@gmail"]) assert.notEqual(v.validateEmail(bad), "", bad);
});

test("address: house/street text and ZIP per country", () => {
  assert.equal(v.validateHouseStreet("Blk 12 Lot 5, Rizal St."), "");
  assert.equal(v.validateHouseStreet("221B Baker Street"), "");
  assert.notEqual(v.validateHouseStreet("<script>"), "");
  assert.notEqual(v.validateHouseStreet(""), "");
  assert.equal(v.validateZip("PH", "1000"), "");
  assert.notEqual(v.validateZip("PH", "10000"), "");
  assert.notEqual(v.validateZip("PH", "abcd"), "");
  assert.equal(v.validateZip("US", "90210"), "");
  assert.equal(v.validateZip("US", "90210-1234"), "");
  assert.notEqual(v.validateZip("US", "9021"), "");
  assert.equal(v.validateZip("GB", "sw1a 1aa"), "");
  assert.equal(v.validateZip("CA", "K1A 0B1"), "");
  assert.equal(v.validateZip("HK", "999077"), "");   // no postal system: generic code accepted
});

test("mobile: prefix follows the country and the number follows its numbering plan", () => {
  assert.equal(v.dialCode("PH"), "63");
  assert.equal(v.dialCode("US"), "1");
  assert.equal(v.dialCode("GB"), "44");
  assert.equal(v.validateMobile("PH", "917 123 4567").e164, "+639171234567");
  assert.match(v.validateMobile("PH", "0917-123-4567").error, /Don't start with 0/);   // a leading 0 is not part of a +63 number
  assert.equal(v.validateMobile("PH", "9171234567").e164, "+639171234567");
  for (const bad of ["", "917123456", "91712345678", "2171234567", "abc", "+639171234567"]) assert.notEqual(v.validateMobile("PH", bad).error, "", bad);
  assert.equal(v.validateMobile("US", "(202) 555-0123").e164, "+12025550123");
  assert.equal(v.validateMobile("GB", "7911 123456").e164, "+447911123456");
  assert.match(v.validateMobile("GB", "07911 123456").error, /Don't start the number with 0/);
  assert.notEqual(v.validateMobile("US", "917 123 4567").error, "");            // a PH number is not a US number
});

test("login checks are format-only on the client", () => {
  assert.equal(v.validateLoginEmail("user@domain.com"), "");
  assert.notEqual(v.validateLoginEmail("user@domain"), "");
  assert.equal(v.validateLoginPassword("x"), "");        // no length rule on purpose
  assert.notEqual(v.validateLoginPassword(""), "");
});

test("mobile input: digits only, capped at 10 for the Philippines", () => {
  assert.equal(v.maxMobileDigits("PH"), 10);
  assert.equal(v.cleanMobileInput("9171234567", "PH"), "9171234567");
  assert.equal(v.cleanMobileInput("917 123 4567 99999", "PH"), "9171234567");   // can't go past 10
  assert.equal(v.cleanMobileInput("abc-917()123", "PH"), "917123");              // anything but digits is dropped
  assert.equal(v.cleanMobileInput("09171234567", "PH"), "9171234567");           // local leading 0 is not part of +63's number
  assert.equal(v.cleanMobileInput("+63 917 123 4567", "PH"), "9171234567");      // pasted with the country code
  assert.equal(v.cleanMobileInput("639171234567", "PH"), "9171234567");
  // whatever it cleans to is still a valid Philippine number
  assert.equal(v.validateMobile("PH", v.cleanMobileInput("+63 917 123 4567", "PH")).error, "");
});

test("mobile input: other countries use their own limit, not a flat 10", () => {
  assert.equal(v.maxMobileDigits("US"), 10);
  assert.equal(v.cleanMobileInput("(415) 555-2671 9", "US"), "4155552671");
  // the local trunk 0 is dropped as it is typed (UK: 07400 123456 -> 7400123456) and the result is valid
  assert.equal(v.cleanMobileInput("07400 123456", "GB"), "7400123456");
  assert.equal(v.validateMobile("GB", v.cleanMobileInput("07400 123456", "GB")).error, "");
  // a country with longer numbers is not cut off at 10
  assert.ok(v.maxMobileDigits("DE") > 10);
});

test("mobile: a leading 0 is refused everywhere except the countries whose mobile numbers start with 0", () => {
  assert.deepEqual(["BF", "BJ", "CG", "CI", "GA", "TJ"].filter(v.allowsLeadingZero), ["BF", "BJ", "CG", "CI", "GA", "TJ"]);
  for (const c of ["PH", "US", "GB", "DE", "IN", "AU", "FR", "SG", "JP"]) assert.equal(v.allowsLeadingZero(c), false, c);
  // typed or pasted: removed for the Philippines, kept for Cote d'Ivoire where the 0 is part of the number
  for (const typed of ["0917 123 4567", "00917 123 4567", "+63 (0)917 123 4567", "0063 917 123 4567"]) assert.equal(v.cleanMobileInput(typed, "PH"), "9171234567", typed);
  assert.equal(v.cleanMobileInput("0100234567", "CI"), "0100234567");
  assert.equal(v.validateMobile("CI", "0100234567").e164, "+2250100234567");
  assert.match(v.validateMobile("PH", "09171234567").error, /Don't start with 0/);   // what the server says if a client skips the browser's cleaning
  assert.equal(v.validateMobile("PH", "9171234567").error, "");
});

test("mobile: the list of countries that allow a leading 0 matches the phone library's own data", async () => {
  // Searches every country for a valid MOBILE number starting with 0, so the hard-coded list can't quietly go stale
  // when the phone library is updated. (If this fails, update ZERO_START_MOBILE_COUNTRIES in shared/validation.js.)
  const { parsePhoneNumberFromString, getCountries, getCountryCallingCode } = await import("libphonenumber-js/mobile");
  const filler = "2345678901234";
  const found = [];
  for (const c of getCountries()) {
    const dial = getCountryCallingCode(c);
    let hit = false;
    for (let len = 5; len <= Math.min(14, 15 - dial.length) && !hit; len++) {
      for (let a = 0; a < 10 && !hit; a++) for (let b = 0; b < 10 && !hit; b++) {
        const national = `0${a}${b}${filler}`.slice(0, len);
        const p = parsePhoneNumberFromString(`+${dial}${national}`, c);
        hit = Boolean(p && p.country === c && p.isValid() && p.nationalNumber.startsWith("0"));
      }
    }
    if (hit) found.push(c);
  }
  assert.deepEqual(found.sort(), getCountries().filter(v.allowsLeadingZero).sort());
});

test("email: shapes that can't be real addresses are refused, ordinary ones pass", () => {
  for (const bad of ["a..b@gmail.com", ".a@gmail.com", "a.@gmail.com", "a@gmail..com", "a@-gmail.com", "a@gmail-.com", "a@gmail.c", `${"x".repeat(65)}@gmail.com`, "a b@gmail.com", "a@@gmail.com"]) {
    assert.notEqual(v.validateEmail(bad), "", bad);
  }
  for (const good of ["juan@gmail.com", "ju.an@gmail.com", "ju.an+news@gmail.com", "j_u%an-1@yahoo.com", `${"x".repeat(64)}@gmail.com`, "JUAN@GMAIL.COM"]) {
    assert.equal(v.validateEmail(good), "", good);
  }
});

test("email: the same mailbox written differently has one canonical form", () => {
  assert.equal(v.canonicalEmail("J.U.A.N+news@Gmail.com"), "juan@gmail.com");
  assert.equal(v.canonicalEmail("juan@googlemail.com"), "juan@gmail.com");
  assert.equal(v.canonicalEmail("ju.an+x@outlook.com"), "ju.an@outlook.com");   // dots only count as nothing at Gmail
  assert.notEqual(v.canonicalEmail("ju.an@outlook.com"), v.canonicalEmail("juan@outlook.com"));
});

test("zip codes are shown as ranges", () => {
  assert.equal(v.formatZipRanges(["1400", "1402", "1403", "1406", "1407", "1408", "1425"]), "1400, 1402-1403, 1406-1408, 1425");
  assert.equal(v.formatZipRanges(["0802", "1100"]), "0802, 1100");
  assert.equal(v.formatZipRanges([]), "");
});