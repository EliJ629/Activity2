/* =========================================================
   shared/countries.js
   Country list (name + calling code) built from the
   libphonenumber-js metadata, so the country dropdown and the
   mobile-number prefix always agree.
   ========================================================= */
import { getCountries, getCountryCallingCode, getExampleNumber } from "libphonenumber-js/mobile";
import examples from "libphonenumber-js/examples.mobile.json";

let cached = null;

export function listCountries() {
  if (cached) return cached;
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  cached = getCountries()
    .map((code) => ({ code, name: names.of(code), dial: getCountryCallingCode(code) }))
    .filter((c) => c.name && c.name !== c.code)
    .sort((a, b) => a.name.localeCompare(b.name));
  return cached;
}

export function getCountry(code) {
  return listCountries().find((c) => c.code === code) || null;
}

// e.g. PH -> "917 123 4567"
export function mobileExample(code) {
  try {
    const n = getExampleNumber(code, examples);
    return n ? n.formatNational().replace(/^0/, "") : "";
  } catch { return ""; }
}
