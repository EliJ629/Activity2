/* ===== components/LoginForm.jsx ===== */
import { useState } from "react";
import { TextField } from "./TextField.jsx";
import { Link, navigate } from "../router.jsx";
import { api } from "../api.js";
import { useApp } from "../auth.jsx";
import { validateLoginEmail, validateLoginPassword } from "../../shared/validation.js";

export function LoginForm() {
  const { refresh, config } = useApp();
  const params = new URLSearchParams(window.location.search);
  const [form, setForm] = useState({ email: "", password: "" });
  const [touched, setTouched] = useState({});
  const [notice, setNotice] = useState(
    params.get("verified") ? { kind: "success", text: "Your account is verified. Sign in to continue." }
      : params.get("unlocked") ? { kind: "success", text: "Your account is unlocked. You can sign in now." } : null,
  );
  const [needsVerify, setNeedsVerify] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Client-side format checks only. The password is only checked for "not empty".
  const errors = {};
  const emailErr = validateLoginEmail(form.email);
  const pwErr = validateLoginPassword(form.password);
  if (emailErr && touched.email) errors.email = emailErr;
  if (pwErr && touched.password) errors.password = pwErr;

  const set = (key) => (val) => { setForm((f) => ({ ...f, [key]: val })); setTouched((t) => ({ ...t, [key]: true })); setNotice(null); };

  const onSubmit = async (e) => {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (emailErr || pwErr) return;
    setSubmitting(true);
    setNotice(null);
    setNeedsVerify(false);
    try {
      await api("/login", { method: "POST", body: form });
      await refresh();
      navigate("/dashboard", { replace: true });
    } catch (err) {
      const code = err.body?.code;
      if (code === "MOBILE_NOT_VERIFIED") { navigate("/verify-mobile?resumed=1"); return; }
      if (code === "EMAIL_NOT_VERIFIED") setNeedsVerify(true);
      setNotice({ kind: code === "ACCOUNT_LOCKED" ? "locked" : "error", text: err.message });
      setForm((f) => ({ ...f, password: "" }));
      setTouched((t) => ({ ...t, password: false })); // the field was emptied on purpose
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async () => {
    try {
      const r = await api("/resend-verification", { method: "POST", body: { email: form.email } });
      setNotice({ kind: "success", text: r.message });
      setNeedsVerify(false);
    } catch (err) { setNotice({ kind: "error", text: err.message }); }
  };

  return (
    <form className="card auth-card" onSubmit={onSubmit} noValidate>
      <h1 className="card__title">Sign in</h1>

      {notice && (
        <p className={`banner banner--${notice.kind === "success" ? "success" : "error"}`} role={notice.kind === "success" ? "status" : "alert"}>
          {notice.text}
        </p>
      )}
      {needsVerify && <button type="button" className="link-btn" onClick={resend}>Resend verification email</button>}

      <div className="stack">
        <TextField id="loginEmail" label="Email Address" type="email" autoComplete="username" value={form.email}
          onChange={set("email")} onBlur={() => setTouched((t) => ({ ...t, email: true }))} error={errors.email} />
        <TextField id="loginPassword" label="Password" type="password" autoComplete="current-password" value={form.password}
          onChange={set("password")} onBlur={() => setTouched((t) => ({ ...t, password: true }))} error={errors.password} />
      </div>

      <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
        {submitting ? "Signing in..." : "Sign in"}
      </button>
      <p className="form-note">
        Your account is locked after {config.login.maxFailures} failed attempts in a row.<br />
        New here? <Link to="/register">Create an account</Link>
      </p>
    </form>
  );
}