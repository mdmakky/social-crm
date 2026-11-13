ALTER TABLE "integration_accounts" ADD COLUMN "connected_meta_user_hash" text;--> statement-breakpoint
CREATE INDEX "integration_accounts_meta_user_idx" ON "integration_accounts" USING btree ("connected_meta_user_hash") WHERE "integration_accounts"."connected_meta_user_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_meta_user_hash" CHECK ("integration_accounts"."connected_meta_user_hash" IS NULL OR "integration_accounts"."connected_meta_user_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
GRANT UPDATE (connected_meta_user_hash) ON integration_accounts TO crm_worker;
