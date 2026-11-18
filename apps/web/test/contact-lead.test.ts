import { describe, expect, it } from "vitest";
import type { ContactLead, PipelineDto } from "@crm/contracts";
import { firstStageOf, leadsQueryToContacts, shownStage, stagesForContact } from "@/lib/contact-lead";
import { MOBILE_TABS, visibleNav } from "@/lib/nav";

const st = (id: string, name: string, kind: "open" | "won" | "lost", position: number, archived = false) => ({ id, pipelineId: "p1", name, kind, defaultProbability: 10, position, archived });
const pipe = (id: string, isDefault: boolean, stages: ReturnType<typeof st>[]): PipelineDto => ({ id, name: id, kind: "lead", defaultCurrency: "USD", isDefault, position: 1, version: 1, archived: false, stages });
const main = pipe("p1", true, [st("s-lost", "Lost", "lost", 9), st("s2", "Qualified", "open", 2), st("s1", "New", "open", 1), st("s-won", "Won", "won", 8), st("s-old", "Old", "open", 0, true)]);
const lead = (stageId: string, stageName: string, stageKind: ContactLead["stageKind"]): ContactLead => ({ id: "l1", stageId, stageName, stageKind, valueMinor: null, currency: null, valueHidden: false, ownerId: null, version: 1, moreCount: 0 });

describe("one contact, one lead", () => {
  it("a contact without a lead shows the first open stage of the default pipeline, marked virtual", () => {
    expect(firstStageOf([main])?.name).toBe("New");
    expect(shownStage([main], null)).toMatchObject({ id: "s1", name: "New", virtual: true });
    expect(shownStage([], null)).toBeNull();
  });
  it("a lead shows its own stage", () => {
    expect(shownStage([main], lead("s-won", "Won", "won"))).toMatchObject({ id: "s-won", virtual: false });
  });
  it("stage choices are ordered open, won, lost and skip archived ones", () => {
    expect(stagesForContact([main], { lead: null }).map((s) => s.name)).toEqual(["New", "Qualified", "Won", "Lost"]);
  });
  it("old /leads links keep the filters that exist on Contacts", () => {
    expect(leadsQueryToContacts({ stage: "abc", q: "ann", status: "won", min: "5" })).toBe("stageId=abc&search=ann");
    expect(leadsQueryToContacts({})).toBe("");
  });
  it("the sidebar has no Leads entry and the phone bar no Leads tab", () => {
    expect(visibleNav("owner").flatMap((g) => g.items.map((i) => i.label))).toEqual(["Home", "Inbox", "Contacts", "Tasks", "Reports", "Settings"]);
    expect([...MOBILE_TABS]).not.toContain("leads");
  });
});
