---
'@kernhq/module-hr': minor
---

Four reports — attendance, overtime, absence and leave balance — behind `hr.report.view`.

Each is built from `attendance_days` and the leave ledger, never from `punches`: punches are raw and
append-only, a voided punch survives beside its correction, and summing them double-counts every
fix. The day sheet is the projection those punches produce, and it is what payroll reads.

Every report states the scope that produced it. An aggregate computed over the people a reader may
see is a number that means "the company" to one person and "my team" to another, and a report that
does not say which is worse than one that refuses — so the scope is part of the response rather than
an assumption the reader brings.

Where a value cannot be known it says so rather than showing zero. A person with no schedule, a day
outside any period, a leave type with no accrual policy: each has a cell where zero would be a lie,
and zero and unknown are different answers. Aggregation is in SQL rather than over a fetched page,
because a year of `attendance_days` for five hundred people is ~130k rows and summing that in the
process works in a demo and falls over on the first real customer.
