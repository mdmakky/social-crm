import { describe, expect, it } from "vitest";
import type { PipelineDto } from "@crm/contracts";
import { listTotal, parseFilters, toCountsQuery, toListQuery, toSearch } from "@/lib/lead-filters";

const st = (id: string, kind: "open" | "won" | "lost", position: number) => ({ id, pipelineId: "", name: id, kind, defaultProbability: 10, position, archived: false });
const pipe = (id: string, isDefault: boolean): PipelineDto => ({ id, name: id, kind: "sales", defaultCurrency: "USD", isDefault, position: 0, version: 1, archived: false, stages: [st(`${id}-a`, "open", 0), st(`${id}-b`, "open", 1), st(`${id}-w`, "won", 2), st(`${id}-l`, "lost", 3)] });
const one = [pipe("p1", true)];
const two = [pipe("p1", true), pipe("p2", false)];
const sp = (s: string) => new URLSearchParams(s);

describe("lead filters in the URL", () => {
  it("round-trips and keeps a clean URL for defaults", () => {
    expect(toSearch(parseFilters(sp(""), two), two)).toBe("");
    for (const url of ["q=ann&stage=p1-b&owner=u1&source=manual&min=10&max=2000.5&active=30&sort=close&dir=asc", "pipeline=all&status=won", "pipeline=p2"]) {
      expect(sp(toSearch(parseFilters(sp(url), two), two)).toString()).toBe(sp(url).toString());
    }
  });
  it("defaults to the default pipeline when there are several, none when there is one, and a stage decides pipeline and status", () => {
    expect(parseFilters(sp(""), two)).toMatchObject({ pipeline: "p1", status: "open" });
    expect(parseFilters(sp(""), one)).toMatchObject({ pipeline: "" });
    expect(parseFilters(sp("pipeline=all"), two).pipeline).toBe("");
    expect(parseFilters(sp("stage=p2-w"), two)).toMatchObject({ pipeline: "p2", stage: "p2-w", status: "all" });
    expect(parseFilters(sp("stage=nope&status=bogus&active=5&min=abc"), two)).toMatchObject({ stage: "", status: "open", active: "", min: "" });
  });
  it("builds the list and counts queries; counts never carry stage, status or paging", () => {
    const f = parseFilters(sp("stage=p1-a&owner=u1&min=10&max=20&active=7&q=x"), one);
    expect(toListQuery(f, one, "cur")).toMatchObject({ stageId: "p1-a", ownerId: "u1", minValue: 1000, maxValue: 2000, activeWithinDays: "7", q: "x", cursor: "cur", limit: 50 });
    expect(toListQuery(f, one)).not.toHaveProperty("outcome"); // stage given: status is "all"
    expect(toCountsQuery(f, one)).toEqual({ pipelineId: "p1", q: "x", ownerId: "u1", minValue: 1000, maxValue: 2000, activeWithinDays: "7" });
  });
  it("derives the list total from per-stage counts", () => {
    const counts = [{ stageId: "p1-a", count: 5 }, { stageId: "p1-b", count: 3 }, { stageId: "p1-w", count: 2 }];
    expect(listTotal(counts, parseFilters(sp(""), one), one)).toBe(8);
    expect(listTotal(counts, parseFilters(sp("stage=p1-b"), one), one)).toBe(3);
    expect(listTotal(counts, parseFilters(sp("status=all"), one), one)).toBe(10);
    expect(listTotal(counts, parseFilters(sp("status=won"), one), one)).toBe(2);
  });
});
