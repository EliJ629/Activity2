/* ===== api.js ===== */
// Talks to our own server. Every state-changing request carries the CSRF token
// (requirement 1b-iv); cookies (session / onboarding) are sent automatically.

let csrfToken = null;

async function getCsrfToken(force = false) {
  if (!csrfToken || force) {
    const res = await fetch("/api/csrf", { credentials: "same-origin" });
    csrfToken = (await res.json()).token;
  }
  return csrfToken;
}

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || "Something went wrong. Please try again.");
    this.status = status;
    this.body = body || {};
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const send = async (forceToken) => {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["X-CSRF-Token"] = await getCsrfToken(forceToken);
    return fetch(`/api${path}`, { method, headers, credentials: "same-origin", body: body !== undefined ? JSON.stringify(body) : undefined });
  };

  let res;
  try {
    res = await send(false);
    if (res.status === 403 && method !== "GET") {
      const j = await res.clone().json().catch(() => ({}));
      if (j.code === "CSRF") res = await send(true); // token expired: fetch a new one and retry once
    }
  } catch {
    throw new ApiError(0, { message: "Can't reach the server. Check your connection and try again." });
  }

  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
