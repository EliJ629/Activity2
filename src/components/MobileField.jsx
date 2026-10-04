/* ===== components/MobileField.jsx ===== */
// Mobile number with a country-code prefix that follows the selected Country
// dropdown (Philippines -> +63). The user types only the national number:
// digits only, capped at the country's length (10 for the Philippines).
import { dialCode, maxMobileDigits, cleanMobileInput } from "../../shared/validation.js";
import { mobileExample } from "../../shared/countries.js";

export function MobileField({ countryCode, value, onChange, onBlur, error }) {
  const prefix = dialCode(countryCode);
  const max = maxMobileDigits(countryCode);
  const example = mobileExample(countryCode).replace(/\D/g, ""); // shown as plain digits, like what gets typed
  return (
    <div className="field">
      <label className="field__label" htmlFor="mobile">Mobile Number</label>
      <div className={`phone${error ? " phone--invalid" : ""}`}>
        <span className="phone__prefix" data-testid="mobile-prefix" aria-label={`Country code plus ${prefix}`}>
          {prefix ? `+${prefix}` : "+"}
        </span>
        {/* No maxLength attribute on purpose: the browser would cut a pasted "+63 917..." before
            the handler could recognise and drop the country code. The handler does the capping. */}
        <input
          id="mobile"
          className="field__input phone__input"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          placeholder={example}
          value={value}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? "mobile-error" : "mobile-hint"}
          onChange={(e) => onChange(cleanMobileInput(e.target.value, countryCode))}
          onBlur={onBlur}
        />
      </div>
      <span className={`field__counter${value.length >= max ? " is-full" : ""}`} data-testid="mobile-counter">{value.length} / {max}</span>
      {!error && <span id="mobile-hint" className="field__hint">Enter the number after {prefix ? `+${prefix}` : "the country code"}. We'll text a verification code to it.</span>}
      {error && <p id="mobile-error" className="field__error">{error}</p>}
    </div>
  );
}