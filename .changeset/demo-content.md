---
'@kernhq/module-hr': minor
---

Fill a workspace created with example content: five departments, eight positions, twelve people with
employments and managers, four leave types with a year's entitlement in the ledger, seven leave
requests (four decided, three waiting) and a week of attendance for three of them.

Nobody seeded here has a Kern account — a person is HR's noun and an account is core's, and inventing
accounts would put strangers in the workspace's member list and mention picker. The one exception is
a person for whoever asked for the demo, so the directory has a face they recognise.

Written through the module's own services (`changeEmployment`, `LedgerService.append`,
`AttendanceService.record`/`recomputeDay`) so the derived rows agree with the raw ones: a balance is
the sum of the ledger and an attendance day is computed from punches, not written beside them.
