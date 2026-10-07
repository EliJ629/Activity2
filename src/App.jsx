/* ===== App.jsx ===== */
import { useEffect } from "react";
import { AppProvider, useApp } from "./auth.jsx";
import { Link, navigate, usePath } from "./router.jsx";
import { RegistrationForm } from "./components/RegistrationForm.jsx";
import { LoginForm } from "./components/LoginForm.jsx";
import { CheckEmailPage, VerifyEmailPage, VerifyMobilePage, UnlockPage } from "./components/VerificationPages.jsx";
import { AppShell, DashboardPage, ProfilePage, SettingsPage } from "./components/Landing.jsx";
import { DevInbox } from "./components/DevInbox.jsx";

const PUBLIC_ROUTES = {
  "/login": LoginForm,
  "/register": RegistrationForm,
  "/check-email": CheckEmailPage,
  "/verify-email": VerifyEmailPage,
  "/verify-mobile": VerifyMobilePage,
  "/unlock": UnlockPage,
};
const PROTECTED_ROUTES = {
  "/dashboard": DashboardPage,
  "/profile": ProfilePage,
  "/settings": SettingsPage,
};
// Signed-in users have no reason to see these
const GUEST_ONLY = new Set(["/login", "/register"]);

function Redirect({ to }) {
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return null;
}

function NotFound() {
  return (
    <section className="card auth-card">
      <h1 className="card__title">Page not found</h1>
      <p><Link to="/">Go to the start page</Link></p>
    </section>
  );
}

function Routes() {
  const { user, loading } = useApp();
  const [rawPath, query = ""] = usePath().split("?");
  const path = rawPath.replace(/\/+$/, "") || "/";

  if (loading) return <p className="splash" role="status">Loading...</p>;
  if (path === "/") return <Redirect to={user ? "/dashboard" : "/login"} />;

  const Protected = PROTECTED_ROUTES[path];
  if (Protected) {
    if (!user) return <Redirect to="/login" />;
    return <AppShell><Protected /></AppShell>;
  }

  const Page = PUBLIC_ROUTES[path];
  if (Page) {
    // Right after someone finishes verifying a NEW account (/login?verified=1) the login form must show, even if the browser still
    // holds somebody else's sign-in: sending them to the dashboard would show them that other person's account.
    const justVerified = path === "/login" && new URLSearchParams(query).get("verified") === "1";
    if (user && GUEST_ONLY.has(path) && !justVerified) return <Redirect to="/dashboard" />;
    return <main className={`app${path === "/register" ? "" : " app--narrow"}`}><Page /></main>;
  }
  return <main className="app app--narrow"><NotFound /></main>;
}

export default function App() {
  return (
    <AppProvider>
      <Routes />
      <DevInbox />
    </AppProvider>
  );
}