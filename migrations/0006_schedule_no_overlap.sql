-- Two schedules may not be in force for one person on the same day.
--
-- `employments`, `office_assignments`, `policy_assignments` and `periods` each got an exclusion
-- constraint the day their table was created; `schedule_assignments` was the one effective-dated
-- table left with nothing but a btree, and the gap is not theoretical. `scheduleFor` selects the
-- assignment in force with `limit 1` and no `order by`, so with two rows in force it takes whichever
-- the executor hands back first — and the inline recompute and the nightly job read at different
-- times, on different plans. The symptom is `scheduled_minutes`, `late_minutes` and
-- `overtime_minutes` changing between one computation and the next, on rows a locked payroll period
-- has already been filed against.
--
-- The overlap is easy to create: `attendance.schedules.assign` closes only rows whose `effective_to`
-- is null, so a backdated assignment lands on top of an already-closed row and neither is trimmed.

-- ---------------------------------------------------------------------------------------------
-- Repair first. An exclusion constraint is validated in full when it is added, so one overlapping
-- pair anywhere in the instance aborts the whole migration and the release with it.
--
-- The repair is the rule `assign` already means to apply, run over every row rather than only the
-- open one: each assignment ends the day before the next one for that person begins. Nothing is
-- deleted — an effective-dated table exists to answer "which schedule was she on in March", and a
-- row removed to satisfy a constraint takes that answer with it. Rows are ordered by
-- `(effective_from, created_at, id)` so two assignments starting on the same day resolve the same
-- way every time: the later-created one wins, and the earlier is left recording a period that
-- covers no day.
--
-- `force row level security` is on this table, and a migration runs on a plain pooled connection
-- with no `app.workspace_id` set — so the policy evaluates to null for every row and an UPDATE here
-- would report success having touched nothing. FORCE means the owner is not exempt either. The
-- table is unforced for the length of the repair and forced again immediately; ALTER TABLE holds an
-- ACCESS EXCLUSIVE lock, and drizzle runs the folder in one transaction, so no other session can
-- read the table through the gap.
alter table "mod_hr"."schedule_assignments" no force row level security;--> statement-breakpoint

with ordered as (
  select
    "id",
    "effective_from",
    "effective_to",
    lead("effective_from") over (
      partition by "workspace_id", "person_id"
      order by "effective_from", "created_at", "id"
    ) as next_from
  from "mod_hr"."schedule_assignments"
)
update "mod_hr"."schedule_assignments" a
   set "effective_to" = ordered.next_from - 1
  from ordered
 where a."id" = ordered."id"
   and ordered.next_from is not null
   and (a."effective_to" is null or a."effective_to" >= ordered.next_from);--> statement-breakpoint

alter table "mod_hr"."schedule_assignments" force row level security;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- The constraint. Same shape as `hr_employments_no_overlap`, with one addition the others do not
-- carry: rows whose `effective_to` fell before their `effective_from` sit outside it.
--
-- `daterange(from, to, '[]')` does not return an empty range for a reversed pair, it raises — so
-- without the predicate a backdated assignment would fail at `assign` time with a raw Postgres
-- range error instead of doing the sensible thing. Such a row applies to no day (`inForceOn` needs
-- `effective_from <= d` and `effective_to >= d` at once, which it can never satisfy), so it cannot
-- be the second schedule in force that this constraint exists to prevent.
--
-- `add constraint` has no `if not exists`, hence the catalogue check — the same shape
-- `ensure_punch_partition` uses in 0003 for `create policy`.
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'mod_hr'
       and t.relname = 'schedule_assignments'
       and c.conname = 'hr_schedule_assign_no_overlap'
  ) then
    alter table "mod_hr"."schedule_assignments"
      add constraint "hr_schedule_assign_no_overlap"
      exclude using gist (
        "person_id" with =,
        daterange("effective_from", "effective_to", '[]') with &&
      ) where ("effective_to" is null or "effective_to" >= "effective_from");
  end if;
end $$;
