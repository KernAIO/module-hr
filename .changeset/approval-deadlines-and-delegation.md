---
'@kernhq/module-hr': minor
---

Approval deadlines fire, delegates can decide, and a delegation no longer covers more than it was
granted for.

BREAKING CHANGE: `approvals.inbox` takes `status: 'pending' | 'decided'` in place of
`includeDecided: boolean`. The old flag was *inclusive* — "also give me the decided ones" — while
every caller used it as an exclusive two-tab switch, so the Decided tab listed requests nobody had
decided. Both halves read correctly alone, which is why it survived. An enum makes each tab exactly
what it says.

**A delegation could be used beyond its scope.** `Delegation.subjectType` is documented as "null
delegates every subject type", so a value means one kind and only that kind — and neither
`mayActFor` nor `inboxFor` looked at it. Someone handed leave cover for a fortnight could also sign
off attendance corrections, and overtime and timesheets once they exist. Never "decide as anybody",
since a live delegation from that person was still required, but wider than its author granted.
Both now filter on it. Null is matched explicitly, because `eq` on a null column yields null rather
than true and would have refused exactly the delegations that cover everything; and one person may
delegate twice with different scopes, so the check keeps a set per delegator rather than a single
value.

**Step deadlines do something.** `slaHours` and `onTimeout` have been in the chain editor since it
shipped and nothing read them, so a step with a 24-hour SLA waited exactly as long as a step with
none. The `approval-timeouts` job runs hourly, fans out per workspace, and reminds, escalates or
auto-approves. `timeout_handled_at` with `timeout_action` is what stops an hourly sweep reminding
the same step for ever against a deadline that stays passed, and the pair is readable without a log:
`on_timeout = 'escalate'` with `timeout_action = 'remind'` is an escalation that had nobody above it
to go to.

An auto-approval is recorded as a decision and is distinguishable from a person's: `source` on
`approval_decisions` says a timeout did it, and `approver_id` carries the nil UUID, which `uuidv7()`
cannot produce and no person can hold. A row that could not say so is one somebody eventually reads
as "her manager approved it".

**Known limit, stated rather than implied:** the sweep will not *complete* a request it cannot
apply. Turning an approved request into booked leave lives in the router's closure where a job
cannot reach it, so `auto_approve` advances an intermediate step and reminds on a final one. Passing
those two appliers into the job is the whole of what is missing, and the call site says so.

**A delegate can decide.** The server already validated delegations; the client never sent
`onBehalfOfId`. The approvals page derives the identities the reader may file as from `people.me`,
their live delegations and the step's approvers, and claims nothing without all three — so a caller
with no delegation sees exactly what they saw before. The dialog states a single delegated identity
outright and forces a choice when there is more than one, because a decision recorded against the
wrong person is the worst outcome on that screen. Two buttons that always failed are replaced by
what they mean: *You have decided* and *Not your step yet*.

Twelve message keys were shipping as their own names on the approvals screens and are now written in
all five locales.
