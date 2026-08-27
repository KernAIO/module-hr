---
'@kernhq/module-hr': patch
---

Fixes found while verifying the reports against a real database rather than against their types.

**Every report would have thrown on its first call.** Drizzle expands a bound JS array into a
parameter *list*, so `${ids}::uuid[]` renders as `($1,$2)::uuid[]` and Postgres rejects it. The
types were clean, the tests passed, and nothing would have failed until somebody opened a report.
Found by executing all ten statements against the real schema; fixed with `inArray` on real columns
and an explicit `array[...]` helper inside the raw SQL.

**`LedgerService.balances` overcounted pending leave by the length of the booking.** It joined
`leave_request_days` to `leave_requests` and summed the whole request's `minutes` once per day, so a
five-day request counted five times and `available = balance − pending` was short by four days —
the number an employee reads before deciding whether they can take a fortnight off, wrong by more
the longer the leave. The same query had no period-year filter at all, so pending spanned every year
on record while the ledger beside it was scoped to one. Both fixed: one row per request, scoped
through `exists` on the days.

A request straddling 31 December is counted whole in both years, deliberately. Halving it means
changing what `minutes` means rather than changing this query, and over-reserving at a year boundary
fails in the safe direction — it refuses a booking that would have been allowed rather than allowing
one that should have been refused.

**Work on an unscheduled day was inflating the worked ratio above 1.** `scheduledWorkedMinutes` now
counts only what the schedule asked for.

**The four report procedures are listed in `hrCapabilityProcedures`**, which is what lets
`module.test.ts` enforce their capability gates rather than merely permit them. A report over a
workspace with attendance switched off must answer 404, not zero: a number is a worse "not
available" than an error, because it looks like an answer.
