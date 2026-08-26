-- An approvals inbox has to say who is asking, and say it in the reader's language.
--
-- Two gaps, both additive so the previous image still reads this schema:
--
--   * `requested_by` holds a *user* id, and an employee need not have a Kern account — so the
--     inbox had no way to name the person whose leave it was showing.
--   * `summary` was composed on the server in English ("2 day(s) from 2026-08-01"), which is what
--     a Persian approver saw whatever locale the shell was in. The same sentence as data lets the
--     client render it, and `summary` stays as the fallback for rows raised before this.
alter table "mod_hr"."approval_requests"
  add column if not exists "requester_person_id" uuid;--> statement-breakpoint

alter table "mod_hr"."approval_requests"
  add column if not exists "summary_params" jsonb;--> statement-breakpoint

-- The inbox lists by approver and then names the requester, so the lookup is by request, not by
-- requester — this index is for "everything Ayşe has asked for", which the person page reads.
-- `requested_at` is the ORM's name for it; the column is `created_at`, from the shared helper.
--
-- `desc nulls last`, not bare `desc`. Postgres reads `desc` as DESC NULLS FIRST, while drizzle
-- writes DESC NULLS LAST for `t.requestedAt.desc()` — so the database and the snapshot described
-- the same index differently, permanently and invisibly, until check-snapshot-drift.mjs learned to
-- compare sort order.
--
-- No corrective migration for instances that already ran this. `created_at` is NOT NULL, so the two
-- orderings are indistinguishable: there is no row for the null ordering to place. Dropping and
-- rebuilding the index would take an ACCESS EXCLUSIVE lock to change nothing anybody can observe.
-- Every statement in this file is `if not exists`, so re-running it after this edit is a no-op.
create index if not exists "hr_approval_requests_requester_idx"
  on "mod_hr"."approval_requests" ("workspace_id", "requester_person_id", "created_at" desc nulls last);
