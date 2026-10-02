/* =========================================================
   server/templates.js  -  email + SMS wording
   The verification email follows section 2b of the requirements.
   ========================================================= */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function layout(appName, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;padding:32px;border-radius:8px">
<tr><td style="font-size:15px;line-height:1.6">${bodyHtml}</td></tr>
</table>
<p style="font-size:12px;color:#888;margin:16px 0 0">${esc(appName)}</p>
</td></tr></table></body></html>`;
}

const button = (href, label) =>
  `<p style="margin:28px 0"><a href="${esc(href)}" style="background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;display:inline-block;font-weight:bold">${esc(label)}</a></p>
<p style="font-size:12px;color:#666;word-break:break-all">If the button doesn't work, copy this link into your browser:<br>${esc(href)}</p>`;

export function verificationEmail({ appName, firstName, link, ttlHours }) {
  const subject = `Action Required: Verify your email address for ${appName}`;
  const text = `Dear ${firstName},

Thank you for registering with ${appName}. We are thrilled to welcome you to our community.

To ensure the security of your account and complete your registration, please verify your email address by clicking the secure link below:

[ Verify My Email Address ]: ${link}

If you did not initiate this request, please disregard this message. This link will expire in ${ttlHours} hours for your protection.

Warm regards,
The ${appName} Security Team`;
  const html = layout(appName, `<p>Dear ${esc(firstName)},</p>
<p>Thank you for registering with ${esc(appName)}. We are thrilled to welcome you to our community.</p>
<p>To ensure the security of your account and complete your registration, please verify your email address by clicking the secure link below:</p>
${button(link, "Verify My Email Address")}
<p>If you did not initiate this request, please disregard this message. This link will expire in ${ttlHours} hours for your protection.</p>
<p>Warm regards,<br>The ${esc(appName)} Security Team</p>`);
  return { subject, text, html };
}

export function unlockEmail({ appName, firstName, link, cooldownSeconds }) {
  const minutes = Math.round(cooldownSeconds / 60);
  const wait = cooldownSeconds % 60 === 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${cooldownSeconds} seconds`;
  const subject = `Security alert: your ${appName} account has been locked`;
  const text = `Dear ${firstName},

We locked your ${appName} account because there were 3 failed sign-in attempts in a row.

To unlock it, open the secure link below. For your protection the unlock only works after a ${wait} waiting period from the moment your account was locked. If you open the link earlier, just wait a moment and try again.

[ Unlock My Account ]: ${link}

If this wasn't you, we recommend that you choose a new password after unlocking.

Warm regards,
The ${appName} Security Team`;
  const html = layout(appName, `<p>Dear ${esc(firstName)},</p>
<p>We locked your ${esc(appName)} account because there were 3 failed sign-in attempts in a row.</p>
<p>To unlock it, use the secure link below. For your protection the unlock only works after a <strong>${wait}</strong> waiting period from the moment your account was locked. If you open the link earlier, just wait a moment and try again.</p>
${button(link, "Unlock My Account")}
<p>If this wasn't you, we recommend that you choose a new password after unlocking.</p>
<p>Warm regards,<br>The ${esc(appName)} Security Team</p>`);
  return { subject, text, html };
}

// Time is written in the time zone of the user's country (section 2c).
export function otpSms({ appName, code, expiresAt, timeZone, ttlMinutes }) {
  let when = "";
  try {
    when = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(expiresAt);
  } catch {
    when = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(expiresAt);
  }
  return `${appName}: ${code} is your verification code. It is valid for ${ttlMinutes} minutes (until ${when}). Never share this code with anyone.`;
}
