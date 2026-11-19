import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { withContext } from "@crm/db";
import { dispatchPending, emitEvent } from "../src/events.ts";
import { notificationsConsumer } from "../src/notifications/index.ts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, outsider: TestUser;
let ws: string;
let other: string;
const P = () => ({ params: { workspaceId: ws } });

async function seed(user: TestUser, count: number, workspaceId = ws) {
  for (let i = 0; i < count; i++) {
    await h.admin.query("INSERT INTO notifications(workspace_id,user_id,kind,title,dedupe_key) VALUES ($1,$2,'task.assigned',$3,$4)", [workspaceId, user.id, `n${i}`, `seed-${Math.random()}`]);
  }
}
const clear = () => h.admin.query("DELETE FROM notifications WHERE workspace_id = ANY($1)", [[ws, other]]);

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("nowner");
  admin = await h.newUser("nadmin");
  agent = await h.newUser("nagent");
  viewer = await h.newUser("nviewer");
  outsider = await h.newUser("noutsider");
  ws = await h.workspace(owner, "Notif", { admin, agent, viewer });
  other = await h.workspace(outsider, "Notif other");
});
afterAll(() => h.close());

describe("notifications API", () => {
  it("lists only the caller's own notifications; admins and owners do not see them", async () => {
    await clear();
    await seed(agent, 2);
    await seed(admin, 1);
    expect(ok(await h.clientFor(agent).call(endpoints.listNotifications, P())).items).toHaveLength(2);
    expect(ok(await h.clientFor(admin).call(endpoints.listNotifications, P())).items).toHaveLength(1);
    expect(ok(await h.clientFor(owner).call(endpoints.listNotifications, P())).items).toHaveLength(0);
    expect(ok(await h.clientFor(viewer).call(endpoints.listNotifications, P())).items).toHaveLength(0); // every role may use the inbox
  });

  it("non-members get 404 for the workspace and cannot touch someone else's notification id", async () => {
    await clear();
    await seed(agent, 1);
    const [mine] = ok(await h.clientFor(agent).call(endpoints.listNotifications, P())).items;
    expect(failure(await h.clientFor(outsider).call(endpoints.listNotifications, P())).status).toBe(404);
    expect(failure(await h.clientFor(outsider).call(endpoints.unreadNotificationCount, P())).status).toBe(404);
    const r = await h.clientFor(admin).call(endpoints.setNotificationRead, { ...P(), params: { workspaceId: ws, notificationId: mine!.id }, body: { read: true } });
    expect(failure(r).status).toBe(404); // another member's row is invisible, even to an admin
    expect(ok(await h.clientFor(agent).call(endpoints.unreadNotificationCount, P())).count).toBe(1);
  });

  it("unread count, mark read/unread, mark all read, and unread filter", async () => {
    await clear();
    await seed(agent, 3);
    const c = h.clientFor(agent);
    expect(ok(await c.call(endpoints.unreadNotificationCount, P())).count).toBe(3);
    const items = ok(await c.call(endpoints.listNotifications, P())).items;
    const read = ok(await c.call(endpoints.setNotificationRead, { params: { workspaceId: ws, notificationId: items[0]!.id }, body: { read: true } }));
    expect(read.readAt).not.toBeNull();
    expect(ok(await c.call(endpoints.unreadNotificationCount, P())).count).toBe(2);
    expect(ok(await c.call(endpoints.listNotifications, { ...P(), query: { unread: "true" } })).items).toHaveLength(2);
    expect(ok(await c.call(endpoints.setNotificationRead, { params: { workspaceId: ws, notificationId: items[0]!.id }, body: { read: false } })).readAt).toBeNull();
    expect(ok(await c.call(endpoints.markAllNotificationsRead, P())).updated).toBe(3);
    expect(ok(await c.call(endpoints.unreadNotificationCount, P())).count).toBe(0);
    expect(ok(await c.call(endpoints.markAllNotificationsRead, P())).updated).toBe(0);
    expect(failure(await c.call(endpoints.setNotificationRead, { params: { workspaceId: ws, notificationId: "not-a-uuid" }, body: { read: true } })).status).toBe(404);
  });

  it("mark all read touches only the caller's rows", async () => {
    await clear();
    await seed(agent, 1);
    await seed(admin, 2);
    ok(await h.clientFor(agent).call(endpoints.markAllNotificationsRead, P()));
    expect(ok(await h.clientFor(admin).call(endpoints.unreadNotificationCount, P())).count).toBe(2);
  });

  it("paginates newest first with a stable cursor and does not repeat or skip items", async () => {
    await clear();
    await seed(agent, 7);
    const c = h.clientFor(agent);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = ok(await c.call(endpoints.listNotifications, { ...P(), query: { limit: 3, cursor } }));
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual([...seen].sort().reverse());
    const raw = (qs: string) => Promise.resolve(h.app.request(`/v1/workspaces/${ws}/notifications?${qs}`, { headers: { cookie: agent.cookie } })).then((r) => r.status);
    expect(await raw("limit=500")).toBe(400);
    expect(await raw("cursor=nope")).toBe(400);
  });

  it("bearer (mobile) path works the same", async () => {
    await clear();
    await seed(agent, 2);
    const c = h.clientFor(agent, "bearer");
    expect(ok(await c.call(endpoints.unreadNotificationCount, P())).count).toBe(2);
    expect(ok(await c.call(endpoints.markAllNotificationsRead, P())).updated).toBe(2);
  });

  it("requires authentication", async () => {
    const res = await h.app.request(`/v1/workspaces/${ws}/notifications`);
    expect(res.status).toBe(401);
  });

  it("is isolated per workspace", async () => {
    await clear();
    await seed(agent, 1);
    await h.admin.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'agent') ON CONFLICT DO NOTHING", [other, agent.id]);
    expect(ok(await h.clientFor(agent).call(endpoints.unreadNotificationCount, { params: { workspaceId: other } })).count).toBe(0);
  });
});

describe("notification preferences API", () => {
  it("defaults on for every kind; update persists per user and workspace and suppresses new notifications", async () => {
    const c = h.clientFor(agent);
    const initial = ok(await c.call(endpoints.getNotificationPreferences, P())).preferences;
    expect(initial.map((p) => p.kind)).toEqual(["contact.owner_assigned", "lead.owner_assigned", "task.assigned", "task.reminder", "import.completed"]);
    expect(initial.every((p) => p.inApp)).toBe(true);
    const after = ok(await c.call(endpoints.updateNotificationPreferences, { ...P(), body: { preferences: [{ kind: "task.assigned", inApp: false }] } })).preferences;
    expect(after.find((p) => p.kind === "task.assigned")?.inApp).toBe(false);
    expect(after.find((p) => p.kind === "import.completed")?.inApp).toBe(true);
    expect(ok(await h.clientFor(admin).call(endpoints.getNotificationPreferences, P())).preferences.every((p) => p.inApp)).toBe(true); // not shared
    expect(ok(await c.call(endpoints.getNotificationPreferences, { params: { workspaceId: other } })).preferences.every((p) => p.inApp)).toBe(true); // other workspace untouched (membership added above)

    await clear();
    await withContext(h.db, { userId: owner.id, workspaceId: ws }, (tx) => emitEvent(tx, { workspaceId: ws, type: "task.assigned", entityType: "task", entityId: "x", actorUserId: owner.id, payload: { assigneeUserId: agent.id, title: "Muted" } }));
    await dispatchPending(h.db, { consumers: [notificationsConsumer], workspaceIds: [ws] });
    expect(ok(await c.call(endpoints.unreadNotificationCount, P())).count).toBe(0);
    ok(await c.call(endpoints.updateNotificationPreferences, { ...P(), body: { preferences: [{ kind: "task.assigned", inApp: true }] } }));
    await withContext(h.db, { userId: owner.id, workspaceId: ws }, (tx) => emitEvent(tx, { workspaceId: ws, type: "task.assigned", entityType: "task", entityId: "y", actorUserId: owner.id, payload: { assigneeUserId: agent.id, title: "Heard" } }));
    await dispatchPending(h.db, { consumers: [notificationsConsumer], workspaceIds: [ws] });
    expect(ok(await c.call(endpoints.listNotifications, P())).items.map((i) => i.title)).toEqual(["New task: Heard"]);
  });

  it("rejects unknown kinds and empty bodies; non-members get 404", async () => {
    const patch = (b: unknown) => Promise.resolve(h.app.request(`/v1/workspaces/${ws}/notification-preferences`, { method: "PATCH", headers: { cookie: agent.cookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(b) })).then((r) => r.status);
    expect(await patch({ preferences: [{ kind: "nope", inApp: false }] })).toBe(400);
    expect(await patch({ preferences: [] })).toBe(400);
    expect(failure(await h.clientFor(outsider).call(endpoints.getNotificationPreferences, P())).status).toBe(404);
  });
});
