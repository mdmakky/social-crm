DROP INDEX "tasks_ws_due_idx";--> statement-breakpoint
CREATE INDEX "tasks_ws_due_desc_idx" ON "tasks" USING btree ("workspace_id",coalesce("due_at", '-infinity'::timestamptz) DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "tasks_ws_due_idx" ON "tasks" USING btree ("workspace_id",coalesce("due_at", 'infinity'::timestamptz),"id");