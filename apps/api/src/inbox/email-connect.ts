import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { ConnectEmailBody, SetEmailEnabledBody, type EmailAccountDto, type EmailIntegrationState, type EmailSetupCheck } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { withContext, type Db } from "@crm/db";
import { cleanHeader, randomToken, supportAddress, type EmailProvider } from "@crm/integrations";
import { writeAudit } from "../audit.ts";
import { actor, body, fail, wctx, type SC, type ScopedEnv } from "../routes/scope.ts";

/** Everything the email channel needs from the process. Absent = the channel is "not available on this server" (the settings panel says so). MOCK providers are labeled everywhere. */
export type EmailDeps = {
  provider: EmailProvider;
  /** Pool connected as crm_worker: the application role cannot create accounts or write delivery states (migration 0018). */
  workerDb: Db;
  /** Domain of the support addresses people write to (support+<token>@this). */
  inboundDomain: string;
  /** Domain mail is sent from (From = support@this). */
  sendingDomain: string;
  mock: boolean;
};

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;
const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());

/** The DNS records the owner adds, in plain words. Mailgun values are UNVERIFIED (docs.mailgun.com domain setup was not checked against a real account); the DKIM value is only known from the provider's dashboard. */
export function dnsSteps(d: Pick<EmailDeps, "inboundDomain" | "sendingDomain" | "mock">): EmailIntegrationState["dns"] {
  const m = d.mock ? " (example values: this is the MOCK provider)" : "";
  return [
    { id: "mx", title: "Receive email", type: "MX", host: d.inboundDomain, value: "10 mxa.mailgun.org, 10 mxb.mailgun.org", plain: `Point mail for ${d.inboundDomain} at your email provider so customer emails reach this inbox${m}.`, technical: "Two MX records, priority 10. Hostnames follow Mailgun's documented defaults (UNVERIFIED; EU accounts use mxa.eu.mailgun.org and mxb.eu.mailgun.org)." },
    { id: "spf", title: "Allow sending", type: "TXT", host: d.sendingDomain, value: "v=spf1 include:mailgun.org ~all", plain: `Say that your provider may send email for ${d.sendingDomain}.`, technical: "One SPF TXT record per domain. If the domain already has an SPF record, add include:mailgun.org to it instead of creating a second one (UNVERIFIED value)." },
    { id: "dkim", title: "Sign your email", type: "TXT", host: `<selector>._domainkey.${d.sendingDomain}`, value: "Copy the value from your provider's domain page", plain: "Add the signing key your provider shows you, so receivers can tell the email really came from you.", technical: "DKIM selector and public key are generated per domain by the provider; there is no fixed value to print here." },
    { id: "dmarc", title: "Protect your domain", type: "TXT", host: `_dmarc.${d.sendingDomain}`, value: "v=DMARC1; p=none; rua=mailto:postmaster@" + d.sendingDomain, plain: "Optional but recommended: tell receivers what to do with email that fails the checks. Start with monitoring only.", technical: "p=none only reports. Move to quarantine or reject once the reports look clean." },
  ];
}

const dtoOf = (r: Row, d: EmailDeps): EmailAccountDto => ({
  id: r.id as string, enabled: r.status === "connected", supportAddress: supportAddress(r.inbound_token as string, d.inboundDomain), fromAddress: r.from_address as string, displayName: r.display_name as string,
  provider: r.provider as "mock" | "mailgun", setupStatus: r.verified_domain_status as EmailAccountDto["setupStatus"], lastCheckedAt: iso(r.last_checked_at), connectedAt: iso(r.connected_at)!,
});
const stateOf = (d: EmailDeps | undefined, a: Row | undefined): EmailIntegrationState =>
  d ? { available: true, mock: d.mock, provider: d.provider.name, inboundDomain: d.inboundDomain, account: a ? dtoOf(a, d) : null, dns: dnsSteps(d) } : { available: false, mock: false, provider: null, inboundDomain: null, account: null, dns: [] };

/** Settings > Channels > Integrations > Email. No OAuth: the owner gets a support address and DNS steps. Permission integration.manage (owner, admin); viewing needs integration.view. */
export function emailConnect(db: Db, deps?: EmailDeps) {
  const r = new Hono<ScopedEnv>();
  const manage = (c: SC) => can(c.get("role"), "integration.manage", {});
  const forbidden = (c: SC) => fail(c, 403, "forbidden", "You don't have permission to do that.");
  const unavailable = (c: SC) => fail(c, 503, "email_not_available", "Email is not set up on this server.");
  const load = (c: SC) =>
    withContext(db, wctx(c), async (tx) =>
      rowsOf(await tx.execute(sql`
        SELECT ea.id, ea.inbound_token, ea.from_address, ea.display_name, ea.provider, ea.verified_domain_status, ea.last_checked_at, ia.status, ia.connected_at, ia.id AS account_id
        FROM integration_accounts ia JOIN email_accounts ea ON ea.workspace_id = ia.workspace_id AND ea.integration_account_id = ia.id
        WHERE ia.workspace_id = ${c.get("workspaceId")} AND ia.platform = 'email'`))[0],
    );
  const audit = (c: SC, action: string, id: string, summary: Record<string, unknown> = {}) =>
    withContext(db, wctx(c), (tx) => writeAudit(tx, { ...actor(c), workspaceId: c.get("workspaceId"), action, entityType: "integration_account", entityId: id, summary: { platform: "email", ...summary } }));
  const event = (c: SC, accountId: string, kind: string, data: Record<string, unknown>) =>
    withContext(deps!.workerDb, wctx(c), (tx) => tx.execute(sql`INSERT INTO integration_events (workspace_id, integration_account_id, kind, actor_user_id, data) VALUES (${c.get("workspaceId")}, ${accountId}, ${kind}, ${c.get("userId")}, ${JSON.stringify({ platform: "email", ...data })}::jsonb)`));

  r.get("/integrations/email", async (c) => {
    if (!can(c.get("role"), "integration.view", {})) return forbidden(c);
    return c.json(stateOf(deps, deps ? await load(c) : undefined));
  });

  r.post("/integrations/email/connect", async (c) => {
    if (!manage(c)) return forbidden(c);
    if (!deps) return unavailable(c);
    const b = await body(c, ConnectEmailBody);
    if (!b.ok) return b.res;
    const ws = c.get("workspaceId");
    const wsName = await withContext(db, wctx(c), async (tx) => rowsOf(await tx.execute(sql`SELECT name FROM workspaces WHERE id = ${ws}`))[0]?.name as string | undefined);
    const displayName = cleanHeader(b.data.displayName ?? wsName ?? "Support", 80).replace(/[<>"]/g, "") || "Support";
    const made = await withContext(deps.workerDb, wctx(c), async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`email-connect:${ws}`}, 0))`); // two clicks, one account
      const have = rowsOf(await tx.execute(sql`SELECT ia.id, ia.status FROM integration_accounts ia WHERE ia.workspace_id = ${ws} AND ia.platform = 'email'`))[0];
      if (have) {
        if (have.status !== "connected") await tx.execute(sql`UPDATE integration_accounts SET status = 'connected', connected_by = ${c.get("userId")}, connected_at = now(), version = version + 1, updated_at = now() WHERE id = ${have.id as string} AND workspace_id = ${ws}`);
        return { id: have.id as string, created: false, reconnected: have.status !== "connected" };
      }
      const token = randomToken(20);
      const acc = rowsOf(await tx.execute(sql`INSERT INTO integration_accounts (workspace_id, platform, external_account_id, display_name, connected_by) VALUES (${ws}, 'email', ${token}, ${displayName}, ${c.get("userId")}) RETURNING id`))[0]!;
      await tx.execute(sql`INSERT INTO email_accounts (workspace_id, integration_account_id, inbound_token, from_address, display_name, provider) VALUES (${ws}, ${acc.id as string}, ${token}, ${`support@${deps.sendingDomain.toLowerCase()}`}, ${displayName}, ${deps.provider.name})`);
      await tx.execute(sql`INSERT INTO integration_events (workspace_id, integration_account_id, kind, actor_user_id, data) VALUES (${ws}, ${acc.id as string}, 'connected', ${c.get("userId")}, ${JSON.stringify({ platform: "email", provider: deps.provider.name, mock: deps.mock })}::jsonb)`);
      return { id: acc.id as string, created: true, reconnected: false };
    });
    if (made.created || made.reconnected) await audit(c, "integration.email.connected", made.id, { provider: deps.provider.name, mock: deps.mock, reconnected: made.reconnected });
    return c.json(stateOf(deps, await load(c)));
  });

  r.post("/integrations/email/enabled", async (c) => {
    if (!manage(c)) return forbidden(c);
    if (!deps) return unavailable(c);
    const b = await body(c, SetEmailEnabledBody);
    if (!b.ok) return b.res;
    const a = await load(c);
    if (!a) return fail(c, 404, "not_found", "Email is not connected yet.");
    const ws = c.get("workspaceId");
    const to = b.data.enabled ? "connected" : "disabled";
    if (a.status !== to) {
      await withContext(deps.workerDb, wctx(c), (tx) => tx.execute(sql`UPDATE integration_accounts SET status = ${to}, version = version + 1, updated_at = now() WHERE id = ${a.account_id as string} AND workspace_id = ${ws}`));
      await event(c, a.account_id as string, "status_changed", { enabled: b.data.enabled });
      await audit(c, b.data.enabled ? "integration.email.enabled" : "integration.email.disabled", a.account_id as string);
    }
    return c.json(stateOf(deps, await load(c)));
  });

  r.post("/integrations/email/disconnect", async (c) => {
    if (!manage(c)) return forbidden(c);
    if (!deps) return unavailable(c);
    const a = await load(c);
    if (!a) return fail(c, 404, "not_found", "Email is not connected.");
    const ws = c.get("workspaceId");
    await withContext(deps.workerDb, wctx(c), async (tx) => {
      await tx.execute(sql`UPDATE integration_accounts SET status = 'disabled', version = version + 1, updated_at = now() WHERE id = ${a.account_id as string} AND workspace_id = ${ws}`);
      await tx.execute(sql`UPDATE email_accounts SET verified_domain_status = 'unchecked', last_checked_at = NULL, updated_at = now() WHERE workspace_id = ${ws} AND integration_account_id = ${a.account_id as string}`);
    });
    await event(c, a.account_id as string, "disconnected", {});
    await audit(c, "integration.email.disconnected", a.account_id as string);
    return c.json(stateOf(deps, await load(c)));
  });

  r.post("/integrations/email/check-setup", async (c) => {
    if (!manage(c)) return forbidden(c);
    if (!deps) return unavailable(c);
    const a = await load(c);
    if (!a) return fail(c, 404, "not_found", "Email is not connected yet.");
    const ws = c.get("workspaceId");
    // MOCK: canned answer, no DNS lookup is made. A real check (Mailgun's domain verification call or a DNS lookup) is not built: the status stays "pending" and says so.
    const checks: EmailSetupCheck["checks"] = deps.mock
      ? [{ id: "mx", ok: true, message: "Mock result: the MX records look right." }, { id: "spf", ok: true, message: "Mock result: SPF looks right." }, { id: "dkim", ok: true, message: "Mock result: DKIM looks right." }, { id: "dmarc", ok: false, message: "Mock result: no DMARC record found. Optional, but recommended." }]
      : (["mx", "spf", "dkim", "dmarc"] as const).map((id) => ({ id, ok: false, message: "Automatic checking is not built yet. Check this record in your provider's dashboard." }));
    const status = deps.mock ? "verified" : "pending";
    await withContext(deps.workerDb, wctx(c), (tx) => tx.execute(sql`UPDATE email_accounts SET verified_domain_status = ${status}, last_checked_at = now(), updated_at = now() WHERE workspace_id = ${ws} AND integration_account_id = ${a.account_id as string}`));
    await audit(c, "integration.email.setup_checked", a.account_id as string, { status, mock: deps.mock });
    return c.json({ state: stateOf(deps, await load(c)), checks, mock: deps.mock } satisfies EmailSetupCheck);
  });

  return r;
}
