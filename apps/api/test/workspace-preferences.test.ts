import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { bootstrap, ok, type Harness, type TestUser } from "./harness.ts";

// Workspace preferences live in workspaces.settings: defaults for old workspaces, partial updates, owner/admin only, no logo bytes in the audit trail.
let h: Harness;
let owner: TestUser, agent: TestUser;
let W: string;
const o = () => h.clientFor(owner);
const p = () => ({ workspaceId: W });
const get = async () => ok(await o().call(endpoints.getWorkspace, { params: p() }));
const patch = (body: Record<string, unknown>) => o().call(endpoints.updateWorkspace, { params: p(), body: body as never });
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("wp-owner"); agent = await h.newUser("wp-agent");
  W = await h.workspace(owner, "Prefs Co", { agent });
});
afterAll(async () => h.close());

describe("workspace preferences", () => {
  it("a workspace with no stored preferences returns the defaults", async () => {
    const w = await get();
    expect(w).toMatchObject({ currency: "USD", timeFormat: "12h", weekStart: "sun", logo: null, business: { phone: "", address: "", website: "", email: "" } });
  });
  it("saves each preference on its own and keeps the others", async () => {
    ok(await patch({ currency: "BDT" }));
    ok(await patch({ timeFormat: "24h", weekStart: "sat" }));
    ok(await patch({ business: { phone: "+880 1700 000000", website: "https://example.com" } }));
    ok(await patch({ business: { email: "hello@example.com" } }));
    const w = await get();
    expect(w).toMatchObject({ name: "Prefs Co", currency: "BDT", timeFormat: "24h", weekStart: "sat", business: { phone: "+880 1700 000000", website: "https://example.com", email: "hello@example.com", address: "" } });
  });
  it("rejects bad values", async () => {
    for (const body of [{ currency: "taka" }, { timeFormat: "36h" }, { weekStart: "fri" }, { business: { website: "example.com" } }, { business: { email: "nope" } }, { logo: "data:text/html;base64,AAAA" }, { logo: "javascript:alert(1)" }, {}]) {
      expect((await patch(body)).ok, JSON.stringify(body)).toBe(false);
    }
  });
  it("stores and removes a logo, and the audit trail never holds the bytes", async () => {
    ok(await patch({ logo: PNG }));
    expect((await get()).logo).toBe(PNG);
    const rows = (await h.admin.query("SELECT summary FROM audit_log WHERE workspace_id=$1 AND action='workspace.updated' ORDER BY created_at", [W])).rows;
    expect(JSON.stringify(rows)).not.toContain("base64");
    ok(await patch({ logo: null }));
    expect((await get()).logo).toBeNull();
  });
  it("only owners and admins can change them", async () => {
    const r = await h.clientFor(agent).call(endpoints.updateWorkspace, { params: p(), body: { currency: "EUR" } });
    expect(r.ok).toBe(false);
    expect((await get()).currency).toBe("BDT");
  });
});
