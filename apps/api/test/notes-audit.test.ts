import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, agent2: TestUser, viewer: TestUser;
let ws: string;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const call = (u: TestUser, method: string, path: string, body?: unknown) =>
  h.app.request(`/v1/workspaces/${ws}/${path}`, { method, headers: { cookie: u.cookie, "content-type": "application/json", origin: "http://localhost:3000" }, body: body === undefined ? undefined : JSON.stringify(body) });
const audits = (noteId: string) => q("SELECT action, actor_user_id, workspace_id, entity_type, summary FROM audit_log WHERE entity_id = $1 AND action LIKE 'note.%' ORDER BY created_at", [noteId]);
const SECRET = "very private note text 4821";
async function note(author: TestUser, contactId: string) {
  const res = await call(author, "POST", `contacts/${contactId}/notes`, { body: SECRET });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("nao");
  admin = await h.newUser("naa");
  agent = await h.newUser("nag");
  agent2 = await h.newUser("nag2");
  viewer = await h.newUser("nav");
  ws = await h.workspace(owner, "Notes Audit", { admin, agent, agent2, viewer });
});
afterAll(async () => { await h.close(); });

describe("notes: audit log for privileged edits and deletes of someone else's note", () => {
  it("an admin editing an agent's note is audited with actor and references, never the text; the author editing their own is not", async () => {
    const c = (await h.contact(h.clientFor(owner), ws, { name: "Notes Person 1" })).id;
    const n = await note(agent, c);
    expect((await call(agent, "PATCH", `contacts/${c}/notes/${n}`, { body: "my own edit" })).status).toBe(200);
    expect(await audits(n)).toHaveLength(0);
    expect((await call(admin, "PATCH", `contacts/${c}/notes/${n}`, { body: "admin rewrote this" })).status).toBe(200);
    const [a] = await audits(n);
    expect(a).toMatchObject({ action: "note.edited_by_other", actor_user_id: admin.id, workspace_id: ws, entity_type: "note" });
    expect(a.summary).toEqual({ contactId: c, authorUserId: agent.id });
    expect(JSON.stringify(a)).not.toContain("rewrote");
    expect(JSON.stringify(a)).not.toContain(SECRET);
  });

  it("deleting someone else's note is audited; deleting your own is not", async () => {
    const c = (await h.contact(h.clientFor(owner), ws, { name: "Notes Person 2" })).id;
    const own = await note(agent, c);
    expect((await call(agent, "DELETE", `contacts/${c}/notes/${own}`)).status).toBe(204);
    expect(await audits(own)).toHaveLength(0);
    const theirs = await note(agent, c);
    expect((await call(owner, "DELETE", `contacts/${c}/notes/${theirs}`)).status).toBe(204);
    const [a] = await audits(theirs);
    expect(a).toMatchObject({ action: "note.deleted_by_other", actor_user_id: owner.id });
    expect(a.summary).toEqual({ contactId: c, authorUserId: agent.id });
  });

  it("refused attempts leave no audit entry and change nothing", async () => {
    const c = (await h.contact(h.clientFor(owner), ws, { name: "Notes Person 3" })).id;
    const n = await note(agent, c);
    expect((await call(agent2, "PATCH", `contacts/${c}/notes/${n}`, { body: "hijack" })).status).toBe(403);
    expect((await call(agent2, "DELETE", `contacts/${c}/notes/${n}`)).status).toBe(403);
    expect((await call(viewer, "DELETE", `contacts/${c}/notes/${n}`)).status).toBe(403);
    expect(await audits(n)).toHaveLength(0);
    expect((await q("SELECT body, deleted_at FROM notes WHERE id = $1", [n]))[0]).toEqual({ body: SECRET, deleted_at: null });
  });

  it("audit entries stay inside their workspace", async () => {
    const other = await h.newUser("naout");
    const wsO = await h.workspace(other, "Notes Audit Other");
    const c = (await h.contact(h.clientFor(owner), ws, { name: "Notes Person 4" })).id;
    const n = await note(agent, c);
    await call(admin, "PATCH", `contacts/${c}/notes/${n}`, { body: "x" });
    const asOther = await h.app.request(`/v1/workspaces/${wsO}/audit-log`, { headers: { cookie: other.cookie } });
    expect(JSON.stringify(await asOther.json())).not.toContain(n);
    expect((await q("SELECT workspace_id FROM audit_log WHERE entity_id = $1", [n])).every((r) => r.workspace_id === ws)).toBe(true);
  });
});
