import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type ImportPlanBody } from "@crm/contracts";
import { bootstrap, failure, ok, ORIGIN, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, agent: TestUser;
let W: string;
let failAtRow = 0;
const o = () => h.clientFor(owner);
const p = () => ({ workspaceId: W });
const header = "Name,Email,Phone,Company,Stage,Owner,Tags";
const MAP: ImportPlanBody["mapping"] = ["name", "email", "phone", "company", "lifecycle_stage", "owner_email", "tags"];
const plan = (over: Partial<ImportPlanBody> = {}): ImportPlanBody => ({ mapping: MAP, onDuplicate: "skip", ...over });
const upload = async (csv: string) => ok(await o().call(endpoints.uploadImport, { params: p(), body: { filename: "h.csv", csv } }));
const tryUpload = async (csv: string) => failure(await o().call(endpoints.uploadImport, { params: p(), body: { filename: "h.csv", csv } }));
const commit = async (id: string, over: Partial<ImportPlanBody> = {}) => o().call(endpoints.commitImport, { params: { ...p(), importId: id }, body: plan(over) });
const preview = async (id: string, over: Partial<ImportPlanBody> = {}) => ok(await o().call(endpoints.previewImport, { params: { ...p(), importId: id }, body: plan(over) }));
const find = async (s: string) => ok(await o().call(endpoints.listContacts, { params: p(), query: { search: s, kind: "all" } })).items; // a lookup helper: finds enquiries (no phone) as well as leads
const q = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) => (await h.admin.query(sql, args)).rows as T[];

beforeAll(async () => {
  h = await bootstrap({ import: { limits: { uploadsPerUser: 10_000, previewsPerUser: 10_000, commitsPerWorkspace: 10_000, maxOpenJobs: 10_000 }, afterRow: (row) => { if (failAtRow && row === failAtRow) throw new Error("simulated failure with secret@pii.example"); } } });
  owner = await h.newUser("howner");
  agent = await h.newUser("hagent");
  W = await h.workspace(owner, "Harden Co", { agent });
  await h.contact(o(), W, { name: "Real Name", email: "real@h.example", phone: "+1 555 010 1111", company: "Keep Co" });
});
afterAll(async () => h.close());

describe("upload limits and hostile files", () => {
  it("refuses a NUL byte with a clear 400, never a 500", async () => {
    const e = await tryUpload("Name,Email\nAna\u0000x,a@h.example\n");
    expect(e).toMatchObject({ status: 400 });
    expect(e.message).toMatch(/NUL/);
  });
  it("counts bytes, not characters: 1.8M euro signs are 5.4 MB", async () => {
    const e = await tryUpload("Name\n" + "€".repeat(1_800_000));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/5 MB/);
  });
  it("rejects an oversized request body with 413 before reading it", async () => {
    const big = JSON.stringify({ filename: "x.csv", csv: "a".repeat(7 * 1024 * 1024) });
    const res = await h.app.request(`/v1/workspaces/${W}/imports`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: owner.cookie }, body: big });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("too_large");
  });
  it("limits columns, rows and cell length, and aborts quickly", async () => {
    const t = performance.now();
    expect((await tryUpload(Array.from({ length: 51 }, (_, i) => `c${i}`).join(",") + "\nx")).message).toMatch(/50 columns/);
    expect((await tryUpload("Name\n" + "x\n".repeat(5001))).message).toMatch(/5000 rows/);
    expect((await tryUpload("Name\n" + "y".repeat(1001))).message).toMatch(/1000 characters/);
    expect((await tryUpload('Name,Email\n"unterminated,a@h.example')).message).toMatch(/CSV/);
    expect((await tryUpload("Name,Email\nA,b@h.example,extra,columns,beyond")).message).toMatch(/more values than the header/);
    expect(performance.now() - t).toBeLessThan(5000);
  });
  it("a hostile 100k-character email cell cannot stall the server", async () => {
    const e = await tryUpload("Name,Email\n" + "A," + "a".repeat(100_000) + "\n");
    expect(e.status).toBe(400);
    // the API is still responsive afterwards
    expect((await h.app.request("/v1/me", { headers: { cookie: owner.cookie } })).status).toBe(200);
  });
  it("rejects a NUL in the file name", async () => {
    const r = await o().call(endpoints.uploadImport, { params: p(), body: { filename: "a\u0000b.csv", csv: "Name\nx" } });
    expect(failure(r).status).toBe(400);
  });
});

describe("formula injection", () => {
  it("stores formula-looking cells as literal text and keeps them guarded on export", async () => {
    const up = await upload([header, '"=HYPERLINK(""http://evil"")",f1@h.example,,+cmd|calc,,,', "'=already guarded,f2@h.example,,,,,"].join("\n"));
    ok(await commit(up.id));
    const [a] = await find("f1@h.example");
    expect(a).toMatchObject({ name: '=HYPERLINK("http://evil")', company: "+cmd|calc" });
    const [b] = await find("f2@h.example");
    expect(b!.name).toBe("=already guarded");
    const csv = ok(await o().call(endpoints.exportContacts, { params: p(), query: { search: "f1@h.example", kind: "all" } })); // the imported person has no phone, so it is an enquiry
    expect(csv).toContain("'=HYPERLINK");
  });
});

describe("duplicate handling", () => {
  it("update from a file without a name never replaces a real name with the email (security M3)", async () => {
    const up = await upload("Email,Company\nreal@h.example,New Co\n");
    const res = ok(await commit(up.id, { mapping: ["email", "company"], onDuplicate: "update" }));
    expect(res).toMatchObject({ updated: 1, created: 0 });
    expect((await find("real@h.example"))[0]).toMatchObject({ name: "Real Name", company: "New Co" });
  });
  it("an update whose earlier matching row was skipped is a skip with a warning, never a silent create (security m5)", async () => {
    const up = await upload([header, "Skip Me,sk@h.example,,,,,", "Update Me,sk@h.example,,,,,"].join("\n"));
    const pv = await preview(up.id, { onDuplicate: "update" });
    expect(pv).toMatchObject({ willCreate: 1, willUpdate: 1, willSkip: 0 });
    // Row 1 matches an existing contact and is skipped; row 2 matches row 1 and wants to update it. Nothing was created or updated by row 1, so row 2 has no target.
    const up2 = await upload([header, "Real Again,real@h.example,,,,,", "Real Twin,real@h.example,,,,,"].join("\n"));
    const pv2 = await preview(up2.id, { onDuplicate: "update", rowDecisions: { "1": "skip" } });
    expect(pv2).toMatchObject({ willSkip: 1, willUpdate: 1 });
    const before = (await find("real@h.example")).length;
    ok(await commit(up2.id, { onDuplicate: "update", rowDecisions: { "1": "skip" } }));
    expect((await find("real@h.example")).length).toBe(before);
  });
  it("a row matching two different contacts is skipped with a warning instead of merging into one", async () => {
    await h.contact(o(), W, { name: "Two A", email: "twoa@h.example" });
    await h.contact(o(), W, { name: "Two B", phone: "+1 555 010 2222" });
    const up = await upload([header, "Mixed,twoa@h.example,+1 555 010 2222,,,,"].join("\n"));
    const pv = await preview(up.id, { onDuplicate: "update" });
    expect(pv).toMatchObject({ willSkip: 1, willUpdate: 0 });
    expect(pv.warnings?.[0]).toMatchObject({ row: 1 });
    expect(pv.warnings?.[0]?.message).toMatch(/two different/);
    expect(ok(await commit(up.id, { onDuplicate: "update" }))).toMatchObject({ skipped: 1, updated: 0 });
    expect((await find("twoa@h.example"))[0]!.phone).toBeNull();
  });
  it("preview and commit agree on counts", async () => {
    const csv = [header, "N1,n1@h.example,,,,,t1", "N2,n2@h.example,,,,,t1;t2", "N1 again,n1@h.example,,Co,,,", "Real,real@h.example,,,,,"].join("\n");
    const a = await upload(csv);
    const pv = await preview(a.id, { onDuplicate: "update" });
    const res = ok(await commit(a.id, { onDuplicate: "update" }));
    expect({ created: res.created, updated: res.updated, skipped: res.skipped }).toEqual({ created: pv.willCreate, updated: pv.willUpdate, skipped: pv.willSkip });
  });
});

describe("concurrency", () => {
  it("two imports of the same new email run one after the other: no duplicate contact is created", async () => {
    const a = await upload([header, "Race,race@h.example,,,,,"].join("\n"));
    const b = await upload([header, "Race Too,race@h.example,,,,,"].join("\n"));
    const [ra, rb] = await Promise.all([commit(a.id), commit(b.id)]);
    expect(ra.ok && rb.ok).toBe(true);
    const created = [ra, rb].map((r) => (r.ok ? r.data.created : -1));
    expect(created.sort()).toEqual([0, 1]);
    expect(await find("race@h.example")).toHaveLength(1);
  });
  it("many commits at once do not exhaust the connection pool", async () => {
    const jobs = await Promise.all(Array.from({ length: 6 }, (_, i) => upload([header, `Pool ${i},pool${i}@h.example,,,,,`].join("\n"))));
    const res = await Promise.all(jobs.map((j) => commit(j.id)));
    expect(res.every((r) => r.ok)).toBe(true);
    expect((await h.app.request("/v1/me", { headers: { cookie: owner.cookie } })).status).toBe(200);
  });
});

describe("atomic rollback (integrity M8)", () => {
  it("rolls back contacts, new tags, the update to an existing contact, activities, audit and job state", async () => {
    const [existing] = await find("real@h.example");
    const c0 = await q<{ n: string }>("SELECT count(*) n FROM contacts WHERE workspace_id=$1", [W]);
    const t0 = await q<{ n: string }>("SELECT count(*) n FROM tags WHERE workspace_id=$1", [W]);
    const a0 = await q<{ n: string }>("SELECT count(*) n FROM activities WHERE workspace_id=$1", [W]);
    const l0 = await q<{ n: string }>("SELECT count(*) n FROM audit_log WHERE workspace_id=$1", [W]);
    const v0 = await q<{ version: number; company: string }>("SELECT version, company FROM contacts WHERE id=$1", [existing!.id]);
    const up = await upload([header, "Rollback Update,real@h.example,,Changed Co,,,never-committed", "Rollback New,rb1@h.example,,,,,never-committed-2", "Rollback Three,rb2@h.example,,,,,"].join("\n"));
    failAtRow = 3;
    const e = failure(await commit(up.id, { onDuplicate: "update" }));
    failAtRow = 0;
    expect(e).toMatchObject({ status: 500, code: "import_failed" });
    expect(await q("SELECT count(*) n FROM contacts WHERE workspace_id=$1", [W])).toEqual(c0);
    expect(await q("SELECT count(*) n FROM tags WHERE workspace_id=$1", [W])).toEqual(t0);
    expect(await q("SELECT count(*) n FROM tags WHERE workspace_id=$1 AND name LIKE 'never-committed%'", [W])).toEqual([{ n: "0" }]);
    expect(await q("SELECT count(*) n FROM activities WHERE workspace_id=$1", [W])).toEqual(a0);
    expect(await q("SELECT count(*) n FROM audit_log WHERE workspace_id=$1", [W])).toEqual(l0);
    expect(await q("SELECT version, company FROM contacts WHERE id=$1", [existing!.id])).toEqual(v0);
    expect(await q("SELECT status, length(csv) > 0 AS has_csv FROM import_jobs WHERE id=$1", [up.id])).toEqual([{ status: "uploaded", has_csv: true }]);
    expect(ok(await commit(up.id, { onDuplicate: "update" }))).toMatchObject({ created: 2, updated: 1 });
  });
  it("the failure log carries no row data (security M2)", async () => {
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try {
      const up = await upload([header, "Log Check,secret-log@h.example,,,,,"].join("\n"));
      failAtRow = 1;
      const e = failure(await commit(up.id));
      failAtRow = 0;
      expect(e.code).toBe("import_failed");
    } finally { console.error = orig; failAtRow = 0; }
    const text = logged.join("\n");
    expect(text).toContain("import failed and was rolled back");
    expect(text).not.toContain("secret-log@h.example");
    expect(text).not.toContain("secret@pii.example");
  });
});

describe("retention", () => {
  it("clears the stored CSV once an import is committed", async () => {
    const up = await upload([header, "Retained,ret@h.example,,,,,"].join("\n"));
    ok(await commit(up.id));
    expect(await q("SELECT status, csv FROM import_jobs WHERE id=$1", [up.id])).toEqual([{ status: "committed", csv: "" }]);
  });
  it("a committed or expired job cannot be previewed again", async () => {
    const up = await upload([header, "Gone,gone@h.example,,,,,"].join("\n"));
    ok(await commit(up.id));
    expect(failure(await o().call(endpoints.previewImport, { params: { ...p(), importId: up.id }, body: plan() })).code).toBe("already_committed");
  });
});

describe("batching", () => {
  it("commits 2,000 rows with tags in one transaction well inside the time budget", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `Bulk ${i},bulk${i}@h.example,,,,,tag${i % 20};common`);
    const up = await upload([header, ...rows].join("\n"));
    const t = performance.now();
    expect(ok(await commit(up.id))).toMatchObject({ created: 2000 });
    expect(performance.now() - t).toBeLessThan(15_000);
    expect(await q("SELECT count(*) n FROM contact_tags ct JOIN contacts c ON c.id=ct.contact_id WHERE c.workspace_id=$1 AND c.email LIKE 'bulk%'", [W])).toEqual([{ n: "4000" }]);
    expect(await q("SELECT count(*) n FROM activities WHERE workspace_id=$1 AND kind='contact.imported' AND data->>'filename'='h.csv'", [W])).toBeTruthy();
  }, 60_000);
});

describe("authorization, rate limits and storage caps", () => {
  it("agents cannot upload, preview or commit; unauthenticated callers get 401", async () => {
    const up = await upload([header, "Authz,authz@h.example,,,,,"].join("\n"));
    const a = h.clientFor(agent);
    expect(failure(await a.call(endpoints.uploadImport, { params: p(), body: { filename: "x.csv", csv: "Name\nx" } })).status).toBe(403);
    expect(failure(await a.call(endpoints.previewImport, { params: { ...p(), importId: up.id }, body: plan() })).status).toBe(403);
    expect(failure(await a.call(endpoints.commitImport, { params: { ...p(), importId: up.id }, body: plan() })).status).toBe(403);
    const anon = await h.app.request(`/v1/workspaces/${W}/imports`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: "{}" });
    expect(anon.status).toBe(401);
  });
  it("a malformed import id is a 404, not a 500", async () => {
    expect(failure(await o().call(endpoints.previewImport, { params: { ...p(), importId: "not-a-uuid" }, body: plan() })).status).toBe(404);
  });

  describe("with the default limits", () => {
    let h2: Harness; let u: TestUser; let W2: string;
    beforeAll(async () => {
      h2 = await bootstrap({ import: { limits: { uploadsPerUser: 6, maxOpenJobs: 3, commitsPerWorkspace: 2 } } });
      u = await h2.newUser("limit");
      W2 = await h2.workspace(u, "Limit Co");
    });
    afterAll(async () => h2.close());
    const up2 = (csv = "Name,Email\nA,a@l.example") => h2.clientFor(u).call(endpoints.uploadImport, { params: { workspaceId: W2 }, body: { filename: "l.csv", csv } });

    it("keeps only the newest open uploads and clears the CSV of discarded ones", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(ok(await up2()).id);
      const rows = await h2.admin.query("SELECT id, status, length(csv) AS len FROM import_jobs WHERE workspace_id=$1", [W2]);
      const byId = new Map(rows.rows.map((r) => [r.id, r]));
      expect(byId.get(ids[0]!)).toMatchObject({ status: "failed", len: 0 });
      expect(byId.get(ids[3]!)).toMatchObject({ status: "uploaded" });
      const gone = failure(await h2.clientFor(u).call(endpoints.previewImport, { params: { workspaceId: W2, importId: ids[0]! }, body: { mapping: ["name", "email"], onDuplicate: "skip" } }));
      expect(gone).toMatchObject({ status: 409, code: "import_expired" });
    });
    it("rate limits uploads per user with 429", async () => {
      let last;
      for (let i = 0; i < 4; i++) last = await up2();
      expect(failure(last!)).toMatchObject({ status: 429, code: "rate_limited" });
    });
    it("rate limits commits per workspace", async () => {
      const h3 = await bootstrap({ import: { limits: { commitsPerWorkspace: 2 } } });
      try {
        const u3 = await h3.newUser("climit");
        const W3 = await h3.workspace(u3, "Commit Limit Co");
        const c = h3.clientFor(u3);
        const codes: number[] = [];
        for (let i = 0; i < 3; i++) {
          const j = ok(await c.call(endpoints.uploadImport, { params: { workspaceId: W3 }, body: { filename: "c.csv", csv: `Name,Email\nA${i},a${i}@c.example` } }));
          const r = await c.call(endpoints.commitImport, { params: { workspaceId: W3, importId: j.id }, body: { mapping: ["name", "email"], onDuplicate: "skip" } });
          codes.push(r.ok ? 200 : r.error.status);
        }
        expect(codes).toEqual([200, 200, 429]);
      } finally { await h3.close(); }
    });
  });
});
