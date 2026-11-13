import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type ImportPlanBody } from "@crm/contracts";
import { parseCsv } from "@crm/core";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, agent: TestUser, member: TestUser;
let W: string;
let failAtRow = 0;
const o = () => h.clientFor(owner);
const p = () => ({ workspaceId: W });

const MAP: ImportPlanBody["mapping"] = ["name", "email", "phone", "company", "lifecycle_stage", "owner_email", "tags"];
const header = "Name,Email,Phone,Company,Stage,Owner,Tags";
const upload = async (csv: string, u: TestUser = owner) => ok(await h.clientFor(u).call(endpoints.uploadImport, { params: p(), body: { filename: "people.csv", csv } }));
const count = async () => ok(await o().call(endpoints.listContacts, { params: p(), query: { limit: 1 } })).total;
const plan = (over: Partial<ImportPlanBody> = {}): ImportPlanBody => ({ mapping: MAP, onDuplicate: "skip", ...over });

beforeAll(async () => {
  h = await bootstrap({ import: { afterRow: (row) => { if (failAtRow && row === failAtRow) throw new Error("simulated failure"); } } });
  owner = await h.newUser("iowner");
  agent = await h.newUser("iagent");
  member = await h.newUser("imember");
  W = await h.workspace(owner, "Import Co", { agent, admin: member });
  await h.contact(o(), W, { name: "Existing Erin", email: "erin@exist.example", phone: "+1 555 010 7777", company: "OldCo" });
  ok(await o().call(endpoints.createCustomField, { params: p(), body: { key: "budget", label: "Budget", type: "number" } }));
});
afterAll(async () => h.close());

describe("upload", () => {
  it("returns headers, row count, a sample and a suggested mapping with custom fields available", async () => {
    const up = await upload(`${header},Budget\nAna,ana@i.example,,Acme,Qualified,,vip,500\nBen,ben@i.example,,,,,,\n`);
    expect(up.headers).toEqual([...header.split(","), "Budget"]);
    expect(up.rowCount).toBe(2);
    expect(up.sample).toHaveLength(2);
    expect(up.suggestedMapping).toEqual(["name", "email", "phone", "company", "lifecycle_stage", "owner_email", "tags", "custom:budget"]);
    expect(up.fields.map((f) => f.id)).toContain("custom:budget");
  });
  it.each([
    ["an empty file", "   \n", /empty/i],
    ["a header with no data", "Name,Email\n", /no data rows/i],
    ["malformed quoting", 'Name,Email\n"Ana,ana@x.com', /CSV/],
    ["too many rows", "Name\n" + "x\n".repeat(5001), /5000/],
  ])("refuses %s with a clear message", async (_n, csv, msg) => {
    const e = failure(await o().call(endpoints.uploadImport, { params: p(), body: { filename: "x.csv", csv } }));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(msg);
  });
  it("is limited to owners and admins", async () => {
    expect(failure(await h.clientFor(agent).call(endpoints.uploadImport, { params: p(), body: { filename: "x.csv", csv: "Name\nx" } })).status).toBe(403);
    expect(ok(await h.clientFor(member).call(endpoints.uploadImport, { params: p(), body: { filename: "x.csv", csv: "Name\nx" } })).id).toBeTruthy();
  });
});

describe("preview", () => {
  it("validates every row and reports problems by row number without changing anything", async () => {
    const before = await count();
    const up = await upload([header, "Good One,good1@i.example,,,,,", "Bad Email,not-an-email,,,,,", "Bad Stage,bs@i.example,,,Nonexistent,,", "Stranger Owner,so@i.example,,,,stranger@x.com,", ",,,,,,"].join("\n"));
    const pv = ok(await o().call(endpoints.previewImport, { params: { ...p(), importId: up.id }, body: plan() }));
    expect(pv).toMatchObject({ total: 5, valid: 1, invalid: 4 });
    expect(pv.errors.map((e) => e.row)).toEqual([2, 3, 4, 5]);
    expect(pv.errors[0]!.messages[0]).toMatch(/not a valid email/);
    expect(await count()).toBe(before);
  });
  it("finds duplicates against existing contacts and within the file, with the default action applied", async () => {
    const up = await upload([header, "Erin Again,ERIN@exist.example,,,,,", "Phone Match,,+1 (555) 010-7777,,,,", "New A,newa@i.example,,,,,", "New A Twin,newa@i.example,,,,,"].join("\n"));
    const pv = ok(await o().call(endpoints.previewImport, { params: { ...p(), importId: up.id }, body: plan() }));
    expect(pv.duplicates).toEqual([
      { row: 1, matchedOn: "email", existing: expect.objectContaining({ name: "Existing Erin" }), duplicateOfRow: null, action: "skip" },
      { row: 2, matchedOn: "phone", existing: expect.objectContaining({ name: "Existing Erin" }), duplicateOfRow: null, action: "skip" },
      { row: 4, matchedOn: "email", existing: null, duplicateOfRow: 3, action: "skip" },
    ]);
    expect(pv).toMatchObject({ willCreate: 1, willSkip: 3, willUpdate: 0 });
  });
  it("per-row decisions override the default", async () => {
    const up = await upload([header, "Erin Again,erin@exist.example,,,,,", "Erin Third,erin@exist.example,,,,,"].join("\n"));
    const pv = ok(await o().call(endpoints.previewImport, { params: { ...p(), importId: up.id }, body: plan({ onDuplicate: "skip", rowDecisions: { "2": "create" } }) }));
    expect(pv.duplicates.map((d) => d.action)).toEqual(["skip", "create"]);
  });
  it("refuses a bad mapping: repeated field, unknown custom field, or no identifying column", async () => {
    const up = await upload(`${header}\nA,a@i.example,,,,,`);
    expect(failure(await o().call(endpoints.previewImport, { params: { ...p(), importId: up.id }, body: plan({ mapping: ["name", "name", null, null, null, null, null] }) })).message).toMatch(/only one column/);
    expect(failure(await o().call(endpoints.previewImport, { params: { ...p(), importId: up.id }, body: plan({ mapping: ["custom:nope", null, null, null, null, null, null] }) })).message).toMatch(/does not exist/);
    expect(failure(await o().call(endpoints.previewImport, { params: { ...p(), importId: up.id }, body: plan({ mapping: [null, null, null, "company", null, null, null] }) })).message).toMatch(/name, email or phone/);
  });
});

describe("commit", () => {
  it("creates contacts with stage, owner, tags and custom values, records import activity and an audit entry", async () => {
    const csv = [`${header},Budget`, `Mia Import,mia@i.example,+44 20 7946 0958,Initrode,Qualified,${agent.email},vip; wholesale,750`, "Noah Import,noah@i.example,,,,,,"].join("\n");
    const up = await upload(csv);
    const mapping = [...MAP, "custom:budget"] as ImportPlanBody["mapping"];
    const res = ok(await o().call(endpoints.commitImport, { params: { ...p(), importId: up.id }, body: plan({ mapping }) }));
    expect(res).toMatchObject({ created: 2, updated: 0, skipped: 0 });
    const mia = ok(await o().call(endpoints.listContacts, { params: p(), query: { search: "mia@i.example" } })).items[0]!;
    expect(mia).toMatchObject({ name: "Mia Import", lifecycleStage: { name: "Qualified" }, owner: { id: agent.id }, source: "import" });
    expect(mia.tags.map((t) => t.name).sort()).toEqual(["vip", "wholesale"]);
    const detail = ok(await o().call(endpoints.getContact, { params: { ...p(), contactId: mia.id } }));
    expect(detail.custom).toEqual({ budget: 750 });
    expect(ok(await o().call(endpoints.listActivity, { params: { ...p(), contactId: mia.id } })).items[0]).toMatchObject({ kind: "contact.imported", data: { filename: "people.csv" } });
    const audit = ok(await o().call(endpoints.auditLog, { params: p(), query: { limit: 10 } }));
    expect(audit.items.find((i) => i.action === "data.imported")?.summary).toMatchObject({ created: 2 });
  });
  it("duplicate resolution: skip leaves contacts alone, update merges into the existing contact, create adds another", async () => {
    const csv = [header, "Erin Updated,erin@exist.example,,NewCo,Customer,,loyal"].join("\n");
    const skip = await upload(csv);
    expect(ok(await o().call(endpoints.commitImport, { params: { ...p(), importId: skip.id }, body: plan({ onDuplicate: "skip" }) }))).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(ok(await o().call(endpoints.listContacts, { params: p(), query: { search: "erin@exist" } })).items[0]!.company).toBe("OldCo");

    const upd = await upload(csv);
    expect(ok(await o().call(endpoints.commitImport, { params: { ...p(), importId: upd.id }, body: plan({ onDuplicate: "update" }) }))).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    const erin = ok(await o().call(endpoints.listContacts, { params: p(), query: { search: "erin@exist" } })).items;
    expect(erin).toHaveLength(1);
    expect(erin[0]).toMatchObject({ company: "NewCo", name: "Erin Updated" });
    expect(erin[0]!.tags.map((t) => t.name)).toContain("loyal");
    expect(erin[0]!.version).toBeGreaterThan(1);

    const dupe = await upload(csv);
    expect(ok(await o().call(endpoints.commitImport, { params: { ...p(), importId: dupe.id }, body: plan({ onDuplicate: "create" }) }))).toMatchObject({ created: 1 });
    expect(ok(await o().call(endpoints.listContacts, { params: p(), query: { search: "erin@exist" } })).total).toBe(2);
  });
  it("a duplicate inside the file can be merged into the row that created it", async () => {
    const up = await upload([header, "Pat First,pat@i.example,,PatCo,,,", "Pat Second,pat@i.example,,PatCo Two,,,"].join("\n"));
    expect(ok(await o().call(endpoints.commitImport, { params: { ...p(), importId: up.id }, body: plan({ onDuplicate: "update" }) }))).toMatchObject({ created: 1, updated: 1 });
    const pat = ok(await o().call(endpoints.listContacts, { params: p(), query: { search: "pat@i.example" } })).items;
    expect(pat).toHaveLength(1);
    expect(pat[0]).toMatchObject({ company: "PatCo Two", name: "Pat Second" });
  });
  it("rows with problems block the commit unless the user chooses to skip them", async () => {
    const before = await count();
    const up = await upload([header, "Fine,fine@i.example,,,,,", "Broken,nope,,,,,"].join("\n"));
    const refused = failure(await o().call(endpoints.commitImport, { params: { ...p(), importId: up.id }, body: plan() }));
    expect(refused).toMatchObject({ status: 400, code: "invalid_rows" });
    expect(await count()).toBe(before);
    expect(ok(await o().call(endpoints.commitImport, { params: { ...p(), importId: up.id }, body: plan({ skipInvalid: true }) }))).toMatchObject({ created: 1 });
  });
  it("is all-or-nothing: a failure part-way rolls back every row and leaves the import retryable", async () => {
    const before = await count();
    const up = await upload([header, "Roll One,r1@i.example,,,,,", "Roll Two,r2@i.example,,,,,", "Roll Three,r3@i.example,,,,,", "Roll Four,r4@i.example,,,,,"].join("\n"));
    failAtRow = 3;
    const e = failure(await o().call(endpoints.commitImport, { params: { ...p(), importId: up.id }, body: plan() }));
    failAtRow = 0;
    expect(e).toMatchObject({ status: 500, code: "import_failed" });
    expect(await count()).toBe(before); // rows 1 and 2 were rolled back
    expect(ok(await o().call(endpoints.listContacts, { params: p(), query: { search: "r1@i.example" } })).items).toEqual([]);
    const tags = ok(await o().call(endpoints.listTags, { params: p() }));
    expect(tags.every((t) => t.name !== "never-committed")).toBe(true);
    // not marked committed: retry succeeds
    expect(ok(await o().call(endpoints.commitImport, { params: { ...p(), importId: up.id }, body: plan() }))).toMatchObject({ created: 4 });
  });
  it("cannot be committed twice, including concurrently", async () => {
    const up = await upload([header, "Once Only,once@i.example,,,,,"].join("\n"));
    const [a, b] = await Promise.all([o().call(endpoints.commitImport, { params: { ...p(), importId: up.id }, body: plan() }), o().call(endpoints.commitImport, { params: { ...p(), importId: up.id }, body: plan() })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(failure(loser).code).toBe("already_committed");
    expect(ok(await o().call(endpoints.listContacts, { params: p(), query: { search: "once@i.example" } })).total).toBe(1);
    expect(failure(await o().call(endpoints.previewImport, { params: { ...p(), importId: up.id }, body: plan() })).code).toBe("already_committed");
  });
  it("another workspace cannot see or commit this import", async () => {
    const other = await h.newUser("iother");
    const wsB = await h.workspace(other, "Other Import Co");
    const up = await upload([header, "Leak,leak@i.example,,,,,"].join("\n"));
    expect(failure(await h.clientFor(other).call(endpoints.previewImport, { params: { workspaceId: wsB, importId: up.id }, body: plan() })).status).toBe(404);
    expect(failure(await h.clientFor(other).call(endpoints.commitImport, { params: { workspaceId: wsB, importId: up.id }, body: plan() })).status).toBe(404);
  });
});

describe("export", () => {
  it("exports the filtered set with custom fields, neutralises formula injection, and is audited", async () => {
    const evil = await h.contact(o(), W, { name: "=HYPERLINK(\"http://evil\",\"x\")", email: "evil@i.example", company: "+cmd|' /C calc'!A0", custom: { budget: 5 } });
    expect(evil.id).toBeTruthy();
    const csv = ok(await o().call(endpoints.exportContacts, { params: p(), query: { search: "evil@i.example" } }));
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(["Name", "Email", "Phone", "Company", "Lifecycle stage", "Owner email", "Tags", "Source", "Last activity", "Created", "Budget"]);
    expect(parsed.rows).toHaveLength(1);
    // the raw file carries the formula guard; our importer removes it again
    expect(csv).toContain("\"'=HYPERLINK(\"\"http://evil\"\",\"\"x\"\")\"");
    expect(csv).toContain(",'+cmd|' /C calc'!A0,");
    expect(parsed.rows[0]![0]).toBe("=HYPERLINK(\"http://evil\",\"x\")");
    expect(parsed.rows[0]![10]).toBe("5");
    const audit = ok(await o().call(endpoints.auditLog, { params: p(), query: { limit: 10 } }));
    expect(audit.items.some((i) => i.action === "data.exported" && (i.summary as { count: number }).count === 1)).toBe(true);
  });
  it("round-trips: an export can be re-imported without duplicates being created when skipping", async () => {
    const csv = ok(await o().call(endpoints.exportContacts, { params: p(), query: { search: "mia@i.example" } }));
    const up = await upload(csv);
    const pv = ok(await o().call(endpoints.previewImport, { params: { ...p(), importId: up.id }, body: plan({ mapping: up.suggestedMapping as ImportPlanBody["mapping"] }) }));
    expect(JSON.stringify(pv.errors)).toBe("[]");
    expect(pv.duplicates).toHaveLength(1);
    expect(pv.willCreate).toBe(0);
  });
});
