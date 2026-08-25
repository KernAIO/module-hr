CREATE TABLE "mod_hr"."periods" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text DEFAULT 'payroll' NOT NULL,
	"legal_entity_id" uuid,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."policies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source" text DEFAULT 'custom' NOT NULL,
	"pack_key" text,
	"config_hash" text DEFAULT '' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."policy_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hr_periods_idx" ON "mod_hr"."periods" USING btree ("workspace_id","kind","starts_on");--> statement-breakpoint
CREATE INDEX "hr_policies_ws_kind_idx" ON "mod_hr"."policies" USING btree ("workspace_id","kind","effective_from");--> statement-breakpoint
CREATE INDEX "hr_policy_assign_idx" ON "mod_hr"."policy_assignments" USING btree ("workspace_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "hr_policy_assign_policy_idx" ON "mod_hr"."policy_assignments" USING btree ("workspace_id","policy_id");--> statement-breakpoint
-- Row-level security on the policy and period tables.
alter table "mod_hr"."policies" enable row level security;--> statement-breakpoint
alter table "mod_hr"."policies" force row level security;--> statement-breakpoint
create policy "policies_ws_isolation" on "mod_hr"."policies"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."policy_assignments" enable row level security;--> statement-breakpoint
alter table "mod_hr"."policy_assignments" force row level security;--> statement-breakpoint
create policy "policy_assignments_ws_isolation" on "mod_hr"."policy_assignments"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."periods" enable row level security;--> statement-breakpoint
alter table "mod_hr"."periods" force row level security;--> statement-breakpoint
create policy "periods_ws_isolation" on "mod_hr"."periods"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

-- One assignment of a policy at a rung over a period.
--
-- Without this, two overlapping assignments at the same priority resolve arbitrarily: the ladder
-- has a tie it cannot break, and which policy applies depends on row order. That is the kind of bug
-- that shows up as two people on the same terms accruing differently.
alter table "mod_hr"."policy_assignments"
  add constraint "hr_policy_assign_no_overlap"
  exclude using gist (
    policy_id with =,
    subject_kind with =,
    coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    daterange(effective_from, effective_to, '[]') with &&
  );--> statement-breakpoint

-- Two periods of a kind may not cover the same day for the same entity: "is this date locked" has
-- to have exactly one answer.
alter table "mod_hr"."periods"
  add constraint "hr_periods_no_overlap"
  exclude using gist (
    kind with =,
    workspace_id with =,
    coalesce(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    daterange(starts_on, ends_on, '[]') with &&
  );
