-- Extensions this module's own schema needs.
--
-- `core` creates these too, and in a real instance it migrates first — but a module must not depend
-- on another module's migration having run. `hr` can be hosted by a service that does not carry
-- core, and its tests boot it alone against a scratch database, where `ltree` would not exist.
-- `if not exists` makes saying so twice free.
--
-- Re-add this block after `pnpm db:generate`: drizzle-kit rewrites this file and does not know
-- about it, the same way it does not know the schema is created before migrations run.
CREATE EXTENSION IF NOT EXISTS ltree;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "mod_hr";
--> statement-breakpoint
CREATE TABLE "mod_hr"."calendar_days" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" text DEFAULT 'public_holiday' NOT NULL,
	"name" text NOT NULL,
	"working_fraction" numeric(3, 2) DEFAULT '0' NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"paid" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."calendars" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"extends_id" uuid,
	"country" text,
	"region" text,
	"working_week" jsonb DEFAULT '{"mon":1,"tue":1,"wed":1,"thu":1,"fri":1,"sat":0,"sun":0}'::jsonb NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"pack_key" text,
	"pack_version" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."cost_centers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"office_id" uuid,
	"org_unit_id" uuid,
	"legal_entity_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."custom_field_defs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"section" text DEFAULT 'profile' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."employments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"org_unit_id" uuid,
	"position_id" uuid,
	"legal_entity_id" uuid,
	"cost_center_id" uuid,
	"manager_person_id" uuid,
	"employment_type" text DEFAULT 'full_time' NOT NULL,
	"fte" numeric(4, 3) DEFAULT '1.000' NOT NULL,
	"contract_hours_week" numeric(5, 2),
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"registration_no" text,
	"tax_no" text,
	"country" text NOT NULL,
	"currency" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."office_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"office_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."offices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"kind" text DEFAULT 'branch' NOT NULL,
	"parent_office_id" uuid,
	"legal_entity_id" uuid,
	"country" text NOT NULL,
	"region" text,
	"city" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"calendar_id" uuid,
	"address" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"head_person_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."org_units" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_id" uuid,
	"path" "ltree" NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"head_person_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."people" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"employee_no" text,
	"display_name" text NOT NULL,
	"work_email" text,
	"personal_email" text,
	"phone" text,
	"photo_file_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"hired_on" date,
	"terminated_on" date,
	"timezone" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."people_sensitive" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"national_id_enc" text,
	"birth_date" date,
	"iban_enc" text,
	"emergency_contact" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."person_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"issued_on" date,
	"expires_on" date,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."person_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"field" text NOT NULL,
	"from_value" jsonb,
	"to_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"source" text DEFAULT 'app' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."positions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"code" text,
	"job_family" text,
	"level" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hr_calendar_days_idx" ON "mod_hr"."calendar_days" USING btree ("workspace_id","calendar_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_calendar_days_uq" ON "mod_hr"."calendar_days" USING btree ("calendar_id","date","kind");--> statement-breakpoint
CREATE INDEX "hr_calendars_ws_idx" ON "mod_hr"."calendars" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_cost_centers_ws_code_uq" ON "mod_hr"."cost_centers" USING btree ("workspace_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_fields_ws_key_uq" ON "mod_hr"."custom_field_defs" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "hr_employments_person_idx" ON "mod_hr"."employments" USING btree ("workspace_id","person_id","effective_from");--> statement-breakpoint
CREATE INDEX "hr_employments_ws_manager_idx" ON "mod_hr"."employments" USING btree ("workspace_id","manager_person_id");--> statement-breakpoint
CREATE INDEX "hr_employments_ws_unit_idx" ON "mod_hr"."employments" USING btree ("workspace_id","org_unit_id");--> statement-breakpoint
CREATE INDEX "hr_entities_ws_idx" ON "mod_hr"."legal_entities" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE INDEX "hr_office_assign_person_idx" ON "mod_hr"."office_assignments" USING btree ("workspace_id","person_id","effective_from");--> statement-breakpoint
CREATE INDEX "hr_office_assign_office_idx" ON "mod_hr"."office_assignments" USING btree ("workspace_id","office_id","effective_from");--> statement-breakpoint
CREATE INDEX "hr_offices_ws_idx" ON "mod_hr"."offices" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE INDEX "hr_offices_ws_country_idx" ON "mod_hr"."offices" USING btree ("workspace_id","country");--> statement-breakpoint
CREATE INDEX "hr_org_units_ws_idx" ON "mod_hr"."org_units" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE INDEX "hr_people_ws_status_idx" ON "mod_hr"."people" USING btree ("workspace_id","status","display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_people_ws_user_uq" ON "mod_hr"."people" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_people_ws_empno_uq" ON "mod_hr"."people" USING btree ("workspace_id","employee_no");--> statement-breakpoint
CREATE INDEX "hr_people_sensitive_ws_idx" ON "mod_hr"."people_sensitive" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "hr_person_docs_idx" ON "mod_hr"."person_documents" USING btree ("workspace_id","person_id","created_at");--> statement-breakpoint
CREATE INDEX "hr_person_docs_expiry_idx" ON "mod_hr"."person_documents" USING btree ("workspace_id","expires_on");--> statement-breakpoint
CREATE INDEX "hr_person_history_idx" ON "mod_hr"."person_history" USING btree ("workspace_id","person_id","created_at");--> statement-breakpoint
CREATE INDEX "hr_positions_ws_idx" ON "mod_hr"."positions" USING btree ("workspace_id","archived_at");