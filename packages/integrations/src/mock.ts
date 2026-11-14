import { signMetaBody } from "./signature.ts";

/** MOCK ONLY: fixtures for tests and mock mode. Never a real Meta secret. */
export const mockSecret = "mock-app-secret-not-for-production";

export function buildMessagePayload(a: { object?: "page" | "instagram"; accountId: string; userId: string; mid: string; text: string; timestampMs: number; echo?: boolean }) {
  const page = { id: a.accountId };
  const user = { id: a.userId };
  return {
    object: a.object ?? "page",
    entry: [{
      id: a.accountId,
      time: a.timestampMs,
      messaging: [{
        sender: a.echo ? page : user,
        recipient: a.echo ? user : page,
        timestamp: a.timestampMs,
        message: { mid: a.mid, text: a.text, ...(a.echo ? { is_echo: true } : {}) },
      }],
    }],
  };
}

/** Merges several payloads' entries into one batch body (object taken from the first). */
export function buildBatch(entries: ReturnType<typeof buildMessagePayload>[]) {
  return { object: entries[0]?.object ?? "page", entry: entries.flatMap((p) => p.entry) };
}

export function signedFixture(payload: unknown, secret: string = mockSecret): { raw: Buffer; signature: string } {
  const raw = Buffer.from(JSON.stringify(payload));
  return { raw, signature: signMetaBody(raw, secret) };
}

/**
 * MOCK ONLY: WhatsApp webhook bodies built from the field lists on Meta's messages-webhook reference pages. They are NOT captured from a real WhatsApp account, so they prove our parser
 * against the documented shape, not against Meta. `wabaId` goes in entry[].id (it is not the routing key); the phone number id goes in value.metadata.
 */
export type WaMessageFixture = Record<string, unknown>;
export function buildWhatsAppChange(a: { phoneNumberId: string; messages?: WaMessageFixture[]; statuses?: Record<string, unknown>[]; contacts?: unknown[]; field?: string }) {
  return {
    field: a.field ?? "messages",
    value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15550783881", phone_number_id: a.phoneNumberId },
      ...(a.contacts ? { contacts: a.contacts } : {}),
      ...(a.messages ? { messages: a.messages } : {}),
      ...(a.statuses ? { statuses: a.statuses } : {}),
    },
  };
}
export const buildWhatsAppBody = (wabaId: string, changes: ReturnType<typeof buildWhatsAppChange>[]) => ({ object: "whatsapp_business_account", entry: [{ id: wabaId, changes }] });
export const waText = (from: string, id: string, body: string, atSeconds = Math.floor(Date.now() / 1000)): WaMessageFixture => ({ from, id, timestamp: String(atSeconds), type: "text", text: { body } });
