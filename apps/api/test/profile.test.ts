import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, type Db } from "@crm/db";
import { buildMessagePayload, createMockGraph, createSecretBox, GraphError, mockSecret, signedFixture, type UserProfile } from "@crm/integrations";
import { metaWebhookRoutes } from "../src/inbox/webhook.ts";
import { processPending, startInboxWorker } from "../src/inbox/process.ts";
import { createProfileEnricher } from "../src/inbox/profile.ts";
import { bootstrap, type Harness } from "./harness.ts";

const DB = process.env.CRM_DB_NAME ?? "crm";
const KEY = Buffer.alloc(32, 7).toString("base64");
const box = createSecretBox({ k1: KEY }, "k1");
let h: Harness;
let ingestDb: Db;
let workerDb: Db;
let hook: Hono;
let wsA: string;
let wsB: string;

const RUN = Math.random().toString(36).slice(2, 8);
const digits = () => `9${Math.floor(Math.random() * 1e12).toString().padStart(12, "0")}`;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const PIC = "https://scontent.xx.fbcdn.net/v/pic.jpg?sig=1";

/** Connected Messenger account with an encrypted Page token, like a real connect leaves it. */
const createdAccounts: string[] = [];
async function account(workspaceId: string, opts: { token?: string | null } = {}) {
  const ref = digits();
  const [{ id }] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status) VALUES ($1,'messenger',$2,'connected') RETURNING id", [workspaceId, ref]);
  if (opts.token !== null) {
    const s = box.seal(opts.token ?? "page-token-secret", `${workspaceId}:${id}`);
    await q("INSERT INTO integration_secrets (workspace_id, integration_account_id, version, ciphertext, nonce, key_id) VALUES ($1,$2,1,$3,$4,$5)", [workspaceId, id, s.ciphertext, s.nonce, s.keyId]);
  }
  createdAccounts.push(id as string);
  return { ref, id: id as string };
}
async function drain() {
  for (let i = 0; i < 30; i++) {
    const r = await processPending(workerDb);
    if (r.processed + r.orphan + r.failed === 0) return;
  }
}
/** Real ingestion path: signed webhook -> ingress -> worker. Returns the identity row. */
async function incoming(acct: { ref: string }, user: string, mid = "m1") {
  const f = signedFixture(buildMessagePayload({ accountId: acct.ref, userId: user, mid: `${RUN}.${mid}.${user}`, text: "hello", timestampMs: Date.now() }), mockSecret);
  const res = await hook.request("/webhooks/meta/messenger", { method: "POST", body: new Uint8Array(f.raw), headers: { "content-type": "application/json", "x-hub-signature-256": f.signature } });
  expect(res.status).toBe(200);
  await drain();
}
const identity = async (acctId: string, user: string) =>
  (await q("SELECT pi.*, c.name AS contact_name, c.version AS contact_version FROM platform_identities pi JOIN contacts c ON c.id = pi.contact_id WHERE pi.integration_account_id = $1 AND pi.external_user_id = $2", [acctId, user]))[0]!;
const enricher = (graph: ReturnType<typeof createMockGraph>, over: Record<string, unknown> = {}) => createProfileEnricher({ workerDb, graph, box, budget: 500, ...over }) // big budget: other test files' pending identities share this database;
const profiles = (m: Record<string, UserProfile | null | GraphError>) => createMockGraph({ profiles: new Map(Object.entries(m)) });

beforeAll(async () => {
  h = await bootstrap();
  ingestDb = createDb(`postgres://crm_ingest:ingest_dev@127.0.0.1:5436/${DB}`);
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  hook = new Hono().route("/webhooks/meta", metaWebhookRoutes({ appSecrets: [mockSecret], verifyToken: "v", ingestDb }));
  const [a, b] = await Promise.all([h.newUser("profa"), h.newUser("profb")]);
  [wsA, wsB] = [await h.workspace(a, "Prof A"), await h.workspace(b, "Prof B")];
});
afterAll(async () => {
  // these accounts have no real token: mark them checked so the shared due-token job (meta-connect tests, LIMIT 100) is not crowded by them
  if (createdAccounts.length) await q("UPDATE integration_accounts SET last_token_check_at = now(), status = 'disabled' WHERE id = ANY($1::uuid[])", [createdAccounts]);
  await ingestDb.$client.end();
  await workerDb.$client.end();
  await h.close();
});

describe("profile enrichment (mock Graph, local database)", () => {
  it("replaces the placeholder name, stores the picture, and fetches each person once", async () => {
    const a = await account(wsA);
    const u = digits();
    await incoming(a, u);
    const before = await identity(a.id, u);
    expect(before.contact_name).toMatch(/^Messenger user \d{4}$/);
    expect(before.profile_status).toBeNull();

    const g = profiles({ [u]: { name: "Rahim Uddin", picUrl: PIC } });
    const enrich = enricher(g);
    expect((await enrich()).enriched).toBeGreaterThanOrEqual(1);
    const after = await identity(a.id, u);
    expect([after.contact_name, after.profile_name, after.profile_pic_url, after.profile_status]).toEqual(["Rahim Uddin", "Rahim Uddin", PIC, "ok"]);
    expect(after.profile_fetched_at).not.toBeNull();
    expect(Number(after.contact_version)).toBe(Number(before.contact_version) + 1);

    const calls = g.calls.filter((c) => c === `profile:${u}`).length;
    await enrich();
    await incoming(a, u, "m2"); // more messages from an enriched person
    await enrich();
    expect(g.calls.filter((c) => c === `profile:${u}`).length).toBe(calls); // no repeat call
  });

  it("keeps the fallback name and records 'unavailable' when Graph has no profile access (empty object)", async () => {
    const a = await account(wsA);
    const u = digits();
    await incoming(a, u);
    const placeholder = (await identity(a.id, u)).contact_name;
    const g = profiles({ [u]: null });
    const enrich = enricher(g);
    await enrich();
    const row = await identity(a.id, u);
    expect([row.profile_status, row.profile_attempts, row.contact_name]).toEqual(["unavailable", 1, placeholder]);
    expect(new Date(row.profile_retry_at).getTime()).toBeGreaterThan(Date.now());
    const n = g.calls.length;
    await enrich();
    expect(g.calls.length).toBe(n); // backoff: not asked again immediately
    await q("UPDATE platform_identities SET profile_retry_at = now() - interval '1 minute' WHERE id = $1", [row.id]);
    await enrich();
    expect(g.calls.length).toBe(n + 1); // asked again once the backoff passed
    expect((await identity(a.id, u)).profile_attempts).toBe(2);
  });

  it("records permission and other errors, never changes the name, never throws", async () => {
    const a = await account(wsA);
    const [u1, u2, u3] = [digits(), digits(), digits()];
    for (const u of [u1, u2, u3]) await incoming(a, u);
    const g = profiles({ [u1]: new GraphError(200, 403, "permission"), [u2]: new GraphError(null, 0, "other"), [u3]: new GraphError(190, 401, "auth") });
    await expect(enricher(g)()).resolves.toBeDefined();
    const rows = await Promise.all([u1, u2, u3].map((u) => identity(a.id, u)));
    expect(rows.map((r) => r.profile_status)).toEqual(["denied", "error", "error"]);
    for (const r of rows) expect(r.contact_name).toMatch(/^Messenger user \d{4}$/);
  });

  it("stops the whole pass on a rate limit, leaves rows untouched and pauses", async () => {
    const a = await account(wsA);
    const [u1, u2] = [digits(), digits()];
    await incoming(a, u1);
    await incoming(a, u2);
    const g = profiles({ [u1]: new GraphError(4, 429, "throttle"), [u2]: { name: "Should Not Be Fetched", picUrl: null } });
    let clock = Date.now();
    const enrich = enricher(g, { now: () => clock, throttleCooldownMs: 60_000 });
    const s = await enrich();
    expect(s.skipped).toBeGreaterThanOrEqual(1);
    expect((await identity(a.id, u1)).profile_status).toBeNull();
    expect((await identity(a.id, u2)).profile_status).toBeNull();
    const n = g.calls.length;
    await enrich();
    expect(g.calls.length).toBe(n); // cooling down: no Graph call at all
    clock += 61_000;
    g.state.profiles!.set(u1, { name: "Back Again", picUrl: null });
    await enrich();
    expect((await identity(a.id, u1)).contact_name).toBe("Back Again");
  });

  it("never overwrites a name a person typed, and the database refuses it too", async () => {
    const a = await account(wsA);
    const u = digits();
    await incoming(a, u);
    const row = await identity(a.id, u);
    await q("UPDATE contacts SET name = 'Typed By Agent' WHERE id = $1", [row.contact_id]);
    await enricher(profiles({ [u]: { name: "Facebook Name", picUrl: PIC } }))();
    const after = await identity(a.id, u);
    expect([after.contact_name, after.profile_name, after.profile_status]).toEqual(["Typed By Agent", "Facebook Name", "ok"]);
    // trigger: crm_worker cannot rename a non-placeholder contact even by a direct statement
    const c = await workerDb.$client.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [wsA]);
      await expect(c.query("UPDATE contacts SET name = 'x' WHERE id = $1", [row.contact_id])).rejects.toThrow(/placeholder/);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  });

  it("skips an account whose token is missing and does not touch another workspace", async () => {
    const noToken = await account(wsB, { token: null });
    const u = digits();
    await incoming(noToken, u);
    const g = profiles({ [u]: { name: "Nope", picUrl: null } });
    const s = await enricher(g)();
    expect(s.skipped).toBeGreaterThanOrEqual(1);
    expect(g.calls).not.toContain(`profile:${u}`);
    expect((await identity(noToken.id, u)).profile_status).toBeNull();
  });

  it("refreshes an expiring picture at most weekly, and only for people who wrote since", async () => {
    const a = await account(wsA);
    const u = digits();
    await incoming(a, u);
    const g = profiles({ [u]: { name: "Stable Name", picUrl: PIC } });
    const enrich = enricher(g);
    await enrich();
    const row = await identity(a.id, u);
    await q("UPDATE platform_identities SET profile_fetched_at = now() - interval '3 days' WHERE id = $1", [row.id]);
    const n = g.calls.length;
    await enrich();
    expect(g.calls.length).toBe(n); // fetched within the week: no call even though they wrote since
    await q("UPDATE platform_identities SET profile_fetched_at = now() + interval '1 day' WHERE id = $1", [row.id]);
    await q("UPDATE platform_identities SET profile_fetched_at = now() - interval '8 days' WHERE id = $1", [row.id]);
    // a stale picture but nobody wrote since: simulate by moving the fetch time after the last inbound message
    await q("UPDATE platform_identities SET profile_fetched_at = (SELECT last_inbound_at + interval '1 second' FROM conversations WHERE identity_id = $1) WHERE id = $1", [row.id]);
    await enrich();
    expect(g.calls.length).toBe(n); // no new message since the last fetch: no call
    await q("UPDATE platform_identities SET profile_fetched_at = now() - interval '8 days' WHERE id = $1", [row.id]);
    g.state.profiles!.set(u, new GraphError(null, 0, "other"));
    await enrich();
    expect(g.calls.length).toBe(n + 1);
    const kept = await identity(a.id, u);
    expect([kept.profile_status, kept.profile_pic_url, kept.contact_name]).toEqual(["ok", PIC, "Stable Name"]); // a failed refresh keeps the last good data
  });

  it("enrichment failure never blocks or fails ingestion", async () => {
    const a = await account(wsA);
    const u = digits();
    const errors: unknown[] = [];
    const worker = startInboxWorker(workerDb, { intervalMs: 3_600_000, enrich: async () => { throw new Error("enrichment exploded"); }, onError: (e) => errors.push(e) });
    const f = signedFixture(buildMessagePayload({ accountId: a.ref, userId: u, mid: `${RUN}.block`, text: "still stored", timestampMs: Date.now() }), mockSecret);
    expect((await hook.request("/webhooks/meta/messenger", { method: "POST", body: new Uint8Array(f.raw), headers: { "content-type": "application/json", "x-hub-signature-256": f.signature } })).status).toBe(200);
    await worker.tick();
    await new Promise((r) => setTimeout(r, 100));
    await worker.stop();
    expect((await q("SELECT count(*)::int AS n FROM messages m JOIN integration_accounts a ON a.id = m.integration_account_id WHERE a.id = $1", [a.id]))[0].n).toBe(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
