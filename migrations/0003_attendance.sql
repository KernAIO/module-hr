CREATE TABLE "mod_hr"."attendance_days" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"scheduled_minutes" integer DEFAULT 0 NOT NULL,
	"worked_minutes" integer DEFAULT 0 NOT NULL,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"overtime_minutes" integer DEFAULT 0 NOT NULL,
	"late_minutes" integer DEFAULT 0 NOT NULL,
	"early_leave_minutes" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'absent' NOT NULL,
	"leave_request_id" uuid,
	"anomalies" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_in" timestamp with time zone,
	"last_out" timestamp with time zone,
	"policy_hash" text,
	"locked" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."punches" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_reported_at" timestamp with time zone,
	"skew_ms" integer,
	"business_date" date NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"method" text DEFAULT 'web' NOT NULL,
	"office_id" uuid,
	"device_id" uuid,
	"geo" jsonb,
	"trust" text DEFAULT 'trusted' NOT NULL,
	"voided_by_punch_id" uuid,
	"idempotency_key" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
) PARTITION BY RANGE ("business_date");
--> statement-breakpoint
-- Partitioned, because five hundred people punching four times a day is half a million rows a year
-- and retrofitting partitioning onto a live table of those is a migration nobody wants. drizzle-kit
-- cannot express PARTITION BY, so this block is hand-maintained: **after `pnpm db:generate`,
-- re-add the `PARTITION BY`, the primary key and the partitions below.**
--
-- A partitioned table's primary key must contain the partition column, which is why it is
-- (id, business_date) rather than (id). Same for the idempotency index: without business_date in it
-- Postgres refuses to create it at all.
ALTER TABLE "mod_hr"."punches" ADD PRIMARY KEY ("id", "business_date");
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_punches_idem_uq"
  ON "mod_hr"."punches" ("workspace_id", "idempotency_key", "business_date")
  WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
-- A DEFAULT partition catches anything outside the ranges below, so a missing monthly partition
-- degrades to a slow insert rather than a failed punch. Attendance that refuses to record because
-- a maintenance job did not run is worse than attendance that records into the wrong file.
CREATE TABLE IF NOT EXISTS "mod_hr"."punches_default"
  PARTITION OF "mod_hr"."punches" DEFAULT;
--> statement-breakpoint
ALTER TABLE "mod_hr"."punches_default" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mod_hr"."punches_default" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "punches_ws_isolation" ON "mod_hr"."punches_default"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
-- Creating a partition is not just `CREATE TABLE ... PARTITION OF`.
--
-- A policy on a partitioned parent applies when you query **through the parent**. Query a partition
-- directly and its own row-level security setting applies — and a fresh partition has none. Any
-- deployment that runs `GRANT SELECT ON ALL TABLES IN SCHEMA mod_hr` therefore hands out an
-- unfiltered view of one month's punches, silently, to every role that grant touched.
--
-- So partition creation goes through this function, which secures what it creates. The monthly job
-- calls the same function, which is the only way it cannot forget.
CREATE OR REPLACE FUNCTION "mod_hr".ensure_punch_partition(month_start date)
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  part_name text := 'punches_' || to_char(month_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
    'mod_hr', part_name, 'mod_hr', 'punches', month_start, (month_start + interval '1 month')::date
  );
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', 'mod_hr', part_name);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', 'mod_hr', part_name);
  -- `IF NOT EXISTS` on CREATE POLICY needs Postgres 18; the catalogue check works everywhere and
  -- keeps this function safe to call repeatedly, which the monthly job relies on.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'mod_hr' AND tablename = part_name AND policyname = 'punches_ws_isolation'
  ) THEN
    EXECUTE format(
      'CREATE POLICY "punches_ws_isolation" ON %I.%I
         USING (workspace_id::text = current_setting(''app.workspace_id'', true))
         WITH CHECK (workspace_id::text = current_setting(''app.workspace_id'', true))',
      'mod_hr', part_name
    );
  END IF;
  RETURN part_name;
END
$fn$;
--> statement-breakpoint
-- Seeds a window either side of today so a fresh instance can record punches immediately.
-- `hr.ensure-partitions` keeps it rolling.
DO $$
DECLARE
  m date := (date_trunc('month', now()) - interval '3 months')::date;
  stop date := (date_trunc('month', now()) + interval '12 months')::date;
BEGIN
  WHILE m < stop LOOP
    PERFORM "mod_hr".ensure_punch_partition(m);
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TABLE "mod_hr"."regularizations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"punch_id" uuid,
	"proposed" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approval_request_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."schedule_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_hr"."schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'fixed' NOT NULL,
	"week" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tz_mode" text DEFAULT 'office' NOT NULL,
	"tz" text,
	"grace_in_minutes" integer DEFAULT 0 NOT NULL,
	"grace_out_minutes" integer DEFAULT 0 NOT NULL,
	"rounding_step_minutes" integer DEFAULT 0 NOT NULL,
	"rounding_direction" text DEFAULT 'nearest' NOT NULL,
	"auto_clock_out_after_minutes" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_attendance_days_uq" ON "mod_hr"."attendance_days" USING btree ("workspace_id","person_id","business_date");--> statement-breakpoint
CREATE INDEX "hr_attendance_days_date_idx" ON "mod_hr"."attendance_days" USING btree ("workspace_id","business_date","status");--> statement-breakpoint
CREATE INDEX "hr_punches_person_idx" ON "mod_hr"."punches" USING btree ("workspace_id","person_id","business_date");--> statement-breakpoint
CREATE INDEX "hr_regularizations_idx" ON "mod_hr"."regularizations" USING btree ("workspace_id","person_id","business_date");--> statement-breakpoint
CREATE INDEX "hr_schedule_assign_idx" ON "mod_hr"."schedule_assignments" USING btree ("workspace_id","person_id","effective_from");--> statement-breakpoint
CREATE INDEX "hr_schedules_ws_idx" ON "mod_hr"."schedules" USING btree ("workspace_id","archived_at");--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Row-level security on the attendance tables.
--
-- A policy on a partitioned parent applies to every partition, including ones created later — which
-- is what makes the rolling partition job safe. The test asserts a freshly created partition
-- returns nothing without `app.workspace_id`, because "it inherits" is the kind of thing that is
-- true until a Postgres upgrade says otherwise.
alter table "mod_hr"."schedules" enable row level security;--> statement-breakpoint
alter table "mod_hr"."schedules" force row level security;--> statement-breakpoint
create policy "schedules_ws_isolation" on "mod_hr"."schedules"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."schedule_assignments" enable row level security;--> statement-breakpoint
alter table "mod_hr"."schedule_assignments" force row level security;--> statement-breakpoint
create policy "schedule_assignments_ws_isolation" on "mod_hr"."schedule_assignments"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."punches" enable row level security;--> statement-breakpoint
alter table "mod_hr"."punches" force row level security;--> statement-breakpoint
create policy "punches_ws_isolation" on "mod_hr"."punches"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."attendance_days" enable row level security;--> statement-breakpoint
alter table "mod_hr"."attendance_days" force row level security;--> statement-breakpoint
create policy "attendance_days_ws_isolation" on "mod_hr"."attendance_days"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."regularizations" enable row level security;--> statement-breakpoint
alter table "mod_hr"."regularizations" force row level security;--> statement-breakpoint
create policy "regularizations_ws_isolation" on "mod_hr"."regularizations"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
