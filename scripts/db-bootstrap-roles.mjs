#!/usr/bin/env node
// One-time, idempotent setup of the four database roles on a MANAGED Postgres (Neon etc.). Run it once with the owner/admin connection.
//   DATABASE_URL_ADMIN=... CRM_MIGRATOR_PASSWORD=... CRM_APP_PASSWORD=... CRM_INGEST_PASSWORD=... CRM_WORKER_PASSWORD=... node scripts/db-bootstrap-roles.mjs [--dry-run]
// Same effect as packages/db/sql/001_roles_and_probe.sql, minus the dev passwords and the `probe` test schema. Re-running rotates the passwords.
// Prints step names only: never passwords or connection URLs. UNVERIFIED on any managed provider (see docs/deploy/free-tier.md).
import { createRequire } from "node:module";

const dry = process.argv.includes("--dry-run");
const ROLES = [
  ["crm_migrator", "CRM_MIGRATOR_PASSWORD", "migrator_dev"],
  ["crm_app", "CRM_APP_PASSWORD", "app_dev"],
  ["crm_ingest", "CRM_INGEST_PASSWORD", "ingest_dev"],
  ["crm_worker", "CRM_WORKER_PASSWORD", "worker_dev"],
];
const fail = (m) => { console.error(`error: ${m}`); process.exit(1); };

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl && !dry) fail("DATABASE_URL_ADMIN is not set");
let dbName = "crm";
let host = "";
if (adminUrl) {
  let u;
  try { u = new URL(adminUrl); } catch { fail("DATABASE_URL_ADMIN is not a valid URL"); }
  dbName = decodeURIComponent(u.pathname.slice(1));
  host = u.hostname;
  if (!dbName) fail("DATABASE_URL_ADMIN has no database name");
}

const passwords = {};
if (!dry) {
  for (const [role, envName, devPw] of ROLES) {
    const p = process.env[envName];
    if (!p) fail(`${envName} is not set`);
    if (p.length < 24) fail(`${envName} must be at least 24 characters`);
    if (p === devPw) fail(`${envName} must not be the development password`);
    passwords[role] = p;
  }
  if (new Set(Object.values(passwords)).size !== ROLES.length) fail("the four role passwords must all be different");
}

// Every statement is built by the SERVER with format(%I, %L), so a password or database name can never break out of its quoting.
const steps = [
  ...ROLES.map(([role]) => ({
    name: `role ${role}`,
    redacted: `CREATE ROLE ${role} LOGIN PASSWORD '<redacted>' NOSUPERUSER NOBYPASSRLS  -- or ALTER ROLE when it exists (rotates the password)`,
    build: async (c) => {
      const exists = (await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount > 0;
      const verb = exists ? "ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS" : "CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS";
      return (await c.query("SELECT format($1, $2::text, $3::text) AS s", [verb, role, passwords[role]])).rows[0].s;
    },
  })),
  { name: "extension pg_trgm", redacted: "CREATE EXTENSION IF NOT EXISTS pg_trgm", sql: "CREATE EXTENSION IF NOT EXISTS pg_trgm" },
  {
    name: "database grants",
    redacted: `GRANT CONNECT ON DATABASE ${dbName} TO crm_migrator, crm_app, crm_ingest, crm_worker; GRANT CREATE ON DATABASE ${dbName} TO crm_migrator`,
    build: async (c) => (await c.query("SELECT format('GRANT CONNECT ON DATABASE %1$I TO crm_migrator, crm_app, crm_ingest, crm_worker; GRANT CREATE ON DATABASE %1$I TO crm_migrator', $1::text) AS s", [dbName])).rows[0].s,
  },
  {
    name: "schema grants",
    redacted: "GRANT USAGE, CREATE ON SCHEMA public TO crm_migrator; GRANT USAGE ON SCHEMA public TO crm_app, crm_ingest, crm_worker",
    sql: "GRANT USAGE, CREATE ON SCHEMA public TO crm_migrator; GRANT USAGE ON SCHEMA public TO crm_app, crm_ingest, crm_worker",
  },
  {
    // Needs the admin role to be allowed to act for crm_migrator: UNVERIFIED on managed providers; this step names the failure if not.
    name: "default privileges for objects created by crm_migrator",
    redacted: "ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app; ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO crm_app",
    sql: "ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app; ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO crm_app",
  },
];

if (dry) {
  console.log(`dry run for database "${dbName}" (nothing is executed, passwords are never printed):`);
  for (const s of steps) console.log(`- ${s.name}: ${s.redacted}`);
  process.exit(0);
}

const pg = createRequire(import.meta.url)("../packages/db/node_modules/pg");
const scrub = (m) => String(m).split("\n")[0].replaceAll(host || "\u0000", "<host>");
const c = new pg.Client({ connectionString: adminUrl });
try {
  await c.connect();
} catch (e) {
  fail(`cannot connect with DATABASE_URL_ADMIN (${e.code ?? "no code"}: ${scrub(e.message)})`);
}
let failed = false;
for (const s of steps) {
  try {
    await c.query(s.sql ?? (await s.build(c)));
    console.log(`ok: ${s.name}`);
  } catch (e) {
    failed = true;
    console.error(`FAILED: ${s.name} (${e.code ?? "no code"}: ${scrub(e.message)})`);
  }
}
await c.end();
process.exit(failed ? 1 : 0);
