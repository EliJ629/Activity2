import nodemailer from "nodemailer";

// Sends through Brevo's HTTPS API when configured (works on hosts that block
// outbound SMTP ports, Render's free tier included), through SMTP when that's
// configured instead (fine for local development, where no ports are
// blocked), or otherwise (development only) the message just goes to the dev
// outbox and the console.
export function createMailer(config, outbox) {
  async function sendViaBrevo({ to, subject, text, html }) {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": config.brevo.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: config.brevo.senderEmail, name: config.brevo.senderName || config.appName },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html || `<pre style="font:inherit">${text}</pre>`,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(`Brevo error: ${data?.message || `HTTP ${res.status}`}`);
    }
  }

  // IPv6 connectivity (the real fix for ENETUNREACH to a Gmail IPv6 address
  // on hosts like Render) is handled once, globally, in server/index.js -
  // nodemailer doesn't read a per-transport option for this, it resolves
  // both address families itself and picks one at random.
  let transporter = null;
  if (config.smtp.url) transporter = nodemailer.createTransport(config.smtp.url);
  else if (config.smtp.host) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      requireTLS: !config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }

  return {
    async send({ to, subject, text, html }) {
      outbox.add({ type: "email", to, subject, body: text });
      if (config.brevoConfigured) {
        await sendViaBrevo({ to, subject, text, html });
      } else if (transporter) {
        await transporter.sendMail({ from: config.smtp.from || `"${config.appName}" <no-reply@localhost>`, to, subject, text, html });
      } else if (config.logMessages) {
        console.log(`\n[mail:dev] To: ${to}\nSubject: ${subject}\n${text}\n`);
      }
    },
  };
}