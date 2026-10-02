import { Component } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// Without this, any unexpected render error anywhere in the app unmounts
// everything and leaves a blank white page with no clue why - this catches
// that, logs the real error to the console, and shows something to act on
// instead of nothing.
class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("Render error:", error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app app--narrow">
        <section className="card auth-card">
          <h1 className="card__title">Something went wrong</h1>
          <p className="banner banner--error" role="alert">
            This page hit an unexpected error. Reloading usually fixes it.
          </p>
          <button type="button" className="btn btn--primary btn--block" onClick={() => window.location.reload()}>Reload</button>
        </section>
      </main>
    );
  }
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);