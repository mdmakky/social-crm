import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ImportPlanBody, IMPORT_FIELDS, UploadImportBody, type ImportPreview } from "@crm/contracts";
import { buildContactFromRow, contactKeys, ImportError, normalizeEmail, normalizePhone, parseCsv, suggestMapping, type ImportContext, type ImportField, type ImportedContact } from "@crm/core";
import { can } from "@crm/core/permissions";
import { schema, user, withContext, type Db, type Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { activeStages, customDefs, toFieldDef } from "../crm-service.ts";
import { WindowCounter } from "../throttle.ts";
import { actor, body, fail, forbidden, isUuid, wctx, type SC, type ScopedEnv } from "./scope.ts";

export type ImportLimits = {
  /** uploads per user per window */ uploadsPerUser: number;
  /** previews per user per window */ previewsPerUser: number;
  /** commits per workspace per window */ commitsPerWorkspace: number;
  /** open (uploaded, not committed) jobs kept per workspace; older ones are discarded on upload */ maxOpenJobs: number;
  windowMs: number;
};
export type ImportHooks = { afterRow?: (row: number) => void | Promise<void>; limits?: Partial<ImportLimits> };

const DEFAULT_LIMITS: ImportLimits = { uploadsPerUser: 20, previewsPerUser: 300, commitsPerWorkspace: 10, maxOpenJobs: 5, windowMs: 10 * 60_000 };
const UPLOAD_BODY_MAX = 6 * 1024 * 1024; // 5 MB of CSV plus JSON escaping overhead; enforced on the stream before buffering
const PLAN_BODY_MAX = 256 * 1024;
const STALE_JOB_HOURS = 24;
const CHUNK = 500;

const LABELS: Record<string, string> = { name: "Full name", first_name: "First name", last_name: "Last name", email: "Email", phone: "Phone", company: "Company", source: "Source", lifecycle_stage: "Lifecycle stage", owner_email: "Owner email", tags: "Tags" };

const chunks = <T>(a: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

/** Logs what is needed to find the problem and nothing a row could carry: drizzle error messages include bound parameters (contact data). */
function logImportFailure(c: SC, e: unknown) {
  const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause ?? (e as { code?: string; constraint?: string } | null) ?? {};
  console.error(JSON.stringify({ msg: "import failed and was rolled back", requestId: c.get("requestId"), error: e instanceof Error ? e.name : typeof e, code: cause.code, constraint: cause.constraint }));
}
const pgCode = (e: unknown): string | undefined => (e as { cause?: { code?: string }; code?: string } | null)?.cause?.code ?? (e as { code?: string } | null)?.code;

type Ref = string; // "e:<existing contact id>" or "r:<row that creates it>"
type Dup = { kind: "existing"; id: string; name: string; matchedOn: string } | { kind: "file"; ofRow: number; matchedOn: string } | null;
type Eff = { kind: "create" } | { kind: "skip" } | { kind: "update"; target: Ref };
type PlanRow = { row: number; contact: ImportedContact; dup: Dup; action: Eff["kind"]; eff: Eff };
type Plan = { total: number; invalid: { row: number; messages: string[] }[]; rows: PlanRow[]; warnings: { row: number; message: string }[]; ctx: ImportContext };

/**
 * Reads the job, then works out what each row will really do. Preview and commit both use this, so the preview is exactly the commit.
 * An "update" with nothing to update (earlier matching row was skipped, or the row matches two different contacts) becomes a skip with a warning,
 * never a silent create.
 */
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
  const existing: { id: string; name: string; e: string | null; p: string | null }[] = [];
  // Chunked: a 5000-row file can carry 10000 keys and a single IN list that large is slow to plan.
  for (const [em, ph] of [...chunks(emails, 1000).map((e) => [e, []] as [string[], string[]]), ...chunks(phones, 1000).map((p) => [[], p] as [string[], string[]])]) {
    existing.push(...(await tx.select({ id: schema.contacts.id, name: schema.contacts.name, e: schema.contacts.emailNormalized, p: schema.contacts.phoneNormalized }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), isNull(schema.contacts.deletedAt), em.length ? inArray(schema.contacts.emailNormalized, em) : inArray(schema.contacts.phoneNormalized, ph)))));
  }
  const existingBy = new Map<string, { id: string; name: string }>();
  for (const e of existing) { if (e.e) existingBy.set(`email:${e.e}`, e); if (e.p) existingBy.set(`phone:${e.p}`, e); }

  const seen = new Map<string, number>(); // key -> first row carrying it (duplicate detection)
  const refByKey = new Map<string, Ref>(); // key -> contact a later row would update (only rows that create or update register here)
  const warnings: Plan["warnings"] = [];
  const rows: PlanRow[] = valid.map(({ row, contact }) => {
    const keys = contactKeys(contact);
    const exKey = keys.find((k) => existingBy.has(k));
    const fileKey = keys.find((k) => seen.has(k));
    for (const k of keys) if (!seen.has(k)) seen.set(k, row);
    const dup: Dup = exKey ? { kind: "existing", id: existingBy.get(exKey)!.id, name: existingBy.get(exKey)!.name, matchedOn: exKey.split(":")[0]! } : fileKey ? { kind: "file", ofRow: seen.get(fileKey)!, matchedOn: fileKey.split(":")[0]! } : null;
    const wanted = dup ? input.rowDecisions?.[String(row)] ?? input.onDuplicate : "create";

    let eff: Eff;
    if (wanted === "skip") eff = { kind: "skip" };
    else if (wanted === "create") eff = { kind: "create" };
    else if (dup?.kind === "existing") {
      const ids = new Set(keys.filter((k) => existingBy.has(k)).map((k) => existingBy.get(k)!.id));
      if (ids.size > 1) { eff = { kind: "skip" }; warnings.push({ row, message: "Skipped: this row matches two different existing contacts (one by email, one by phone), so it cannot be merged safely." }); }
      else eff = { kind: "update", target: `e:${dup.id}` };
    } else {
      const ref = keys.map((k) => refByKey.get(k)).find(Boolean);
      if (ref) eff = { kind: "update", target: ref };
      else { eff = { kind: "skip" }; warnings.push({ row, message: "Skipped: the earlier row with the same email or phone was skipped, so there is no contact to update." }); }
    }
    if (eff.kind !== "skip") {
      const ref = eff.kind === "create" ? `r:${row}` : eff.target;
      for (const k of keys) if (!refByKey.has(k)) refByKey.set(k, ref);
    }
    return { row, contact, dup, action: eff.kind, eff };
  });
  return { total: parsed.rows.length, invalid, rows, warnings, ctx };
}

type Values = { name: string; email: string | null; emailNormalized: string | null; phone: string | null; phoneNormalized: string | null; company: string | null; ownerUserId: string | null; lifecycleStageId: string; source: string; custom: Record<string, unknown> };
type Draft = { id: string | null; values: Values; tags: Set<string>; touched: boolean };

const fromImported = (k: ImportedContact): Values => ({ name: k.name, email: k.email, emailNormalized: normalizeEmail(k.email), phone: k.phone, phoneNormalized: normalizePhone(k.phone), company: k.company, ownerUserId: k.ownerUserId, lifecycleStageId: k.lifecycleStageId, source: k.source, custom: k.custom });

/** Fields the file provides replace the stored ones; fields it leaves empty keep the stored value. A name taken from the email or phone never replaces a real name. */
function merge(v: Values, k: ImportedContact): Values {
  return {
    ...v,
    name: k.nameDerived || !k.name ? v.name : k.name,
    company: k.company ?? v.company,
    email: k.email ?? v.email, emailNormalized: k.email ? normalizeEmail(k.email) : v.emailNormalized,
    phone: k.phone ?? v.phone, phoneNormalized: k.phone ? normalizePhone(k.phone) : v.phoneNormalized,
    ownerUserId: k.ownerUserId ?? v.ownerUserId,
    custom: { ...v.custom, ...k.custom },
  };
}

export function importRoutes(db: Db, hooks: ImportHooks = {}) {
  const r = new Hono<ScopedEnv>();
  const lim: ImportLimits = { ...DEFAULT_LIMITS, ...hooks.limits };
  const uploads = new WindowCounter(lim.uploadsPerUser, lim.windowMs);
  const previews = new WindowCounter(lim.previewsPerUser, lim.windowMs);
  const commits = new WindowCounter(lim.commitsPerWorkspace, lim.windowMs);
  const tooLarge = (c: SC) => fail(c, 413, "too_large", "The request is too large.");
  const limited = (c: SC) => { c.header("Retry-After", String(Math.ceil(lim.windowMs / 1000))); return fail(c, 429, "rate_limited", "Too many imports in a short time. Try again in a few minutes."); };

  r.post("/imports", bodyLimit({ maxSize: UPLOAD_BODY_MAX, onError: (c) => tooLarge(c as SC) }), async (c) => {
    if (!can(c.get("role"), "data.import", {})) return forbidden(c);
    const { workspaceId, userId } = wctx(c);
    if (!uploads.allow(`${workspaceId}:${userId}`)) return limited(c);
    const b = await body(c, UploadImportBody);
    if (!b.ok) return b.res;
    if (b.data.filename.includes("\u0000")) return fail(c, 400, "invalid_body", "The file name contains invalid characters.");
    let parsed;
    try { parsed = parseCsv(b.data.csv); } catch (e) { return fail(c, 400, "invalid_file", e instanceof ImportError ? e.message : "The file could not be read."); }
    return withContext(db, wctx(c), async (tx) => {
      // Storage hygiene: abandoned uploads hold full contact data. Drop anything older than a day, and keep only the newest few open jobs.
      await tx.execute(sql`UPDATE import_jobs SET csv = '', status = 'failed', summary = '{"expired":true}'::jsonb WHERE workspace_id = ${workspaceId} AND status = 'uploaded' AND csv <> '' AND (created_at < now() - make_interval(hours => ${STALE_JOB_HOURS}) OR id IN (SELECT id FROM import_jobs WHERE workspace_id = ${workspaceId} AND status = 'uploaded' ORDER BY created_at DESC, id DESC OFFSET ${Math.max(0, lim.maxOpenJobs - 1)}))`);
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
  const notOpen = (c: SC, status: string) => status === "failed"
    ? fail(c, 409, "import_expired", "This upload expired. Upload the file again.")
    : fail(c, 409, "already_committed", "This import has already been completed.");

  r.post("/imports/:importId/preview", bodyLimit({ maxSize: PLAN_BODY_MAX, onError: (c) => tooLarge(c as SC) }), async (c) => {
    if (!can(c.get("role"), "data.import", {})) return forbidden(c);
    const { workspaceId, userId } = wctx(c);
    if (!previews.allow(`${workspaceId}:${userId}`)) return limited(c);
    const b = await body(c, ImportPlanBody);
    if (!b.ok) return b.res;
    try {
      return await withContext(db, wctx(c), async (tx) => {
        const job = await loadJob(c, tx, false);
        if (!job) return fail(c, 404, "not_found");
        if (job.status !== "uploaded") return notOpen(c, job.status);
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
          warnings: plan.warnings.slice(0, 100),
          truncated: plan.invalid.length > 100 || dups.length > 100 || plan.warnings.length > 100,
        };
        return c.json(preview);
      });
    } catch (e) {
      if (e instanceof ImportError) return fail(c, 400, "invalid_file", e.message);
      logImportFailure(c, e);
      return fail(c, 500, "preview_failed", "The preview could not be built. Try again.");
    }
  });

  r.post("/imports/:importId/commit", bodyLimit({ maxSize: PLAN_BODY_MAX, onError: (c) => tooLarge(c as SC) }), async (c) => {
    if (!can(c.get("role"), "data.import", {})) return forbidden(c);
    const { workspaceId, userId } = wctx(c);
    if (!commits.allow(workspaceId)) return limited(c);
    const b = await body(c, ImportPlanBody);
    if (!b.ok) return b.res;
    try {
      // One transaction: any failure rolls back every row, so an import is all or nothing.
      return await withContext(db, wctx(c), async (tx) => {
        const job = await loadJob(c, tx, true);
        if (!job) return fail(c, 404, "not_found");
        if (job.status !== "uploaded") return notOpen(c, job.status);
        // Serialise duplicate decisions per workspace: a second import waits, then sees this one's contacts as existing duplicates.
        await tx.execute(sql`SET LOCAL lock_timeout = '60s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`contacts-write:${workspaceId}`}, 0))`);
        const plan = await buildPlan(tx, workspaceId, job.csv, b.data);
        if ("error" in plan) return fail(c, 400, "invalid_mapping", plan.error);
        if (plan.invalid.length && !b.data.skipInvalid) return fail(c, 400, "invalid_rows", `${plan.invalid.length} row${plan.invalid.length === 1 ? " has" : "s have"} problems. Fix the file, or choose to skip invalid rows.`);

        // 1. Work out the final state of every contact in memory, in row order.
        const drafts = new Map<Ref, Draft>();
        const targetIds = plan.rows.flatMap((p) => (p.eff.kind === "update" && p.eff.target.startsWith("e:") ? [p.eff.target.slice(2)] : []));
        for (const ids of chunks(Array.from(new Set(targetIds)), 1000)) {
          for (const cur of await tx.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), isNull(schema.contacts.deletedAt), inArray(schema.contacts.id, ids)))) {
            drafts.set(`e:${cur.id}`, { id: cur.id, tags: new Set(), touched: false, values: { name: cur.name, email: cur.email, emailNormalized: cur.emailNormalized, phone: cur.phone, phoneNormalized: cur.phoneNormalized, company: cur.company, ownerUserId: cur.ownerUserId, lifecycleStageId: cur.lifecycleStageId, source: cur.source, custom: (cur.custom as Record<string, unknown>) ?? {} } });
          }
        }
        let created = 0, updated = 0, skipped = 0;
        const updateRows: { ref: Ref; row: number }[] = [];
        const createRows: { ref: Ref; row: number }[] = [];
        for (const pr of plan.rows) {
          if (pr.eff.kind === "skip") { skipped++; continue; }
          if (pr.eff.kind === "create") {
            const ref: Ref = `r:${pr.row}`;
            drafts.set(ref, { id: null, values: fromImported(pr.contact), tags: new Set(pr.contact.tags), touched: true });
            createRows.push({ ref, row: pr.row });
            created++;
            continue;
          }
          const d = drafts.get(pr.eff.target);
          if (!d) { skipped++; continue; } // target was deleted between planning and now (cannot happen under the lock, but never create by accident)
          d.values = merge(d.values, pr.contact);
          for (const t of pr.contact.tags) d.tags.add(t);
          d.touched = true;
          updateRows.push({ ref: pr.eff.target, row: pr.row });
          updated++;
        }

        // 2. Write in batches.
        const now = new Date();
        for (const part of chunks(createRows, CHUNK)) {
          const out = await tx.insert(schema.contacts).values(part.map(({ ref }) => ({ workspaceId, ...drafts.get(ref)!.values, createdBy: userId, lastActivityAt: now }))).returning({ id: schema.contacts.id });
          if (out.length !== part.length) throw new Error("insert returned an unexpected row count");
          part.forEach((p, i) => { drafts.get(p.ref)!.id = out[i]!.id; });
        }
        // One UPDATE per 500 contacts instead of one per contact (5,000 updates took 18 s row by row on an idle host).
        const touched = [...new Set(updateRows.map((u) => u.ref))].map((ref) => drafts.get(ref)!);
        for (const part of chunks(touched, CHUNK)) {
          const vals = sql.join(part.map((d) => { const v = d.values; return sql`(${d.id}::uuid, ${v.name}, ${v.email}, ${v.emailNormalized}, ${v.phone}, ${v.phoneNormalized}, ${v.company}, ${v.ownerUserId}, ${JSON.stringify(v.custom)}::jsonb)`; }), sql`, `);
          await tx.execute(sql`UPDATE contacts AS c SET name = v.name, email = v.email, email_normalized = v.email_normalized, phone = v.phone, phone_normalized = v.phone_normalized, company = v.company, owner_user_id = v.owner_user_id, custom = v.custom, version = c.version + 1, updated_at = ${now}, last_activity_at = ${now}
            FROM (VALUES ${vals}) AS v(id, name, email, email_normalized, phone, phone_normalized, company, owner_user_id, custom)
            WHERE c.workspace_id = ${workspaceId}::uuid AND c.id = v.id`);
        }

        const activities = [
          ...createRows.map(({ ref, row }) => ({ workspaceId, contactId: drafts.get(ref)!.id!, kind: "contact.imported", actorUserId: userId, actorType: "user", data: { importId: job.id, filename: job.filename, row } })),
          ...updateRows.map(({ ref, row }) => ({ workspaceId, contactId: drafts.get(ref)!.id!, kind: "contact.updated", actorUserId: userId, actorType: "user", data: { via: "import", importId: job.id, row } })),
        ];
        for (const part of chunks(activities, 1000)) await tx.insert(schema.activities).values(part);

        const wantedTags = new Map<string, string>(); // lowercase -> first spelling in the file
        for (const d of drafts.values()) for (const t of d.tags) if (!wantedTags.has(t.toLowerCase())) wantedTags.set(t.toLowerCase(), t);
        if (wantedTags.size) {
          const have = new Map((await tx.select().from(schema.tags).where(eq(schema.tags.workspaceId, workspaceId))).map((t) => [t.name.toLowerCase(), t.id]));
          const missing = [...wantedTags].filter(([k]) => !have.has(k));
          for (const part of chunks(missing, CHUNK)) for (const t of await tx.insert(schema.tags).values(part.map(([, name]) => ({ workspaceId, name }))).returning()) have.set(t.name.toLowerCase(), t.id);
          const links = [...drafts.values()].flatMap((d) => (d.touched ? [...d.tags].map((t) => ({ workspaceId, contactId: d.id!, tagId: have.get(t.toLowerCase())! })) : []));
          for (const part of chunks(links, 2000)) await tx.insert(schema.contactTags).values(part).onConflictDoNothing();
        }

        for (const pr of plan.rows) await hooks.afterRow?.(pr.row);
        // The raw file holds every contact's details; once committed it is no longer needed.
        await tx.update(schema.importJobs).set({ status: "committed", committedAt: now, csv: "", summary: { created, updated, skipped, invalid: plan.invalid.length, warnings: plan.warnings.length } }).where(and(eq(schema.importJobs.workspaceId, workspaceId), eq(schema.importJobs.id, job.id)));
        await writeAudit(tx, { ...actor(c), workspaceId, action: "data.imported", entityType: "import", entityId: job.id, summary: { filename: job.filename, created, updated, skipped } });
        return c.json({ importId: job.id, created, updated, skipped });
      });
    } catch (e) {
      if (e instanceof ImportError) return fail(c, 400, "invalid_file", e.message);
      if (pgCode(e) === "55P03") return fail(c, 409, "import_busy", "Another import is running in this workspace. Try again in a moment.");
      logImportFailure(c, e);
      return fail(c, 500, "import_failed", "The import failed and nothing was changed. Try again.");
    }
  });

  return r;
}
