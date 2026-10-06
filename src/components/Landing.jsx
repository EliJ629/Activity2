/* ===== components/Landing.jsx ===== */
// Post-login area: floating menu bar, hero, "View More" modal with tabs, plus the
// Profile and Settings pages.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, navigate, usePath } from "../router.jsx";
import { useApp } from "../auth.jsx";
import { Modal, Tabs } from "./Modal.jsx";
import { AccountsTab } from "./AccountsTab.jsx";
import { HolidayViewer } from "./HolidayViewer.jsx";
import { formatDateTime, formatPlainDate } from "../utils/dates.js";

const ModalContext = createContext(null);
export const useViewMore = () => useContext(ModalContext);

const TABS = [
  { id: "accounts", label: "Accounts" },
  { id: "holidays", label: "Calendars / Holidays" },
];

function LogoMark() {
  return (
    <svg className="logo__mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" opacity="0.15" />
      <path d="M8 21c3-6 5-6 8-6s5 0 8 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="16" cy="10" r="3" fill="currentColor" />
    </svg>
  );
}

function Navbar() {
  const { user, config, logout } = useApp();
  const { openModal } = useViewMore();
  const path = usePath().split("?")[0];
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef(null);

  // Close the menus on navigation, on Escape, and when clicking elsewhere
  useEffect(() => { setMenuOpen(false); setProfileOpen(false); }, [path]);
  useEffect(() => {
    const onDoc = (e) => { if (profileRef.current && !profileRef.current.contains(e.target)) setProfileOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") { setProfileOpen(false); setMenuOpen(false); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, []);

  const doLogout = async () => { await logout(); navigate("/login", { replace: true }); };
  const link = (to, label) => (
    <Link to={to} className={`nav__link${path === to ? " is-active" : ""}`} aria-current={path === to ? "page" : undefined}>{label}</Link>
  );
  const initials = `${user.firstName[0]}${user.lastName[0]}`.toUpperCase();

  return (
    <header className="nav">
      <div className="nav__bar">
        <Link to="/dashboard" className="logo" aria-label={`${config.appName} home`}>
          <LogoMark /> <span className="logo__text">{config.appName}</span>
        </Link>

        <nav className={`nav__links${menuOpen ? " is-open" : ""}`} id="main-menu" aria-label="Main">
          {link("/dashboard", "Dashboard")}
          {link("/profile", "Profile")}
          {link("/settings", "Settings")}
          <button type="button" className="nav__link nav__link--button" onClick={() => { setMenuOpen(false); openModal("holidays"); }}>
            Standard Philippine Holidays
          </button>
          <div className="nav__mobile-account">
            <span className="nav__email">{user.email}</span>
            <button type="button" className="nav__link nav__link--button" onClick={doLogout}>Log out</button>
          </div>
        </nav>

        <div className="profile" ref={profileRef}>
          <button type="button" className="profile__button" aria-haspopup="menu" aria-expanded={profileOpen} onClick={() => setProfileOpen((o) => !o)}>
            <span className="avatar" aria-hidden="true">{initials}</span>
            <span className="profile__name">{user.firstName}</span>
            <span className="profile__caret" aria-hidden="true">&#9662;</span>
          </button>
          {profileOpen && (
            <div className="profile__menu" role="menu">
              <div className="profile__who"><strong>{user.firstName} {user.lastName}</strong><span>{user.email}</span></div>
              <Link to="/profile" role="menuitem" className="profile__item">Profile</Link>
              <Link to="/settings" role="menuitem" className="profile__item">Settings</Link>
              <button type="button" role="menuitem" className="profile__item profile__item--danger" onClick={doLogout}>Log out</button>
            </div>
          )}
        </div>

        <button type="button" className="hamburger" aria-label="Menu" aria-expanded={menuOpen} aria-controls="main-menu" onClick={() => setMenuOpen((o) => !o)}>
          <span /><span /><span />
        </button>
      </div>
    </header>
  );
}

function ViewMoreModal({ state, onClose, onTab }) {
  return (
    <Modal open={state.open} onClose={onClose} title="View more">
      <Tabs tabs={TABS} active={state.tab} onChange={onTab} idPrefix="vm" />
      <div className="modal__body">
        {state.tab === "accounts" && <div role="tabpanel" id="vm-panel-accounts" aria-labelledby="vm-tab-accounts"><AccountsTab /></div>}
        {state.tab === "holidays" && <div role="tabpanel" id="vm-panel-holidays" aria-labelledby="vm-tab-holidays"><HolidayViewer /></div>}
      </div>
    </Modal>
  );
}

// Wraps every signed-in page: menu bar + the modal that opens from it
export function AppShell({ children }) {
  const [modal, setModal] = useState({ open: false, tab: "accounts" });
  const openModal = useCallback((tab = "accounts") => setModal({ open: true, tab }), []);
  const closeModal = useCallback(() => setModal((m) => ({ ...m, open: false })), []);

  return (
    <ModalContext.Provider value={{ openModal }}>
      <Navbar />
      {children}
      <ViewMoreModal state={modal} onClose={closeModal} onTab={(tab) => setModal({ open: true, tab })} />
    </ModalContext.Provider>
  );
}

export function DashboardPage() {
  const { user } = useApp();
  const { openModal } = useViewMore();
  return (
    <main className="hero" id="main">
      <div className="hero__content">
        <p className="hero__eyebrow">Welcome back</p>
        <h1 className="hero__title">Hello, {user.firstName}.</h1>
        <p className="hero__lead">Your account is verified and ready. Browse the accounts directory or plan ahead with the Philippine holiday calendar.</p>
        <div className="hero__actions">
          <button type="button" className="btn btn--light" onClick={() => openModal("accounts")}>View More</button>
        </div>
      </div>
    </main>
  );
}

function Row({ label, children }) {
  return <div className="details__row"><dt>{label}</dt><dd>{children}</dd></div>;
}

export function ProfilePage() {
  const { user } = useApp();
  const a = user.address;
  return (
    <main className="page" id="main">
      <div className="page__inner">
        <h1 className="card__title">Profile</h1>
        <dl className="details">
          <Row label="Name">{user.firstName} {user.middleInitial} {user.lastName}</Row>
          <Row label="Email">{user.email} <span className="badge badge--ok">Verified</span></Row>
          <Row label="Mobile">{user.mobileNumber} <span className="badge badge--ok">Verified</span></Row>
          <Row label="Birthday">{formatPlainDate(user.birthday)}</Row>
          {a && <Row label="Address">{a.houseStreet}, {a.city}, {a.state} {a.zip}, {a.country}</Row>}
          <Row label="Member since">{formatDateTime(user.createdAt)}</Row>
        </dl>
      </div>
    </main>
  );
}

export function SettingsPage() {
  const { user, config, sessionExpiresAt, logout } = useApp();
  return (
    <main className="page" id="main">
      <div className="page__inner">
        <h1 className="card__title">Settings</h1>
        <h2 className="page__subtitle">Security</h2>
        <dl className="details">
          <Row label="Signed in as">{user.email}</Row>
          <Row label="Birthday">{formatPlainDate(user.birthday)}</Row>
          <Row label="Session expires">{formatDateTime(sessionExpiresAt)}</Row>
          <Row label="Account lock">After {config.login.maxFailures} failed sign-ins, with an unlock link by email ({Math.round(config.login.unlockCooldownSeconds / 60)}-minute waiting period)</Row>
          <Row label="Time zone">Asia/Manila (Philippine Standard Time)</Row>
        </dl>
        <button type="button" className="btn btn--secondary" onClick={async () => { await logout(); navigate("/login", { replace: true }); }}>Log out</button>
      </div>
    </main>
  );
}