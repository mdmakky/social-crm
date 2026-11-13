import type { Context } from "hono";
import type { z } from "zod";
import type { Role } from "@crm/core/permissions";
import type { Vars } from "./workspaces.ts";

export type ScopedEnv = { Variables: Vars & { workspaceId: string; role: Role } };
export type SC = Context<ScopedEnv>;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const wctx = (c: SC) => ({ userId: c.get("userId"), workspaceId: c.get("workspaceId") });
export const actor = (c: SC) => ({ actorUserId: c.get("userId"), requestId: c.get("requestId"), ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() });

export type ErrStatus = 400 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503;
export const fail = (c: SC, status: ErrStatus, code: string, message?: string, details?: unknown) => c.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, status);
export const forbidden = (c: SC) => fail(c, 403, "forbidden", "You don't have permission to do that.");

/** Postgres cannot store U+0000 in text; reject it at the edge so it is a 400, not a 500 whose log line carries the row. */
export function hasNul(v: unknown): boolean {
  if (typeof v === "string") return v.includes("\u0000");
  if (Array.isArray(v)) return v.some(hasNul);
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => k.includes("\u0000") || hasNul(x));
  return false;
}
const NUL_MESSAGE = "Text cannot contain NUL characters.";

/** Validates a JSON body against its shared schema; on failure returns a ready 400 response. */
export async function body<S extends z.ZodType>(c: SC, schema: S): Promise<{ ok: true; data: z.output<S> } | { ok: false; res: Response }> {
  const raw = await c.req.json().catch(() => null);
  if (hasNul(raw)) return { ok: false, res: fail(c, 400, "invalid_body", NUL_MESSAGE) };
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, res: fail(c, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request") };
}
export function query<S extends z.ZodType>(c: SC, schema: S): { ok: true; data: z.output<S> } | { ok: false; res: Response } {
  if (hasNul(c.req.query())) return { ok: false, res: fail(c, 400, "invalid_query", NUL_MESSAGE) };
  const parsed = schema.safeParse(c.req.query());
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, res: fail(c, 400, "invalid_query", parsed.error.issues[0]?.message ?? "Invalid query") };
}
export const isUuid = (s: string | undefined): s is string => !!s && UUID.test(s);
