// Sends OTP text messages through one of three providers, tried in this
// order: TextBee (a paired Android phone's own SIM - no per-message cost),
// Semaphore (a Philippine SMS gateway), or Twilio's REST API. Whichever has
// credentials set in .env is used; if none are set, the message just goes
// to the dev outbox (and the console, outside production).
export function createSms(config, outbox) {
  const b = config.textbee;
  const s = config.semaphore;
  const t = config.twilio;

  async function sendViaTextBee(to, body) {
    const res = await fetch(`https://api.textbee.dev/api/v1/gateway/devices/${b.deviceId}/send-sms`, {
      method: "POST",
      headers: { "x-api-key": b.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ recipients: [to], message: body }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(`TextBee error: ${data?.message || `HTTP ${res.status}`}`);
    }
  }

  // Semaphore expects local Philippine numbers like "09171234567".
  // The rest of the app stores mobile numbers in E.164 ("+639171234567").
  const toLocalPhFormat = (e164) => e164.replace(/^\+63/, "0");

  async function sendViaSemaphore(to, body) {
    const form = new URLSearchParams({ apikey: s.apiKey, number: toLocalPhFormat(to), message: body });
    if (s.senderName) form.set("sendername", s.senderName);
    const res = await fetch("https://api.semaphore.co/api/v4/messages", { method: "POST", body: form });
    const data = await res.json().catch(() => null);
    // On success Semaphore returns an array (one entry per message queued).
    // An error can still come back with HTTP 200, as a plain object instead
    // of an array, e.g. { "message": "Insufficient balance." } - treat
    // anything that isn't an array as a failure.
    if (!res.ok || !Array.isArray(data)) {
      const reason = (data && !Array.isArray(data) && data.message) || `HTTP ${res.status}`;
      throw new Error(`Semaphore error: ${reason}`);
    }
  }

  async function sendViaTwilio(to, body) {
    const form = new URLSearchParams({ To: to, Body: body });
    if (t.messagingServiceSid) form.set("MessagingServiceSid", t.messagingServiceSid);
    else form.set("From", t.from);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${t.accountSid}:${t.authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!res.ok) throw new Error(`SMS provider error (${res.status})`);
  }

  return {
    async send(to, body) {
      outbox.add({ type: "sms", to, subject: "SMS", body });
      if (config.textbeeConfigured) await sendViaTextBee(to, body);
      else if (config.semaphoreConfigured) await sendViaSemaphore(to, body);
      else if (config.twilioConfigured) await sendViaTwilio(to, body);
      else if (config.logMessages) console.log(`\n[sms:dev] To: ${to}\n${body}\n`);
    },
  };
}
