-- Row-level security, plus the constraints that carry this module's real invariants.
--
-- RLS is the last line, not the first: the API checks membership and permission before anything
-- reaches here. It exists for the query that skips them — a job, a report, a mistake — and for
-- anyone who reaches the database another way. A tenant table without a policy is simply readable.
--
-- Superusers bypass RLS, so a database owned by one will pass a test that proves nothing. Run the
-- application as a plain role.

alter table "mod_hr"."legal_entities" enable row level security;--> statement-breakpoint
alter table "mod_hr"."legal_entities" force row level security;--> statement-breakpoint
create policy "legal_entities_ws_isolation" on "mod_hr"."legal_entities"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."offices" enable row level security;--> statement-breakpoint
alter table "mod_hr"."offices" force row level security;--> statement-breakpoint
create policy "offices_ws_isolation" on "mod_hr"."offices"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."cost_centers" enable row level security;--> statement-breakpoint
alter table "mod_hr"."cost_centers" force row level security;--> statement-breakpoint
create policy "cost_centers_ws_isolation" on "mod_hr"."cost_centers"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."org_units" enable row level security;--> statement-breakpoint
alter table "mod_hr"."org_units" force row level security;--> statement-breakpoint
create policy "org_units_ws_isolation" on "mod_hr"."org_units"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."positions" enable row level security;--> statement-breakpoint
alter table "mod_hr"."positions" force row level security;--> statement-breakpoint
create policy "positions_ws_isolation" on "mod_hr"."positions"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."people" enable row level security;--> statement-breakpoint
alter table "mod_hr"."people" force row level security;--> statement-breakpoint
create policy "people_ws_isolation" on "mod_hr"."people"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."people_sensitive" enable row level security;--> statement-breakpoint
alter table "mod_hr"."people_sensitive" force row level security;--> statement-breakpoint
create policy "people_sensitive_ws_isolation" on "mod_hr"."people_sensitive"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."employments" enable row level security;--> statement-breakpoint
alter table "mod_hr"."employments" force row level security;--> statement-breakpoint
create policy "employments_ws_isolation" on "mod_hr"."employments"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."office_assignments" enable row level security;--> statement-breakpoint
alter table "mod_hr"."office_assignments" force row level security;--> statement-breakpoint
create policy "office_assignments_ws_isolation" on "mod_hr"."office_assignments"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."person_history" enable row level security;--> statement-breakpoint
alter table "mod_hr"."person_history" force row level security;--> statement-breakpoint
create policy "person_history_ws_isolation" on "mod_hr"."person_history"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."person_documents" enable row level security;--> statement-breakpoint
alter table "mod_hr"."person_documents" force row level security;--> statement-breakpoint
create policy "person_documents_ws_isolation" on "mod_hr"."person_documents"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."custom_field_defs" enable row level security;--> statement-breakpoint
alter table "mod_hr"."custom_field_defs" force row level security;--> statement-breakpoint
create policy "custom_field_defs_ws_isolation" on "mod_hr"."custom_field_defs"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."calendars" enable row level security;--> statement-breakpoint
alter table "mod_hr"."calendars" force row level security;--> statement-breakpoint
create policy "calendars_ws_isolation" on "mod_hr"."calendars"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_hr"."calendar_days" enable row level security;--> statement-breakpoint
alter table "mod_hr"."calendar_days" force row level security;--> statement-breakpoint
create policy "calendar_days_ws_isolation" on "mod_hr"."calendar_days"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- The invariants, in the database rather than in application code.
--
-- Every one of these is something two concurrent requests could otherwise both "win". Enforcing
-- them here means the loser gets a constraint violation instead of the system holding two
-- contradictory answers to a question an auditor will eventually ask.

create extension if not exists btree_gist;--> statement-breakpoint

-- One workspace, one default office. It is where a person with no assignment lands and where the
-- resolution ladder bottoms out, so two of them would make "which calendar applies" ambiguous.
create unique index "hr_offices_one_default_per_ws"
  on "mod_hr"."offices" (workspace_id)
  where is_default;--> statement-breakpoint

-- No two employment rows for one person may overlap. Without this, a backdated correction racing a
-- forward-dated change leaves two rows in force on the same day, and "what was her FTE in March"
-- has two answers.
alter table "mod_hr"."employments"
  add constraint "hr_employments_no_overlap"
  exclude using gist (
    person_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  );--> statement-breakpoint

-- Nor may one person hold the same office twice over an overlapping period.
alter table "mod_hr"."office_assignments"
  add constraint "hr_office_assignments_no_duplicate"
  exclude using gist (
    person_id with =,
    office_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  );--> statement-breakpoint

-- And exactly one of a person's concurrent assignments may be primary. Only the primary office
-- decides holidays, timezone and policy; two would mean two answers, which is the one thing the
-- multi-office model must never allow.
alter table "mod_hr"."office_assignments"
  add constraint "hr_office_assignments_one_primary"
  exclude using gist (
    person_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  ) where (is_primary);--> statement-breakpoint

-- An org unit's ltree path is unique within a workspace: two departments at the same path would
-- make a subtree query return one of them arbitrarily.
create unique index "hr_org_units_ws_path_uq" on "mod_hr"."org_units" (workspace_id, path);--> statement-breakpoint
create index "hr_org_units_path_gist" on "mod_hr"."org_units" using gist (path);
