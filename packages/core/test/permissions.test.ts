import { describe, expect, it } from "vitest";
import { can, memberChangeAllowed, ROLES, ACTIONS } from "../src/permissions.ts";

describe("permission matrix (docs/architecture/permissions.md)", () => {
  it("every action is decided for every role", () => {
    for (const a of ACTIONS) for (const r of ROLES) expect(typeof can(r, a, {})).toBe("boolean");
  });
  it("viewers are read-only", () => {
    expect(can("viewer", "contact.view", {})).toBe(true);
    for (const a of ACTIONS.filter((x) => x !== "contact.view" && x !== "workspace.view" && x !== "lead.view")) expect(can("viewer", a, {})).toBe(false);
  });
  it("agents work conversations but cannot administer", () => {
    expect(can("agent", "conversation.reply", {})).toBe(true);
    expect(can("agent", "integration.manage", {})).toBe(false);
    expect(can("agent", "audit.view", {})).toBe(false);
    expect(can("agent", "member.invite", {})).toBe(false);
    expect(can("agent", "data.export", {})).toBe(false);
  });
  it("qualified actions need their qualifier", () => {
    expect(can("agent", "conversation.assign", {})).toBe(false);
    expect(can("agent", "conversation.assign", { isSelf: true })).toBe(true);
    expect(can("agent", "task.edit", {})).toBe(false);
    expect(can("agent", "task.edit", { isOwn: true })).toBe(true);
    expect(can("agent", "approval.decide", {})).toBe(false);
    expect(can("agent", "approval.decide", { isNamedApprover: true })).toBe(true);
    expect(can("admin", "task.edit", {})).toBe(true);
  });
  it("notes: agents edit their own, admins any; viewers none; shared views need an admin", () => {
    expect(can("agent", "note.edit", {})).toBe(false);
    expect(can("agent", "note.edit", { isOwn: true })).toBe(true);
    expect(can("admin", "note.edit", {})).toBe(true);
    expect(can("viewer", "note.edit", { isOwn: true })).toBe(false);
    expect(can("agent", "view.share", {})).toBe(false);
    expect(can("admin", "view.share", {})).toBe(true);
  });
  it("only owners transfer ownership or delete the workspace", () => {
    expect(can("owner", "workspace.delete", {})).toBe(true);
    expect(can("admin", "workspace.delete", {})).toBe(false);
    expect(can("owner", "workspace.transfer", {})).toBe(true);
    expect(can("admin", "workspace.transfer", {})).toBe(false);
  });
  it("owners and admins view the audit log and manage integrations", () => {
    for (const r of ["owner", "admin"] as const) {
      expect(can(r, "audit.view", {})).toBe(true);
      expect(can(r, "integration.manage", {})).toBe(true);
      expect(can(r, "capi.manage", {})).toBe(true);
    }
  });
});

describe("memberChangeAllowed", () => {
  const base = { ownerCount: 2 };
  it("admin cannot touch owners or grant owner", () => {
    expect(memberChangeAllowed({ ...base, actor: "admin", target: "owner", change: { role: "agent" } })).toEqual({ ok: false, reason: "admin_cannot_change_owner" });
    expect(memberChangeAllowed({ ...base, actor: "admin", target: "agent", change: { role: "owner" } })).toEqual({ ok: false, reason: "admin_cannot_grant_owner" });
    expect(memberChangeAllowed({ ...base, actor: "admin", target: "agent", change: { role: "viewer" } })).toEqual({ ok: true });
  });
  it("agents and viewers cannot manage members", () => {
    expect(memberChangeAllowed({ ...base, actor: "agent", target: "viewer", change: { role: "agent" } }).ok).toBe(false);
  });
  it("the last owner cannot be demoted or removed", () => {
    expect(memberChangeAllowed({ ownerCount: 1, actor: "owner", target: "owner", change: { role: "admin" } })).toEqual({ ok: false, reason: "last_owner" });
    expect(memberChangeAllowed({ ownerCount: 1, actor: "owner", target: "owner", change: { remove: true } })).toEqual({ ok: false, reason: "last_owner" });
    expect(memberChangeAllowed({ ownerCount: 2, actor: "owner", target: "owner", change: { remove: true } })).toEqual({ ok: true });
  });

  it("lead actions: viewers read only, agents edit but not delete or reopen", () => {
    expect(can("viewer", "lead.view", {})).toBe(true);
    expect(can("viewer", "lead.edit", {})).toBe(false);
    expect(can("agent", "lead.edit", {})).toBe(true);
    expect(can("agent", "lead.delete", {})).toBe(false);
    expect(can("agent", "lead.reopen", {})).toBe(false);
    expect(can("admin", "lead.reopen", {})).toBe(true);
  });
  it("deal value needs owner/admin or an explicit grant; viewers never", () => {
    for (const a of ["lead.value.view", "lead.value.edit"] as const) {
      expect(can("owner", a, {})).toBe(true);
      expect(can("admin", a, {})).toBe(true);
      expect(can("agent", a, {})).toBe(false);
      expect(can("agent", a, { isGranted: true })).toBe(true);
      expect(can("viewer", a, { isGranted: true })).toBe(false);
    }
  });
});
