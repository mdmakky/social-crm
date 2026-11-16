import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getProvider, type GenerateResult } from "@crm/ai";
import { endpoints } from "@crm/contracts";
import { FsBlobStore } from "@crm/core";
import { createDb, type Db } from "@crm/db";
import { createSecretBox } from "@crm/integrations";
import { bootstrap, ok, type Harness, type TestUser } from "./harness.ts";

// Regression: a media tool (blob read + provider call) must never run while a database transaction is open, in run, dry-run and approve.
// The transaction counters are patched onto the very pool objects the app uses (app pool and worker pool).
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 7).toString("base64") }, "k1");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("PIX")]);
let h: Harness, workerDb: Db, dir: string;
let owner: TestUser;
let A = "", conv = "";
let open = 0, maxOpen = 0;
const violations: string[] = [];
let nextReply = "";
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;

class WatchedStore extends FsBlobStore {
  override async get(key: string) { if (open > 0) violations.push("blob get"); return super.get(key); }
}
const count = (db: Db) => {
  const t = db as unknown as { transaction: (fn: (tx: unknown) => Promise<unknown>, ...r: unknown[]) => Promise<unknown> };
  const orig = t.transaction.bind(t);
  t.transaction = (fn, ...rest) => orig(async (tx) => { open++; maxOpen = Math.max(maxOpen, open); try { return await fn(tx); } finally { open--; } }, ...rest);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "att-tx-"));
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  const mock = getProvider("mock", { timeoutMs: 1000 });
  const providerFor = () => ({ ...mock, id: "mock",
    async generate(): Promise<GenerateResult> { return { text: nextReply, usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" }; },
    async vision(r: Parameters<NonNullable<typeof mock.vision>>[0]) { if (open > 0) violations.push("provider call"); return mock.vision!(r); } });
  h = await bootstrap({ aiAgentRunsPerUser: 1000, mediaLimits: { perWorkspace: 1000 } }, undefined, { workerDb, box, backoffMs: 1, sleep: async () => {}, providerFor }, { store: new WatchedStore(dir), uploadsPerUser: 1000 });
  count(h.db); count(workerDb);
  owner = await h.newUser("mtx");
  A = await h.workspace(owner, "Media tx");
  ok(await h.clientFor(owner).call(endpoints.setAiProvider, { params: { workspaceId: A, provider: "mock" }, body: { isDefault: true } }));
  const [acct] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'messenger',$2,'connected','x') RETURNING id", [A, `7${Date.now()}`]);
  const [stage] = await q("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1", [A]);
  const [ct] = await q("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id) VALUES ($1,'C',$2) RETURNING id", [A, stage.id]);
  const [idn] = await q("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [A, acct.id, `8${Date.now()}`, ct.id]);
  conv = (await q("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [A, acct.id, idn.id, ct.id]))[0].id;
  await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state, occurred_at) VALUES ($1,$2,$3,'in',$4,'contact','hi','received',now())", [A, conv, acct.id, `m${Date.now()}`]);
});
afterAll(async () => { await workerDb.$client.end(); await h.close(); rmSync(dir, { recursive: true, force: true }); });

describe("media tools never hold a transaction", () => {
  it("run, dry-run and approve do the blob read and the provider call outside any transaction", async () => {
    const up = await h.clientFor(owner).call(endpoints.uploadAttachment, { params: { workspaceId: A, conversationId: conv }, body: { filename: "a.png", mime: "image/png", contentBase64: PNG.toString("base64") } }).then(ok);
    const mk = async (mode: "auto" | "approval") => {
      const a = ok(await h.clientFor(owner).call(endpoints.createAiAgent, { params: { workspaceId: A }, body: { name: `Media ${mode} ${Date.now()}`, instructions: "x", toolGrants: [{ tool: "media.describe_image", mode }] } }));
      ok(await h.clientFor(owner).call(endpoints.activateAiAgent, { params: { workspaceId: A, agentId: a.id }, body: {} }));
      return a.id;
    };
    nextReply = JSON.stringify({ reply: "ok", actions: [{ tool: "media.describe_image", args: { attachmentId: up.id } }] });
    const auto = await mk("auto");
    const run = (agentId: string, dryRun: boolean) => h.clientFor(owner).call(endpoints.testAiAgent, { params: { workspaceId: A, agentId }, body: { input: "look", conversationId: conv, dryRun } as never }).then(ok);
    const dry = await run(auto, true);
    expect(dry.actions[0]).toMatchObject({ status: "executed" });
    expect(JSON.stringify(dry.actions[0]!.result)).toContain("MOCK IMAGE DESCRIPTION");
    const live = await run(auto, false);
    expect(live.actions[0]).toMatchObject({ status: "executed" });
    // approval path: pending first, then approve runs the call before its transaction
    const appr = await mk("approval");
    const pending = await run(appr, false);
    expect(pending.actions[0]).toMatchObject({ status: "pending" });
    const done = await h.clientFor(owner).call(endpoints.approveAiAgentAction, { params: { workspaceId: A, actionId: pending.actions[0]!.actionId! } }).then(ok);
    expect(done.status).toBe("executed");
    expect(JSON.stringify(done.result)).toContain("MOCK IMAGE DESCRIPTION");
    expect(violations).toEqual([]);
    expect(open).toBe(0);
    expect(maxOpen).toBeGreaterThan(0); // the counters really observed transactions
  });
});
