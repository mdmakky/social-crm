import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, schema, withContext, type Db } from "../src/index.ts";

// AI agent builder (migration 0032): agents, append-only versions and the approval queue are tenant isolated, role scoped and guarded.
const NAME = process.env.CRM_DB_NAME ?? "crm";
const url = (u: string, p: string) => `postgres://${u}:${p}@127.0.0.1:5436/${NAME}`;
const run = Date.now().toString(36);
const U = { owner: `ag-owner-${run}`, agent: `ag-agent-${run}`, viewer: `ag-viewer-${run}`, ownerB: `ag-ownerb-${run}` };
let app: Db, root: pg.Client;
let A = "", B = "", agA = "", verA = "", agB = "";
const ctx = (userId?: string, workspaceId?: string) => ({ userId, workspaceId });
const q = <T = Record<string, unknown>>(db: Db, c: ReturnType<typeof ctx>, s: ReturnType<typeof sql>) => withContext(db, c, async (tx) => (await tx.execute(s)).rows as T[]);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toMatchObject({ cause: { message: expect.stringMatching(re) } });
const mkAgent = (ws: string, user: string, key: string) => withContext(app, ctx(user, ws), async (tx) => {
  const [a] = await tx.insert(schema.aiAgents).values({ workspaceId: ws, key, name: key, createdBy: user }).returning();
  const [v] = await tx.insert(schema.aiAgentVersions).values({ workspaceId: ws, agentId: a!.id, version: 1, instructions: "help", createdBy: user }).returning();
  return { a: a!.id, v: v!.id };
});
const action = (ws: string, agent: string, ver: string, user: string) => sql.raw(`INSERT INTO ai_agent_actions(workspace_id,agent_id,agent_version_id,source,tool,args,reason,requested_by) VALUES ('${ws}','${agent}','${ver}','test','crm.add_tag','{"tagName":"x"}','sensitive','${user}') RETURNING id`);

beforeAll(async () => {
  root = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN ?? url("postgres", "postgres") });
  await root.connect();
  app = createDb(url("crm_app", "app_dev"));
  for (const id of Object.values(U)) await root.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,$1,$2,true) ON CONFLICT (id) DO NOTHING`, [id, `${id}@t.test`]);
  const mk = (owner: string, slug: string) => withContext(app, { userId: owner }, async (tx) => {
    const [w] = await tx.insert(schema.workspaces).values({ name: slug, slug, ownerUserId: owner }).returning();
    await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: "owner" });
    return w!.id;
  });
  A = await mk(U.owner, `ag-a-${run}`); B = await mk(U.ownerB, `ag-b-${run}`);
  await withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.memberships).values([{ workspaceId: A, userId: U.agent, role: "agent" }, { workspaceId: A, userId: U.viewer, role: "viewer" }]));
  ({ a: agA, v: verA } = await mkAgent(A, U.owner, "alpha"));
  ({ a: agB } = await mkAgent(B, U.ownerB, "alpha")); // same key in another workspace is fine
});
afterAll(async () => { await Promise.all([app.$client.end(), root.end()]); });

describe("tenant isolation and roles", () => {
  it("each workspace sees only its own agents and versions; viewers see none; agents can read", async () => {
    expect((await q(app, ctx(U.owner, A), sql`SELECT id FROM ai_agents`)).map((r) => r.id)).toEqual([agA]);
    expect((await q(app, ctx(U.ownerB, B), sql`SELECT id FROM ai_agents`)).map((r) => r.id)).toEqual([agB]);
    expect(await q(app, ctx(U.owner, A), sql`SELECT id FROM ai_agent_versions WHERE workspace_id = ${B}`)).toHaveLength(0);
    expect(await q(app, ctx(U.agent, A), sql`SELECT id FROM ai_agents`)).toHaveLength(1);
    expect(await q(app, ctx(U.viewer, A), sql`SELECT id FROM ai_agents`)).toHaveLength(0);
    expect(await q(app, ctx(U.viewer, A), sql`SELECT id FROM ai_agent_versions`)).toHaveLength(0);
  });
  it("cannot write another workspace's rows, and agents/viewers cannot create agents", async () => {
    await rejects(withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.aiAgents).values({ workspaceId: B, key: "evil", name: "x", createdBy: U.owner })), /row-level security/);
    await rejects(withContext(app, ctx(U.agent, A), (tx) => tx.insert(schema.aiAgents).values({ workspaceId: A, key: "nope", name: "x", createdBy: U.agent })), /row-level security/);
    await rejects(withContext(app, ctx(U.owner, A), (tx) => tx.insert(schema.aiAgentVersions).values({ workspaceId: A, agentId: agB, version: 9, instructions: "x", createdBy: U.owner })), /foreign key/);
    expect(await q(app, ctx(U.owner, A), sql`UPDATE ai_agents SET name = 'hijack' WHERE workspace_id = ${B} RETURNING id`)).toHaveLength(0);
  });
});

describe("versions are append-only; the active pointer must be the agent's own", () => {
  it("rejects updates and deletes of a version", async () => {
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE ai_agent_versions SET instructions = 'x'`), /permission denied/);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM ai_agent_versions`), /permission denied/);
    await expect(root.query(`UPDATE ai_agent_versions SET instructions='x' WHERE workspace_id=$1`, [A])).rejects.toThrow(/append-only/);
  });
  it("bounds temperature, language, grants and the version number", async () => {
    const bad = (cols: string, vals: string) => rejects(q(app, ctx(U.owner, A), sql.raw(`INSERT INTO ai_agent_versions(workspace_id,agent_id,version,instructions,created_by,${cols}) VALUES ('${A}','${agA}',5,'x','${U.owner}',${vals})`)), /violates check constraint/);
    await bad("temperature", "1.5");
    await bad("language", "'not a tag'");
    await bad("tool_grants", `'{"a":1}'::jsonb`);
    await bad("max_output_tokens", "10");
    await rejects(q(app, ctx(U.owner, A), sql.raw(`INSERT INTO ai_agent_versions(workspace_id,agent_id,version,instructions,created_by) VALUES ('${A}','${agA}',1,'dup','${U.owner}')`)), /unique/);
  });
  it("activation needs a version of the same agent; identity cannot change", async () => {
    expect(await q(app, ctx(U.owner, A), sql`UPDATE ai_agents SET status='active', active_version_id=${verA} WHERE id=${agB} RETURNING id`)).toHaveLength(0); // other workspace: no row visible
    const other = await mkAgent(A, U.owner, "beta");
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE ai_agents SET status='active', active_version_id=${other.v} WHERE id=${agA}`), /foreign key/);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE ai_agents SET status='active' WHERE id=${agA}`), /check constraint/);
    expect(await q(app, ctx(U.owner, A), sql`UPDATE ai_agents SET status='active', active_version_id=${verA} WHERE id=${agA} RETURNING id`)).toHaveLength(1);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE ai_agents SET key='renamed' WHERE id=${agA}`), /permission denied/);
    await expect(root.query(`UPDATE ai_agents SET key='renamed' WHERE id=$1`, [agA])).rejects.toThrow(/identity/);
  });
});

describe("agent actions", () => {
  it("are visible to owner/admin and to the requesting agent only; the proposal is immutable; terminal states are final", async () => {
    const id = (await q<{ id: string }>(app, ctx(U.agent, A), action(A, agA, verA, U.agent)))[0]!.id;
    expect(await q(app, ctx(U.owner, A), sql`SELECT id FROM ai_agent_actions`)).toHaveLength(1);
    expect(await q(app, ctx(U.agent, A), sql`SELECT id FROM ai_agent_actions`)).toHaveLength(1);
    expect(await q(app, ctx(U.viewer, A), sql`SELECT id FROM ai_agent_actions`)).toHaveLength(0);
    expect(await q(app, ctx(U.ownerB, B), sql`SELECT id FROM ai_agent_actions`)).toHaveLength(0);
    await rejects(q(app, ctx(U.agent, A), action(A, agA, verA, U.owner)), /row-level security/); // cannot file one in someone else's name
    expect(await q(app, ctx(U.agent, A), sql`UPDATE ai_agent_actions SET status='approved', decided_by=${U.agent} WHERE id=${id} RETURNING id`)).toHaveLength(0); // agents cannot decide
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE ai_agent_actions SET tool='crm.assign_owner' WHERE id=${id}`), /permission denied/);
    await expect(root.query(`UPDATE ai_agent_actions SET tool='crm.assign_owner' WHERE id=$1`, [id])).rejects.toThrow(/cannot be edited/);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE ai_agent_actions SET status='executed', decided_by=${U.owner} WHERE id=${id}`), /invalid agent action status/); // must be approved first
    expect(await q(app, ctx(U.owner, A), sql`UPDATE ai_agent_actions SET status='approved', decided_by=${U.owner}, decided_at=now() WHERE id=${id} RETURNING id`)).toHaveLength(1);
    expect(await q(app, ctx(U.owner, A), sql`UPDATE ai_agent_actions SET status='executed' WHERE id=${id} RETURNING id`)).toHaveLength(1);
    await rejects(q(app, ctx(U.owner, A), sql`UPDATE ai_agent_actions SET status='rejected' WHERE id=${id}`), /invalid agent action status/);
    await rejects(q(app, ctx(U.owner, A), sql`DELETE FROM ai_agent_actions`), /permission denied/);
  });
  it("an automation run cannot queue the same call twice (idempotency key)", async () => {
    const ins = () => q(app, ctx(U.owner, A), sql.raw(`INSERT INTO ai_agent_actions(workspace_id,agent_id,agent_version_id,source,source_ref,idx,tool,args,reason,requested_by) VALUES ('${A}','${agA}','${verA}','automation','automation:r1',0,'crm.add_tag','{}','sensitive','${U.owner}')`));
    await ins();
    await rejects(ins(), /unique/);
  });
});
