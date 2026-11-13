import { Hono } from "hono";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ImportPlanBody, IMPORT_FIELDS, UploadImportBody, type ImportPreview } from "@crm/contracts";
import { buildContactFromRow, contactKeys, ImportError, normalizeEmail, normalizePhone, parseCsv, suggestMapping, validateCustomValues, type ImportContext, type ImportField, type ImportedContact } from "@crm/core";
import { can } from "@crm/core/permissions";
import { schema, user, withContext, type Db, type Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { activeStages, customDefs, recordActivity, toFieldDef } from "../crm-service.ts";
import { actor, body, fail, forbidden, isUuid, wctx, type SC, type ScopedEnv } from "./scope.ts";

export type ImportHooks = { afterRow?: (row: number) => void | Promise<void> };

const LABELS: Record<string, string> = { name: "Full name", first_name: "First name", last_name: "Last name", email: "Email", phone: "Phone", company: "Company", source: "Source", lifecycle_stage: "Lifecycle stage", owner_email: "Owner email", tags: "Tags" };

type Decision = "skip" | "update" | "create";
type PlanRow = { row: number; contact: ImportedContact; dup: { kind: "existing"; id: string; name: string; matchedOn: string } | { kind: "file"; ofRow: number; matchedOn: string } | null; action: Decision };
type Plan = { total: number; invalid: { row: number; messages: string[] }[]; rows: PlanRow[]; ctx: ImportContext };

async function buildPlan(tx: Tx, workspaceId: string, csv: string, input: ReturnType<typeof ImportPlanBody.parse>): Promise<Plan | { error: string }> {
  const parsed = parseCsv(csv);
  const defs = (await customDefs(tx, workspaceId)).map(toFieldDef);
  const defKeys = new Set(defs.map((d) => d.key));
  const mapping = parsed.headers.map((_, i) => (input.mapping[i] ?? null) as ImportField | null);
  const chosen = mapping.filter((m): m is ImportField => !!m);
  if (new Set(chosen).size !== chosen.length) return { error: "Each field can be mapped to only one column." };
  const unknown = chosen.find((m) => m.startsWith("custom:") && !defKeys.has(m.slice(7)));
  if (unknown) return { error: `The custom field "${unknown.slice(7)}" does not exist or is archived.` };
  if (!chosen.some((m) => ["name", "first_name", "last_name", "email", "phone"].includes(m))) return { error: "Map at least a name, email or phone column." };

  const stages = await activeStages(tx, workspaceId);
  if (!stages.length) return { error: "The workspace has no active lifecycle stage." };
  const members = await tx.select({ userId: schema.memberships.userId, email: user.email }).from(schema.memberships).innerJoin(user, eq(user.id, schema.memberships.userId)).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.status, "active")));
  const ctx: ImportContext = { stages: stages.map((s) => ({ id: s.id, name: s.name })), defaultStageId: stages[0]!.id, members, customDefs: defs };

  const built = parsed.rows.map((r, i) => ({ row: i + 1, res: buildContactFromRow(r, mapping, ctx) }));
  const invalid = built.flatMap((b) => (b.res.ok ? [] : [{ row: b.row, messages: b.res.errors.map((e) => e.message) }]));
  const valid = built.flatMap((b) => (b.res.ok ? [{ row: b.row, contact: b.res.contact }] : []));

  const emails = Array.from(new Set(valid.map((v) => normalizeEmail(v.contact.email)).filter((x): x is string => !!x)));
  const phones = Array.from(new Set(valid.map((v) => normalizePhone(v.contact.phone)).filter((x): x is string => !!x)));
  const existing = emails.length || phones.length
    ? await tx.select({ id: schema.contacts.id, name: schema.contacts.name, e: schema.contacts.emailNormalized, p: schema.contacts.phoneNormalized }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), isNull(schema.contacts.deletedAt), sql`(${emails.length ? inArray(schema.contacts.emailNormalized, emails) : sql`false`} OR ${phones.length ? inArray(schema.contacts.phoneNormalized, phones) : sql`false`})`))
    : [];
  const existingBy = new Map<string, { id: string; name: string }>();
  for (const e of existing) { if (e.e) existingBy.set(`email:${e.e}`, e); if (e.p) existingBy.set(`phone:${e.p}`, e); }

  const seen = new Map<string, number>();
  const rows: PlanRow[] = valid.map(({ row, contact }) => {
    const keys = contactKeys(contact);
    const ex = keys.find((k) => existingBy.has(k));
    const inFile = keys.find((k) => seen.has(k));
    for (const k of keys) if (!seen.has(k)) seen.set(k, row);
    const dup: PlanRow["dup"] = ex ? { kind: "existing", id: existingBy.get(ex)!.id, name: existingBy.get(ex)!.name, matchedOn: ex.split(":")[0]! } : inFile ? { kind: "file", ofRow: seen.get(inFile)!, matchedOn: inFile.split(":")[0]! } : null;
    return { row, contact, dup, action: dup ? input.rowDecisions?.[String(row)] ?? input.onDuplicate : "create" };
  });
  return { total: parsed.rows.length, invalid, rows, ctx };
}

export function importRoutes(db: Db, hooks: ImportHooks = {}) {
  const r = new Hono<ScopedEnv>();

  r.post("/imports", async (c) => {
    if (!can(c.get("role"), "data.import", {})) return forbidden(c);
    const b = await body(c, UploadImportBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    let parsed;
    try { parsed = parseCsv(b.data.csv); } catch (e) { return fail(c, 400, "invalid_file", e instanceof ImportError ? e.message : "The file could not be read."); }
    return withContext(db, wctx(c), async (tx) => {
      const defs = (await customDefs(tx, workspaceId)).map(toFieldDef);
      const [job] = await tx.insert(schema.importJobs).values({ workspaceId, filename: b.data.filename, csv: b.data.csv, createdBy: userId }).returning();
      return c.json({
        id: job!.id,
        headers: parsed.headers,
        rowCount: parsed.rows.length,
        sample: parsed.rows.slice(0, 5),
        suggestedMapping: suggestMapping(parsed.headers, defs),
        fields: [...IMPORT_FIELDS.map((id) => ({ id: id as string, label: LABELS[id]! })), ...defs.map((d) => ({ id: `custom:${d.key}`, label: d.label }))],
      }, 201);
    });
  });

  const loadJob = async (c: SC, tx: Tx, lock: boolean) => {
    const id = c.req.param("importId");
    if (!isUuid(id)) return null;
    const rows = (await tx.execute(sql`SELECT id, filename, csv, status FROM import_jobs WHERE workspace_id = ${c.get("workspaceId")} AND id = ${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}`)).rows as { id: string; filename: string; csv: string; status: string }[];
    return rows[0] ?? null;
  };

  r.post("/imports/:importId/preview", async (c) => {
    if (!can(c.get("role"), "data.import", {})) return forbidden(c);
    const b = await body(c, ImportPlanBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const job = await loadJob(c, tx, false);
      if (!job) return fail(c, 404, "not_found");
      if (job.status !== "uploaded") return fail(c, 409, "already_committed", "This import has already been completed.");
      const plan = await buildPlan(tx, workspaceId, job.csv, b.data);
      if ("error" in plan) return fail(c, 400, "invalid_mapping", plan.error);
      const dups = plan.rows.filter((x) => x.dup);
      const preview: ImportPreview = {
        total: plan.total,
        valid: plan.rows.length,
        invalid: plan.invalid.length,
        willCreate: plan.rows.filter((x) => x.action === "create").length,
        willUpdate: plan.rows.filter((x) => x.action === "update").length,
        willSkip: plan.rows.filter((x) => x.action === "skip").length,
        errors: plan.invalid.slice(0, 100),
        duplicates: dups.slice(0, 100).map((x) => ({ row: x.row, matchedOn: x.dup!.matchedOn, existing: x.dup!.kind === "existing" ? { id: x.dup!.id, name: x.dup!.name } : null, duplicateOfRow: x.dup!.kind === "file" ? x.dup!.ofRow : null, action: x.action })),
        truncated: plan.invalid.length > 100 || dups.length > 100,
      };
      return c.json(preview);
    });
  });

  r.post("/imports/:importId/commit", async (c) => {
    if (!can(c.get("role"), "data.import", {})) return forbidden(c);
    const b = await body(c, ImportPlanBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    try {
      // One transaction: any failure rolls back every row, so an import is all or nothing.
      return await withContext(db, wctx(c), async (tx) => {
        const job = await loadJob(c, tx, true);
        if (!job) return fail(c, 404, "not_found");
        if (job.status !== "uploaded") return fail(c, 409, "already_committed", "This import has already been completed.");
        const plan = await buildPlan(tx, workspaceId, job.csv, b.data);
        if ("error" in plan) return fail(c, 400, "invalid_mapping", plan.error);
        if (plan.invalid.length && !b.data.skipInvalid) return fail(c, 400, "invalid_rows", `${plan.invalid.length} row${plan.invalid.length === 1 ? " has" : "s have"} problems. Fix the file, or choose to skip invalid rows.`);

        const tagRows = await tx.select().from(schema.tags).where(eq(schema.tags.workspaceId, workspaceId));
        const tagIds = new Map(tagRows.map((t) => [t.name.toLowerCase(), t.id]));
        const tagId = async (name: string) => {
          const k = name.toLowerCase();
          if (!tagIds.has(k)) tagIds.set(k, (await tx.insert(schema.tags).values({ workspaceId, name }).returning())[0]!.id);
          return tagIds.get(k)!;
        };
        const attachTags = async (contactId: string, names: string[]) => { for (const n of names) await tx.insert(schema.contactTags).values({ workspaceId, contactId, tagId: await tagId(n) }).onConflictDoNothing(); };

        const createdByKey = new Map<string, string>();
        let created = 0, updated = 0, skipped = 0;
        for (const pr of plan.rows) {
          const keys = contactKeys(pr.contact);
          let target: string | null = null;
          if (pr.dup?.kind === "existing") target = pr.dup.id;
          else if (pr.dup?.kind === "file") target = keys.map((k) => createdByKey.get(k)).find(Boolean) ?? null;

          if (pr.action === "skip") skipped++;
          else if (pr.action === "update" && target) {
            const [cur] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.id, target)));
            const k = pr.contact;
            const merged = { ...((cur!.custom as Record<string, unknown>) ?? {}), ...k.custom };
            const check = validateCustomValues(plan.ctx.customDefs, Object.fromEntries(Object.entries(merged).filter(([key]) => plan.ctx.customDefs.some((d) => d.key === key))));
            await tx.update(schema.contacts).set({
              name: k.name || cur!.name, company: k.company ?? cur!.company,
              email: k.email ?? cur!.email, emailNormalized: k.email ? normalizeEmail(k.email) : cur!.emailNormalized,
              phone: k.phone ?? cur!.phone, phoneNormalized: k.phone ? normalizePhone(k.phone) : cur!.phoneNormalized,
              ownerUserId: k.ownerUserId ?? cur!.ownerUserId, custom: check.ok ? { ...merged, ...check.values } : cur!.custom,
              version: sql`${schema.contacts.version} + 1`, updatedAt: new Date(),
            }).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.id, target)));
            await attachTags(target, k.tags);
            await recordActivity(tx, { workspaceId, contactId: target, kind: "contact.updated", actorUserId: userId, data: { via: "import", importId: job.id, fields: ["from import"] } });
            updated++;
          } else {
            const k = pr.contact;
            const [row] = await tx.insert(schema.contacts).values({ workspaceId, name: k.name, email: k.email, emailNormalized: normalizeEmail(k.email), phone: k.phone, phoneNormalized: normalizePhone(k.phone), company: k.company, ownerUserId: k.ownerUserId, lifecycleStageId: k.lifecycleStageId, source: k.source, custom: k.custom, createdBy: userId, lastActivityAt: new Date() }).returning();
            await attachTags(row!.id, k.tags);
            await recordActivity(tx, { workspaceId, contactId: row!.id, kind: "contact.imported", actorUserId: userId, data: { importId: job.id, filename: job.filename, row: pr.row } });
            for (const key of keys) createdByKey.set(key, row!.id);
            created++;
          }
          await hooks.afterRow?.(pr.row);
        }
        await tx.update(schema.importJobs).set({ status: "committed", committedAt: new Date(), summary: { created, updated, skipped, invalid: plan.invalid.length } }).where(and(eq(schema.importJobs.workspaceId, workspaceId), eq(schema.importJobs.id, job.id)));
        await writeAudit(tx, { ...actor(c), workspaceId, action: "data.imported", entityType: "import", entityId: job.id, summary: { filename: job.filename, created, updated, skipped } });
        return c.json({ importId: job.id, created, updated, skipped });
      });
    } catch (e) {
      console.error("import failed and was rolled back", e instanceof Error ? e.message : e);
      return fail(c, 500, "import_failed", "The import failed and nothing was changed. Try again.");
    }
  });

  return r;
}
