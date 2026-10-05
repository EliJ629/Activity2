/* ===== components/RegistrationForm.jsx ===== */
import { useEffect, useState } from "react";
import { TextField, PasswordChecklist, PasswordSuggester } from "./TextField.jsx";
import { BirthdateInput } from "./BirthdateInput.jsx";
import { MobileField } from "./MobileField.jsx";
import { AddressFields } from "./AddressFields.jsx";
import { Link, navigate } from "../router.jsx";
import { api } from "../api.js";
import { checkEmailDomain } from "../utils/emailApi.js";
import { getCountry } from "../../shared/countries.js";
import {
  NAME_MAX_LENGTH, validateEmail, emailDomain, validateRegistration, normalizeEmail, cleanMobileInput,
  formatZipRanges, normalizeZip,
} from "../../shared/validation.js";

const EMPTY_FORM = {
  firstName: "",
  middleInitial: "",
  lastName: "",
  birthday: "",
  email: "",
  password: "",
  confirmPassword: "",
  mobile: "",
  address: {
    houseStreet: "", countryCode: "PH",
    region: "", regionName: "", city: "", cityName: "", barangay: "", barangayName: "",
    stateText: "", cityText: "", zip: "",
  },
};

// Turns the form state into the payload the server expects (same shape the shared validator uses)
function toPayload(form) {
  const a = form.address;
  const ph = a.countryCode === "PH";
  return {
    firstName: form.firstName,
    middleInitial: form.middleInitial,
    lastName: form.lastName,
    birthday: form.birthday,
    email: form.email,
    password: form.password,
    confirmPassword: form.confirmPassword,
    mobile: form.mobile,
    address: {
      houseStreet: a.houseStreet,
      countryCode: a.countryCode,
      state: ph ? a.regionName : a.stateText,
      city: ph ? a.cityName : a.cityText,
      cityCode: ph ? a.city : "", // the PSGC code of the chosen city: the server uses it to check the ZIP
      barangay: ph ? a.barangayName : "",
      zip: a.zip,
    },
  };
}

const ALL_FIELDS = ["firstName", "middleInitial", "lastName", "birthday", "email", "password", "confirmPassword",
  "mobile", "houseStreet", "countryCode", "state", "city", "barangay", "zip"];

export function RegistrationForm() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [touched, setTouched] = useState({}); // errors appear as soon as a field is used
  const [serverErrors, setServerErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [revealPasswords, setRevealPasswords] = useState(false);
  const [domainCheck, setDomainCheck] = useState({ domain: "", status: "" }); // "checking" | "valid" | "invalid" | "error"
  const [emailCheck, setEmailCheck] = useState({ email: "", status: "" }); // "available" | "taken"
  const [phZips, setPhZips] = useState({ cityCode: "", zip: "", city: "", zips: null, valid: null, message: "" }); // what the server says about the chosen Philippine city and ZIP

  // Check the email domain through the DNS API, 500 ms after the user stops typing
  useEffect(() => {
    const domain = emailDomain(form.email);
    if (validateEmail(form.email) || !domain) {
      setDomainCheck({ domain: "", status: "" });
      return undefined;
    }
    let cancelled = false;
    setDomainCheck({ domain, status: "checking" });
    const timer = setTimeout(() => {
      checkEmailDomain(domain).then((status) => {
        if (!cancelled) setDomainCheck({ domain, status });
      });
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [form.email]);

  // Ask the server whether this email is already registered, 500 ms after the user
  // stops typing - so they find out while filling in the form, not after pressing
  // "Create account". Only asks once the address is complete and allowed. If the
  // request fails (offline, rate limited) nothing is blocked: the server checks again on submit.
  useEffect(() => {
    if (validateEmail(form.email)) {
      setEmailCheck({ email: "", status: "" });
      return undefined;
    }
    const email = normalizeEmail(form.email);
    let cancelled = false;
    const timer = setTimeout(() => {
      api(`/email-available?email=${encodeURIComponent(email)}`)
        .then((r) => { if (!cancelled) setEmailCheck({ email, status: r.available ? "available" : "taken" }); })
        .catch(() => { if (!cancelled) setEmailCheck({ email: "", status: "" }); });
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [form.email]);

  // Philippines: ask the server (which asks the ZIP API) about the chosen city and the ZIP typed so far, a moment after the
  // user stops typing. It returns the city's postal codes for the hint and, once the ZIP is 4 digits, whether that ZIP
  // belongs to the city - the same check registration uses, so the form and the server always agree. If the lookup
  // fails nothing is blocked here: the server checks again on submit.
  const zipToCheck = /^\d{4}$/.test(normalizeZip(form.address.zip)) ? normalizeZip(form.address.zip) : "";
  useEffect(() => {
    const cityCode = form.address.countryCode === "PH" ? form.address.city : "";
    const empty = { cityCode: "", zip: "", city: "", zips: null, valid: null, message: "" };
    if (!cityCode) {
      setPhZips(empty);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api(`/ph-postal?cityCode=${encodeURIComponent(cityCode)}${zipToCheck ? `&zip=${zipToCheck}` : ""}`)
        .then((r) => { if (!cancelled) setPhZips({ cityCode, zip: zipToCheck, city: r.city, zips: r.zips, valid: r.valid ?? null, message: r.message || "" }); })
        .catch(() => { if (!cancelled) setPhZips(empty); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [form.address.countryCode, form.address.city, zipToCheck]);

  // Validation runs live on every change
  const payload = toPayload(form);
  const countryName = getCountry(form.address.countryCode)?.name;
  const allErrors = validateRegistration(payload, { countryLabel: countryName });
  if (!allErrors.email && domainCheck.status === "invalid") {
    allErrors.email = `"@${domainCheck.domain}" doesn't exist or can't receive email.`;
  }
  const emailChecked = emailCheck.email === normalizeEmail(form.email) ? emailCheck.status : "";
  if (!allErrors.email && emailChecked === "taken") allErrors.email = "An account with this email already exists.";
  const phReady = form.address.countryCode === "PH" && phZips.zips && phZips.cityCode === form.address.city;
  if (!allErrors.zip && phReady && zipToCheck && phZips.zip === zipToCheck && phZips.valid === false) allErrors.zip = phZips.message;
  const merged = { ...allErrors, ...serverErrors };
  const errors = Object.fromEntries(Object.entries(merged).filter(([k]) => touched[k] || serverErrors[k]));

  const touch = (keys) => setTouched((t) => ({ ...t, ...Object.fromEntries(keys.map((k) => [k, true])) }));
  const clearServer = (keys) => setServerErrors((s) => {
    if (!keys.some((k) => s[k])) return s;
    const next = { ...s };
    keys.forEach((k) => delete next[k]);
    return next;
  });

// AFTER
const set = (key, keys = [key]) => (eOrVal) => {
  const val = eOrVal && eOrVal.target !== undefined ? eOrVal.target.value : eOrVal;
  setForm((f) => ({ ...f, [key]: val }));
  touch(keys);
  clearServer(keys);
  setFormError("");
};
  const setAddress = (next, keys) => {
    setForm((f) => ({
      ...f,
      address: next,
      // a different country has a different limit (and prefix): trim what was already typed
      mobile: next.countryCode !== f.address.countryCode ? cleanMobileInput(f.mobile, next.countryCode) : f.mobile,
    }));
    touch(keys);
    clearServer(keys);
    setFormError("");
  };

  const useSuggested = (pw) => {
    setForm((f) => ({ ...f, password: pw, confirmPassword: pw }));
    touch(["password", "confirmPassword"]);
    setRevealPasswords(true);
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setFormError("");
    touch(ALL_FIELDS);
    if (Object.keys(allErrors).length) {
      setTimeout(() => document.querySelector('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    setSubmitting(true);
    try {
      const r = await api("/register", { method: "POST", body: payload });
      sessionStorage.setItem("pendingEmail", normalizeEmail(form.email));
      sessionStorage.setItem("pendingEmailSent", r.emailSent ? "1" : "0");
      navigate("/check-email");
    } catch (err) {
      if (err.body?.errors) {
        setServerErrors(err.body.errors);
        setTimeout(() => document.querySelector('[aria-invalid="true"]')?.focus(), 0);
      } else if (err.status === 429) {
        const wait = err.body?.retryAfter ? ` Try again in about ${Math.ceil(err.body.retryAfter / 60)} minute(s).` : "";
        setFormError(`${err.message}${wait}`);
      } else {
        setFormError(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const firstBlur = (key) => () => touch([key]);

  return (
    <form className="card registration" onSubmit={onSubmit} noValidate>
      <h1 className="card__title">Create an Account</h1>

      {formError && <p className="banner banner--error" role="alert">{formError}</p>}

      <div className="form-grid">
        <div className="name-row field--full">
          <TextField id="firstName" label="First Name" maxLength={NAME_MAX_LENGTH} showCounter autoComplete="given-name"
            value={form.firstName} onChange={set("firstName")} onBlur={firstBlur("firstName")} error={errors.firstName} />
          <TextField id="middleInitial" label="Middle Initial (optional)" maxLength={2} autoComplete="additional-name" placeholder="A."
            value={form.middleInitial} onChange={set("middleInitial")} onBlur={firstBlur("middleInitial")} error={errors.middleInitial} />
          <TextField id="lastName" label="Last Name" maxLength={NAME_MAX_LENGTH} showCounter autoComplete="family-name"
            value={form.lastName} onChange={set("lastName")} onBlur={firstBlur("lastName")} error={errors.lastName} />
        </div>

        <TextField id="email" label="Email Address" type="email" autoComplete="email" full
          hint="Gmail, Outlook, Yahoo, iCloud and other public email providers only."
          value={form.email} onChange={set("email")} onBlur={firstBlur("email")} error={errors.email}>
          {domainCheck.status === "checking" && <span className="field__hint is-checking">Checking email domain...</span>}
          {domainCheck.status === "valid" && <span className="field__hint is-valid">Email domain verified</span>}
          {domainCheck.status === "error" && <span className="field__hint">Couldn't verify the domain right now (no connection to the DNS API).</span>}
          {emailChecked === "available" && !errors.email && <span className="field__hint is-valid">Email is available</span>}
        </TextField>

        <TextField id="password" label="Password" type="password" autoComplete="new-password" forceVisible={revealPasswords}
          value={form.password} onChange={set("password", ["password", "confirmPassword"])} onBlur={firstBlur("password")} error={errors.password}>
          <PasswordChecklist password={form.password} />
          <PasswordSuggester onUse={useSuggested} />
        </TextField>
        <TextField id="confirmPassword" label="Confirm Password" type="password" autoComplete="new-password" forceVisible={revealPasswords}
          value={form.confirmPassword} onChange={set("confirmPassword")} onBlur={firstBlur("confirmPassword")} error={errors.confirmPassword} />

        <BirthdateInput value={form.birthday} onChange={set("birthday")} onBlur={firstBlur("birthday")} error={errors.birthday} />
        <MobileField countryCode={form.address.countryCode} value={form.mobile}
          onChange={set("mobile")} onBlur={firstBlur("mobile")} error={errors.mobile} />

        <AddressFields value={form.address} onChange={setAddress} onTouch={touch} errors={errors}
          zipHint={phReady ? `Postal codes for ${phZips.city}: ${formatZipRanges(phZips.zips)}` : ""} />
      </div>

      <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
        {submitting ? "Creating account..." : "Create account"}
      </button>
      <p className="form-note">By registering you agree to receive a verification email and a text message. Already registered? <Link to="/login">Sign in</Link></p>
    </form>
  );
}