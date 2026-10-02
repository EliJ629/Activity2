/* ===== components/VerificationPages.jsx ===== */
// check-email  ->  verify-email (link)  ->  verify-mobile (OTP)  ->  login,  plus the unlock page.
import { useEffect, useRef, useState } from "react";
import { Link, navigate } from "../router.jsx";
import { api } from "../api.js";
import { useApp, useCountdown } from "../auth.jsx";
import { formatClock } from "../utils/dates.js";
import { validateLoginEmail } from "../../shared/validation.js";

/* ---------- after registering: "check your inbox" ---------- */
export function CheckEmailPage() {
  const { config } = useApp();
  const email = sessionStorage.getItem("pendingEmail") || "";
  const emailSent = sessionStorage.getItem("pendingEmailSent") !== "0";
  const [cooldown, startCooldown] = useCountdown(config.otp.resendSeconds);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // If the link gets clicked on a different device (e.g. opening the email on
  // a phone), this device is otherwise just sitting here with no way to know.
  // Poll quietly in the background and move on once it's verified.
  useEffect(() => {
    if (!email) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api(`/registration-status?email=${encodeURIComponent(email)}`);
        // Move on to the OTP step, same as the device that actually clicked the
        // link - never straight to sign-in, since mobile verification still
        // isn't done yet and jumping ahead would be misleading.
        if (!cancelled && r.emailVerified) { navigate("/verify-mobile", { replace: true }); return; }
      } catch { /* transient network hiccup: just try again next tick */ }
      if (!cancelled) timer = setTimeout(tick, 4000);
    };
    let timer = setTimeout(tick, 4000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [email]);

  if (!email) {
    return (
      <section className="card auth-card">
        <h1 className="card__title">Check your email</h1>
        <p>If you just registered, open the verification link we emailed you. <Link to="/login">Sign in</Link> once you've verified.</p>
      </section>
    );
  }

  const resend = async () => {
    setBusy(true);
    try { setMsg((await api("/resend-verification", { method: "POST", body: { email } })).message); startCooldown(config.otp.resendSeconds); }
    catch (err) { setMsg(err.message); }
    finally { setBusy(false); }
  };

  return (
    <section className="card auth-card">
      <h1 className="card__title">Check your email</h1>
      {emailSent ? (
        <>
          <p>We sent a verification link to <strong>{email}</strong>. Open it within 24 hours to activate your account, then we'll text you a code to verify your mobile number.</p>
          <p className="muted">Can't find it? Look in your spam folder, or request a new link.</p>
        </>
      ) : (
        <p className="banner banner--error" role="alert">
          Your account was created, but we couldn't deliver the verification email to <strong>{email}</strong> just now.
          This usually means email sending isn't configured correctly on the server. Try "Resend verification email" below,
          or contact the site administrator if it keeps failing.
        </p>
      )}
      {msg && <p className="banner banner--success" role="status">{msg}</p>}
      <button type="button" className="btn btn--secondary" onClick={resend} disabled={busy || cooldown > 0}>
        {cooldown > 0 ? `Resend email in ${formatClock(cooldown)}` : "Resend verification email"}
      </button>
      <p className="form-note"><Link to="/login">Back to sign in</Link></p>
    </section>
  );
}

/* ---------- the link in the email ---------- */
export function VerifyEmailPage() {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [state, setState] = useState({ status: token ? "loading" : "error", message: token ? "" : "This verification link is missing its token." });
  const [email, setEmail] = useState("");
  const [resendMsg, setResendMsg] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;
    api("/verify-email", { method: "POST", body: { token } })
      .then((r) => {
        setState({ status: "ok", message: "" });
        // the URL contains a one-time token: replace it so it doesn't stay in history
        navigate(r.next === "mobile" ? "/verify-mobile" : "/login?verified=1", { replace: true });
      })
      .catch((err) => setState({ status: "error", message: err.message }));
  }, [token]);

  const resend = async (e) => {
    e.preventDefault();
    try { setResendMsg((await api("/resend-verification", { method: "POST", body: { email } })).message); }
    catch (err) { setResendMsg(err.message); }
  };

  return (
    <section className="card auth-card">
      <h1 className="card__title">Verify your email</h1>
      {state.status === "loading" && <p role="status">Verifying your email address...</p>}
      {state.status === "ok" && <p role="status">Email verified. Continuing...</p>}
      {state.status === "error" && (
        <>
          <p className="banner banner--error" role="alert">{state.message}</p>
          <form onSubmit={resend} className="stack" noValidate>
            <p className="muted">Enter your email and we'll send a fresh link.</p>
            <div className="field">
              <label className="field__label" htmlFor="resendEmail">Email Address</label>
              <input id="resendEmail" className="field__input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <button className="btn btn--secondary" type="submit" disabled={Boolean(validateLoginEmail(email))}>Send a new link</button>
            {resendMsg && <p className="banner banner--success" role="status">{resendMsg}</p>}
          </form>
          <p className="form-note"><Link to="/login">Back to sign in</Link></p>
        </>
      )}
    </section>
  );
}

/* ---------- mobile OTP ---------- */
export function VerifyMobilePage() {
  const { config } = useApp();
  const [phase, setPhase] = useState("loading"); // loading | noSession | ready
  const [info, setInfo] = useState({ sentTo: "", active: false, attemptsLeft: config.otp.maxAttempts });
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expiresIn, startExpiry] = useCountdown(0);
  const [resendIn, startResend] = useCountdown(0);
  const [lockedFor, startLock] = useCountdown(0);

  const apply = (s) => {
    setInfo({ sentTo: s.sentTo, active: s.active, attemptsLeft: s.attemptsLeft });
    startExpiry(s.expiresInSeconds || 0);
    startResend(s.resendInSeconds || 0);
    startLock(s.lockedForSeconds || 0);
  };

  // Keeps checking, not just once on load - so this device notices and moves
  // on once mobile verification completes, even if it happens somewhere else
  // (e.g. the OTP was actually entered on the device that clicked the email
  // link, while this one is just sitting here waiting). If this device loses
  // its session partway through (cookie expires), it falls through to the
  // same no-session polling the other device would use.
  useEffect(() => {
    let cancelled = false;
    let timer;

    const pollNoSession = async () => {
      const email = sessionStorage.getItem("pendingEmail") || "";
      if (email) {
        try {
          const r = await api(`/registration-status?email=${encodeURIComponent(email)}`);
          if (!cancelled && r.mobileVerified) { navigate("/login?verified=1", { replace: true }); return; }
        } catch { /* transient network hiccup: just try again next tick */ }
      }
      if (!cancelled) timer = setTimeout(pollNoSession, 4000);
    };

    const pollReady = async () => {
      try {
        const s = await api("/otp/status");
        if (cancelled) return;
        if (s.verified) { navigate("/login?verified=1", { replace: true }); return; }
        apply(s);
        setPhase("ready");
        timer = setTimeout(pollReady, 4000);
      } catch (err) {
        if (cancelled) return;
        setPhase(err.status === 401 ? "noSession" : "ready");
        if (err.status === 401) pollNoSession();
        else timer = setTimeout(pollReady, 4000);
      }
    };

    pollReady();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    setError("");
    setBusy(true);
    try { apply(await api("/otp/send", { method: "POST", body: {} })); setCode(""); }
    catch (err) {
      if (err.body?.retryAfter) { (err.status === 423 ? startLock : startResend)(err.body.retryAfter); }
      setError(err.message);
    } finally { setBusy(false); }
  };

  const verify = async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) { setError("Enter the 6-digit code."); return; }
    setError("");
    setBusy(true);
    try {
      await api("/otp/verify", { method: "POST", body: { code } });
      navigate("/login?verified=1", { replace: true });
    } catch (err) {
      const c = err.body?.code;
      if (c === "OTP_WRONG") setInfo((i) => ({ ...i, attemptsLeft: err.body.attemptsLeft }));
      if (c === "OTP_LOCKED") { startLock(err.body.retryAfter || 0); setInfo((i) => ({ ...i, active: false, attemptsLeft: 0 })); }
      if (c === "OTP_EXPIRED" || c === "OTP_NONE") setInfo((i) => ({ ...i, active: false }));
      setError(c === "OTP_WRONG" ? `That code isn't right. ${err.body.attemptsLeft} attempt${err.body.attemptsLeft === 1 ? "" : "s"} left.` : err.message);
      setCode("");
    } finally { setBusy(false); }
  };

  if (phase === "loading") return <section className="card auth-card"><h1 className="card__title">Verify your mobile</h1><p role="status">Loading...</p></section>;
  if (phase === "noSession") {
    return (
      <section className="card auth-card">
        <h1 className="card__title">Verify your mobile</h1>
        <p>To enter the code on this device, <Link to="/login">sign in</Link> with your email and password first.</p>
        <p className="muted" role="status">If you're entering the code on another device instead, this page will move on by itself once it's done.</p>
      </section>
    );
  }

  const locked = lockedFor > 0;
  return (
    <section className="card auth-card">
      <h1 className="card__title">Verify your mobile</h1>
      <p>We texted a 6-digit code to <strong data-testid="otp-sent-to">{info.sentTo}</strong>. Enter it below.</p>

      {error && <p className="banner banner--error" role="alert">{error}</p>}
      {locked && <p className="banner banner--error" role="alert">Too many wrong codes. Try again in {formatClock(lockedFor)}.</p>}

      <form onSubmit={verify} className="stack" noValidate>
        <div className="field">
          <label className="field__label" htmlFor="otp">Verification code</label>
          <input id="otp" className="field__input otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            value={code} disabled={!info.active || locked} placeholder="000000"
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
          {info.active && !locked && (
            <span className="field__hint">Code expires in {formatClock(expiresIn)} · {info.attemptsLeft} attempt{info.attemptsLeft === 1 ? "" : "s"} left</span>
          )}
          {!info.active && !locked && <span className="field__hint">There's no active code. Request one below.</span>}
        </div>
        <button type="submit" className="btn btn--primary btn--block" disabled={busy || !info.active || locked || code.length !== 6}>Verify</button>
      </form>

      <button type="button" className="btn btn--secondary btn--block" onClick={send} disabled={busy || resendIn > 0 || locked}>
        {resendIn > 0 ? `Resend OTP in ${formatClock(resendIn)}` : info.active ? "Resend OTP" : "Send code"}
      </button>
      <p className="form-note"><Link to="/login">Back to sign in</Link></p>
    </section>
  );
}

/* ---------- unlock link ---------- */
export function UnlockPage() {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [phase, setPhase] = useState(token ? "loading" : "invalid"); // loading | cooling | ready | done | invalid
  const [message, setMessage] = useState(token ? "" : "This unlock link is missing its token.");
  const [wait, startWait] = useCountdown(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    api("/unlock/status", { method: "POST", body: { token } })
      .then((r) => { setPhase(r.state); startWait(r.retryAfter || 0); })
      .catch((err) => { setPhase("invalid"); setMessage(err.message); });
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the countdown reaches zero the button becomes available
  const cooling = phase === "cooling" && wait > 0;

  const unlock = async () => {
    setBusy(true);
    setMessage("");
    try {
      await api("/unlock", { method: "POST", body: { token } });
      setPhase("done");
      navigate("/login?unlocked=1", { replace: true });
    } catch (err) {
      if (err.body?.code === "UNLOCK_COOLDOWN") { setPhase("cooling"); startWait(err.body.retryAfter || 1); }
      else { setPhase("invalid"); }
      setMessage(err.message);
    } finally { setBusy(false); }
  };

  return (
    <section className="card auth-card">
      <h1 className="card__title">Unlock your account</h1>
      {phase === "loading" && <p role="status">Checking your link...</p>}
      {phase === "invalid" && (
        <>
          <p className="banner banner--error" role="alert">{message}</p>
          <p className="form-note"><Link to="/login">Back to sign in</Link></p>
        </>
      )}
      {(phase === "cooling" || phase === "ready") && (
        <>
          <p>Your account was locked after several failed sign-in attempts. For your protection there's a short waiting period before it can be unlocked.</p>
          {cooling
            ? <p className="banner banner--info" role="status" data-testid="unlock-wait">You can unlock your account in <strong>{formatClock(wait)}</strong>.</p>
            : <p className="banner banner--success" role="status">The waiting period is over.</p>}
          {message && !cooling && <p className="banner banner--error" role="alert">{message}</p>}
          <button type="button" className="btn btn--primary btn--block" onClick={unlock} disabled={busy || cooling}>
            {cooling ? `Unlock available in ${formatClock(wait)}` : "Unlock my account"}
          </button>
        </>
      )}
      {phase === "done" && <p role="status">Your account is unlocked. Redirecting...</p>}
    </section>
  );
}