CREATE TABLE "lead_tags" (
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "lead_tags_workspace_id_lead_id_tag_id_pk" PRIMARY KEY("workspace_id","lead_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "lead_value_grants" (
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_value_grants_workspace_id_lead_id_user_id_pk" PRIMARY KEY("workspace_id","lead_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"primary_contact_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"outcome" text DEFAULT 'open' NOT NULL,
	"rank" text NOT NULL,
	"value_minor" bigint,
	"currency" text,
	"expected_close_date" date,
	"probability" smallint NOT NULL,
	"probability_manual" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"lost_reason_id" uuid,
	"next_activity_at" timestamp with time zone,
	"priority" text DEFAULT 'normal' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"owner_user_id" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "leads_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "leads_title_len" CHECK (char_length("leads"."title") BETWEEN 1 AND 160),
	CONSTRAINT "leads_description_len" CHECK ("leads"."description" IS NULL OR char_length("leads"."description") <= 5000),
	CONSTRAINT "leads_outcome" CHECK ("leads"."outcome" IN ('open','won','lost')),
	CONSTRAINT "leads_value_range" CHECK ("leads"."value_minor" IS NULL OR "leads"."value_minor" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "leads_currency_fmt" CHECK ("leads"."currency" IS NULL OR "leads"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "leads_value_currency_pair" CHECK (("leads"."value_minor" IS NULL) = ("leads"."currency" IS NULL)),
	CONSTRAINT "leads_close_date_range" CHECK ("leads"."expected_close_date" IS NULL OR "leads"."expected_close_date" BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
	CONSTRAINT "leads_prob_range" CHECK ("leads"."probability" BETWEEN 0 AND 100),
	CONSTRAINT "leads_closed_at_matches_outcome" CHECK (("leads"."outcome" = 'open') = ("leads"."closed_at" IS NULL)),
	CONSTRAINT "leads_lost_reason_only_when_lost" CHECK ("leads"."outcome" = 'lost' OR "leads"."lost_reason_id" IS NULL),
	CONSTRAINT "leads_lost_needs_reason" CHECK ("leads"."outcome" <> 'lost' OR "leads"."lost_reason_id" IS NOT NULL),
	CONSTRAINT "leads_won_prob" CHECK ("leads"."outcome" <> 'won' OR "leads"."probability" = 100),
	CONSTRAINT "leads_lost_prob" CHECK ("leads"."outcome" <> 'lost' OR "leads"."probability" = 0),
	CONSTRAINT "leads_priority" CHECK ("leads"."priority" IN ('low','normal','high'))
);
--> statement-breakpoint
CREATE TABLE "lost_reasons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lost_reasons_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "lost_reasons_name_len" CHECK (char_length("lost_reasons"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'open' NOT NULL,
	"default_probability" smallint NOT NULL,
	"position" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stages_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "stages_ws_pipeline_id" UNIQUE("workspace_id","pipeline_id","id"),
	CONSTRAINT "stages_ws_pipeline_id_kind" UNIQUE("workspace_id","pipeline_id","id","kind"),
	CONSTRAINT "stages_name_len" CHECK (char_length("pipeline_stages"."name") BETWEEN 1 AND 60),
	CONSTRAINT "stages_kind" CHECK ("pipeline_stages"."kind" IN ('open','won','lost')),
	CONSTRAINT "stages_prob_range" CHECK ("pipeline_stages"."default_probability" BETWEEN 0 AND 100),
	CONSTRAINT "stages_won_100" CHECK ("pipeline_stages"."kind" <> 'won' OR "pipeline_stages"."default_probability" = 100),
	CONSTRAINT "stages_lost_0" CHECK ("pipeline_stages"."kind" <> 'lost' OR "pipeline_stages"."default_probability" = 0),
	CONSTRAINT "stages_terminal_not_archived" CHECK ("pipeline_stages"."kind" = 'open' OR "pipeline_stages"."archived_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipelines_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "pipelines_name_len" CHECK (char_length("pipelines"."name") BETWEEN 1 AND 80),
	CONSTRAINT "pipelines_kind" CHECK ("pipelines"."kind" IN ('lead','sales')),
	CONSTRAINT "pipelines_currency" CHECK ("pipelines"."default_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "stage_transitions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid NOT NULL,
	"from_outcome" text,
	"to_outcome" text NOT NULL,
	"actor_user_id" text,
	"lost_reason_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_transitions_to_outcome" CHECK ("stage_transitions"."to_outcome" IN ('open','won','lost'))
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_workspace_id_lead_id_leads_workspace_id_id_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "public"."leads"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_workspace_id_tag_id_tags_workspace_id_id_fk" FOREIGN KEY ("workspace_id","tag_id") REFERENCES "public"."tags"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_value_grants" ADD CONSTRAINT "lead_value_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_value_grants" ADD CONSTRAINT "lead_value_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_value_grants" ADD CONSTRAINT "lead_value_grants_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_value_grants" ADD CONSTRAINT "lead_value_grants_workspace_id_lead_id_leads_workspace_id_id_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "public"."leads"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_primary_contact_id_contacts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","primary_contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_pipeline_id_stage_id_outcome_pipeline_stages_workspace_id_pipeline_id_id_kind_fk" FOREIGN KEY ("workspace_id","pipeline_id","stage_id","outcome") REFERENCES "public"."pipeline_stages"("workspace_id","pipeline_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_lost_reason_id_lost_reasons_workspace_id_id_fk" FOREIGN KEY ("workspace_id","lost_reason_id") REFERENCES "public"."lost_reasons"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lost_reasons" ADD CONSTRAINT "lost_reasons_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_workspace_id_pipeline_id_pipelines_workspace_id_id_fk" FOREIGN KEY ("workspace_id","pipeline_id") REFERENCES "public"."pipelines"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_workspace_id_lead_id_leads_workspace_id_id_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "public"."leads"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_workspace_id_to_stage_id_pipeline_stages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","to_stage_id") REFERENCES "public"."pipeline_stages"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_tags_tag_idx" ON "lead_tags" USING btree ("workspace_id","tag_id","lead_id");--> statement-breakpoint
CREATE INDEX "leads_board_idx" ON "leads" USING btree ("workspace_id","pipeline_id","stage_id","rank" COLLATE "C","id") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "leads_contact_idx" ON "leads" USING btree ("workspace_id","primary_contact_id") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "leads_owner_idx" ON "leads" USING btree ("workspace_id","owner_user_id","outcome") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "leads_ws_updated_idx" ON "leads" USING btree ("workspace_id","updated_at" DESC NULLS LAST,"id") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "leads_ws_close_idx" ON "leads" USING btree ("workspace_id","expected_close_date","id") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stages_one_won" ON "pipeline_stages" USING btree ("workspace_id","pipeline_id") WHERE "pipeline_stages"."kind" = 'won';--> statement-breakpoint
CREATE UNIQUE INDEX "stages_one_lost" ON "pipeline_stages" USING btree ("workspace_id","pipeline_id") WHERE "pipeline_stages"."kind" = 'lost';--> statement-breakpoint
CREATE INDEX "stages_pipeline_pos" ON "pipeline_stages" USING btree ("workspace_id","pipeline_id","position") WHERE "pipeline_stages"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_one_default" ON "pipelines" USING btree ("workspace_id") WHERE "pipelines"."is_default" AND "pipelines"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_ws_name" ON "pipelines" USING btree ("workspace_id",lower("name")) WHERE "pipelines"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "stage_transitions_lead_idx" ON "stage_transitions" USING btree ("workspace_id","lead_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "stage_transitions_stage_idx" ON "stage_transitions" USING btree ("workspace_id","pipeline_id","to_stage_id","occurred_at");--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_workspace_id_lead_id_leads_workspace_id_id_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "public"."leads"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_lead_idx" ON "activities" USING btree ("workspace_id","lead_id","id") WHERE "activities"."lead_id" IS NOT NULL;