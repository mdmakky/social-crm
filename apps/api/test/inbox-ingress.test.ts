import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, type Db } from "@crm/db";
import { buildBatch, buildMessagePayload, mockSecret, signedFixture, signMetaBody } from "@crm/integrations";
import { metaWebhookRoutes, MAX_WEBHOOK_BYTES, type IngressConfig } from "../src/inbox/webhook.ts";
import { processPending, processWebhookEvent, purgeRawBodies, startInboxWorker, MAX_ATTEMPTS, type InboxWorker } from "../src/inbox/process.ts";
import { bootstrap, type Harness } from "./harness.ts";

const DB = process.env.CRM_DB_NAME ?? "crm";
const VERIFY = "verify-token-123";
const PREVIOUS = "previous-mock-secret-xyz";
let h: Harness;
let ingestDb: Db;
let workerDb: Db;
let hook: Hono;
let wsA: string;
let wsB: string;

const RUN = Math.random().toString(36).slice(2, 8);
const digits = () => `9${Math.floor(Math.random() * 1e12).toString().padStart(12, "0")}`;
const cfg = (over: Partial<IngressConfig> = {}): IngressConfig => ({ appSecrets: [mockSecret, PREVIOUS], verifyToken: VERIFY, ingestDb, ...over });
const mount = (c: IngressConfig) => new Hono().route("/webhooks/meta", metaWebhookRoutes(c));
const post = (app: Hono, platform: string, body: Buffer, signature: string | null, extra: Record<string, string> = {}) =>
  app.request(`/webhooks/meta/${platform}`, { method: "POST", body: new Uint8Array(body), headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}), ...extra } });
const send = (payload: unknown, platform = "messenger", secret = mockSecret) => {
  const f = signedFixture(payload, secret);
  return post(hook, platform, f.raw, f.signature);
};
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;

// processPending takes the oldest 50 events database-wide, so leftovers of earlier runs can push this test's events out of one batch: loop until the queue is quiet.
async function drain() {
  for (let i = 0; i < 30; i++) {
    const r = await processPending(workerDb);
    if (r.processed + r.orphan + r.failed === 0) return;
  }
}
async function account(workspaceId: string, platform = "messenger") {
  const ref = digits();
  await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id) VALUES ($1,$2,$3)", [workspaceId, platform, ref]);
  return ref;
}
const eventsFor = (ref: string) => q("SELECT id, platform, status, attempts, last_error, workspace_id, raw_body, body_purged_at FROM webhook_events WHERE account_ref = $1 ORDER BY received_at, id", [ref]);
const msg = (a: string, u: string, mid: string, ts: number, extra: Record<string, unknown> = {}) => buildMessagePayload({ accountId: a, userId: u, mid: `${RUN}.${mid}`, text: `hello ${mid}`, timestampMs: ts, ...extra });

beforeAll(async () => {
  h = await bootstrap();
  ingestDb = createDb(`postgres://crm_ingest:ingest_dev@127.0.0.1:5436/${DB}`);
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  hook = mount(cfg());
  const [a, b] = await Promise.all([h.newUser("inboxa"), h.newUser("inboxb")]);
  [wsA, wsB] = [await h.workspace(a, "Inbox A"), await h.workspace(b, "Inbox B")];
});
afterAll(async () => {
  await ingestDb.$client.end();
  await workerDb.$client.end();
  await h.close();
});

describe("ingress: handshake", () => {
  const get = (qs: string, platform = "messenger") => hook.request(`/webhooks/meta/${platform}?${qs}`);
  it("echoes the challenge only for the right token and mode", async () => {
    const ok = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
    expect([ok.status, await ok.text()]).toEqual([200, "12345"]);
    expect((await get(`hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`)).status).toBe(403);
    expect((await get(`hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`)).status).toBe(403);
    expect((await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=%3Cscript%3E`)).status).toBe(403);
    expect((await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`, "tiktok")).status).toBe(403);
  });
});

describe("ingress: signature, size, rotation", () => {
  it("stores a validly signed body byte for byte, unrouted", async () => {
    const ref = digits();
    const f = signedFixture(msg(ref, digits(), "m.1", Date.now()));
    expect((await post(hook, "messenger", f.raw, f.signature)).status).toBe(200);
    const [e] = await eventsFor(ref);
    expect(e.status).toBe("received");
    expect(e.workspace_id).toBeNull();
    expect(Buffer.compare(e.raw_body, f.raw)).toBe(0);
  });

  it("rejects a bad, missing, upper-case or wrong-secret signature with 403 and stores no body", async () => {
    const ref = digits();
    const raw = signedFixture(msg(ref, digits(), "m.bad", Date.now())).raw;
    const good = signMetaBody(raw, mockSecret);
    const cases = [signMetaBody(raw, "some-other-secret"), null, good.toUpperCase(), good.slice(0, -2), "sha256=" + "0".repeat(64)];
    for (const sig of cases) expect((await post(hook, "messenger", raw, sig)).status).toBe(403);
    expect(await eventsFor(ref)).toHaveLength(0); // nothing is stored under the claimed account
    const rej = await q("SELECT count(*)::int AS n FROM webhook_events WHERE status='rejected' AND raw_body IS NULL AND signature_valid = false AND body_size = $1", [raw.length]);
    expect(rej[0].n).toBeGreaterThanOrEqual(1);
  });

  it("accepts the previous secret during rotation, and nothing else", async () => {
    const ref = digits();
    expect((await send(msg(ref, digits(), "m.rot", Date.now()), "messenger", PREVIOUS)).status).toBe(200);
    expect(await eventsFor(ref)).toHaveLength(1);
    const only = mount(cfg({ appSecrets: [mockSecret] }));
    const f = signedFixture(msg(ref, digits(), "m.rot2", Date.now()), PREVIOUS);
    expect((await post(only, "messenger", f.raw, f.signature)).status).toBe(403);
  });

  it("answers 413 above 1 MB without storing, for declared and undeclared lengths", async () => {
    const big = Buffer.alloc(MAX_WEBHOOK_BYTES + 1, 0x61);
    const before = (await q("SELECT count(*)::int AS n FROM webhook_events"))[0].n;
    expect((await post(hook, "messenger", big, signMetaBody(big, mockSecret))).status).toBe(413);
    const chunked = await hook.request("/webhooks/meta/messenger", { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }), duplex: "half", headers: { "x-hub-signature-256": signMetaBody(big, mockSecret) } } as RequestInit);
    expect(chunked.status).toBe(413);
    expect((await q("SELECT count(*)::int AS n FROM webhook_events"))[0].n).toBe(before);
  });

  it("acknowledges signed but unusable bodies without storing them; the channel comes from the signed payload, not the URL path", async () => {
    const ref = digits();
    const junk = Buffer.from("not json at all");
    expect((await post(hook, "messenger", junk, signMetaBody(junk, mockSecret))).status).toBe(200);
    expect(await eventsFor(ref)).toHaveLength(0);
    // object "page" posted to the instagram path is stored as a Messenger event (UNVERIFIED C8: Meta may send both objects to one URL)
    expect((await send(msg(ref, digits(), "m.wrongpath", Date.now()), "instagram")).status).toBe(200);
    expect((await eventsFor(ref)).map((e: { platform: string }) => e.platform)).toEqual(["messenger"]);
  });
});

describe("ingress: rate limits and batching", () => {
  it("rate limits failed signatures per source and caps rejected rows written", async () => {
    let t = 1_000_000;
    const app = mount(cfg({ limits: { perKeyPerWindow: 100, failedPerKeyPerWindow: 3, rejectedRowsPerWindow: 2, windowMs: 60_000 }, now: () => t }));
    const size = 700 + Math.floor(Math.random() * 90_000);
    const raw = Buffer.alloc(size, 0x20);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(app, "messenger", raw, "sha256=" + "1".repeat(64))).status);
    expect(statuses).toEqual([403, 403, 403, 429, 429]);
    expect((await q("SELECT count(*)::int AS n FROM webhook_events WHERE status='rejected' AND body_size = $1", [size]))[0].n).toBe(2);
    t += 61_000; // window passes
    expect((await post(app, "messenger", raw, "sha256=" + "1".repeat(64))).status).toBe(403);
  });

  it("rate limits all traffic per source", async () => {
    const app = mount(cfg({ limits: { perKeyPerWindow: 2, failedPerKeyPerWindow: 50, rejectedRowsPerWindow: 50, windowMs: 60_000 } }));
    const ref = digits();
    const out: number[] = [];
    for (let i = 0; i < 4; i++) { const f = signedFixture(msg(ref, digits(), `m.rl${i}`, Date.now())); out.push((await post(app, "messenger", f.raw, f.signature)).status); }
    expect(out).toEqual([200, 200, 429, 429]);
  });

  it("splits a multi-account batch into one routed row per account and drops repeats inside the batch", async () => {
    const [r1, r2] = [digits(), digits()];
    const u = digits();
    const p1 = msg(r1, u, "m.b1", Date.now());
    const p2 = msg(r2, u, "m.b2", Date.now());
    expect((await send(buildBatch([p1, p2, p1]))).status).toBe(200);
    for (const [ref, mid] of [[r1, "m.b1"], [r2, "m.b2"]] as const) {
      const rows = await eventsFor(ref);
      expect(rows).toHaveLength(1);
      const body = JSON.parse(rows[0].raw_body.toString());
      expect(body.entry).toHaveLength(1);
      expect(JSON.stringify(body)).toContain(mid);
    }
  });
});

describe("worker: processing", () => {
  it("creates identity, contact, conversation and message; stamps the workspace; replays change nothing", async () => {
    const ref = await account(wsA);
    const u = digits();
    const payload = msg(ref, u, "m.new", Date.parse("2026-11-01T10:00:00Z"));
    await send(payload);
    await send(payload); // Meta redelivers: a second stored event for the same message
    await drain();
    const evs = await eventsFor(ref);
    expect(evs.map((e) => e.status)).toEqual(["processed", "processed"]);
    expect(evs.every((e) => e.workspace_id === wsA)).toBe(true);
    const conv = await q("SELECT c.id, c.message_seq, c.last_inbound_at, ct.source, ct.name FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.integration_account_id = (SELECT id FROM integration_accounts WHERE external_account_id=$1)", [ref]);
    expect(conv).toHaveLength(1);
    expect(conv[0]).toMatchObject({ message_seq: "1", source: "messenger" });
    expect(conv[0].name).not.toContain("hello");
    const ms = await q("SELECT direction, sender_kind, delivery_state, body, seq FROM messages WHERE conversation_id = $1", [conv[0].id]);
    expect(ms).toEqual([{ direction: "in", sender_kind: "contact", delivery_state: "received", body: "hello m.new", seq: "1" }]);
    expect(new Date(conv[0].last_inbound_at).toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });

  it("keeps thread order by platform time: a late older message does not move last_message_at back", async () => {
    const ref = await account(wsA);
    const u = digits();
    await send(msg(ref, u, "m.new2", Date.parse("2026-11-02T10:00:00Z")));
    await send(msg(ref, u, "m.old2", Date.parse("2026-11-02T09:00:00Z")));
    await drain();
    const [c] = await q("SELECT last_message_at, message_seq FROM conversations WHERE integration_account_id = (SELECT id FROM integration_accounts WHERE external_account_id=$1)", [ref]);
    expect(new Date(c.last_message_at).toISOString()).toBe("2026-11-02T10:00:00.000Z");
    expect(c.message_seq).toBe("2");
  });

  it("stores echoes as outbound sent messages from an external sender and moves receipts forward only", async () => {
    const ref = await account(wsA);
    const u = digits();
    await send(msg(ref, u, "m.in3", Date.parse("2026-11-03T10:00:00Z")));
    await send(buildMessagePayload({ accountId: ref, userId: u, mid: `${RUN}.m.echo3`, text: "from the native app", timestampMs: Date.parse("2026-11-03T10:01:00Z"), echo: true }));
    const receipt = (kind: "read" | "delivery", ms: number) => ({ object: "page", entry: [{ id: ref, time: ms, messaging: [{ sender: { id: u }, recipient: { id: ref }, timestamp: ms, [kind]: { watermark: ms } }] }] });
    await send(receipt("read", Date.parse("2026-11-03T12:00:00Z")));
    await send(receipt("read", Date.parse("2026-11-03T11:00:00Z"))); // older: ignored
    await drain();
    const rows = await q("SELECT direction, sender_kind, delivery_state FROM messages WHERE external_id = $1", [`${RUN}.m.echo3`]);
    expect(rows).toEqual([{ direction: "out", sender_kind: "external", delivery_state: "sent" }]);
    const [c] = await q("SELECT contact_read_at FROM conversations WHERE integration_account_id = (SELECT id FROM integration_accounts WHERE external_account_id=$1)", [ref]);
    expect(new Date(c.contact_read_at).toISOString()).toBe("2026-11-03T12:00:00.000Z");
  });

  it("marks events for an unknown Page orphan, and a replay after the Page is connected processes them", async () => {
    const ref = digits();
    await send(msg(ref, digits(), "m.orph", Date.now()));
    await drain();
    const [e] = await eventsFor(ref);
    expect([e.status, e.last_error]).toEqual(["orphan", "unknown_account"]);
    expect(await q("SELECT 1 FROM contacts WHERE source='messenger' AND created_at > now() - interval '1 second' AND false")).toHaveLength(0);
    await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id) VALUES ($1,'messenger',$2)", [wsA, ref]);
    await q("UPDATE webhook_events SET status='received' WHERE id=$1", [e.id]);
    expect(await processWebhookEvent(workerDb, e.id)).toBe("processed");
  });

  it("never writes into another workspace: an account's event can only touch that account's workspace", async () => {
    const [refA, refB] = [await account(wsA), await account(wsB)];
    const u = digits();
    await send(msg(refA, u, "m.iso.a", Date.now()));
    await send(msg(refB, u, "m.iso.b", Date.now())); // same platform user id on two Pages: two different identities
    // A stored body that names Page B but is filed under Page A's account_ref must write nothing at all.
    const forged = signedFixture(msg(refB, u, "m.iso.forged", Date.now())).raw;
    await q("INSERT INTO webhook_events (platform, signature_valid, raw_body, body_sha256, body_size, account_ref, status) VALUES ('messenger', true, $1, sha256($1), $2, $3, 'received')", [forged, forged.length, refA]);
    await drain();
    const byWs = await q("SELECT workspace_id, count(*)::int AS n FROM messages WHERE external_id LIKE $1 GROUP BY 1 ORDER BY 1", [`${RUN}.m.iso.%`]);
    expect(byWs.sort((a, b) => a.workspace_id.localeCompare(b.workspace_id)).map((r) => [r.workspace_id, r.n]).sort()).toEqual([[wsA, 1], [wsB, 1]].sort());
    expect((await q("SELECT 1 FROM messages WHERE external_id = $1", [`${RUN}.m.iso.forged`]))).toHaveLength(0);
    expect((await q("SELECT count(*)::int AS n FROM platform_identities WHERE external_user_id=$1", [u]))[0].n).toBe(2);
  });
});

describe("worker: concurrency and recovery", () => {
  it("two workers on one event produce exactly one message; the loser skips", async () => {
    const ref = await account(wsA);
    await send(msg(ref, digits(), "m.race", Date.now()));
    const [e] = await eventsFor(ref);
    const out = await Promise.all([processWebhookEvent(workerDb, e.id), processWebhookEvent(workerDb, e.id), processWebhookEvent(workerDb, e.id)]);
    expect(out.filter((o) => o === "processed")).toHaveLength(1);
    expect(out.filter((o) => o === "skipped")).toHaveLength(2);
    expect((await q("SELECT count(*)::int AS n FROM messages WHERE external_id=$1", [`${RUN}.m.race`]))[0].n).toBe(1);
  });

  it("many events for one new thread processed in parallel give one contact, one conversation and gapless seq", async () => {
    const ref = await account(wsA);
    const u = digits();
    for (let i = 0; i < 12; i++) await send(msg(ref, u, `m.par${i}`, Date.parse("2026-11-04T10:00:00Z") + i * 1000));
    const ids = (await eventsFor(ref)).map((e) => e.id as string);
    const out = await Promise.all(ids.map((id) => processWebhookEvent(workerDb, id)));
    expect(out.every((o) => o === "processed")).toBe(true);
    const acc = "(SELECT id FROM integration_accounts WHERE external_account_id=$1)";
    expect((await q(`SELECT count(*)::int AS n FROM conversations WHERE integration_account_id = ${acc}`, [ref]))[0].n).toBe(1);
    expect((await q(`SELECT count(*)::int AS n FROM platform_identities WHERE integration_account_id = ${acc}`, [ref]))[0].n).toBe(1);
    expect((await q(`SELECT count(*)::int AS n FROM contacts WHERE id IN (SELECT contact_id FROM platform_identities WHERE integration_account_id = ${acc})`, [ref]))[0].n).toBe(1);
    const seqs = (await q(`SELECT seq FROM messages WHERE integration_account_id = ${acc} ORDER BY seq`, [ref])).map((r) => Number(r.seq));
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("a failure rolls the whole event back, is recorded without payload text, and a retry succeeds", async () => {
    const ws = await h.workspace(await h.newUser("inboxc"), "Inbox C");
    const ref = await account(ws);
    const stages = await q("SELECT id FROM lifecycle_stages WHERE workspace_id=$1", [ws]);
    await q("UPDATE lifecycle_stages SET archived_at = now() WHERE workspace_id=$1", [ws]); // no usable stage: contact creation must fail
    await send(msg(ref, digits(), "m.fail", Date.now(), { text: "SECRET customer text" }));
    const [e] = await eventsFor(ref);
    expect(await processWebhookEvent(workerDb, e.id)).toBe("failed");
    const [f] = await eventsFor(ref);
    expect([f.status, f.attempts, f.last_error]).toEqual(["failed", 1, "no_lifecycle_stage"]);
    expect(f.workspace_id).toBeNull(); // the routing stamp rolled back with everything else
    expect((await q("SELECT count(*)::int AS n FROM platform_identities WHERE workspace_id=$1", [ws]))[0].n).toBe(0);
    await q("UPDATE lifecycle_stages SET archived_at = NULL WHERE workspace_id=$1", [ws]);
    expect(stages.length).toBeGreaterThan(0);
    expect(await processWebhookEvent(workerDb, e.id)).toBe("processed");
    expect((await q("SELECT count(*)::int AS n FROM messages WHERE external_id=$1", [`${RUN}.m.fail`]))[0].n).toBe(1);
  });

  it("a poison event is dead-lettered at once and not picked up again", async () => {
    const ref = await account(wsA);
    const garbage = Buffer.from("{ not json");
    await q("INSERT INTO webhook_events (platform, signature_valid, raw_body, body_sha256, body_size, account_ref, status) VALUES ('messenger', true, $1, sha256($1), $2, $3, 'received')", [garbage, garbage.length, ref]);
    await drain();
    const [e] = await eventsFor(ref);
    expect([e.status, e.attempts, e.last_error]).toEqual(["failed", MAX_ATTEMPTS, "unparseable"]);
    const [e2] = await eventsFor(ref);
    await drain();
    expect((await eventsFor(ref))[0].attempts).toBe(e2.attempts);
  });
});

describe("raw body purge", () => {
  it("nulls bodies older than 30 days only, via the worker-only function", async () => {
    const ref = digits();
    const body = Buffer.from("{}");
    const ins = async (age: string) => (await q(`INSERT INTO webhook_events (platform, signature_valid, raw_body, body_sha256, body_size, account_ref, status, received_at) VALUES ('messenger', true, $1, sha256($1), 2, $2, 'processed', now() - interval '${age}') RETURNING id`, [body, ref]))[0].id as string;
    const [oldId, freshId] = [await ins("31 days"), await ins("2 days")];
    expect(await purgeRawBodies(workerDb)).toBeGreaterThanOrEqual(1);
    const rows = await q("SELECT id, raw_body, body_purged_at FROM webhook_events WHERE id = ANY($1)", [[oldId, freshId]]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[oldId].raw_body).toBeNull();
    expect(by[oldId].body_purged_at).not.toBeNull();
    expect(by[freshId].raw_body).not.toBeNull();
    await expect(ingestDb.$client.query("SELECT purge_webhook_event_bodies()")).rejects.toThrow(/permission denied/);
  });
});

describe("worker: event driven (no polling needed)", () => {
  it("processes stored events right away, with an hour-long interval, including a burst that arrives while a run is in progress", async () => {
    const ref = await account(wsA);
    let w: InboxWorker | null = null;
    const app = mount(cfg({ onStored: () => void w?.tick() }));
    w = startInboxWorker(workerDb, { intervalMs: 3_600_000, purgeEveryMs: 86_400_000 });
    try {
      await new Promise((r) => setTimeout(r, 500)); // the initial run
      const posts = await Promise.all(Array.from({ length: 6 }, (_, i) => { const f = signedFixture(msg(ref, digits(), `m.evt${i}`, Date.now() + i)); return post(app, "messenger", f.raw, f.signature); }));
      expect(posts.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      await expect.poll(async () => (await eventsFor(ref)).filter((e) => e.status === "processed").length, { timeout: 15_000 }).toBe(6);
      expect((await q("SELECT count(*)::int AS n FROM messages WHERE integration_account_id = (SELECT id FROM integration_accounts WHERE external_account_id=$1)", [ref]))[0].n).toBe(6);
    } finally {
      await w.stop();
    }
  });

  it("after stop() a late signal starts nothing and the event stays for the next process", async () => {
    const ref = await account(wsA);
    const w = startInboxWorker(workerDb, { intervalMs: 3_600_000, purgeEveryMs: 86_400_000 });
    await new Promise((r) => setTimeout(r, 400));
    await w.stop();
    const f = signedFixture(msg(ref, digits(), "m.late", Date.now()));
    expect((await post(hook, "messenger", f.raw, f.signature)).status).toBe(200); // ingress stored it while this process was shutting down
    await w.tick(); // the late signal
    await new Promise((r) => setTimeout(r, 400));
    expect((await eventsFor(ref)).map((e) => e.status)).toEqual(["received"]); // untouched: durable, picked up by the next process
    expect(await processPending(workerDb)).toMatchObject({ failed: 0 });
    expect((await eventsFor(ref))[0].status).toBe("processed");
  });

  it("a rejected or unusable delivery does not signal the worker", async () => {
    let signals = 0;
    const app = mount(cfg({ onStored: () => { signals += 1; } }));
    const raw = Buffer.from("{}");
    expect((await post(app, "messenger", raw, "sha256=" + "0".repeat(64))).status).toBe(403);
    expect((await post(app, "messenger", raw, signMetaBody(raw, mockSecret))).status).toBe(200); // signed but no entries: acknowledged, nothing stored
    expect(signals).toBe(0);
  });
});
