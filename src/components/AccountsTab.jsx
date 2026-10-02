/* ===== components/AccountsTab.jsx ===== */
// Accounts tab of the "View More" modal: a table of active accounts.
// The server only sends masked details (first name + last initial, masked email).
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { formatDate } from "../utils/dates.js";

export function AccountsTab() {
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, error: "", data: null });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: "" }));
    api(`/accounts?page=${page}&pageSize=8`)
      .then((data) => !cancelled && setState({ loading: false, error: "", data }))
      .catch((err) => !cancelled && setState({ loading: false, error: err.message, data: null }));
    return () => { cancelled = true; };
  }, [page]);

  const { loading, error, data } = state;
  return (
    <section aria-labelledby="accounts-title">
      <h2 className="card__title" id="accounts-title">Accounts</h2>
      {loading && !data && <p className="holidays__status" role="status">Loading accounts...</p>}
      {error && <p className="banner banner--error" role="alert">{error}</p>}
      {data && (
        <>
          <p className="muted">{data.total} active account{data.total === 1 ? "" : "s"}. Personal details are masked.</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Country</th><th scope="col">Member since</th><th scope="col">Status</th></tr>
              </thead>
              <tbody>
                {data.accounts.map((a, i) => (
                  <tr key={i} className={a.isYou ? "is-you" : ""}>
                    <td data-label="Name"><span>{a.name}{a.isYou && <span className="badge badge--note">You</span>}</span></td>
                    <td data-label="Email">{a.email}</td>
                    <td data-label="Country">{a.country || "-"}</td>
                    <td data-label="Member since">{formatDate(a.memberSince)}</td>
                    <td data-label="Status"><span className="badge badge--ok">Email verified</span> <span className="badge badge--ok">Mobile verified</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.pages > 1 && (
            <nav className="pager" aria-label="Accounts pages">
              <button type="button" className="btn btn--secondary btn--small" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <span>Page {data.page} of {data.pages}</span>
              <button type="button" className="btn btn--secondary btn--small" disabled={page >= data.pages || loading} onClick={() => setPage((p) => p + 1)}>Next</button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
