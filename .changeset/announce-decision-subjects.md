---
'@kernhq/module-hr': patch
---

Announce the entities an approval decision actually moves: a final decision on leave also announces `leave_request` and `leave_balance` (the deadline sweep too), a regularization decision announces `regularization` and the rebuilt `attendance_day`, a cancellation of approved leave announces the ledger reversal via `leave_balance`, and a retention-horizon save announces `retention_run` so a second admin's save arrives without a reload.