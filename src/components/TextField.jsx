/* ===== components/TextField.jsx ===== */
import { useState } from "react";
import { PASSWORD_RULES, generateStrongPassword } from "../../shared/validation.js";

// Reusable text input. Password fields get a Show / Hide toggle.
export function TextField({
  id, label, type = "text", value, onChange, onBlur, error, full, maxLength, children,
  placeholder, inputMode, autoComplete, showCounter, forceVisible, hint,
}) {
  const [visible, setVisible] = useState(false);
  const isPassword = type === "password";
  const shown = visible || forceVisible;
  const describedBy = [error ? `${id}-error` : "", hint ? `${id}-hint` : ""].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`field${full ? " field--full" : ""}`}>
      <label className="field__label" htmlFor={id}>{label}</label>
      <div className="field__control">
        <input
          id={id}
          className={`field__input${error ? " field__input--invalid" : ""}${isPassword ? " field__input--password" : ""}`}
          type={isPassword && shown ? "text" : type}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          inputMode={inputMode}
          autoComplete={autoComplete}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
        {isPassword && (
          <button
            type="button"
            className="field__toggle"
            aria-label={shown ? "Hide password" : "Show password"}
            aria-pressed={shown}
            onClick={() => setVisible((v) => !v)}
          >
            {shown ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {showCounter && maxLength && (
        <span className={`field__counter${value.length >= maxLength ? " is-full" : ""}`}>
          {value.length} / {maxLength}
        </span>
      )}
      {hint && <span id={`${id}-hint`} className="field__hint">{hint}</span>}
      {children}
      {error && <p id={`${id}-error`} className="field__error">{error}</p>}
    </div>
  );
}

// Live checklist that ticks off each password rule as the user types
export function PasswordChecklist({ password }) {
  return (
    <ul className="password-rules">
      {PASSWORD_RULES.map((r) => {
        const met = r.test(password);
        return (
          <li key={r.id} className={`password-rules__item ${met ? "is-met" : "is-unmet"}`}>
            {r.label}
          </li>
        );
      })}
    </ul>
  );
}

// "Suggest a strong password": generates a random password in the browser
// (crypto.getRandomValues) and can fill both password fields with it.
export function PasswordSuggester({ onUse }) {
  const [suggestion, setSuggestion] = useState("");
  const [copied, setCopied] = useState(false);
  const [used, setUsed] = useState(false);

  const generate = () => { setSuggestion(generateStrongPassword(16)); setCopied(false); setUsed(false); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(suggestion); setCopied(true); } catch { setCopied(false); }
  };

  if (!suggestion) {
    return (
      <button type="button" className="link-btn" onClick={generate}>
        Suggest a strong password
      </button>
    );
  }
  return (
    <div className="suggester" role="group" aria-label="Suggested password">
      <code className="suggester__value" data-testid="suggested-password">{suggestion}</code>
      <div className="suggester__actions">
        <button type="button" className="link-btn" onClick={() => { onUse(suggestion); setUsed(true); }}>Use this password</button>
        <button type="button" className="link-btn" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" className="link-btn" onClick={generate}>New suggestion</button>
      </div>
      {used && <span className="field__hint is-valid">Filled in both password fields. Save it in your password manager.</span>}
    </div>
  );
}
