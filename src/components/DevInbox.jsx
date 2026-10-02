/* ===== components/DevInbox.jsx ===== */
// DEVELOPMENT ONLY. When no email / SMS provider is configured the server keeps
// the messages it would have sent, and this panel shows them so the whole
// registration flow can be tried on one machine. The server only exposes the
// outbox to localhost and refuses to start with it enabled in production.
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../auth.jsx";

const URL_SPLIT = /(https?:\/\/[^\s]+)/; // with a capture group, split() puts the links at the odd positions

function Body({ text }) {
  return (
    <pre className="dev__body">
      {text.split(URL_SPLIT).map((part, i) => (i % 2 === 1 ? <a key={i} href={part}>{part}</a> : part))}
    </pre>
  );
}

export function DevInbox() {
  const { config } = useApp();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!config.devOutbox) return undefined;
    let stop = false;
    const load = () => api("/dev/outbox").then((r) => !stop && setItems(r.items)).catch(() => {});
    load();
    const id = setInterval(load, 2000);
    return () => { stop = true; clearInterval(id); };
  }, [config.devOutbox]);

  if (!config.devOutbox) return null;

  const clear = async () => { await api("/dev/outbox", { method: "DELETE" }).catch(() => {}); setItems([]); };

  return (
    <aside className={`dev${open ? " is-open" : ""}`} aria-label="Development inbox">
      <button type="button" className="dev__toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Dev inbox{items.length ? ` (${items.length})` : ""}
      </button>
      {open && (
        <div className="dev__panel">
          <p className="dev__note">Development only: emails and text messages the server would have sent.</p>
          {items.length === 0 && <p className="muted">Nothing sent yet.</p>}
          <ul className="dev__list">
            {items.map((m) => {
              const otp = m.type === "sms" ? m.body.match(/\b(\d{6})\b/)?.[1] : null;
              return (
                <li key={m.id} className="dev__item">
                  <div className="dev__head"><span className={`badge badge--${m.type === "sms" ? "special" : "regular"}`}>{m.type === "sms" ? "SMS" : "Email"}</span> <span>to {m.to}</span></div>
                  {m.type === "email" && <strong className="dev__subject">{m.subject}</strong>}
                  {otp && <div className="dev__otp" data-testid="dev-otp">{otp}</div>}
                  <Body text={m.body} />
                </li>
              );
            })}
          </ul>
          {items.length > 0 && <button type="button" className="link-btn" onClick={clear}>Clear</button>}
        </div>
      )}
    </aside>
  );
}
