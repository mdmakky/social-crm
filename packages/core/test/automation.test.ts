import { describe, expect, it } from "vitest";
import { conditionShape, evaluateCondition as ev, retryDelayMs, type Condition } from "../src/automation.ts";

const ctx = { source: "manual", count: 3, flag: true, none: null, tags: ["vip", "eu"], name: "Acme Corp", nested: { stage: "won" } };

describe("condition engine", () => {
  it("equals is strict and handles null/boolean/number", () => {
    expect(ev({ op: "equals", field: "source", value: "manual" }, ctx)).toBe(true);
    expect(ev({ op: "equals", field: "count", value: "3" }, ctx)).toBe(false);
    expect(ev({ op: "equals", field: "flag", value: true }, ctx)).toBe(true);
    expect(ev({ op: "equals", field: "none", value: null }, ctx)).toBe(true);
  });
  it("a missing field never matches, not even null", () => {
    expect(ev({ op: "equals", field: "nope", value: null }, ctx)).toBe(false);
    expect(ev({ op: "in", field: "nope", values: [null] }, ctx)).toBe(false);
    expect(ev({ op: "contains", field: "nope", value: "x" }, ctx)).toBe(false);
  });
  it("in, contains (string is case-insensitive, array is exact) and dotted paths", () => {
    expect(ev({ op: "in", field: "source", values: ["import", "manual"] }, ctx)).toBe(true);
    expect(ev({ op: "in", field: "source", values: ["import"] }, ctx)).toBe(false);
    expect(ev({ op: "contains", field: "name", value: "ACME" }, ctx)).toBe(true);
    expect(ev({ op: "contains", field: "tags", value: "vip" }, ctx)).toBe(true);
    expect(ev({ op: "contains", field: "tags", value: "VI" }, ctx)).toBe(false);
    expect(ev({ op: "equals", field: "nested.stage", value: "won" }, ctx)).toBe(true);
  });
  it("and / or, empty and is true, empty or is false, nesting works", () => {
    const t: Condition = { op: "equals", field: "source", value: "manual" };
    const f: Condition = { op: "equals", field: "source", value: "x" };
    expect(ev({ op: "and", conditions: [] }, ctx)).toBe(true);
    expect(ev({ op: "or", conditions: [] }, ctx)).toBe(false);
    expect(ev({ op: "and", conditions: [t, f] }, ctx)).toBe(false);
    expect(ev({ op: "or", conditions: [f, { op: "and", conditions: [t, t] }] }, ctx)).toBe(true);
  });
  it("does not walk the prototype chain", () => {
    expect(ev({ op: "equals", field: "constructor.name", value: "Object" }, ctx)).toBe(false);
    expect(ev({ op: "contains", field: "__proto__", value: "x" }, ctx)).toBe(false);
  });
  it("shape counts nodes and depth", () => {
    expect(conditionShape({ op: "and", conditions: [{ op: "equals", field: "a", value: 1 }, { op: "or", conditions: [{ op: "equals", field: "b", value: 1 }] }] })).toEqual({ nodes: 4, depth: 3 });
  });
});

describe("retry policy", () => {
  it("backs off 30 s, 2 min, 8 min", () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([30_000, 120_000, 480_000]);
  });
});
