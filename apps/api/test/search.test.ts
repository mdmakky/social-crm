import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, SearchResponse } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";
import type { SearchProvider } from "../src/search/types.ts";

// A fake provider for an entity that does not exist yet: proves providers plug in without touching the endpoint.
const fake: SearchProvider = {
  type: "fakes",
  label: "Fakes",
  requires: (role) => can(role, "contact.edit", {}), // viewers excluded
  search: async (_tx, ctx, q, limit) => [{ id: "f1", type: "fakes", title: `fake ${q}`, href: `/w/${ctx.workspaceId}/fakes/f1` }].slice(0, limit),
};

let h: Harness;
let owner: TestUser, agent: TestUser, viewer: TestUser, outsider: TestUser, other: TestUser;
let W: string, W2: string;

beforeAll(async () => {
  h = await bootstrap({ extraSearchProviders: [fake] });
  owner = await h.newUser("so");
  agent = await h.newUser("sa");
  viewer = await h.newUser("sv");
  outsider = await h.newUser("sx");
  other = await h.newUser("sy");
  W = await h.workspace(owner, "Search Co", { agent, viewer });
  W2 = await h.workspace(other, "Other Search Co");
  const c = h.clientFor(owner);
  const seed = (name: string, extra: Record<string, string> = {}) => h.contact(c, W, { name, ...extra } as never);
  await seed("Zed Exactmatch", { email: "zed@ranking.example", phone: "+1 555 010 4242" });
  await seed("Zedekiah Prefix");
  await seed("Alpha Zed Substring");
  await seed("Percent 100% Done");
  await seed("Under_score Person");
  await seed("Robert'); DROP TABLE contacts;--");
  await seed("Élodie Ünal", { company: "Café Société" });
  await seed("Acme Contact", { company: "Zedcorp" });
  await h.contact(h.clientFor(other), W2, { name: "Zed Foreign", email: "zed@foreign.example" } as never);
});
afterAll(() => h.close());

const search = (u: TestUser, ws: string, query: Record<string, unknown>, mode: "cookie" | "bearer" = "cookie") => h.clientFor(u, mode).call(endpoints.search, { params: { workspaceId: ws }, query: query as never });
const hits = async (u: TestUser, ws: string, query: Record<string, unknown>, type = "contacts") => ok(await search(u, ws, query)).groups.find((g) => g.type === type)?.hits ?? [];

describe("global search", () => {
  it("returns grouped hits with name, subtitle, href and meta, validated against the contract", async () => {
    const res = await h.app.request(`/v1/workspaces/${W}/search?q=elodie`.replace("elodie", "%C3%A9lodie"), { headers: { cookie: owner.cookie } });
    const data = SearchResponse.parse(await res.json());
    const g = data.groups.find((x) => x.type === "contacts")!;
    expect(g.label).toBe("Contacts");
    expect(g.hits[0]).toMatchObject({ title: "Élodie Ünal", subtitle: "Café Société", meta: { company: "Café Société" } });
    expect(g.hits[0]!.href).toBe(`/w/${W}/contacts/${g.hits[0]!.id}`);
  });
  it("works over bearer auth through the shared client", async () => {
    const r = ok(await search(owner, W, { q: "zed" }, "bearer"));
    expect(r.groups[0]!.hits.length).toBeGreaterThan(0);
  });
  it("ranks exact email first, then name prefix, then substring; ties by recency", async () => {
    expect((await hits(owner, W, { q: "zed@ranking.example" }))[0]!.title).toBe("Zed Exactmatch");
    expect((await hits(owner, W, { q: "5550104242" }))[0]!.title).toBe("Zed Exactmatch");
    expect((await hits(owner, W, { q: "zed" })).map((x) => x.title)).toEqual(["Zedekiah Prefix", "Zed Exactmatch", "Acme Contact", "Alpha Zed Substring"]);
  });
  it("treats % and _ literally and survives SQL metacharacters", async () => {
    expect((await hits(owner, W, { q: "100%" })).map((x) => x.title)).toEqual(["Percent 100% Done"]);
    expect(await hits(owner, W, { q: "%%" })).toEqual([]);
    expect((await hits(owner, W, { q: "r_" })).map((x) => x.title)).toEqual(["Under_score Person"]);
    expect((await hits(owner, W, { q: "'); drop table" })).map((x) => x.title)).toEqual(["Robert'); DROP TABLE contacts;--"]);
    expect(((await h.admin.query("SELECT count(*)::int n FROM contacts WHERE workspace_id=$1", [W])).rows[0] as { n: number }).n).toBe(8);
  });
  it("is case and accent tolerant for the same-case-folding cases", async () => {
    expect((await hits(owner, W, { q: "ZEDCORP" })).map((x) => x.title)).toEqual(["Acme Contact"]);
    expect((await hits(owner, W, { q: "ÉLODIE" })).map((x) => x.title)).toEqual(["Élodie Ünal"]);
  });
  it("rejects short, long and bad-limit queries with 400", async () => {
    for (const qs of ["q=z", "q=%20z%20", `q=${"x".repeat(101)}`, "", "q=zed&limit=0", "q=zed&limit=21"]) {
      expect((await h.app.request(`/v1/workspaces/${W}/search?${qs}`, { headers: { cookie: owner.cookie } })).status).toBe(400);
    }
  });
  it("applies the per-provider limit", async () => {
    expect(await hits(owner, W, { q: "zed", limit: 2 })).toHaveLength(2);
  });
  it("filters by types; unknown types never appear", async () => {
    expect(ok(await search(owner, W, { q: "zed", types: "contacts" })).groups.map((g) => g.type)).toEqual(["contacts"]);
    expect(ok(await search(owner, W, { q: "zed", types: "tasks,conversations" })).groups).toEqual([]);
    expect(ok(await search(owner, W, { q: "zed" })).groups.map((g) => g.type).sort()).toEqual(["contacts", "fakes", "leads"]);
  });
  it("registers an extra provider with its own permission rule", async () => {
    const types = async (u: TestUser) => ok(await search(u, W, { q: "zed" })).groups.map((g) => g.type);
    expect(await types(agent)).toContain("fakes");
    expect(await types(viewer)).toEqual(["contacts", "leads"]);
  });
  it("never leaks across workspaces and returns 404 to non-members", async () => {
    expect((await hits(owner, W, { q: "foreign" }))).toEqual([]);
    expect((await hits(other, W2, { q: "foreign" })).map((x) => x.title)).toEqual(["Zed Foreign"]);
    expect(failure(await search(outsider, W, { q: "zed" })).status).toBe(404);
    expect(failure(await search(owner, W2, { q: "zed" })).status).toBe(404);
    expect(failure(await search(owner, "not-a-uuid", { q: "zed" })).status).toBe(404);
  });
  it("requires authentication", async () => {
    expect((await h.app.request(`/v1/workspaces/${W}/search?q=zed`)).status).toBe(401);
  });
});

