import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// Leads/pipeline schema: every CHECK and composite FK, role-by-command RLS, append-only history, immutability, tenancy.
const NAME = process.env.CRM_DB_NAME ?? "crm";
const ADMIN = process.env.DATABASE_URL_ADMIN ?? `postgres://postgres:postgres@127.0.0.1:5436/${NAME}`;
const APP = process.env.DATABASE_URL_APP ?? `postgres://crm_app:app_dev@127.0.0.1:5436/${NAME}`;
const run = Date.now().toString(36);
const U = { owner: `ls-owner-${run}`, admin: `ls-admin-${run}`, agent: `ls-agent-${run}`, viewer: `ls-viewer-${run}`, ownerB: `ls-ownerb-${run}` };
let db: Db, admin: pg.Client;
let A: string, B: string, pipe: string, pipeB: string, open1: string, open2: string, won: string, lost: string, stageB: string, reason: string, contactA: string, contactB: string, lifecycle: string;
const ctx = (userId: string, workspaceId?: string) => ({ userId, workspaceId });
const denied = /row-level security|permission denied/;
const rejects = (p: Promise<unknown>, re: RegExp = denied) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(re) } });
const base = () => ({ workspaceId: A, title: "Deal", primaryContactId: contactA, pipelineId: pipe, stageId: open1, outcome: "open", rank: "a0", probability: 10 });
const insertLead = (user: string, v: Record<string, unknown> = {}) => withContext(db, ctx(user, A), (tx) => tx.insert(schema.leads).values({ ...base(), ...v } as never).returning());

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  for (const id of Object.values(U)) await admin.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${id}@t.test`]);
  db = createDb(APP);
  const mk = (owner: string, slug: string) => withContext(db, { userId: owner }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug, ownerUserId: owner }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
    return w!.id;
  });
  A = await mk(U.owner, `ls-a-${run}`);
  B = await mk(U.ownerB, `ls-b-${run}`);
  await withContext(db, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values([
    { workspaceId: A, userId: U.admin, role: "admin" }, { workspaceId: A, userId: U.agent, role: "agent" }, { workspaceId: A, userId: U.viewer, role: "viewer" },
  ]));
  lifecycle = (await withContext(db, ctx(U.owner, A), (tx) => tx.insert(schema.lifecycleStages).values({ workspaceId: A, name: "New", position: 0 }).returning()))[0]!.id;
  const lifeB = (await withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.lifecycleStages).values({ workspaceId: B, name: "New", position: 0 }).returning()))[0]!.id;
  contactA = (await withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.contacts).values({ workspaceId: A, name: "Alice", lifecycleStageId: lifecycle }).returning()))[0]!.id;
  contactB = (await withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.contacts).values({ workspaceId: B, name: "Bob", lifecycleStageId: lifeB }).returning()))[0]!.id;
  const seed = async (ws: string, owner: string) => withContext(db, ctx(owner, ws), async (tx) => {
    const [p] = await tx.insert(schema.pipelines).values({ workspaceId: ws, name: "Sales", kind: "sales", isDefault: true, position: 0 }).returning();
    const st = await tx.insert(schema.pipelineStages).values([
      { workspaceId: ws, pipelineId: p!.id, name: "New", kind: "open", defaultProbability: 10, position: 0 },
      { workspaceId: ws, pipelineId: p!.id, name: "Qualified", kind: "open", defaultProbability: 40, position: 1 },
      { workspaceId: ws, pipelineId: p!.id, name: "Won", kind: "won", defaultProbability: 100, position: 2 },
      { workspaceId: ws, pipelineId: p!.id, name: "Lost", kind: "lost", defaultProbability: 0, position: 3 },
    ]).returning();
    const [r] = await tx.insert(schema.lostReasons).values({ workspaceId: ws, name: "No budget", position: 0 }).returning();
    return { p: p!.id, st, r: r!.id };
  });
  const a = await seed(A, U.owner);
  pipe = a.p; open1 = a.st[0]!.id; open2 = a.st[1]!.id; won = a.st[2]!.id; lost = a.st[3]!.id; reason = a.r;
  const b = await seed(B, U.ownerB);
  pipeB = b.p; stageB = b.st[0]!.id;
});
afterAll(async () => { await db.$client.end(); await admin.end(); });

describe("constraints", () => {
  it("accepts a valid open lead", async () => { expect((await insertLead(U.agent))[0]!.outcome).toBe("open"); });
  it.each([
    ["empty title", { title: "" }], ["title over 160", { title: "x".repeat(161) }], ["probability 101", { probability: 101 }], ["negative value", { valueMinor: -1, currency: "USD" }],
    ["value without currency", { valueMinor: 5 }], ["currency without value", { currency: "USD" }], ["bad currency", { valueMinor: 5, currency: "usd" }],
    ["close date out of range", { expectedCloseDate: "1999-01-01" }], ["bad priority", { priority: "urgent" }],
    ["closed_at on open", { closedAt: new Date() }], ["lost reason on open", () => ({ lostReasonId: reason })],
  ])("rejects %s", async (_n, v) => { await expect(insertLead(U.agent, typeof v === "function" ? v() : v)).rejects.toBeTruthy(); });
  it("outcome must equal the stage kind (composite FK)", async () => {
    await expect(insertLead(U.agent, { stageId: won, outcome: "open", probability: 100 })).rejects.toBeTruthy();
    await expect(insertLead(U.agent, { stageId: open1, outcome: "won", probability: 100, closedAt: new Date() })).rejects.toBeTruthy();
  });
  it("won needs probability 100; lost needs a reason and probability 0", async () => {
    await expect(insertLead(U.agent, { stageId: won, outcome: "won", probability: 50, closedAt: new Date() })).rejects.toBeTruthy();
    expect((await insertLead(U.agent, { stageId: won, outcome: "won", probability: 100, closedAt: new Date() }))[0]!.outcome).toBe("won");
    await expect(insertLead(U.agent, { stageId: lost, outcome: "lost", probability: 0, closedAt: new Date() })).rejects.toBeTruthy();
    expect((await insertLead(U.agent, { stageId: lost, outcome: "lost", probability: 0, closedAt: new Date(), lostReasonId: reason }))[0]!.outcome).toBe("lost");
  });
  it("stage from another pipeline, contact or stage from another workspace are rejected", async () => {
    await expect(insertLead(U.agent, { primaryContactId: contactB })).rejects.toBeTruthy();
    await expect(insertLead(U.agent, { stageId: stageB })).rejects.toBeTruthy();
    await expect(insertLead(U.agent, { pipelineId: pipeB })).rejects.toBeTruthy();
  });
  it("one won and one lost stage per pipeline; terminal stages cannot be archived", async () => {
    await expect(withContext(db, ctx(U.owner, A), (tx) => tx.insert(schema.pipelineStages).values({ workspaceId: A, pipelineId: pipe, name: "Won2", kind: "won", defaultProbability: 100, position: 9 }))).rejects.toBeTruthy();
    await expect(withContext(db, ctx(U.owner, A), (tx) => tx.update(schema.pipelineStages).set({ archivedAt: new Date() }).where(eq(schema.pipelineStages.id, won)))).rejects.toBeTruthy();
  });
  it("stage kind and pipeline are immutable", async () => {
    await expect(withContext(db, ctx(U.owner, A), (tx) => tx.update(schema.pipelineStages).set({ kind: "lost", defaultProbability: 0 }).where(eq(schema.pipelineStages.id, open2)))).rejects.toBeTruthy();
  });
  it("one default pipeline per workspace and unique active names", async () => {
    await expect(withContext(db, ctx(U.owner, A), (tx) => tx.insert(schema.pipelines).values({ workspaceId: A, name: "Other", kind: "lead", isDefault: true, position: 1 }))).rejects.toBeTruthy();
    await expect(withContext(db, ctx(U.owner, A), (tx) => tx.insert(schema.pipelines).values({ workspaceId: A, name: "sales", kind: "lead", position: 1 }))).rejects.toBeTruthy();
  });
});

describe("RLS by role", () => {
  it("viewer reads but cannot write leads", async () => {
    expect((await withContext(db, ctx(U.viewer, A), (tx) => tx.select().from(schema.leads))).length).toBeGreaterThan(0);
    await rejects(insertLead(U.viewer));
  });
  it("agent can update but cannot soft-delete (admin can); nobody can hard-delete", async () => {
    const [l] = await insertLead(U.agent);
    await withContext(db, ctx(U.agent, A), (tx) => tx.update(schema.leads).set({ title: "renamed" }).where(eq(schema.leads.id, l!.id)));
    await rejects(withContext(db, ctx(U.agent, A), (tx) => tx.update(schema.leads).set({ deletedAt: new Date() }).where(eq(schema.leads.id, l!.id))));
    await withContext(db, ctx(U.admin, A), (tx) => tx.update(schema.leads).set({ deletedAt: new Date() }).where(eq(schema.leads.id, l!.id)));
    await rejects(withContext(db, ctx(U.owner, A), (tx) => tx.delete(schema.leads).where(eq(schema.leads.id, l!.id))));
  });
  it("pipeline configuration is owner/admin only", async () => {
    await rejects(withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.pipelines).values({ workspaceId: A, name: "X", kind: "lead", position: 5 })));
    await rejects(withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.lostReasons).values({ workspaceId: A, name: "X", position: 5 })));
    await withContext(db, ctx(U.admin, A), (tx) => tx.insert(schema.lostReasons).values({ workspaceId: A, name: "Timing", position: 5 }));
  });
  it("other workspace sees nothing and cannot write", async () => {
    expect(await withContext(db, ctx(U.ownerB, B), (tx) => tx.select().from(schema.leads))).toHaveLength(0);
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.leads).values({ ...base() } as never)));
  });
  it("value grants: owner/admin manage, agent sees only own grant", async () => {
    const [l] = await insertLead(U.agent);
    await withContext(db, ctx(U.admin, A), (tx) => tx.insert(schema.leadValueGrants).values({ workspaceId: A, leadId: l!.id, userId: U.agent, grantedBy: U.admin }));
    await rejects(withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.leadValueGrants).values({ workspaceId: A, leadId: l!.id, userId: U.viewer, grantedBy: U.agent })));
    const seen = await withContext(db, ctx(U.agent, A), (tx) => tx.select().from(schema.leadValueGrants));
    expect(seen.every((g) => g.userId === U.agent)).toBe(true);
  });
});

describe("stage_transitions", () => {
  it("is append-only and records the actor as the caller", async () => {
    const [l] = await insertLead(U.agent);
    const row = { workspaceId: A, leadId: l!.id, pipelineId: pipe, toStageId: open1, toOutcome: "open" };
    await rejects(withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.stageTransitions).values({ ...row, actorUserId: U.admin })));
    await withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.stageTransitions).values({ ...row, actorUserId: U.agent }));
    await rejects(withContext(db, ctx(U.owner, A), (tx) => tx.update(schema.stageTransitions).set({ toOutcome: "won" })));
    await rejects(withContext(db, ctx(U.owner, A), (tx) => tx.delete(schema.stageTransitions)));
    await expect(admin.query(`DELETE FROM stage_transitions`)).rejects.toThrow(/append-only/);
  });
});

describe("task links and activities", () => {
  it("task_links accepts a lead, rejects unknown entity types and foreign-workspace leads", async () => {
    const [l] = await insertLead(U.agent);
    const [t] = await withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.tasks).values({ workspaceId: A, title: "call", createdBy: U.agent }).returning());
    await withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.taskLinks).values({ workspaceId: A, taskId: t!.id, entityType: "lead", entityId: l!.id }));
    await expect(withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.taskLinks).values({ workspaceId: A, taskId: t!.id, entityType: "deal", entityId: l!.id }))).rejects.toBeTruthy();
    await expect(withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.taskLinks).values({ workspaceId: A, taskId: t!.id, entityType: "lead", entityId: crypto.randomUUID() }))).rejects.toBeTruthy();
  });
  it("activities.lead_id composite FK blocks a lead from another workspace", async () => {
    const [l] = await insertLead(U.agent);
    await withContext(db, ctx(U.agent, A), (tx) => tx.insert(schema.activities).values({ workspaceId: A, contactId: contactA, leadId: l!.id, kind: "lead.created", actorType: "user", actorUserId: U.agent }));
    await expect(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.activities).values({ workspaceId: B, contactId: contactB, leadId: l!.id, kind: "lead.created", actorType: "user", actorUserId: U.ownerB }))).rejects.toBeTruthy();
  });
});
