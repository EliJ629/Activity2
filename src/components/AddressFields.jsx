/* ===== components/AddressFields.jsx ===== */
import { useEffect, useMemo, useState } from "react";
import { fetchRegions, fetchCities, fetchBarangays } from "../utils/psgcApi.js";
import { fetchGeoStates, fetchGeoCities } from "../utils/geoApi.js";
import { listCountries } from "../../shared/countries.js";

// Address value shape:
// { houseStreet, countryCode, region, regionName, city, cityName, barangay, barangayName,
//   stateText, cityText, zip }
// Philippines: region / city / barangay hold PSGC codes (the *Name fields hold the
// display names) and come from the PSGC API dropdowns.
// Other countries: state and city are dropdowns from the Country State City API (through our server) whenever the
// lists are available - stateCode / cityKey remember the pick, stateText / cityText hold the names that get saved - and
// plain text fields when they aren't, or when the person's place isn't listed ("Other (type it)": stateManual / cityManual).

function useOptions(loader, key) {
  const [state, setState] = useState({ key: null, list: [], loading: false, error: "" });

  useEffect(() => {
    if (key === null) {
      setState({ key: null, list: [], loading: false, error: "" });
      return undefined;
    }
    let cancelled = false;
    setState({ key, list: [], loading: true, error: "" });
    loader(key)
      .then((list) => !cancelled && setState({ key, list, loading: false, error: "" }))
      .catch(() => !cancelled && setState({ key, list: [], loading: false, error: "Couldn't load list. Check your internet and reload." }));
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Until the effect has run for this key, the previous key's list must not show (and it counts as loading)
  if (key !== null && state.key !== key) return { list: [], loading: true, error: "" };
  return state;
}

const OTHER = "__other__";                                   // the "Other (type it)" choice
const NO_OPTIONS = { list: [], loading: false, error: "" };

function ApiSelect({ id, label, placeholder, value, options, disabled, onSelect, onBlur, error, otherLabel }) {
  const text = options.loading ? "Loading..." : placeholder;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      <select
        id={id}
        className={`field__select${options.loading ? " field__select--loading" : ""}`}
        value={value}
        disabled={disabled || options.loading}
        aria-invalid={error ? "true" : undefined}
        onBlur={onBlur}
        onChange={(e) => {
          if (e.target.value === OTHER) { onSelect({ code: OTHER, name: "" }); return; }
          const picked = options.list.find((o) => o.code === e.target.value);
          onSelect(picked || { code: "", name: "" });
        }}
      >
        <option value="">{text}</option>
        {options.list.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
        {otherLabel && !options.loading && <option value={OTHER}>{otherLabel}</option>}
      </select>
      {options.error && <p className="field__error">{options.error}</p>}
      {!options.error && error && <p className="field__error">{error}</p>}
    </div>
  );
}

// The ZIP dropdown: only the codes of the chosen city (Philippines)
function ZipSelect({ id, label, value, options, loading, disabled, placeholder, onChange, onBlur, error }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      <select
        id={id}
        className={`field__select${loading ? " field__select--loading" : ""}`}
        value={value}
        disabled={disabled || loading}
        autoComplete="postal-code"
        aria-invalid={error ? "true" : undefined}
        onBlur={onBlur}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{loading ? "Loading..." : placeholder}</option>
        {options.map((z) => <option key={z} value={z}>{z}</option>)}
      </select>
      {error && <p className="field__error">{error}</p>}
    </div>
  );
}

function PlainField({ id, label, value, onChange, onBlur, error, placeholder, maxLength, autoComplete, hint }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      <input
        id={id}
        className={`field__input${error ? " field__input--invalid" : ""}`}
        type="text"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete={autoComplete}
        aria-invalid={error ? "true" : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {!error && hint && <span className="field__hint">{hint}</span>}
      {error && <p className="field__error">{error}</p>}
    </div>
  );
}

// onChange(nextValue, touchedKeys)  |  onTouch(keys)
export function AddressFields({ value, onChange, onTouch, errors = {}, zipOptions = null, zipLoading = false }) {
  const isPH = value.countryCode === "PH";
  const countries = useMemo(() => listCountries(), []);
  const regions = useOptions(fetchRegions, isPH ? "all" : null);
  const cities = useOptions(fetchCities, isPH ? value.region || null : null);
  const barangays = useOptions(fetchBarangays, isPH ? value.city || null : null);

  // Other countries: states of the country, then cities of the state (lists come from our server; empty = not available)
  const geoStates = useOptions(fetchGeoStates, !isPH && value.countryCode && !value.stateManual ? value.countryCode : null);
  const geoCities = useOptions(
    (k) => { const i = k.indexOf("/"); return fetchGeoCities(k.slice(0, i), k.slice(i + 1)); },
    !isPH && value.countryCode && value.stateCode && !value.stateManual && !value.cityManual ? `${value.countryCode}/${value.stateCode}` : null,
  );
  const stateList = !isPH && Boolean(value.countryCode) && !value.stateManual && (geoStates.loading || geoStates.list.length > 0);
  const cityWaiting = stateList && !value.stateCode;                                           // pick a state first
  const cityList = stateList && Boolean(value.stateCode) && !value.cityManual && (geoCities.loading || geoCities.list.length > 0);

  const set = (patch, keys) => onChange({ ...value, ...patch }, keys);

  // Changing the country clears everything below it (each country has its own places and ZIP format)
  const setCountry = (code) =>
    set({ countryCode: code, region: "", regionName: "", city: "", cityName: "", barangay: "", barangayName: "", stateText: "", cityText: "", zip: "",
      stateCode: "", cityKey: "", stateManual: false, cityManual: false }, ["countryCode"]);
  // Changing a parent resets the fields below it
  // (the ZIP goes too: it was one of the old city's codes)
  const setRegion = (r) => set({ region: r.code, regionName: r.name, city: "", cityName: "", barangay: "", barangayName: "", zip: "" }, ["state"]);
  const setCity = (c) => set({ city: c.code, cityName: c.name, barangay: "", barangayName: "", zip: "" }, ["city"]);
  const setBarangay = (b) => set({ barangay: b.code, barangayName: b.name }, ["barangay"]);
  // Other countries
  const pickState = (st) => (st.code === OTHER
    ? set({ stateManual: true, stateCode: "", stateText: "", cityKey: "", cityText: "", cityManual: false }, ["state"])
    : set({ stateCode: st.code, stateText: st.name, cityKey: "", cityText: "", cityManual: false }, ["state"]));
  const pickCity = (c) => (c.code === OTHER
    ? set({ cityManual: true, cityKey: "", cityText: "" }, ["city"])
    : set({ cityKey: c.code, cityText: c.name }, ["city"]));
  const backToStateList = () => set({ stateManual: false, stateCode: "", stateText: "", cityKey: "", cityText: "", cityManual: false }, []);
  const backToCityList = () => set({ cityManual: false, cityKey: "", cityText: "" }, []);

  // A city with a single ZIP: nothing to choose, so pick it
  const onlyZip = zipOptions && zipOptions.length === 1 ? zipOptions[0] : "";
  useEffect(() => {
    if (isPH && onlyZip && value.zip !== onlyZip) set({ zip: onlyZip }, ["zip"]);
  }, [isPH, onlyZip, value.zip]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <fieldset className="fieldset field--full">
      <legend className="fieldset__legend">Address</legend>
      <div className="address-grid">
        <div className="field field--full">
          <label className="field__label" htmlFor="houseStreet">House No. &amp; Street</label>
          <input
            id="houseStreet"
            className={`field__input${errors.houseStreet ? " field__input--invalid" : ""}`}
            type="text"
            autoComplete="street-address"
            placeholder="e.g. Blk 12 Lot 5, Rizal St."
            value={value.houseStreet}
            aria-invalid={errors.houseStreet ? "true" : undefined}
            onChange={(e) => set({ houseStreet: e.target.value }, ["houseStreet"])}
            onBlur={() => onTouch(["houseStreet"])}
          />
          {errors.houseStreet && <p className="field__error">{errors.houseStreet}</p>}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="country">Country</label>
          <select
            id="country"
            className="field__select"
            value={value.countryCode}
            aria-invalid={errors.countryCode ? "true" : undefined}
            onBlur={() => onTouch(["countryCode"])}
            onChange={(e) => setCountry(e.target.value)}
          >
            <option value="">Select country</option>
            {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
          {errors.countryCode && <p className="field__error">{errors.countryCode}</p>}
        </div>

        {isPH ? (
          <>
            <ApiSelect id="region" label="State / Region" placeholder="Select region" value={value.region}
              options={regions} onSelect={setRegion} onBlur={() => onTouch(["state"])} error={errors.state} />
            <ApiSelect id="city" label="City" placeholder="Select city" value={value.city}
              options={cities} disabled={!value.region} onSelect={setCity} onBlur={() => onTouch(["city"])} error={errors.city} />
            <ApiSelect id="barangay" label="Barangay" placeholder="Select barangay" value={value.barangay}
              options={barangays} disabled={!value.city} onSelect={setBarangay} onBlur={() => onTouch(["barangay"])} error={errors.barangay} />
          </>
        ) : (
          <>
            {stateList ? (
              <ApiSelect id="state" label="State / Province" placeholder="Select state / province" value={value.stateCode || ""}
                options={geoStates} otherLabel="Other (type it)" onSelect={pickState} onBlur={() => onTouch(["state"])} error={errors.state} />
            ) : (
              <PlainField id="state" label="State / Province" value={value.stateText} maxLength={100} autoComplete="address-level1"
                hint={value.stateManual ? <button type="button" className="link-btn" onClick={backToStateList}>Choose from the list instead</button> : ""}
                onChange={(v) => set({ stateText: v }, ["state"])} onBlur={() => onTouch(["state"])} error={errors.state} />
            )}
            {cityList || cityWaiting ? (
              <ApiSelect id="city" label="City" placeholder={cityWaiting ? "Select state first" : "Select city"} value={value.cityKey || ""}
                options={cityWaiting ? NO_OPTIONS : geoCities} disabled={cityWaiting} otherLabel={cityWaiting ? "" : "Other (type it)"}
                onSelect={pickCity} onBlur={() => onTouch(["city"])} error={errors.city} />
            ) : (
              <PlainField id="cityText" label="City" value={value.cityText} maxLength={100} autoComplete="address-level2"
                hint={value.cityManual && stateList ? <button type="button" className="link-btn" onClick={backToCityList}>Choose from the list instead</button> : ""}
                onChange={(v) => set({ cityText: v }, ["city"])} onBlur={() => onTouch(["city"])} error={errors.city} />
            )}
          </>
        )}

        {isPH && (!value.city || zipLoading || zipOptions) ? (
          <ZipSelect id="zip" label="ZIP / Postal Code" value={value.zip} options={zipOptions || []}
            loading={zipLoading} disabled={!value.city}
            placeholder={value.city ? "Select ZIP code" : "Select a city first"}
            onChange={(v) => set({ zip: v }, ["zip"])} onBlur={() => onTouch(["zip"])} error={errors.zip} />
        ) : (
          // other countries, or a Philippine city whose list couldn't be loaded: type it (the server still checks it)
          <PlainField id="zip" label="ZIP / Postal Code" value={value.zip} maxLength={12} autoComplete="postal-code"
            placeholder={isPH ? "e.g. 1400" : ""}
            hint={isPH ? "We couldn't load this city's postal codes. Type yours and we'll check it when you submit." : ""}
            onChange={(v) => set({ zip: v }, ["zip"])} onBlur={() => onTouch(["zip"])} error={errors.zip} />
        )}
        {stateList && <p className="form-note field--full">State and city lists: Country State City database (ODbL).</p>}
      </div>
    </fieldset>
  );
}