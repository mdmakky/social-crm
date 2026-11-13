-- Run once as a superuser. Idempotent. Local development / test only; real migrations replace the probe.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_migrator') THEN
    CREATE ROLE crm_migrator LOGIN PASSWORD 'migrator_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app LOGIN PASSWORD 'app_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
  -- Meta Inbox (migration 0018): the webhook ingress process (INSERT only) and the background worker. Dev passwords; real ones come from the environment.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_ingest') THEN
    CREATE ROLE crm_ingest LOGIN PASSWORD 'ingest_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_worker') THEN
    CREATE ROLE crm_worker LOGIN PASSWORD 'worker_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE crm TO crm_migrator, crm_app, crm_ingest, crm_worker;
GRANT CREATE ON DATABASE crm TO crm_migrator;
CREATE SCHEMA IF NOT EXISTS probe AUTHORIZATION crm_migrator;
GRANT USAGE ON SCHEMA probe TO crm_app;

SET ROLE crm_migrator;
CREATE TABLE IF NOT EXISTS probe.items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  body text NOT NULL
);
ALTER TABLE probe.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE probe.items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON probe.items;
CREATE POLICY tenant_isolation ON probe.items
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON probe.items TO crm_app;
RESET ROLE;

-- Migrations run as crm_migrator in schema public; crm_app gets DML only on what the migrator creates.
GRANT USAGE, CREATE ON SCHEMA public TO crm_migrator;
GRANT USAGE ON SCHEMA public TO crm_app, crm_ingest, crm_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO crm_app;
