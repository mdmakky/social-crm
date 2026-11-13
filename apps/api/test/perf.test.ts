import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { bootstrap, ok, type Harness, type TestUser } from "./harness.ts";

/**
 * Phase 2 gate: with 10,000 contacts, list p95 < 300 ms and search p95 < 500 ms.
 * Measured in-process against the local Docker Postgres (no network), so it bounds the database and query cost only.
 */
let h: Harness;
let owner: TestUser;
let W: string;
const ROWS = 10_000;
const timings: Record<string, number[]> = {};

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
async function measure(label: string, fn: () => Promise<unknown>, runs = 30) {
  await fn(); // warm the plan cache
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
  }
  timings[label] = out;
  return p95(out);
}

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("perfowner");
  W = await h.workspace(owner, "Perf Co");
  const stages = ok(await h.clientFor(owner).call(endpoints.listLifecycleStages, { params: { workspaceId: W } }));
  await h.admin.query(
    `INSERT INTO contacts (workspace_id, name, email, email_normalized, phone, phone_normalized, company, lifecycle_stage_id, source, last_activity_at, created_at, updated_at)
     SELECT $1, 'Person ' || g || ' ' || (ARRAY['Okafor','Silva','Nguyen','Moreau','Patel','Sato','Petrov','Costa'])[1 + g % 8],
            'person' || g || '@perf.example', 'person' || g || '@perf.example', '+1 555 ' || lpad(g::text, 7, '0'), '+1555' || lpad(g::text, 7, '0'),
            (ARRAY['Globex','Initech','Umbrella','Hooli'])[1 + g % 4], $2::uuid, (ARRAY['manual','import','messenger'])[1 + g % 3],
            now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, now()
     FROM generate_series(1, $3) g`,
    [W, stages[g0(stages)]!.id, ROWS],
  );
  await h.admin.query("ANALYZE contacts");
}, 120_000);
const g0 = (s: unknown[]) => (s.length ? 0 : 0);

afterAll(async () => {
  await h.admin.query("DELETE FROM contacts WHERE workspace_id = $1", [W]);
  process.stderr.write(`\nP95_MS ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(p95(v))])))}\n`);
  await h.close();
});

const call = (query: Record<string, unknown>) => h.clientFor(owner).call(endpoints.listContacts, { params: { workspaceId: W }, query: query as never });

describe(`${ROWS.toLocaleString("en-US")} contacts`, { timeout: 120_000 }, () => {
  it("has the rows", async () => {
    expect(ok(await call({ limit: 1 })).total).toBe(ROWS);
  });
  it("list (default sort) p95 < 300 ms", async () => { expect(await measure("list default", () => call({ limit: 25 }))).toBeLessThan(300); });
  it("list sorted by name p95 < 300 ms", async () => { expect(await measure("list by name", () => call({ sort: "name", dir: "asc", limit: 25 }))).toBeLessThan(300); });
  it("list filtered by lifecycle stage and source p95 < 300 ms", async () => {
    const stages = ok(await h.clientFor(owner).call(endpoints.listLifecycleStages, { params: { workspaceId: W } }));
    expect(await measure("list filtered", () => call({ lifecycleStageId: stages[0]!.id, source: "import", limit: 25 }))).toBeLessThan(300);
  });
  it("deep pagination (page 200) p95 < 300 ms", async () => {
    let cursor: string | null = null;
    for (let i = 0; i < 199; i++) cursor = ok(await call({ limit: 50, cursor: cursor ?? undefined })).nextCursor;
    expect(await measure("deep page", () => call({ limit: 50, cursor: cursor ?? undefined }))).toBeLessThan(300);
  }, 120_000);
  it("search by name substring p95 < 500 ms", async () => { expect(await measure("search name", () => call({ search: "okafor", limit: 25 }))).toBeLessThan(500); });
  it("search by email fragment p95 < 500 ms", async () => { expect(await measure("search email", () => call({ search: "person4242@", limit: 25 }))).toBeLessThan(500); });
  it("search by phone digits p95 < 500 ms", async () => { expect(await measure("search phone", () => call({ search: "5550004242", limit: 25 }))).toBeLessThan(500); });
  it("search by company p95 < 500 ms", async () => { expect(await measure("search company", () => call({ search: "umbrella", limit: 25 }))).toBeLessThan(500); });
});
