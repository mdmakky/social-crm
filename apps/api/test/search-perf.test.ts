import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { bootstrap, ok, type Harness, type TestUser } from "./harness.ts";

/** Global search budget: p95 < 300 ms at 10,000 contacts (in-process, local Postgres; bounds database and query cost). */
let h: Harness;
let owner: TestUser;
let W: string;
const ROWS = 10_000;
const timings: Record<string, number[]> = {};
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("sperfowner");
  W = await h.workspace(owner, "Search Perf Co");
  const stages = ok(await h.clientFor(owner).call(endpoints.listLifecycleStages, { params: { workspaceId: W } }));
  await h.admin.query(
    `INSERT INTO contacts (workspace_id, name, email, email_normalized, phone, phone_normalized, company, lifecycle_stage_id, source, last_activity_at, created_at, updated_at)
     SELECT $1, 'Person ' || g || ' ' || (ARRAY['Okafor','Silva','Nguyen','Moreau','Patel','Sato','Petrov','Costa'])[1 + g % 8],
            'person' || g || '@perf.example', 'person' || g || '@perf.example', '+1 555 ' || lpad(g::text, 7, '0'), '+1555' || lpad(g::text, 7, '0'),
            (ARRAY['Globex','Initech','Umbrella','Hooli'])[1 + g % 4], $2::uuid, 'import', now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, now()
     FROM generate_series(1, $3) g`,
    [W, stages[0]!.id, ROWS],
  );
  await h.admin.query("ANALYZE contacts");
}, 120_000);
afterAll(async () => {
  await h.admin.query("DELETE FROM contacts WHERE workspace_id = $1", [W]);
  process.stderr.write(`\nSEARCH_P95_MS ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(p95(v))])))}\n`);
  await h.close();
});

describe(`global search at ${ROWS.toLocaleString("en-US")} contacts`, { timeout: 120_000 }, () => {
  for (const [label, q] of [["name substring", "okafor"], ["name prefix", "person42"], ["email exact", "person4242@perf.example"], ["phone digits", "5550004242"], ["company", "umbrella"], ["two chars", "pe"]] as const) {
    it(`${label} p95 < 300 ms`, async () => {
      const run = () => h.clientFor(owner).call(endpoints.search, { params: { workspaceId: W }, query: { q } });
      await run();
      const out: number[] = [];
      for (let i = 0; i < 40; i++) { const t = performance.now(); ok(await run()); out.push(performance.now() - t); }
      timings[label] = out;
      expect(p95(out)).toBeLessThan(300);
    });
  }
});
