-- Second way to connect an Instagram account: Instagram API with Unified Login (Facebook Login for Business with an Instagram-only configuration, no Facebook Page, system-user token).
-- Accounts, secrets, webhooks, conversations and messages are unchanged; only how the account was authorised is recorded. Existing rows are Page-based connections, which the default says.
ALTER TABLE "integration_accounts" ADD COLUMN "auth_method" text DEFAULT 'facebook' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_auth_method" CHECK ("auth_method" IN ('facebook','unified'));--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_auth_method_platform" CHECK ("auth_method" = 'facebook' OR "platform" = 'instagram');--> statement-breakpoint
GRANT UPDATE (auth_method) ON integration_accounts TO crm_worker;
