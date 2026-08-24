-- Row-level security. Hand-written, because drizzle-kit does not generate it.
--
-- This is the last line, not the first: the API already checks membership and permission. It exists
-- for the query that skips them — a job, a report, a mistake — and for anyone who reaches the
-- database another way. A tenant table without a policy is simply readable.
--
-- `@kernhq/kernel` exports `rlsPolicySql('mod_hr', 'notes')`, which emits exactly this.
-- Superusers bypass RLS, so a database owned by one will pass a test that proves nothing: run the
-- application as a plain role.
alter table "mod_hr"."notes" enable row level security;--> statement-breakpoint
alter table "mod_hr"."notes" force row level security;--> statement-breakpoint
create policy "notes_ws_isolation" on "mod_hr"."notes"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
