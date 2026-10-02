import nodemailer from "nodemailer";

// Sends through SMTP when configured; otherwise (development only) the message
// goes to the dev outbox and the console.
export function createMailer(config, outbox) {
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
      if (transporter) {
        await transporter.sendMail({ from: config.smtp.from || `"${config.appName}" <no-reply@localhost>`, to, subject, text, html });
      } else if (config.logMessages) {
        console.log(`\n[mail:dev] To: ${to}\nSubject: ${subject}\n${text}\n`);
      }
    },
  };
}
