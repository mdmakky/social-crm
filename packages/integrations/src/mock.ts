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
