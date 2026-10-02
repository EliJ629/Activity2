/* ===== router.jsx ===== */
// A tiny path router (History API) so the project needs no routing library.
import { useEffect, useState } from "react";

const listeners = new Set();

export function navigate(to, { replace = false } = {}) {
  window.history[replace ? "replaceState" : "pushState"](null, "", to);
  listeners.forEach((fn) => fn());
  window.scrollTo(0, 0);
}

if (typeof window !== "undefined") window.addEventListener("popstate", () => listeners.forEach((fn) => fn()));

export function usePath() {
  const [loc, setLoc] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => {
    const update = () => setLoc(window.location.pathname + window.location.search);
    listeners.add(update);
    return () => listeners.delete(update);
  }, []);
  return loc;
}

export function Link({ to, children, onClick, ...rest }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onClick && onClick(e);
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
