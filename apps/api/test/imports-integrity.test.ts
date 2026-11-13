// Track C: REAL PostgreSQL failures part-way through an import commit (no JS hook throws).
// Needs its own database (CRM_DB_NAME) because it installs temporary triggers; they are dropped in afterAll and in finally blocks.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type ImportPlanBody } from "@crm/contracts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser;
let W: string;
const o = () => h.clientFor(owner);
const p = () => ({ workspaceId: W });
const header = "Name,Email,Phone,Company,Stage,Owner,Tags";
const MAP: ImportPlanBody["mapping"] = ["name", "email", "phone", "company", "lifecycle_stage", "owner_email", "tags"];
const plan = (over: Partial<ImportPlanBody> = {}): ImportPlanBody => ({ mapping: MAP, onDuplicate: "update", ...over });
const commit = (id: string) => o().call(endpoints.commitImport, { params: { ...p(), importId: id }, body: plan() });
const q = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) => (await h.admin.query(sql, args)).rows as T[];

const DB = process.env.CRM_DB_NAME ?? "crm";
// Installs triggers database-wide, so it only runs when explicitly pointed at a throwaway database (never the shared `crm`):
//   CRM_DB_NAME=crm_import IMPORT_ISOLATED=1 pnpm exec vitest run test/imports-integrity.test.ts
const ISOLATED = process.env.IMPORT_ISOLATED === "1" && DB !== "crm";
const snapshot = async (contactId: string) => ({
  contacts: await q("SELECT count(*) n FROM contacts WHERE workspace_id=$1", [W]),
  tags: await q("SELECT count(*) n FROM tags WHERE workspace_id=$1", [W]),
  contactTags: await q("SELECT count(*) n FROM contact_tags WHERE workspace_id=$1", [W]),
  activities: await q("SELECT count(*) n FROM activities WHERE workspace_id=$1", [W]),
  audit: await q("SELECT count(*) n FROM audit_log WHERE workspace_id=$1", [W]),
  existing: await q("SELECT version, company, name FROM contacts WHERE id=$1", [contactId]),
});

/** No backend of the test database may be left inside a transaction, and no advisory lock may be held. */
async function expectNoLeaks() {
  await new Promise((r) => setTimeout(r, 200));
  const idle = await q("SELECT pid, state FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'", [DB]);
  expect(idle).toEqual([]);
  const adv = await q("SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND a.datname=$1", [DB]);
  expect(adv).toEqual([]);
}

async function dropTriggers() {
  await h.admin.query("DROP TRIGGER IF EXISTS poison_ct ON contact_tags");
  await h.admin.query("DROP TRIGGER IF EXISTS poison_act ON activities");
  await h.admin.query("DROP TRIGGER IF EXISTS poison_aud ON audit_log");
}
async function dropAll() {
  await dropTriggers();
  await h.admin.query("DROP FUNCTION IF EXISTS poison_ct_fn()");
  await h.admin.query("DROP FUNCTION IF EXISTS poison_act_fn()");
  await h.admin.query("DROP FUNCTION IF EXISTS poison_aud_fn()");
}

beforeAll(async () => {
  if (!ISOLATED) return;
  h = await bootstrap({ import: { limits: { uploadsPerUser: 10_000, previewsPerUser: 10_000, commitsPerWorkspace: 10_000, maxOpenJobs: 10_000 } } });
  await dropAll();
  owner = await h.newUser("iowner");
  // SECURITY DEFINER (owned by the superuser) so the trigger can read RLS-protected tables as the app role.
  await h.admin.query(`CREATE FUNCTION poison_ct_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN IF EXISTS (SELECT 1 FROM tags WHERE id = NEW.tag_id AND name = 'poison-tag') THEN RAISE EXCEPTION 'poison contact_tags insert'; END IF; RETURN NEW; END $$`);
  await h.admin.query(`CREATE FUNCTION poison_act_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN IF EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND name = 'POISON-ACT') THEN RAISE EXCEPTION 'poison activities insert'; END IF; RETURN NEW; END $$`);
  await h.admin.query(`CREATE FUNCTION poison_aud_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN IF NEW.action = 'data.imported' AND NEW.summary->>'filename' = 'poison-audit.csv' THEN RAISE EXCEPTION 'poison audit insert'; END IF; RETURN NEW; END $$`);
}, 60_000);

/** Fresh workspace with one existing contact, so scenarios cannot affect each other. */
async function fresh(label: string) {
  W = await h.workspace(owner, label);
  await h.contact(o(), W, { name: "Existing One", email: "existing@i.example", company: "Original Co" });
}

afterAll(async () => {
  if (!ISOLATED) return;
  try { await dropAll(); } finally { await h.close(); }
});

/** 1,100 new rows (3 insert batches), 2 tags each (2,200 links = 2 link batches), row 1 updates the existing contact. */
function bigCsv(poisonLast: "tag" | "activity" | "none", filename = "i.csv") {
  const rows = [`Updated Name,existing@i.example,,Changed Co,,,existing-tag`];
  for (let i = 0; i < 1100; i++) {
    const last = i === 1099;
    const name = last && poisonLast === "activity" ? "POISON-ACT" : `Row ${i}`;
    const tags = last && poisonLast === "tag" ? "poison-tag;t-b" : `t-${i % 7};t-b`;
    rows.push(`${name},row${i}@i.example,,,,,${tags}`);
  }
  return { csv: [header, ...rows].join("\n"), filename };
}

describe.skipIf(!ISOLATED)("real PostgreSQL failure mid-commit", () => {
  const scenarios: Array<{ label: string; trigger: string; kind: "tag" | "activity" | "none" }> = [
    { label: "contact_tags insert fails in the SECOND link batch (contacts, update, activities, tags already written)", trigger: "CREATE TRIGGER poison_ct BEFORE INSERT ON contact_tags FOR EACH ROW EXECUTE FUNCTION poison_ct_fn()", kind: "tag" },
    { label: "activities insert fails in the SECOND activity batch (contacts and update already written)", trigger: "CREATE TRIGGER poison_act BEFORE INSERT ON activities FOR EACH ROW EXECUTE FUNCTION poison_act_fn()", kind: "activity" },
  ];
  for (const s of scenarios) {
    it(`${s.label}: everything rolls back and the job is retryable`, async () => {
      await fresh("Integrity " + s.kind);
      const existing = (await q<{ id: string }>("SELECT id FROM contacts WHERE workspace_id=$1 AND email='existing@i.example'", [W]))[0]!;
      const before = await snapshot(existing.id);
      const { csv, filename } = bigCsv(s.kind);
      const up = ok(await o().call(endpoints.uploadImport, { params: p(), body: { filename, csv } }));
      let failed;
      try {
        await h.admin.query(s.trigger);
        const quiet = console.error; console.error = () => {};
        try { failed = failure(await commit(up.id)); } finally { console.error = quiet; }
      } finally { await dropTriggers(); }
      expect(failed).toMatchObject({ status: 500, code: "import_failed" });
      expect(await snapshot(existing.id)).toEqual(before);
      expect(await q("SELECT count(*) n FROM tags WHERE workspace_id=$1 AND name IN ('poison-tag','existing-tag','t-b','t-0')", [W])).toEqual([{ n: "0" }]);
      expect(await q("SELECT status, length(csv) > 0 AS has_csv FROM import_jobs WHERE id=$1", [up.id])).toEqual([{ status: "uploaded", has_csv: true }]);
      await expectNoLeaks();
      // trigger gone: the same job commits cleanly now (advisory lock was released too)
      const res = ok(await commit(up.id));
      expect(res).toMatchObject({ created: 1100, updated: 1 });
      expect(await q("SELECT version, company FROM contacts WHERE id=$1", [existing.id])).toEqual([{ version: (before.existing[0] as { version: number }).version + 1, company: "Changed Co" }]);
      expect(await q("SELECT count(*) n FROM contact_tags WHERE workspace_id=$1", [W])).toEqual([{ n: String(1100 * 2 + 1) }]);
      await expectNoLeaks();
    }, 120_000);
  }

  it("audit_log insert (the very last statement) fails: the whole import still rolls back", async () => {
    await fresh("Integrity audit");
    const existing = (await q<{ id: string }>("SELECT id FROM contacts WHERE workspace_id=$1 AND email='existing@i.example'", [W]))[0]!;
    const before = await snapshot(existing.id);
    const { csv, filename } = bigCsv("none", "poison-audit.csv");
    const up = ok(await o().call(endpoints.uploadImport, { params: p(), body: { filename, csv } }));
    let failed;
    try {
      await h.admin.query("CREATE TRIGGER poison_aud BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION poison_aud_fn()");
      const quiet = console.error; console.error = () => {};
      try { failed = failure(await commit(up.id)); } finally { console.error = quiet; }
    } finally { await dropTriggers(); }
    expect(failed).toMatchObject({ status: 500, code: "import_failed" });
    expect(await snapshot(existing.id)).toEqual(before);
    expect(await q("SELECT status, length(csv) > 0 AS has_csv FROM import_jobs WHERE id=$1", [up.id])).toEqual([{ status: "uploaded", has_csv: true }]);
    await expectNoLeaks();
    expect(ok(await commit(up.id))).toMatchObject({ created: 1100, updated: 1 });
    await expectNoLeaks();
  }, 120_000);

  it("a failed commit in workspace A does not block a different workspace", async () => {
    const o2 = await h.newUser("iother");
    const W2 = await h.workspace(o2, "Other Co");
    const up = ok(await h.clientFor(o2).call(endpoints.uploadImport, { params: { workspaceId: W2 }, body: { filename: "x.csv", csv: [header, "A,a@o.example,,,,,"].join("\n") } }));
    expect(ok(await h.clientFor(o2).call(endpoints.commitImport, { params: { workspaceId: W2, importId: up.id }, body: plan() }))).toMatchObject({ created: 1 });
  });
});
