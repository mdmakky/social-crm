import { describe, expect, it } from "vitest";
import { describeAudit } from "@/lib/audit-text";
import { initials } from "@/lib/initials";
import { NAV, titleFor, visibleNav } from "@/lib/nav";
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
  it("the sidebar is daily work plus one Settings entry, the same for every role that can use it", () => {
    expect(labels("owner")).toEqual(["Home", "Inbox", "Contacts", "Tasks", "Leads", "Reports", "Settings"]);
    expect(labels("viewer")).toEqual(["Home", "Inbox", "Contacts", "Tasks", "Leads", "Reports", "Settings"]);
    for (const gone of ["Integrations", "Members", "Audit log", "Automation", "AI assistant"]) expect(labels("owner")).not.toContain(gone);
  });
  it("derives page titles from the path", () => {
    expect(titleFor("/w/abc/settings/ai", "abc")).toBe("Settings");
    expect(titleFor("/w/abc", "abc")).toBe("Home");
  });
});

describe("formatDate", () => {
  it("formats in the workspace time zone, not the machine's", () => {
    expect(formatDate("2026-11-13T02:00:00Z", "America/New_York")).toBe("Nov 12, 2026");
    expect(formatDate("2026-11-13T02:00:00Z", "Asia/Dhaka")).toBe("Nov 13, 2026");
  });
});

describe("initials with emoji and Bangla", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|�/;
  it("keeps an emoji at the start or end of a name whole (never half a surrogate pair)", () => {
    for (const [name, want] of [
      ["🌸 Sara Ahmed", "🌸A"],
      ["Sara 🌸", "S🌸"],
      ["🌸", "🌸"],
      ["👍🏽 Tom Reed", "👍🏽R"],
      ["👨‍👩‍👧‍👦 Family Ali", "👨‍👩‍👧‍👦A"],
      ["🏳️‍🌈 Pride Co", "🏳️‍🌈C"],
      ["🇧🇩 Rahim Uddin", "🇧🇩U"],
      ["❤️ Love", "❤️L"],
    ] as const) {
      const got = initials(name);
      expect(got, name).toBe(want);
      expect(lone.test(got), `${name} -> lone surrogate`).toBe(false);
    }
  });
  it("leaves letters exactly as before, Bangla included", () => {
    expect(initials("Maya Okafor")).toBe("MO");
    expect(initials("আব্দুল করিম")).toBe("আক");
    expect(initials("  rahim   uddin  ")).toBe("RU");
    expect(initials("")).toBe("?");
    expect(initials("Sara")).toBe("S");
  });
});
