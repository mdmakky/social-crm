/** Pure automation helpers: condition engine and retry policy. No I/O, no eval: a condition is data, evaluated by a fixed set of operators. */
export type Scalar = string | number | boolean | null;
export type Condition =
  | { op: "and" | "or"; conditions: Condition[] }
  | { op: "equals"; field: string; value: Scalar }
  | { op: "in"; field: string; values: Scalar[] }
  | { op: "contains"; field: string; value: string };

export const MAX_CONDITION_NODES = 20;
export const MAX_CONDITION_DEPTH = 4;

function lookup(ctx: unknown, path: string): unknown {
  let cur = ctx;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** An empty `and` is true (no restriction), an empty `or` is false. A missing field never matches. */
export function evaluateCondition(c: Condition, ctx: Record<string, unknown>): boolean {
  switch (c.op) {
    case "and": return c.conditions.every((x) => evaluateCondition(x, ctx));
    case "or": return c.conditions.some((x) => evaluateCondition(x, ctx));
    case "equals": return lookup(ctx, c.field) === c.value;
    case "in": { const v = lookup(ctx, c.field); return v !== undefined && c.values.includes(v as Scalar); }
    case "contains": {
      const v = lookup(ctx, c.field);
      if (typeof v === "string") return v.toLowerCase().includes(c.value.toLowerCase());
      return Array.isArray(v) && v.includes(c.value);
    }
  }
}

/** Counts nodes and depth, so callers can cap the size of a stored condition tree. */
export function conditionShape(c: Condition, depth = 1): { nodes: number; depth: number } {
  if (c.op !== "and" && c.op !== "or") return { nodes: 1, depth };
  return c.conditions.reduce((a, x) => { const s = conditionShape(x, depth + 1); return { nodes: a.nodes + s.nodes, depth: Math.max(a.depth, s.depth) }; }, { nodes: 1, depth });
}

export const MAX_RUN_ATTEMPTS = 3;
/** Delay before retry n (n = attempts already made): 30 s, 2 min, 8 min. */
export const retryDelayMs = (attemptsMade: number) => 30_000 * 4 ** (attemptsMade - 1);
