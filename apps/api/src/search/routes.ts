import { Hono } from "hono";
import { withContext, type Db } from "@crm/db";
import { SearchQuery, type SearchGroup } from "@crm/contracts";
import { query, wctx, type ScopedEnv } from "../routes/scope.ts";
import { defaultProviders } from "./registry.ts";
import type { SearchProvider } from "./types.ts";

const DEFAULT_LIMIT = 5;

export function searchRoutes(db: Db, extra: SearchProvider[] = []) {
  const providers = [...defaultProviders, ...extra];
  const r = new Hono<ScopedEnv>();
  r.get("/search", async (c) => {
    const q = query(c, SearchQuery);
    if (!q.ok) return q.res;
    const role = c.get("role");
    const wanted = q.data.types ? new Set(q.data.types.split(",").map((t) => t.trim())) : null;
    const active = providers.filter((p) => p.requires(role) && (!wanted || wanted.has(p.type)));
    const ctx = { ...wctx(c), role };
    const limit = q.data.limit ?? DEFAULT_LIMIT;
    const groups: SearchGroup[] = await withContext(db, wctx(c), async (tx) => {
      const out: SearchGroup[] = [];
      for (const p of active) out.push({ type: p.type, label: p.label, hits: await p.search(tx, ctx, q.data.q, limit) });
      return out;
    });
    return c.json({ groups });
  });
  return r;
}
