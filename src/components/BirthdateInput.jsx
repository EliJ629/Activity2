/* ===== components/BirthdateInput.jsx ===== */
// Birthday: a plain TEXT input strictly formatted as MM/DD/YYYY (no date picker).
// Slashes are inserted while typing. Validation (real calendar date, at least
// 13 years old) lives in shared/validation.js and is repeated on the server.
import { TextField } from "./TextField.jsx";

// "03251998" -> "03/25/1998"
export function maskBirthday(raw) {
  const d = String(raw).replace(/\D/g, "").slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

export function BirthdateInput({ value, onChange, onBlur, error }) {
  return (
    <TextField
      id="birthday"
      label="Birthday"
      value={value}
      onChange={(v) => onChange(maskBirthday(v))}
      onBlur={onBlur}
      error={error}
      placeholder="MM/DD/YYYY"
      inputMode="numeric"
      autoComplete="off"
      maxLength={10}
      hint="Format: MM/DD/YYYY. You must be at least 13 years old."
    />
  );
}
