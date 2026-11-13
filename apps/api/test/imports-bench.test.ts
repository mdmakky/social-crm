// Track C benchmark. Skipped unless IMPORT_BENCH=1 (slow, prints numbers instead of asserting performance).
//   IMPORT_BENCH=1 CRM_DB_NAME=crm_import pnpm exec vitest run test/imports-bench.test.ts
// Requests go through app.request (in process), so HTTP/JSON transport costs of a real socket are not included.
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type ImportPlanBody } from "@crm/contracts";
import { bootstrap, ok, type Harness, type TestUser } from "./harness.ts";

const BENCH = process.env.IMPORT_BENCH === "1";
const DB = process.env.CRM_DB_NAME ?? "crm";
const header = "Name,Email,Phone,Company,Stage,Owner,Tags";
const MAP: ImportPlanBody["mapping"] = ["name", "email", "phone", "company", "lifecycle_stage", "owner_email", "tags"];
const plan = (): ImportPlanBody => ({ mapping: MAP, onDuplicate: "update" });
const mb = (n: number) => Math.round(n / 1048576);
const out = (line: string) => { console.log(line); if (process.env.BENCH_OUT) appendFileSync(process.env.BENCH_OUT, line + "\n"); };
const ms = (t: number) => Math.round(performance.now() - t);

let h: Harness;
let owner: TestUser;
const c = () => h.clientFor(owner);

/** 500 pre-existing contacts (seeded separately), then a 5,000-row file: 500 updates, 200 in-file duplicates, 4,300 new; 3 tags per row from a pool of 50. */
function csv5000(tag: string, pfx = "") {
  const rows: string[] = [];
  const tags = (i: number) => [i % 50, (i * 7 + 3) % 50, (i * 13 + 11) % 50].map((t) => `${tag}-t${t}`).join(";");
  for (let i = 0; i < 500; i++) rows.push(`Upd ${i},seed${i}@b.example,,Updated Co,,,${tags(i)}`);
  for (let i = 0; i < 4300; i++) rows.push(`New ${i},${pfx}new${i}@b.example,,,,,${tags(i + 500)}`);
  for (let i = 0; i < 200; i++) rows.push(`Dup ${i},${pfx}new${i * 3}@b.example,,Dup Co,,,${tags(i)}`);
  return [header, ...rows].join("\n");
}
async function seed(W: string, tag: string) {
  const rows = Array.from({ length: 500 }, (_, i) => `Seed ${i},seed${i}@b.example,,,,,${tag}-seedtag`);
  const up = ok(await c().call(endpoints.uploadImport, { params: { workspaceId: W }, body: { filename: "seed.csv", csv: [header, ...rows].join("\n") } }));
  ok(await c().call(endpoints.commitImport, { params: { workspaceId: W, importId: up.id }, body: plan() }));
}
const q = async (sql: string, a: unknown[] = []) => (await h.admin.query(sql, a)).rows;

beforeAll(async () => {
  if (!BENCH) return;
  h = await bootstrap({ import: { limits: { uploadsPerUser: 10_000, previewsPerUser: 10_000, commitsPerWorkspace: 10_000, maxOpenJobs: 10_000 } } });
  owner = await h.newUser("bowner");
}, 60_000);
afterAll(async () => { if (BENCH) await h.close(); });

describe.skipIf(!BENCH)("import benchmark (5,000 rows, ~50 tags)", () => {
  const results: Record<string, unknown>[] = [];

  for (const run of [1, 2, 3]) {
    it(`run ${run}: fresh workspace, upload / preview / commit`, async () => {
      const W = await h.workspace(owner, `Bench ${run}`);
      await seed(W, `r${run}`);
      const body = csv5000(`r${run}`);
      const bytes = Buffer.byteLength(body);
      const rssBefore = process.memoryUsage().rss;
      let peak = rssBefore, maxBackends = 0;
      const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
      const sampler = setInterval(async () => {
        try { const r = await q("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND usename='crm_app' AND state <> 'idle'", [DB]); maxBackends = Math.max(maxBackends, r[0].n); } catch { /* sampler only */ }
      }, 100);
      let t = performance.now();
      const up = ok(await c().call(endpoints.uploadImport, { params: { workspaceId: W }, body: { filename: "b.csv", csv: body } }));
      const upMs = ms(t);
      t = performance.now();
      const pv = ok(await c().call(endpoints.previewImport, { params: { workspaceId: W, importId: up.id }, body: plan() }));
      const pvMs = ms(t);
      t = performance.now();
      const res = ok(await c().call(endpoints.commitImport, { params: { workspaceId: W, importId: up.id }, body: plan() }));
      const cmMs = ms(t);
      clearInterval(timer); clearInterval(sampler);
      const rssAfter = process.memoryUsage().rss;
      const tagCount = (await q("SELECT count(*)::int n FROM tags WHERE workspace_id=$1 AND name LIKE $2", [W, `r${run}-t%`]))[0].n;
      expect({ created: res.created, updated: res.updated, skipped: res.skipped }).toEqual({ created: pv.willCreate, updated: pv.willUpdate, skipped: pv.willSkip });
      const row = { run, csvBytes: bytes, uploadMs: upMs, previewMs: pvMs, commitMs: cmMs, totalMs: upMs + pvMs + cmMs, rssBeforeMB: mb(rssBefore), rssAfterMB: mb(rssAfter), rssPeakMB: mb(peak), maxActiveAppBackendsSampled: maxBackends, tagsCreated: tagCount, result: { created: res.created, updated: res.updated, skipped: res.skipped } };
      results.push(row);
      out("BENCH " + JSON.stringify(row));
    }, 300_000);
  }

  it("concurrent commits in ONE workspace: the second waits on the advisory lock instead of failing", async () => {
    const W = await h.workspace(owner, "Bench concurrent");
    await seed(W, "cc");
    const a = ok(await c().call(endpoints.uploadImport, { params: { workspaceId: W }, body: { filename: "a.csv", csv: csv5000("cca", "a") } }));
    const b = ok(await c().call(endpoints.uploadImport, { params: { workspaceId: W }, body: { filename: "b.csv", csv: csv5000("ccb", "b") } }));
    const t0 = performance.now();
    const timed = async (id: string, label: string) => { const r = await c().call(endpoints.commitImport, { params: { workspaceId: W, importId: id }, body: plan() }); return { label, ok: r.ok, status: r.ok ? 200 : r.error.status, code: r.ok ? null : r.error.code, doneAtMs: ms(t0) }; };
    const [ra, rb] = await Promise.all([timed(a.id, "A"), timed(b.id, "B")]);
    out("BENCH-CONCURRENT " + JSON.stringify([ra, rb]));
    expect(ra.ok && rb.ok).toBe(true);
    // control: the same two kinds of file committed strictly one after the other
    const cc = ok(await c().call(endpoints.uploadImport, { params: { workspaceId: W }, body: { filename: "c.csv", csv: csv5000("ccc", "c") } }));
    const dd = ok(await c().call(endpoints.uploadImport, { params: { workspaceId: W }, body: { filename: "d.csv", csv: csv5000("ccd", "d") } }));
    const seq: number[] = [];
    for (const id of [cc.id, dd.id]) { const t = performance.now(); ok(await c().call(endpoints.commitImport, { params: { workspaceId: W, importId: id }, body: plan() })); seq.push(ms(t)); }
    out("BENCH-SEQUENTIAL-CONTROL " + JSON.stringify(seq));
  }, 300_000);

  it("5,000 UPDATES of existing contacts (update-heavy commit) and a second commit queued behind it", async () => {
    const W = await h.workspace(owner, "Bench updates");
    const mk = (company: string) => [header, ...Array.from({ length: 5000 }, (_, i) => `U ${i},u${i}@b.example,,${company},,,ut${i % 50}`)].join("\n");
    const first = ok(await c().call(endpoints.uploadImport, { params: { workspaceId: W }, body: { filename: "u1.csv", csv: mk("") } }));
    let t = performance.now();
    ok(await c().call(endpoints.commitImport, { params: { workspaceId: W, importId: first.id }, body: plan() }));
    const createMs = ms(t);
    const upd = ok(await c().call(endpoints.uploadImport, { params: { workspaceId: W }, body: { filename: "u2.csv", csv: mk("Changed Co") } }));
    const small = ok(await c().call(endpoints.uploadImport, { params: { workspaceId: W }, body: { filename: "s.csv", csv: [header, "Small,small@b.example,,,,,"].join("\n") } }));
    t = performance.now();
    const t0 = t;
    const big = c().call(endpoints.commitImport, { params: { workspaceId: W, importId: upd.id }, body: plan() }).then((r) => ({ ok: r.ok, at: ms(t0), res: r.ok ? r.data : r.error }));
    await new Promise((r) => setTimeout(r, 500));
    const sm = c().call(endpoints.commitImport, { params: { workspaceId: W, importId: small.id }, body: plan() }).then((r) => ({ ok: r.ok, at: ms(t0), res: r.ok ? r.data : r.error }));
    const [rb, rs] = await Promise.all([big, sm]);
    out("BENCH-UPDATES " + JSON.stringify({ create5000Ms: createMs, update5000: rb, smallQueuedBehind: rs }));
    expect(rb.ok).toBe(true);
  }, 400_000);

  it("12 concurrent commits (12 workspaces) with a 10-connection pool: /v1/me latency meanwhile", async () => {
    const jobs = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const W = await h.workspace(owner, `Bench pool ${i}`);
      const rows = Array.from({ length: 1500 }, (_, k) => `P${i} ${k},p${i}x${k}@b.example,,,,,pool${k % 25};pool-common`);
      const up = ok(await c().call(endpoints.uploadImport, { params: { workspaceId: W }, body: { filename: "p.csv", csv: [header, ...rows].join("\n") } }));
      return { W, id: up.id };
    }));
    const t0 = performance.now();
    let done = false;
    const commits = Promise.all(jobs.map(async (j) => { const r = await c().call(endpoints.commitImport, { params: { workspaceId: j.W, importId: j.id }, body: plan() }); return { ok: r.ok, at: ms(t0) }; })).finally(() => { done = true; });
    const lat: number[] = [];
    let maxActive = 0;
    await new Promise((r) => setTimeout(r, 300)); // let the commits grab their connections first
    while (!done) {
      const t = performance.now();
      const res = await h.app.request("/v1/me", { headers: { cookie: owner.cookie } });
      lat.push(ms(t));
      expect(res.status).toBe(200);
      const r = await q("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND usename='crm_app' AND state <> 'idle'", [DB]);
      maxActive = Math.max(maxActive, r[0].n);
      await new Promise((r2) => setTimeout(r2, 100));
    }
    const outs = await commits;
    lat.sort((x, y) => x - y);
    const info = { commits: outs.length, allOk: outs.every((x) => x.ok), allDoneMs: ms(t0), meSamples: lat.length, meP50: lat[Math.floor(lat.length / 2)], meMax: lat[lat.length - 1], maxActiveAppBackends: maxActive };
    out("BENCH-POOL " + JSON.stringify(info));
    expect(info.allOk).toBe(true);
  }, 300_000);
});

it.skipIf(BENCH)("benchmark is opt-in (set IMPORT_BENCH=1)", () => { expect(BENCH).toBe(false); });
