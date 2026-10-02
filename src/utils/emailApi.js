/* ===== utils/emailApi.js ===== */
// Email domain check using Google Public DNS (free, no API key).
// Runs in addition to the public-provider rule in shared/validation.js:
// https://dns.google/resolve?name=example.com&type=MX
//
// The domain must really exist and be able to receive email:
//   - it has MX (mail server) records, or
//   - it has no MX but has an A record (mail servers fall back to that)
// Returns "valid", "invalid", or "error" (API unreachable).

const DNS_URL = "https://dns.google/resolve";
const domainCache = {};

// Domains that are real (they pass DNS) but are obviously placeholder / test /
// keyboard-mash values people type instead of their real email. DNS alone
// can't detect these, so they're blocked by name here.
const BLOCKED_DOMAINS = [
  "qwerty.com", "example.com", "example.org", "example.net",
  "test.com", "asdf.com", "sample.com", "mailinator.com",
  "yopmail.com", "tempmail.com", "fake.com", "email.com",
];

async function lookup(domain, type) {
  const res = await fetch(`${DNS_URL}?name=${encodeURIComponent(domain)}&type=${type}`);
  if (!res.ok) throw new Error(`DNS API error (${res.status})`);
  return res.json();
}

export async function checkEmailDomain(domain) {
  const key = domain.toLowerCase();
  if (BLOCKED_DOMAINS.includes(key)) return "invalid";
  if (domainCache[key]) return domainCache[key];

  let status;
  try {
    const mx = await lookup(key, "MX");
    if (mx.Status === 3) {
      status = "invalid"; // NXDOMAIN: the domain doesn't exist
    } else if (mx.Status !== 0) {
      throw new Error("DNS lookup failed");
    } else {
      const mxRecords = (mx.Answer || []).filter((r) => r.type === 15);
      // A "null MX" (priority 0, host ".") means the domain refuses email
      const nullMx = mxRecords.length === 1 && /^0\s+\.$/.test(mxRecords[0].data.trim());
      if (mxRecords.length && !nullMx) status = "valid";
      else if (nullMx) status = "invalid";
      else {
        const a = await lookup(key, "A");
        status = (a.Answer || []).some((r) => r.type === 1) ? "valid" : "invalid";
      }
    }
  } catch {
    return "error"; // not cached, so it's retried next time
  }

  domainCache[key] = status;
  return status;
}
