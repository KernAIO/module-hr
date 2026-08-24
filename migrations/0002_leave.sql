CREATE TABLE "mod_hr"."approval_chains" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"subject_type" text NOT NULL,
	"spec" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."approval_decisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"approver_id" uuid NOT NULL,
	"on_behalf_of_id" uuid,
	"decision" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"chain" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."approval_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"mode" text DEFAULT 'any' NOT NULL,
	"min_approvals" integer DEFAULT 1 NOT NULL,
	"approver_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone,
	"escalated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."delegations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"from_person_id" uuid NOT NULL,
	"to_person_id" uuid NOT NULL,
	"subject_type" text,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."leave_balance_cursor" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"period_year" integer NOT NULL,
	"cached_balance_minutes" integer DEFAULT 0 NOT NULL,
	"as_of_entry_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."leave_ledger" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minutes" integer NOT NULL,
	"effective_on" date NOT NULL,
	"period_year" integer NOT NULL,
	"request_id" uuid,
	"reverses_entry_id" uuid,
	"policy_hash" text,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."leave_request_days" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"date" date NOT NULL,
	"fraction" numeric(3, 2) DEFAULT '1' NOT NULL,
	"counted" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"start_part" text DEFAULT 'full' NOT NULL,
	"end_part" text DEFAULT 'full' NOT NULL,
	"hours" numeric(5, 2),
	"working_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"document_file_id" uuid,
	"approval_request_id" uuid,
	"idempotency_key" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."leave_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"paid" boolean DEFAULT true NOT NULL,
	"unit" text DEFAULT 'day' NOT NULL,
	"color" text,
	"icon" text,
	"requires_document_after_days" integer,
	"counts_working_days_only" boolean DEFAULT true NOT NULL,
	"allow_negative" boolean DEFAULT false NOT NULL,
	"max_negative_minutes" integer DEFAULT 0 NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hr_approval_chains_idx" ON "mod_hr"."approval_chains" USING btree ("workspace_id","subject_type","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_approval_decisions_uq" ON "mod_hr"."approval_decisions" USING btree ("step_id","approver_id");--> statement-breakpoint
CREATE INDEX "hr_approval_requests_subject_idx" ON "mod_hr"."approval_requests" USING btree ("workspace_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "hr_approval_requests_status_idx" ON "mod_hr"."approval_requests" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_approval_steps_uq" ON "mod_hr"."approval_steps" USING btree ("request_id","step_index");--> statement-breakpoint
CREATE INDEX "hr_approval_steps_due_idx" ON "mod_hr"."approval_steps" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE INDEX "hr_delegations_idx" ON "mod_hr"."delegations" USING btree ("workspace_id","to_person_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_balance_cursor_uq" ON "mod_hr"."leave_balance_cursor" USING btree ("workspace_id","person_id","leave_type_id","period_year");--> statement-breakpoint
CREATE INDEX "hr_ledger_person_idx" ON "mod_hr"."leave_ledger" USING btree ("workspace_id","person_id","leave_type_id","effective_on");--> statement-breakpoint
CREATE INDEX "hr_ledger_request_idx" ON "mod_hr"."leave_ledger" USING btree ("workspace_id","request_id");--> statement-breakpoint
CREATE INDEX "hr_ledger_year_idx" ON "mod_hr"."leave_ledger" USING btree ("workspace_id","period_year");--> statement-breakpoint
CREATE INDEX "hr_leave_days_person_idx" ON "mod_hr"."leave_request_days" USING btree ("workspace_id","person_id","date");--> statement-breakpoint
CREATE INDEX "hr_leave_days_request_idx" ON "mod_hr"."leave_request_days" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "hr_leave_requests_person_idx" ON "mod_hr"."leave_requests" USING btree ("workspace_id","person_id","starts_on");--> statement-breakpoint
CREATE INDEX "hr_leave_requests_status_idx" ON "mod_hr"."leave_requests" USING btree ("workspace_id","status","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_leave_requests_idem_uq" ON "mod_hr"."leave_requests" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_leave_types_ws_key_uq" ON "mod_hr"."leave_types" USING btree ("workspace_id","key");--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Row-level security on the new tenant tables.
alter table "mod_hr"."leave_types" enable row level security;--> statement-breakpoint
alter table "mod_hr"."leave_types" force row level security;--> statement-breakpoint
create policy "leave_types_ws_isolation" on "mod_hr"."leave_types"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."leave_ledger" enable row level security;--> statement-breakpoint
alter table "mod_hr"."leave_ledger" force row level security;--> statement-breakpoint
create policy "leave_ledger_ws_isolation" on "mod_hr"."leave_ledger"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."leave_balance_cursor" enable row level security;--> statement-breakpoint
alter table "mod_hr"."leave_balance_cursor" force row level security;--> statement-breakpoint
create policy "leave_balance_cursor_ws_isolation" on "mod_hr"."leave_balance_cursor"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."leave_requests" enable row level security;--> statement-breakpoint
alter table "mod_hr"."leave_requests" force row level security;--> statement-breakpoint
create policy "leave_requests_ws_isolation" on "mod_hr"."leave_requests"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."leave_request_days" enable row level security;--> statement-breakpoint
alter table "mod_hr"."leave_request_days" force row level security;--> statement-breakpoint
create policy "leave_request_days_ws_isolation" on "mod_hr"."leave_request_days"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."approval_chains" enable row level security;--> statement-breakpoint
alter table "mod_hr"."approval_chains" force row level security;--> statement-breakpoint
create policy "approval_chains_ws_isolation" on "mod_hr"."approval_chains"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."approval_requests" enable row level security;--> statement-breakpoint
alter table "mod_hr"."approval_requests" force row level security;--> statement-breakpoint
create policy "approval_requests_ws_isolation" on "mod_hr"."approval_requests"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."approval_steps" enable row level security;--> statement-breakpoint
alter table "mod_hr"."approval_steps" force row level security;--> statement-breakpoint
create policy "approval_steps_ws_isolation" on "mod_hr"."approval_steps"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."approval_decisions" enable row level security;--> statement-breakpoint
alter table "mod_hr"."approval_decisions" force row level security;--> statement-breakpoint
create policy "approval_decisions_ws_isolation" on "mod_hr"."approval_decisions"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."delegations" enable row level security;--> statement-breakpoint
alter table "mod_hr"."delegations" force row level security;--> statement-breakpoint
create policy "delegations_ws_isolation" on "mod_hr"."delegations"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- The invariant that keeps a balance honest under concurrency.
--
-- Two overlapping requests can both read the same balance, both see enough for the last day, and
-- both succeed — leaving somebody minus a day and nobody able to say which request caused it. The
-- cursor lock serialises the *spend*; this index refuses the *overlap*, so a person cannot hold two
-- live requests covering one date whatever the application layer believes.
--
-- Partial on purpose: a cancelled or rejected request must not block rebooking the same day, and a
-- weekend inside a range is not counted so it does not conflict with anything either.
create unique index "hr_leave_days_no_double_booking"
  on "mod_hr"."leave_request_days" (workspace_id, person_id, date)
  where counted and status in ('pending', 'approved');
