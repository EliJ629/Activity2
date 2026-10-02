// Development inbox: keeps the last messages in memory so the app can show them
// when no real SMTP / SMS provider is configured. Never enabled in production.
import crypto from "node:crypto";

export function createOutbox(enabled) {
  const items = [];
  return {
    enabled,
    add(entry) {
      if (!enabled) return;
      items.unshift({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...entry });
      items.length = Math.min(items.length, 50);
    },
    list: () => items.slice(),
    clear: () => { items.length = 0; },
  };
}
