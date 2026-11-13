import { describe, expect, it } from "vitest";
import { canEditTask, dayBounds, dueState } from "../src/tasks.ts";

const iso = (d: Date) => d.toISOString();

describe("dayBounds", () => {
  it("UTC day", () => {
    const b = dayBounds(new Date("2026-03-15T12:00:00Z"), "UTC");
    expect([iso(b.start), iso(b.end)]).toEqual(["2026-03-15T00:00:00.000Z", "2026-03-16T00:00:00.000Z"]);
  });
  it("Pacific/Auckland is UTC+13 on 15 March 2026", () => {
    const b = dayBounds(new Date("2026-03-15T12:00:00Z"), "Pacific/Auckland");
    expect([iso(b.start), iso(b.end)]).toEqual(["2026-03-15T11:00:00.000Z", "2026-03-16T11:00:00.000Z"]);
  });
  it("America/New_York is UTC-4 after the 8 March DST change", () => {
    const b = dayBounds(new Date("2026-03-15T12:00:00Z"), "America/New_York");
    expect([iso(b.start), iso(b.end)]).toEqual(["2026-03-15T04:00:00.000Z", "2026-03-16T04:00:00.000Z"]);
  });
  it("the spring-forward day is 23 hours long", () => {
    const b = dayBounds(new Date("2026-03-08T15:00:00Z"), "America/New_York");
    expect([iso(b.start), iso(b.end)]).toEqual(["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
  });
  it("the fall-back day is 25 hours long", () => {
    const b = dayBounds(new Date("2026-11-01T15:00:00Z"), "America/New_York");
    expect([iso(b.start), iso(b.end)]).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  });
  it("the instant just before midnight stays in the old day", () => {
    const b = dayBounds(new Date("2026-03-15T23:59:59.999Z"), "UTC");
    expect(iso(b.start)).toBe("2026-03-15T00:00:00.000Z");
  });
});

describe("dueState", () => {
  const now = new Date("2026-03-15T12:00:00Z");
  const st = (status: string, dueAt: string | null, tz?: string) => dueState({ status, dueAt }, now, tz);
  it("closed tasks are never overdue", () => {
    expect(st("done", "2026-01-01T00:00:00Z")).toBe("closed");
    expect(st("cancelled", "2026-01-01T00:00:00Z")).toBe("closed");
  });
  it("no date", () => expect(st("open", null)).toBe("none"));
  it("strictly before now is overdue, exactly now is today", () => {
    expect(st("open", "2026-03-15T11:59:59Z")).toBe("overdue");
    expect(st("in_progress", "2026-03-15T12:00:00Z")).toBe("today");
  });
  it("later today vs tomorrow, per time zone", () => {
    expect(st("open", "2026-03-15T23:59:59Z")).toBe("today");
    expect(st("open", "2026-03-16T00:00:00Z")).toBe("upcoming");
    expect(st("open", "2026-03-16T00:00:00Z", "America/New_York")).toBe("today");
  });
});

describe("canEditTask", () => {
  const t = { assignee: { id: "u1" }, createdBy: { id: "u2" } };
  it("owner and admin always; viewer never", () => {
    expect(canEditTask("owner", "x", t)).toBe(true);
    expect(canEditTask("admin", "x", t)).toBe(true);
    expect(canEditTask("viewer", "u1", t)).toBe(false);
  });
  it("an agent edits only tasks assigned to or created by them", () => {
    expect(canEditTask("agent", "u1", t)).toBe(true);
    expect(canEditTask("agent", "u2", t)).toBe(true);
    expect(canEditTask("agent", "u3", t)).toBe(false);
    expect(canEditTask("agent", "u3", { assignee: null, createdBy: null })).toBe(false);
  });
});
