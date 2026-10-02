/* ===== components/MobileField.jsx ===== */
// Mobile number with a country-code prefix that follows the selected Country
// dropdown (Philippines -> +63). The user types only the national number.
import { dialCode } from "../../shared/validation.js";
import { mobileExample } from "../../shared/countries.js";

export function MobileField({ countryCode, value, onChange, onBlur, error }) {
  const prefix = dialCode(countryCode);
  const example = mobileExample(countryCode);
  return (
    <div className="field">
      <label className="field__label" htmlFor="mobile">Mobile Number</label>
      <div className={`phone${error ? " phone--invalid" : ""}`}>
        <span className="phone__prefix" data-testid="mobile-prefix" aria-label={`Country code plus ${prefix}`}>
          {prefix ? `+${prefix}` : "+"}
        </span>
        <input
          id="mobile"
          className="field__input phone__input"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder={example}
          value={value}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? "mobile-error" : "mobile-hint"}
          onChange={(e) => onChange(e.target.value.replace(/[^\d\s\-()]/g, "").slice(0, 20))}
          onBlur={onBlur}
        />
      </div>
      {!error && <span id="mobile-hint" className="field__hint">Enter the number after {prefix ? `+${prefix}` : "the country code"}. We'll text a verification code to it.</span>}
      {error && <p id="mobile-error" className="field__error">{error}</p>}
    </div>
  );
}
