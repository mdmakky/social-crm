import { describe, expect, it } from "vitest";
import { canDecideApprovals, summarizeApprovalActions, triggerLabel } from "../src/approvals.ts";

describe("approvals helpers", () => {
  it("only owner and admin may decide", () => {
    expect((["owner", "admin", "agent", "viewer"] as const).map(canDecideApprovals)).toEqual([true, true, false, false]);
  });
  it("summarizes actions in plain language", () => {
    const names: Record<string, string> = { u1: "Ana" };
    expect(summarizeApprovalActions([{ type: "create_task", title: "Call" }, { type: "add_tag", tagName: "vip" }, { type: "assign_owner", ownerUserId: "u1" }, { type: "assign_owner", ownerUserId: "zz" }], (id) => names[id])).toBe('Create task "Call", Add tag "vip", Assign owner Ana, Assign owner (unknown member)');
    expect(summarizeApprovalActions([])).toBe("No actions");
  });
  it("trigger labels fall back to the raw key", () => {
    expect(triggerLabel("lead.stage_changed")).toBe("A lead moves to another stage");
    expect(triggerLabel("x.y")).toBe("x.y");
  });
});
