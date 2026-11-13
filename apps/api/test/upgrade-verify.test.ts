import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { withContext, schema } from "@crm/db";
import { sql } from "drizzle-orm";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// Guarded: runs only against a database that was created at migration 0013, seeded with representative CRM data
// (workspaces pre-a and pre-b, 250 contacts, tasks, notes, activities) and then upgraded to the latest migration.
// Usage: UPGRADE_DB=1 CRM_DB_NAME=upgrade_final pnpm exec vitest run test/upgrade-verify.test.ts
const A = "00000000-0000-7000-8000-00000000000a";
const B = "00000000-0000-7000-8000-00000000000b";
const d = process.env.UPGRADE_DB === "1" ? describe : describe.skip;

d("upgrade from 0013 with existing data", () => {
  let h: Harness;
  let admin!: TestUser, agent!: TestUser, ownerB!: TestUser, outsider!: TestUser;
  const as = (u: TestUser) => h.clientFor(u);
  let contactA1 = "", taskA1 = "", taskDue = "";

  beforeAll(async () => {
    h = await bootstrap();
    admin = await h.newUser("up-admin"); agent = await h.newUser("up-agent"); ownerB = await h.newUser("up-ownerb"); outsider = await h.newUser("up-out");
    for (const [ws, u, role] of [[A, admin, "admin"], [A, agent, "agent"], [B, ownerB, "owner"]] as const) await h.admin.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,$3::workspace_role)", [ws, u.id, role]);
    contactA1 = (await h.admin.query("SELECT id FROM contacts WHERE workspace_id=$1 AND name='Contact A1'", [A])).rows[0].id;
    const t = (await h.admin.query("SELECT id, due_at FROM tasks WHERE workspace_id=$1 AND title='Call Contact A1'", [A])).rows[0];
    taskA1 = t.id; taskDue = t.due_at.toISOString();
  });
  afterAll(async () => { await h.close(); });

  it("pre-existing data is intact and readable through the current API", async () => {
    const counts = (await h.admin.query("SELECT (SELECT count(*) FROM contacts WHERE workspace_id=$1)::int c, (SELECT count(*) FROM activities WHERE workspace_id=$1 AND lead_id IS NULL)::int a, (SELECT count(*) FROM tasks WHERE workspace_id=$1)::int t", [A])).rows[0];
    expect(counts).toEqual({ c: 200, a: 200, t: 5 });
    const page = ok(await as(admin).call(endpoints.listContacts, { params: { workspaceId: A }, query: { limit: 100 } }));
    expect(page.items.length).toBe(100);
    const detail = ok(await as(admin).call(endpoints.getContact, { params: { workspaceId: A, contactId: contactA1 } }));
    expect(detail.name).toBe("Contact A1");
    expect(ok(await as(admin).call(endpoints.listTasks, { params: { workspaceId: A }, query: {} })).items.length).toBe(5);
  });

  it("an existing workspace gets its default pipeline on the first admin visit; agents see it afterwards", async () => {
    expect((await h.admin.query("SELECT count(*)::int n FROM pipelines WHERE workspace_id=$1", [A])).rows[0].n).toBe(0);
    const cfg = ok(await as(admin).call(endpoints.listPipelines, { params: { workspaceId: A } }));
    expect(cfg.pipelines).toHaveLength(1);
    expect(cfg.pipelines[0]!.stages.map((s) => s.kind)).toEqual(["open", "open", "open", "open", "open", "won", "lost"]);
    expect(ok(await as(agent).call(endpoints.listPipelines, { params: { workspaceId: A } })).pipelines).toHaveLength(1);
  });

  it("a lead on an existing contact works with an existing task: next_activity_at derives from the old task's due date", async () => {
    const lead = ok(await as(agent).call(endpoints.createLead, { params: { workspaceId: A }, body: { title: "Upgrade deal", primaryContactId: contactA1 } }));
    expect(lead.primaryContact.name).toBe("Contact A1");
    ok(await as(admin).call(endpoints.linkLeadTask, { params: { workspaceId: A, leadId: lead.id, taskId: taskA1 } }));
    const after = ok(await as(agent).call(endpoints.getLead, { params: { workspaceId: A, leadId: lead.id } }));
    expect(new Date(after.nextActivityAt!).toISOString()).toBe(taskDue);
    expect(ok(await as(agent).call(endpoints.listActivity, { params: { workspaceId: A, contactId: contactA1 }, query: {} })).items.map((a) => a.kind)).toEqual(expect.arrayContaining(["contact.created"]));
    const ev = (await h.admin.query("SELECT count(*)::int n FROM activities WHERE workspace_id=$1 AND lead_id=$2", [A, lead.id])).rows[0].n;
    expect(ev).toBe(1);
  });

  it("cross-workspace isolation holds for old and new data", async () => {
    const lead = ok(await as(admin).call(endpoints.createLead, { params: { workspaceId: A }, body: { title: "A only", primaryContactId: contactA1, allowDuplicate: true } }));
    expect(failure(await as(ownerB).call(endpoints.getLead, { params: { workspaceId: A, leadId: lead.id } })).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.listLeads, { params: { workspaceId: A }, query: {} })).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.listContacts, { params: { workspaceId: A }, query: {} })).status).toBe(404);
    expect(failure(await as(outsider).call(endpoints.listPipelines, { params: { workspaceId: A } })).status).toBe(404);
    // B cannot attach A's contact to its own lead, and its pipeline is its own
    const cfgB = ok(await as(ownerB).call(endpoints.listPipelines, { params: { workspaceId: B } }));
    expect(cfgB.pipelines[0]!.id).not.toBe(ok(await as(admin).call(endpoints.listPipelines, { params: { workspaceId: A } })).pipelines[0]!.id);
    expect(failure(await as(ownerB).call(endpoints.createLead, { params: { workspaceId: B }, body: { title: "x", primaryContactId: contactA1 } })).status).toBe(400);
    // database level: with B's context the app role sees none of A's rows, old or new
    const seen = await withContext(h.db, { userId: ownerB.id, workspaceId: B }, async (tx) => ({
      leads: (await tx.execute(sql`SELECT count(*)::int n FROM leads WHERE workspace_id = ${A}`)).rows[0],
      pipelines: (await tx.execute(sql`SELECT count(*)::int n FROM pipelines WHERE workspace_id = ${A}`)).rows[0],
      transitions: (await tx.execute(sql`SELECT count(*)::int n FROM stage_transitions WHERE workspace_id = ${A}`)).rows[0],
      contacts: (await tx.execute(sql`SELECT count(*)::int n FROM contacts WHERE workspace_id = ${A}`)).rows[0],
      tasks: (await tx.execute(sql`SELECT count(*)::int n FROM tasks WHERE workspace_id = ${A}`)).rows[0],
    }));
    expect(seen).toEqual({ leads: { n: 0 }, pipelines: { n: 0 }, transitions: { n: 0 }, contacts: { n: 0 }, tasks: { n: 0 } });
    await expect(withContext(h.db, { userId: ownerB.id, workspaceId: B }, (tx) => tx.insert(schema.leads).values({ workspaceId: A, title: "x", primaryContactId: contactA1, pipelineId: crypto.randomUUID(), stageId: crypto.randomUUID(), rank: "1", probability: 10 } as never))).rejects.toBeTruthy();
  });
});
