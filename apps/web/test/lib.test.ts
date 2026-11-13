import { describe, expect, it } from "vitest";
import { describeAudit } from "@/lib/audit-text";
import { initials } from "@/lib/initials";
import { NAV, builtNav, plannedItems, titleFor, visibleNav } from "@/lib/nav";
import { formatDate } from "@/lib/format";

describe("describeAudit", () => {
  it("writes readable sentences", () => {
    expect(describeAudit({ action: "workspace.created", actorName: "Maya", summary: {} })).toBe("Maya created the workspace");
    expect(describeAudit({ action: "member.role_changed", actorName: "Dana", summary: { name: "Sam", from: "agent", to: "viewer" } })).toBe("Dana changed Sam's role from agent to viewer");
    expect(describeAudit({ action: "member.removed", actorName: null, summary: { name: "Vic" } })).toBe("System removed Vic from the workspace");
  });
  it("says what changed in a workspace update", () => {
    expect(describeAudit({ action: "workspace.updated", actorName: "Ann", summary: { name: "X" } })).toBe("Ann updated the workspace name");
    expect(describeAudit({ action: "workspace.updated", actorName: "Ann", summary: { name: "X", timezone: "UTC" } })).toBe("Ann updated the workspace name and time zone");
    expect(describeAudit({ action: "workspace.updated", actorName: "Ann", summary: { timezone: "UTC" } })).toBe("Ann updated the workspace time zone");
  });
  it("never hides an unknown action", () => {
    expect(describeAudit({ action: "something.new", actorName: "Ann", summary: {} })).toBe("Ann: something.new");
  });
});

describe("initials", () => {
  it("uses first and last word", () => {
    expect(initials("Maya Okafor")).toBe("MO");
    expect(initials("Daniel Brandt-Fitzgerald Montgomery")).toBe("DM");
    expect(initials("cher")).toBe("C");
    expect(initials("   ")).toBe("?");
  });
});

describe("navigation permissions", () => {
  const labels = (role: "owner" | "admin" | "agent" | "viewer") => visibleNav(role).flatMap((g) => g.items.map((i) => i.label));
  it("owners and admins see everything", () => {
    expect(labels("owner")).toEqual(NAV.flatMap((g) => g.items.map((i) => i.label)));
    expect(labels("admin")).toEqual(labels("owner"));
  });
  it("agents lose audit log and automation but keep integrations and AI", () => {
    const l = labels("agent");
    expect(l).not.toContain("Audit log");
    expect(l).not.toContain("Automation");
    expect(l).toContain("Integrations");
    expect(l).toContain("AI assistant");
  });
  it("viewers see only the basics", () => {
    expect(labels("viewer")).toEqual(["Home", "Inbox", "Contacts", "Tasks", "Leads", "Pipeline", "Reports", "Members", "Settings"]);
  });
  it("only built features are links; planned ones are listed separately and also permission-filtered", () => {
    expect(builtNav("owner").flatMap((g) => g.items.map((i) => i.label))).toEqual(["Home", "Contacts", "Tasks", "Leads", "Pipeline", "Reports", "Members", "Audit log", "Settings"]);
    expect(builtNav("viewer").flatMap((g) => g.items.map((i) => i.label))).toEqual(["Home", "Contacts", "Tasks", "Leads", "Pipeline", "Reports", "Members", "Settings"]);
    expect(plannedItems("owner").map((i) => i.label)).toEqual(["Inbox", "Automation", "AI assistant", "Integrations"]);
    expect(plannedItems("viewer").map((i) => i.label)).toEqual(["Inbox"]);
  });
  it("derives page titles from the path", () => {
    expect(titleFor("/w/abc/members", "abc")).toBe("Members");
    expect(titleFor("/w/abc", "abc")).toBe("Home");
    expect(titleFor("/w/abc/audit-log", "abc")).toBe("Audit log");
  });
});

describe("formatDate", () => {
  it("formats in the workspace time zone, not the machine's", () => {
    expect(formatDate("2026-11-13T02:00:00Z", "America/New_York")).toBe("Nov 12, 2026");
    expect(formatDate("2026-11-13T02:00:00Z", "Asia/Dhaka")).toBe("Nov 13, 2026");
  });
});
