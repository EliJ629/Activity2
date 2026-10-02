/* ===== components/Modal.jsx ===== */
// Accessible overlay dialog: focus moves inside, Tab is trapped, Escape and a
// click on the backdrop close it, the page behind can't scroll.
import { useEffect, useRef } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, children }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    document.body.classList.add("no-scroll");
    ref.current?.focus();

    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
      if (previous && previous.focus) previous.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <button type="button" className="modal__close" aria-label="Close" onClick={onClose}>&times;</button>
        {children}
      </div>
    </div>
  );
}

// Tab list with roving focus (Left / Right / Home / End keys)
export function Tabs({ tabs, active, onChange, idPrefix }) {
  const onKeyDown = (e) => {
    const i = tabs.findIndex((t) => t.id === active);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[next].id);
    document.getElementById(`${idPrefix}-tab-${tabs[next].id}`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label="View more" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button key={t.id} id={`${idPrefix}-tab-${t.id}`} type="button" role="tab" className={`tabs__tab${active === t.id ? " is-active" : ""}`}
          aria-selected={active === t.id} aria-controls={`${idPrefix}-panel-${t.id}`} tabIndex={active === t.id ? 0 : -1} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
