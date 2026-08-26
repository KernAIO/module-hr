-- Two queries that ran without an index they could use. Neither is new; both only get slower.

-- ---------------------------------------------------------------------------------------------
-- The approvals inbox.
--
-- `inboxFor` asks `approver_ids && ARRAY[…]::uuid[]`, and the three btrees on this table cannot
-- answer an array overlap at all — so the query a manager triggers every time they open the inbox
-- read the whole table, and the table has no ceiling: a step is written for every request ever
-- raised and never removed.
--
-- Plain GIN, not `btree_gin`: GIN indexes the array's elements, which is exactly what `&&` searches.
-- Folding `workspace_id` in beside it would need the extension and buys nothing — the overlap has
-- already reduced the table to the rows naming this approver by the time the workspace filter runs.
create index if not exists "hr_approval_steps_approvers_idx"
  on "mod_hr"."approval_steps" using gin ("approver_ids");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- The auto-clock-out sweep.
--
-- The hourly job asks for punches on `workspace_id`, `direction = 'in'`, `voided_by_punch_id is
-- null` and `at <= cutoff`. Before this index none of those four columns was indexed —
-- `hr_punches_person_idx` starts on `(workspace_id, person_id, …)` and `hr_punches_idem_uq` is
-- partial on `idempotency_key` — so the sweep scanned every partition of a table sized at half a
-- million rows a year, once an hour, for every workspace.
--
-- Why the split between predicate and columns is the way round it is: `voided_by_punch_id is null`
-- is emitted literally, so the planner can always prove the query implies the partial predicate,
-- while `direction = 'in'` arrives as a bind parameter that a generic plan cannot match against a
-- constant in a predicate. A predicate the planner cannot prove is an index the query never uses.
--
-- Created on the partitioned parent, which is what makes it a partitioned index: Postgres builds a
-- matching index on every existing partition and on every one `ensure_punch_partition` creates
-- later. That also rules out `concurrently` — Postgres does not support it on a partitioned parent,
-- and drizzle runs the whole folder in one transaction regardless. On an instance with real punch
-- history this statement holds a write lock for the length of the build.
create index if not exists "hr_punches_open_idx"
  on "mod_hr"."punches" ("workspace_id", "direction", "at")
  where "voided_by_punch_id" is null;
