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
  assert.equal(v.validateMobile("PH", "0917-123-4567").e164, "+639171234567");   // leading trunk 0 is accepted
  assert.equal(v.validateMobile("PH", "9171234567").e164, "+639171234567");
  for (const bad of ["", "917123456", "91712345678", "2171234567", "abc", "+639171234567"]) assert.notEqual(v.validateMobile("PH", bad).error, "", bad);
  assert.equal(v.validateMobile("US", "(202) 555-0123").e164, "+12025550123");
  assert.equal(v.validateMobile("GB", "07911 123456").e164, "+447911123456");
  assert.notEqual(v.validateMobile("US", "917 123 4567").error, "");            // a PH number is not a US number
});

test("login checks are format-only on the client", () => {
  assert.equal(v.validateLoginEmail("user@domain.com"), "");
  assert.notEqual(v.validateLoginEmail("user@domain"), "");
  assert.equal(v.validateLoginPassword("x"), "");        // no length rule on purpose
  assert.notEqual(v.validateLoginPassword(""), "");
});
