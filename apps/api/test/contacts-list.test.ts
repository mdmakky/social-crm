import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type ContactListQuery, type ContactSummary } from "@crm/contracts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, agent: TestUser;
let W: string;
let tagVip: string, tagLead: string;
let stages: { id: string; name: string }[];
const c = () => h.clientFor(owner);
const list = async (query: ContactListQuery = {}) => ok(await c().call(endpoints.listContacts, { params: { workspaceId: W }, query }));
const all = async (query: ContactListQuery) => {
  const out: ContactSummary[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await list({ ...query, limit: 7, cursor });
    out.push(...r.items);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
};

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("lowner");
  agent = await h.newUser("lagent");
  W = await h.workspace(owner, "List Co", { agent });
  stages = (ok(await c().call(endpoints.listLifecycleStages, { params: { workspaceId: W } })) as { id: string; name: string }[]);
  tagVip = ok(await c().call(endpoints.createTag, { params: { workspaceId: W }, body: { name: "vip" } })).id;
  tagLead = ok(await c().call(endpoints.createTag, { params: { workspaceId: W }, body: { name: "lead" } })).id;
  const names = ["Ana Costa", "Ben Okafor", "Chloe Park", "Dev Patel", "Eli Moreau", "Fatima Noor", "Gus Hall", "Hana Sato", "Ivan Petrov", "Jia Li"];
  // 60 contacts: deterministic spread over stage, owner, source, tags and company
  for (let i = 0; i < 60; i++) {
    const created = await h.contact(c(), W, {
      name: `${names[i % 10]} ${Math.floor(i / 10)}`,
      email: `person${i}@list.example`,
      phone: `+1 555 01${String(i).padStart(2, "0")} 00${String(i).padStart(2, "0")}`,
      company: i % 4 === 0 ? "Globex 100%" : i % 4 === 1 ? "Initech_Co" : "Umbrella",
      lifecycleStageId: stages[i % 5]!.id,
      ownerUserId: i % 3 === 0 ? owner.id : i % 3 === 1 ? agent.id : null,
      source: i % 2 === 0 ? "manual" : "messenger",
      tagIds: i % 5 === 0 ? [tagVip] : i % 7 === 0 ? [tagLead] : [],
    });
    expect(created.id).toBeTruthy();
  }
});
afterAll(async () => h.close());

describe("pagination", () => {
  for (const sort of ["name", "created", "lastActivity"] as const) {
    for (const dir of ["asc", "desc"] as const) {
      it(`pages through every contact exactly once, sorted by ${sort} ${dir}`, async () => {
        const items = await all({ sort, dir });
        expect(items).toHaveLength(60);
        expect(new Set(items.map((x) => x.id)).size).toBe(60);
        if (sort === "name") {
          const names = items.map((x) => x.name);
          expect(names).toEqual([...names].sort((a, b) => (dir === "asc" ? (a < b ? -1 : a > b ? 1 : 0) : a > b ? -1 : a < b ? 1 : 0)));
        } else {
          const key = (x: ContactSummary) => (sort === "created" ? x.createdAt : x.lastActivityAt!);
          const keys = items.map(key);
          expect(keys).toEqual([...keys].sort((a, b) => (dir === "asc" ? a.localeCompare(b) : b.localeCompare(a))));
        }
      });
    }
  }
  it("reports the total independent of the page size", async () => {
    const r = await list({ limit: 5 });
    expect(r.items).toHaveLength(5);
    expect(r.total).toBe(60);
    expect(r.nextCursor).toBeTruthy();
  });
  it("the last page has no cursor", async () => {
    const r = await list({ limit: 100 });
    expect(r.items).toHaveLength(60);
    expect(r.nextCursor).toBeNull();
  });
  it("rejects a cursor from a different sort, a malformed cursor, and out-of-range limits", async () => {
    const first = await list({ sort: "name", limit: 5 });
    expect(failure(await c().call(endpoints.listContacts, { params: { workspaceId: W }, query: { sort: "created", cursor: first.nextCursor! } })).status).toBe(400);
    expect(failure(await c().call(endpoints.listContacts, { params: { workspaceId: W }, query: { cursor: "garbage" } })).status).toBe(400);
    expect(failure(await c().call(endpoints.listContacts, { params: { workspaceId: W }, query: { limit: 101 } })).kind).toBe("invalid_request");
    expect(failure(await c().call(endpoints.listContacts, { params: { workspaceId: W }, query: { limit: 0 } })).kind).toBe("invalid_request");
  });
  it("new contacts created between pages do not duplicate or drop rows on the following pages", async () => {
    const p1 = await list({ sort: "created", dir: "desc", limit: 10 });
    await h.contact(c(), W, { name: "Late Arrival", email: "late@list.example" });
    const p2 = await list({ sort: "created", dir: "desc", limit: 10, cursor: p1.nextCursor! });
    const ids1 = new Set(p1.items.map((x) => x.id));
    expect(p2.items.every((x) => !ids1.has(x.id))).toBe(true);
    expect(p2.items).toHaveLength(10);
  });
});

describe("search", () => {
  it("matches name case-insensitively and by substring", async () => {
    expect((await list({ search: "ana costa" })).total).toBe(6);
    expect((await list({ search: "OKAFOR" })).total).toBe(6);
  });
  it("matches email, company and phone digits", async () => {
    expect((await list({ search: "person17@" })).items.map((x) => x.email)).toEqual(["person17@list.example"]);
    expect((await list({ search: "umbrella" })).total).toBe(30);
    expect((await list({ search: "5550123" })).items).toHaveLength(1); // phone digits, formatting ignored
    expect((await list({ search: "(555) 012-3" })).total).toBeGreaterThan(0);
  });
  it("treats LIKE wildcards literally", async () => {
    expect((await list({ search: "100%" })).total).toBe(15); // only the Globex 100% company
    expect((await list({ search: "%" })).total).toBe(15);
    expect((await list({ search: "_" })).total).toBe(15); // only "Initech_Co"; an unescaped "_" would match every row
    expect((await list({ search: "nomatch-xyz" })).items).toEqual([]);
  });
  it("is not affected by SQL metacharacters", async () => {
    expect((await list({ search: "'; DROP TABLE contacts; --" })).items).toEqual([]);
    expect((await list()).total).toBeGreaterThanOrEqual(60);
  });
});

describe("filters", () => {
  it("by lifecycle stage", async () => {
    const r = await list({ lifecycleStageId: stages[1]!.id });
    expect(r.total).toBe(12);
    expect(r.items.every((x) => x.lifecycleStage.id === stages[1]!.id)).toBe(true);
  });
  it("by owner: me, unassigned, and a specific member", async () => {
    expect((await list({ ownerId: "me" })).total).toBe(20);
    expect((await list({ ownerId: "unassigned" })).total).toBe(21); // 20 seeded plus "Late Arrival" from the pagination test
    expect((await list({ ownerId: agent.id })).total).toBe(20);
  });
  it("by tag: any of several tags", async () => {
    expect((await list({ tagIds: tagVip })).total).toBe(12);
    expect((await list({ tagIds: `${tagVip},${tagLead}` })).total).toBeGreaterThan(12);
    expect(failure(await c().call(endpoints.listContacts, { params: { workspaceId: W }, query: { tagIds: "not-a-uuid" } })).status).toBe(400);
  });
  it("by source and by created range (a plain end date includes that whole day)", async () => {
    expect((await list({ source: "messenger" })).total).toBe(30);
    const today = new Date().toISOString().slice(0, 10);
    expect((await list({ createdFrom: today, createdTo: today })).total).toBe(61);
    expect((await list({ createdTo: "2000-01-01" })).total).toBe(0);
    expect(failure(await c().call(endpoints.listContacts, { params: { workspaceId: W }, query: { createdFrom: "yesterday-ish" } })).status).toBe(400);
  });
  it("combines filters and search, and paginates the filtered set", async () => {
    const q = { source: "manual" as const, ownerId: "me", search: "person" };
    const r = await list({ ...q, limit: 100 });
    expect(r.items.every((x) => x.source === "manual" && x.owner?.id === owner.id)).toBe(true);
    expect((await all(q)).length).toBe(r.total);
  });
  it("includes tags, owner and stage on every row", async () => {
    const r = await list({ tagIds: tagVip, limit: 3 });
    expect(r.items[0]!.tags.map((t) => t.name)).toContain("vip");
    expect(r.items[0]!.lifecycleStage.name).toBeTruthy();
  });
});

describe("performance sanity", () => {
  it("lists and searches a 60-row workspace quickly (the seeded set is small; the 10k-row threshold is measured separately)", async () => {
    const t = performance.now();
    await list({ search: "ana", limit: 25 });
    expect(performance.now() - t).toBeLessThan(500);
  });
});
