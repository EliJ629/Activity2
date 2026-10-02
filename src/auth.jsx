/* ===== auth.jsx ===== */
// App-wide state: server config (app name, timers) and the signed-in user.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api.js";

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

const DEFAULT_CONFIG = {
  appName: "Registration App",
  devOutbox: false,
  otp: { ttlSeconds: 300, resendSeconds: 60, maxAttempts: 3 },
  login: { maxFailures: 3, unlockCooldownSeconds: 120 },
};

export function AppProvider({ children }) {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [user, setUser] = useState(null);
  const [sessionExpiresAt, setSessionExpiresAt] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api("/me");
      setUser(me.user);
      setSessionExpiresAt(me.sessionExpiresAt);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try { setConfig(await api("/config")); } catch { /* keep defaults */ }
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  useEffect(() => { document.title = config.appName; }, [config.appName]);

  const logout = useCallback(async () => {
    try { await api("/logout", { method: "POST", body: {} }); } catch { /* cookie is cleared anyway on next load */ }
    setUser(null);
  }, []);

  return (
    <AppContext.Provider value={{ config, user, sessionExpiresAt, loading, refresh, logout }}>
      {children}
    </AppContext.Provider>
  );
}

// Counts down in whole seconds. start(n) restarts it.
export function useCountdown(initial = 0) {
  const [endsAt, setEndsAt] = useState(initial ? Date.now() + initial * 1000 : 0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!endsAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [endsAt]);
  const seconds = endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 0;
  const start = useCallback((s) => { setNow(Date.now()); setEndsAt(s > 0 ? Date.now() + s * 1000 : 0); }, []);
  return [seconds, start];
}
