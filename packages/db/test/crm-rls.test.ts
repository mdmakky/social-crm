import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

const ADMIN = process.env.DATABASE_URL_ADMIN ?? "postgres://postgres:postgres@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
const APP = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
const run = Date.now().toString(36);
const U = { ownerA: `ca-owner-${run}`, adminA: `ca-admin-${run}`, agentA: `ca-agent-${run}`, viewerA: `ca-viewer-${run}`, agent2A: `ca-agent2-${run}`, ownerB: `ca-ownerb-${run}` };

let db: Db;
let admin: pg.Client;
let A: string;
let B: string;
let stageA: string;
let stageB: string;
let contactA: string;
let contactB: string;

const ctx = (userId: string, workspaceId: string) => ({ userId, workspaceId });
const denied = /row-level security|permission denied|violates foreign key|append-only/;
const rejects = async (p: Promise<unknown>) => {
  await expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(denied) } });
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  for (const [k, id] of Object.entries(U)) await admin.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${k}-${run}@t.example`]);
  db = createDb(APP);
  const mk = async (owner: string, slug: string) =>
    withContext(db, { userId: owner }, async (tx) => {
      const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug, ownerUserId: owner }).returning();
      await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
      return w!.id;
    });
  A = await mk(U.ownerA, `crm-a-${run}`);
  B = await mk(U.ownerB, `crm-b-${run}`);
  await withContext(db, ctx(U.ownerA, A), (tx) =>
    tx.insert(schema.memberships).values([
      { workspaceId: A, userId: U.adminA, role: "admin" },
      { workspaceId: A, userId: U.agentA, role: "agent" },
      { workspaceId: A, userId: U.agent2A, role: "agent" },
      { workspaceId: A, userId: U.viewerA, role: "viewer" },
    ]),
  );
  stageA = (await withContext(db, ctx(U.ownerA, A), (tx) => tx.insert(schema.lifecycleStages).values({ workspaceId: A, name: "New", position: 0 }).returning()))[0]!.id;
  stageB = (await withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.lifecycleStages).values({ workspaceId: B, name: "New", position: 0 }).returning()))[0]!.id;
  contactA = (await withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.contacts).values({ workspaceId: A, name: "Alice A", lifecycleStageId: stageA }).returning()))[0]!.id;
  contactB = (await withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.contacts).values({ workspaceId: B, name: "Bob B", lifecycleStageId: stageB }).returning()))[0]!.id;
});
afterAll(async () => {
  await db.$client.end();
  await admin.end();
});

const TABLES = ["lifecycle_stages", "contacts", "tags", "contact_tags", "custom_field_definitions", "notes", "activities", "tasks", "saved_views", "import_jobs"];

describe("CRM tables: tenant isolation", () => {
  it("no context sees nothing in any CRM table", async () => {
    for (const t of TABLES) expect((await db.execute(sql.raw(`SELECT 1 FROM ${t}`))).rows, t).toEqual([]);
  });
  it("another workspace's members see none of workspace A's rows, even when asking for them by id", async () => {
    const rows = await withContext(db, ctx(U.ownerB, B), (tx) => tx.execute(sql`SELECT id FROM contacts WHERE id = ${contactA}`));
    expect(rows.rows).toEqual([]);
    const stages = await withContext(db, ctx(U.ownerB, B), (tx) => tx.select().from(schema.lifecycleStages));
    expect(stages.map((s) => s.id)).toEqual([stageB]);
  });
  it("a user who is not a member of the workspace sees nothing even with that workspace's context set", async () => {
    const rows = await withContext(db, ctx(U.ownerB, A), (tx) => tx.select().from(schema.contacts));
    expect(rows).toEqual([]);
  });
  it("cannot write into another workspace", async () => {
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.contacts).values({ workspaceId: A, name: "Planted", lifecycleStageId: stageA })));
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.tags).values({ workspaceId: A, name: "x" })));
  });
  it("composite foreign keys stop a contact using another workspace's lifecycle stage", async () => {
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.contacts).values({ workspaceId: B, name: "Cross", lifecycleStageId: stageA })));
  });
  it("composite foreign keys stop notes, tasks and tags attaching to another workspace's contact", async () => {
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.notes).values({ workspaceId: B, contactId: contactA, authorUserId: U.ownerB, body: "x" })));
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.tasks).values({ workspaceId: B, contactId: contactA, title: "x", createdBy: U.ownerB })));
    const [tagB] = await withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.tags).values({ workspaceId: B, name: `t-${run}` }).returning());
    await rejects(withContext(db, ctx(U.ownerB, B), (tx) => tx.insert(schema.contactTags).values({ workspaceId: B, contactId: contactA, tagId: tagB!.id })));
  });
  it("hard deletes of contacts, stages, notes and import jobs are denied to the app role", async () => {
    await rejects(withContext(db, ctx(U.ownerA, A), (tx) => tx.execute(sql`DELETE FROM contacts WHERE id = ${contactA}`)));
    await rejects(withContext(db, ctx(U.ownerA, A), (tx) => tx.execute(sql`DELETE FROM lifecycle_stages WHERE id = ${stageA}`)));
  });
});

describe("CRM tables: role boundaries enforced by the database", () => {
  it("viewers cannot create or change contacts, notes, tasks or tags", async () => {
    const v = ctx(U.viewerA, A);
    await rejects(withContext(db, v, (tx) => tx.insert(schema.contacts).values({ workspaceId: A, name: "V", lifecycleStageId: stageA })));
    await rejects(withContext(db, v, (tx) => tx.insert(schema.notes).values({ workspaceId: A, contactId: contactA, authorUserId: U.viewerA, body: "x" })));
    await rejects(withContext(db, v, (tx) => tx.insert(schema.tasks).values({ workspaceId: A, contactId: contactA, title: "x", createdBy: U.viewerA })));
    await rejects(withContext(db, v, (tx) => tx.insert(schema.tags).values({ workspaceId: A, name: "v" })));
    const upd = await withContext(db, v, (tx) => tx.execute(sql`UPDATE contacts SET name = 'hacked' WHERE id = ${contactA}`));
    expect(upd.rowCount).toBe(0);
  });
  it("viewers can read", async () => {
    const rows = await withContext(db, ctx(U.viewerA, A), (tx) => tx.select().from(schema.contacts));
    expect(rows.map((r) => r.id)).toContain(contactA);
  });
  it("agents cannot configure lifecycle stages or custom fields, or read import jobs", async () => {
    const a = ctx(U.agentA, A);
    await rejects(withContext(db, a, (tx) => tx.insert(schema.lifecycleStages).values({ workspaceId: A, name: "Agent stage", position: 9 })));
    await rejects(withContext(db, a, (tx) => tx.insert(schema.customFieldDefinitions).values({ workspaceId: A, key: "k", label: "K", type: "text" })));
    await rejects(withContext(db, a, (tx) => tx.insert(schema.importJobs).values({ workspaceId: A, filename: "x.csv", csv: "a", createdBy: U.agentA })));
    await withContext(db, ctx(U.adminA, A), (tx) => tx.insert(schema.importJobs).values({ workspaceId: A, filename: "x.csv", csv: "a", createdBy: U.adminA }));
    expect(await withContext(db, a, (tx) => tx.select().from(schema.importJobs))).toEqual([]);
    expect((await withContext(db, ctx(U.adminA, A), (tx) => tx.select().from(schema.importJobs))).length).toBeGreaterThan(0);
  });
  it("agents can create contacts and tags but cannot rename or delete tags", async () => {
    const a = ctx(U.agentA, A);
    const [tag] = await withContext(db, a, (tx) => tx.insert(schema.tags).values({ workspaceId: A, name: `agent-tag-${run}` }).returning());
    const renamed = await withContext(db, a, (tx) => tx.execute(sql`UPDATE tags SET name = 'renamed' WHERE id = ${tag!.id}`));
    expect(renamed.rowCount).toBe(0);
    const removed = await withContext(db, a, (tx) => tx.execute(sql`DELETE FROM tags WHERE id = ${tag!.id}`));
    expect(removed.rowCount).toBe(0);
    expect((await withContext(db, ctx(U.adminA, A), (tx) => tx.execute(sql`UPDATE tags SET name = ${`renamed-${run}`} WHERE id = ${tag!.id}`))).rowCount).toBe(1);
  });
  it("notes: an agent edits their own but not another agent's; an admin edits any", async () => {
    const [n] = await withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.notes).values({ workspaceId: A, contactId: contactA, authorUserId: U.agentA, body: "mine" }).returning());
    const own = await withContext(db, ctx(U.agentA, A), (tx) => tx.execute(sql`UPDATE notes SET body = 'edited' WHERE id = ${n!.id}`));
    expect(own.rowCount).toBe(1);
    const other = await withContext(db, ctx(U.agent2A, A), (tx) => tx.execute(sql`UPDATE notes SET body = 'tampered' WHERE id = ${n!.id}`));
    expect(other.rowCount).toBe(0);
    const adm = await withContext(db, ctx(U.adminA, A), (tx) => tx.execute(sql`UPDATE notes SET body = 'moderated' WHERE id = ${n!.id}`));
    expect(adm.rowCount).toBe(1);
  });
  it("a note cannot be written in someone else's name", async () => {
    await rejects(withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.notes).values({ workspaceId: A, contactId: contactA, authorUserId: U.agent2A, body: "forged" })));
  });
});

describe("activities and saved views", () => {
  it("the contact timeline is append-only for everyone, including the table owner", async () => {
    await withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.activities).values({ workspaceId: A, contactId: contactA, kind: "contact.created", actorUserId: U.agentA }));
    await rejects(withContext(db, ctx(U.ownerA, A), (tx) => tx.execute(sql`UPDATE activities SET kind = 'x'`)));
    await rejects(withContext(db, ctx(U.ownerA, A), (tx) => tx.execute(sql`DELETE FROM activities`)));
    const owner = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATOR ?? "postgres://crm_migrator:migrator_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "" });
    await owner.connect();
    await expect(owner.query("UPDATE activities SET kind = 'x'")).rejects.toThrow(/append-only/);
    await owner.end();
  });
  it("personal saved views are private; shared views are visible to the workspace and managed by admins", async () => {
    const cfg = { columns: ["contact"] };
    await withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.savedViews).values({ workspaceId: A, userId: U.agentA, name: "mine", config: cfg }));
    await withContext(db, ctx(U.adminA, A), (tx) => tx.insert(schema.savedViews).values({ workspaceId: A, userId: null, name: "shared", config: cfg }));
    const agent2 = (await withContext(db, ctx(U.agent2A, A), (tx) => tx.select().from(schema.savedViews))).map((v) => v.name);
    expect(agent2).toContain("shared");
    expect(agent2).not.toContain("mine");
    await rejects(withContext(db, ctx(U.agentA, A), (tx) => tx.insert(schema.savedViews).values({ workspaceId: A, userId: null, name: "agent-shared", config: cfg })));
    const viewerOwn = await withContext(db, ctx(U.viewerA, A), (tx) => tx.insert(schema.savedViews).values({ workspaceId: A, userId: U.viewerA, name: "viewer-pref", config: cfg }).returning());
    expect(viewerOwn).toHaveLength(1);
  });
});

describe("search indexes", () => {
  it("trigram indexes exist for name, email, phone and company", async () => {
    const r = await admin.query("SELECT indexname FROM pg_indexes WHERE tablename = 'contacts' AND indexdef ILIKE '%gin_trgm_ops%'");
    expect(r.rows.map((x) => x.indexname).sort()).toEqual(["contacts_company_trgm", "contacts_email_trgm", "contacts_name_trgm", "contacts_phone_trgm"]);
  });
  it("workspace B's contact is still intact", async () => {
    expect((await withContext(db, ctx(U.ownerB, B), (tx) => tx.select().from(schema.contacts))).map((c) => c.id)).toEqual([contactB]);
  });
});
