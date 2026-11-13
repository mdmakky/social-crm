// Sends mock-signed fixtures through the public tunnel URL (.dev-tunnel/url). MOCK secret, not Meta.
import { readFileSync } from "node:fs";
import { buildMessagePayload, signedFixture, signMetaBody } from "@crm/integrations";

const base = readFileSync(new URL("../../../.dev-tunnel/url", import.meta.url), "utf8").trim();
const verify = process.env.META_VERIFY_TOKEN ?? "dev-verify-token-local";
const acct = `9${Date.now()}`;
const show = async (label: string, p: Promise<Response>) => { const r = await p; console.log(label.padEnd(44), r.status, (await r.text()).slice(0, 40)); };

await show("GET handshake (right token)", fetch(`${base}/webhooks/meta/messenger?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=4242`));
await show("GET handshake (wrong token)", fetch(`${base}/webhooks/meta/messenger?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=4242`));
const f = signedFixture(buildMessagePayload({ accountId: acct, userId: "9100000001", mid: `tunnel.${acct}`, text: "tunnel smoke", timestampMs: Date.now() }));
await show("POST signed fixture", fetch(`${base}/webhooks/meta/messenger`, { method: "POST", body: f.raw, headers: { "content-type": "application/json", "x-hub-signature-256": f.signature } }));
await show("POST bad signature", fetch(`${base}/webhooks/meta/messenger`, { method: "POST", body: f.raw, headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(f.raw, "wrong") } }));
await show("POST no signature", fetch(`${base}/webhooks/meta/messenger`, { method: "POST", body: f.raw }));
await show("GET /v1/me (must be 404)", fetch(`${base}/v1/me`));
await show("POST /api/auth/sign-up/email (must be 404)", fetch(`${base}/api/auth/sign-up/email`, { method: "POST", body: "{}" }));
await show("GET /health (must be 404)", fetch(`${base}/health`));
console.log("account_ref", acct);
