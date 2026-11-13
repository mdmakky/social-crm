ALTER TABLE "contacts" ALTER COLUMN "last_activity_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "last_activity_at" SET NOT NULL;