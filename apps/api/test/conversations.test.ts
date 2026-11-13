import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, agent2: TestUser, viewer: TestUser, other: TestUser;
let ws: string, wsOther: string, acct: string, acctOther: string;
const digits = () => `6${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

const call = (u: TestUser, method: string, path: string, body?: unknown) =>
  h.app.request(path, { method, headers: { cookie: u.cookie, origin: "http://localhost:3000", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const CP = (w: string) => `/v1/workspaces/${w}/conversations`;
const list = async (u: TestUser, qs = "", w = ws) => (await call(u, "GET", `${CP(w)}${qs}`)).json();

async function account(w: string) {
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, display_name) VALUES ($1,'messenger',$2,'Test Page') RETURNING id", [w, digits()]);
  return a.id as string;
}
type Msg = { dir: "in" | "out"; body?: string | null; at: string; state?: string; attachments?: unknown[] };
/** Inserts contact, identity, conversation and its messages as the superuser. Returns the conversation id. */
async function conv(w: string, a: string, name: string, msgs: Msg[], opts: { status?: string; assignee?: string | null; lastAt?: string } = {}) {
  const [stage] = await q("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1", [w]);
  const [ct] = await q("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,$2,$3,'messenger') RETURNING id", [w, name, stage.id]);
  const [idn] = await q("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [w, a, digits(), ct.id]);
  const [cv] = await q("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id, status, assignee_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [w, a, idn.id, ct.id, opts.status ?? "open", opts.assignee ?? null]);
  for (const m of msgs) await addMsg(w, a, cv.id, m);
  const inbound = msgs.filter((m) => m.dir === "in").map((m) => m.at).sort();
  const all = msgs.map((m) => m.at).sort();
  await q("UPDATE conversations SET last_message_at = $2::timestamptz, last_inbound_at = $3::timestamptz WHERE id=$1", [cv.id, opts.lastAt ?? all.at(-1) ?? null, inbound.at(-1) ?? null]);
  return cv.id as string;
}
async function addMsg(w: string, a: string, cid: string, m: Msg) {
  const inbound = m.dir === "in";
  await q(
    `INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, sender_user_id, body, attachments, delivery_state, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
    [w, cid, a, m.dir, inbound ? `m.${digits()}` : null, inbound ? "contact" : "user", inbound ? null : owner.id, m.body === undefined ? "hello" : m.body, JSON.stringify(m.attachments ?? []), inbound ? "received" : (m.state ?? "sent"), m.at],
  );
}
const unreadOf = async (u: TestUser, id: string) => (await (await call(u, "GET", `${CP(ws)}/${id}`)).json()).unreadCount as number;

beforeAll(async () => {
  h = await bootstrap();
  [owner, admin, agent, agent2, viewer, other] = (await Promise.all(["cvowner", "cvadmin", "cvagent", "cvagent2", "cvviewer", "cvother"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];
  ws = await h.workspace(owner, "Conv A", { admin, agent, agent2, viewer });
  wsOther = await h.workspace(other, "Conv B");
  acct = await account(ws);
  acctOther = await account(wsOther);
});
afterAll(async () => h.close());

describe("list", () => {
  it("returns derived fields: preview, direction, per-user unread, reply window, account, and totals", async () => {
    const w = await h.workspace(owner, "Conv List", { agent });
    const a = await account(w);
    const open = await conv(w, a, "Maria Lopez", [{ dir: "in", body: "Is the blue one available?", at: iso(30) }, { dir: "out", body: "Yes, 3 in stock.", at: iso(25) }, { dir: "in", body: "x".repeat(300), at: iso(5) }]);
    const closed = await conv(w, a, "Jon Park", [{ dir: "in", body: "Thanks", at: iso(60 * 30) }]);
    const none = await conv(w, a, "No Inbound", [{ dir: "out", body: "Hello first", at: iso(10) }]);
    const res = await list(owner, "", w);
    expect(res.items.map((i: { id: string }) => i.id)).toEqual([open, none, closed]); // last message newest first
    const byId = Object.fromEntries(res.items.map((i: { id: string }) => [i.id, i]));
    expect(byId[open]).toMatchObject({ platform: "messenger", accountName: "Test Page", status: "open", assignee: null, unreadCount: 2, previewDirection: "in", replyWindow: "open", contact: { name: "Maria Lopez" } });
    expect(byId[open].preview).toHaveLength(120);
    expect(byId[closed]).toMatchObject({ unreadCount: 1, replyWindow: "closed" });
    expect(byId[none]).toMatchObject({ unreadCount: 0, replyWindow: "none", previewDirection: "out" });
    expect(res.totalUnread).toBe(3);
    expect(res.nextCursor).toBeNull();
  });

  it("paginates with a stable keyset cursor (ties on the same timestamp included) and rejects a bad cursor", async () => {
    const w = await h.workspace(owner, "Conv Pages");
    const a = await account(w);
    const same = iso(10);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await conv(w, a, `P${i}`, [{ dir: "in", at: i < 3 ? same : iso(20 + i) }], { lastAt: i < 3 ? same : iso(20 + i) }));
    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const r = await list(owner, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`, w);
      seen.push(...r.items.map((i: { id: string }) => i.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(new Set(seen)).toEqual(new Set(ids));
    const bad = await call(owner, "GET", `${CP(w)}?cursor=garbage`);
    expect(bad.status).toBe(400);
  });

  it("filters by status, assignee (me, unassigned, user id), unread and name, with LIKE wildcards escaped", async () => {
    const w = await h.workspace(owner, "Conv Filters", { agent, agent2 });
    const a = await account(w);
    const open = await conv(w, a, "Alpha Open", [{ dir: "in", at: iso(5) }]);
    const resolved = await conv(w, a, "Beta Resolved", [{ dir: "in", at: iso(6) }], { status: "resolved" });
    const mine = await conv(w, a, "Gamma Mine", [{ dir: "out", at: iso(7) }], { assignee: agent.id });
    const pct = await conv(w, a, "100%_Fan", [{ dir: "in", at: iso(8) }]);
    const plain = await conv(w, a, "100 Xfan", [{ dir: "in", at: iso(9) }]);
    const ids = async (qs: string, u = owner) => (await list(u, qs, w)).items.map((i: { id: string }) => i.id).sort();
    expect(await ids("?status=resolved")).toEqual([resolved]);
    expect(await ids("?assignee=me", agent)).toEqual([mine]);
    expect(await ids("?assignee=me")).toEqual([]);
    expect(await ids(`?assignee=${agent.id}`)).toEqual([mine]);
    expect(await ids("?assignee=unassigned")).toEqual([open, resolved, pct, plain].sort());
    expect(await ids("?unread=1")).toEqual([open, resolved, pct, plain].sort()); // the outbound-only one is not unread
    expect(await ids("?q=alpha")).toEqual([open]);
    expect(await ids("?q=" + encodeURIComponent("100%_"))).toEqual([pct]); // % and _ are literal
    expect(await ids("?q=" + encodeURIComponent("%"))).toEqual([pct]);
    expect((await call(owner, "GET", `${CP(w)}?status=bogus`)).status).toBe(400);
  });
});

describe("detail, messages and tenant isolation", () => {
  it("returns detail and an ascending message page with attachments and delivery states", async () => {
    const id = await conv(ws, acct, "Detail Person", [
      { dir: "in", body: "m1", at: iso(50), attachments: [{ type: "image", url: "https://example.com/a.png" }, { type: "audio" }] },
      { dir: "out", body: "m2", at: iso(40), state: "unknown" },
      { dir: "out", body: null, at: iso(30), state: "failed", attachments: [{ type: "file", url: "https://example.com/f.pdf" }] },
      { dir: "in", body: "m4", at: iso(20) },
    ]);
    const d = await (await call(viewer, "GET", `${CP(ws)}/${id}`)).json(); // viewers can read
    expect(d).toMatchObject({ id, lastSeq: 4, lastReadSeq: 0, unreadCount: 2, contactSummary: { name: "Detail Person", email: null }, replyWindow: "open" });
    const all = await (await call(viewer, "GET", `${CP(ws)}/${id}/messages`)).json();
    expect(all.items.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(all.hasMore).toBe(false);
    expect(all.items[0].attachments).toEqual([{ type: "image", url: "https://example.com/a.png" }, { type: "audio", url: null }]);
    expect(all.items.map((m: { deliveryState: string }) => m.deliveryState)).toEqual(["received", "unknown", "failed", "received"]);
    expect(all.items[1]).toMatchObject({ direction: "out", senderKind: "user", senderName: owner.name });
    const older = await (await call(owner, "GET", `${CP(ws)}/${id}/messages?limit=2`)).json();
    expect(older.items.map((m: { seq: number }) => m.seq)).toEqual([3, 4]);
    expect(older.hasMore).toBe(true);
    const before = await (await call(owner, "GET", `${CP(ws)}/${id}/messages?before=3&limit=2`)).json();
    expect(before.items.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    expect(before.hasMore).toBe(false);
  });

  it("another workspace sees nothing: 404 as a non-member, empty list as a member, 404 on a foreign id", async () => {
    const id = await conv(ws, acct, "Private Person", [{ dir: "in", body: "secret", at: iso(3) }]);
    expect((await call(other, "GET", CP(ws))).status).toBe(404);
    expect((await call(other, "GET", `${CP(ws)}/${id}`)).status).toBe(404);
    // the other workspace's own routes: id from workspace A is unknown there
    expect((await call(other, "GET", `${CP(wsOther)}/${id}`)).status).toBe(404);
    expect((await call(other, "GET", `${CP(wsOther)}/${id}/messages`)).status).toBe(404);
    expect((await call(other, "POST", `${CP(wsOther)}/${id}/read`, { upToSeq: 1 })).status).toBe(404);
    expect((await call(other, "PATCH", `${CP(wsOther)}/${id}`, { status: "resolved", expectedVersion: 1 })).status).toBe(404);
    expect(await list(other, "", wsOther)).toMatchObject({ items: [], totalUnread: 0 });
    await conv(wsOther, acctOther, "Other Person", [{ dir: "in", at: iso(1) }]);
    const mine = await list(owner);
    expect(JSON.stringify(mine)).not.toContain("Other Person");
    expect((await call(owner, "GET", `${CP(ws)}/not-a-uuid`)).status).toBe(404);
  });

  it("the typed client matches the served routes", async () => {
    const r = await h.clientFor(owner).call(endpoints.listConversations, { params: { workspaceId: ws } });
    expect(r.ok).toBe(true);
  });
});

describe("read state (per user)", () => {
  it("each user has an independent cursor: A reading never clears B, own and outbound messages never count", async () => {
    const id = await conv(ws, acct, "Reads Person", [{ dir: "in", at: iso(9) }, { dir: "out", at: iso(8) }, { dir: "in", at: iso(7) }, { dir: "in", at: iso(6) }]);
    expect(await unreadOf(agent, id)).toBe(3);
    expect(await unreadOf(agent2, id)).toBe(3);
    const r = await call(agent, "POST", `${CP(ws)}/${id}/read`, { upToSeq: 3 });
    expect(await r.json()).toEqual({ lastReadSeq: 3, unreadCount: 1 });
    expect(await unreadOf(agent, id)).toBe(1);
    expect(await unreadOf(agent2, id)).toBe(3); // B untouched
    expect(await unreadOf(owner, id)).toBe(3);
    expect(await (await call(viewer, "POST", `${CP(ws)}/${id}/read`, { upToSeq: 4 })).json()).toEqual({ lastReadSeq: 4, unreadCount: 0 }); // viewers keep their own cursor
    expect(await unreadOf(agent, id)).toBe(1);
  });

  it("is forward-only and clamped to the last message", async () => {
    const id = await conv(ws, acct, "Cursor Person", [{ dir: "in", at: iso(5) }, { dir: "in", at: iso(4) }, { dir: "in", at: iso(3) }]);
    expect(await (await call(owner, "POST", `${CP(ws)}/${id}/read`, { upToSeq: 2 })).json()).toEqual({ lastReadSeq: 2, unreadCount: 1 });
    expect(await (await call(owner, "POST", `${CP(ws)}/${id}/read`, { upToSeq: 1 })).json()).toEqual({ lastReadSeq: 2, unreadCount: 1 }); // never back
    expect(await (await call(owner, "POST", `${CP(ws)}/${id}/read`, { upToSeq: 999 })).json()).toEqual({ lastReadSeq: 3, unreadCount: 0 }); // clamped, no 500
    expect((await call(owner, "POST", `${CP(ws)}/${id}/read`, { upToSeq: -1 })).status).toBe(400);
    const rows = await q("SELECT count(*)::int AS n FROM conversation_reads WHERE conversation_id=$1 AND user_id=$2", [id, owner.id]);
    expect(rows[0].n).toBe(1);
  });

  it("concurrent reads and incoming messages never wrongly clear unread", async () => {
    for (let round = 0; round < 6; round++) {
      const id = await conv(ws, acct, `Race ${round}`, [{ dir: "in", at: iso(9) }, { dir: "in", at: iso(8) }, { dir: "in", at: iso(7) }]);
      const readers = [1, 2, 3, 3, 2, 3].map((n) => call(agent, "POST", `${CP(ws)}/${id}/read`, { upToSeq: n }));
      const inserts = [0, 1, 2].map((i) => addMsg(ws, acct, id, { dir: "in", at: iso(5 - i) }));
      const reads = await Promise.all([...readers, ...inserts]);
      expect(reads.slice(0, 6).every((x) => (x as Response).status === 200)).toBe(true);
      const [{ last, total }] = await q("SELECT (SELECT last_read_seq FROM conversation_reads WHERE conversation_id=$1 AND user_id=$2)::int AS last, (SELECT message_seq FROM conversations WHERE id=$1)::int AS total", [id, agent.id]);
      expect(last).toBe(3); // reads were all up to the first three messages; the cursor never exceeds what was read
      expect(total).toBe(6);
      expect(await unreadOf(agent, id)).toBe(3); // the three messages that arrived meanwhile are all still unread
    }
  });
});

describe("update: status and assignment", () => {
  it("changes status with optimistic concurrency, bumps the version, writes an audit entry, and a stale version is a 409", async () => {
    const id = await conv(ws, acct, "Status Person", [{ dir: "in", at: iso(5) }]);
    const v1 = (await (await call(agent, "GET", `${CP(ws)}/${id}`)).json()).version as number;
    const res = await call(agent, "PATCH", `${CP(ws)}/${id}`, { status: "pending", expectedVersion: v1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "pending", version: v1 + 1 });
    const stale = await call(owner, "PATCH", `${CP(ws)}/${id}`, { status: "resolved", expectedVersion: v1 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("version_conflict");
    const audit = await q("SELECT action, summary FROM audit_log WHERE workspace_id=$1 AND entity_id=$2", [ws, id]);
    expect(audit).toEqual([{ action: "conversation.status_changed", summary: { from: "open", to: "pending" } }]);
    const noop = await call(owner, "PATCH", `${CP(ws)}/${id}`, { status: "pending", expectedVersion: v1 + 1 });
    expect((await noop.json()).version).toBe(v1 + 1); // nothing changed, no bump
    expect((await call(owner, "PATCH", `${CP(ws)}/${id}`, { expectedVersion: v1 + 1 })).status).toBe(400);
    expect((await call(owner, "PATCH", `${CP(ws)}/${id}`, { status: "weird", expectedVersion: v1 + 1 })).status).toBe(400);
  });

  it("owner and admin assign anyone; an agent only takes it for themselves or releases their own; viewers change nothing", async () => {
    const id = await conv(ws, acct, "Assign Person", [{ dir: "in", at: iso(5) }]);
    const ver = async () => (await (await call(owner, "GET", `${CP(ws)}/${id}`)).json()).version as number;
    const as = async (u: TestUser, b: Record<string, unknown>) => call(u, "PATCH", `${CP(ws)}/${id}`, { ...b, expectedVersion: await ver() });
    expect((await as(owner, { assigneeUserId: agent2.id })).status).toBe(200);
    expect((await as(agent, { assigneeUserId: agent.id })).status).toBe(200); // self-assign over someone else's: allowed by the matrix ("self")
    expect((await as(agent, { assigneeUserId: agent2.id })).status).toBe(403); // not for others
    expect((await as(agent2, { assigneeUserId: null })).status).toBe(403); // cannot release someone else's
    expect((await as(agent, { assigneeUserId: null })).status).toBe(200); // can release their own
    expect((await as(admin, { assigneeUserId: agent2.id })).status).toBe(200);
    expect((await as(viewer, { assigneeUserId: viewer.id })).status).toBe(403);
    expect((await as(viewer, { status: "resolved" })).status).toBe(403);
    expect((await as(owner, { assigneeUserId: other.id })).status).toBe(422); // not a member of this workspace
    const d = await (await call(owner, "GET", `${CP(ws)}/${id}`)).json();
    expect(d.assignee).toMatchObject({ userId: agent2.id });
    const acts = (await q("SELECT action FROM audit_log WHERE workspace_id=$1 AND entity_id=$2 ORDER BY id", [ws, id])).map((r) => r.action);
    expect(acts).toEqual(["conversation.assigned", "conversation.assigned", "conversation.assigned", "conversation.assigned"]);
  });
});
