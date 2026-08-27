---
'@kernhq/module-hr': minor
---

An approval deadline can now finish the job, approvers are told a request exists, and the dashboard
stops offering decisions it cannot file.

**A timeout could not complete a request.** `applyApproval` and `applyRegularization` lived inside
the router's closure, so the sweep would advance an intermediate step and then refuse the step that
would finish one — logging that it could not apply the subject, and reminding instead. They now live
in `hrSubjects(deps)`, which both the router and the job build `ApprovalService` from, so a human
decision and a deadline run one implementation rather than two that drift. `appliersFor(actorId)`
carries the only thing the two callers genuinely disagree about: a person is written onto the ledger
entry as `created_by`, a deadline as nobody.

The appliers run inside the sweep's transaction, which is what makes a decision and its booking
atomic — and therefore lets one unbookable request abort the sweep. Unguarded that is one tenant
stopping every other tenant's deadlines, hourly and indefinitely, so each workspace is wrapped and
the loop continues. Nothing is swallowed: the sweep is one transaction, so a workspace that throws
changed nothing and is swept again on the next tick.

**Nobody was told a request had been raised.** The sweep reminded approvers about work they had
never been notified of in the first place. Both raise paths now notify the first step's approvers
after the transaction commits, on exactly the sweep's terms — same group key, so a later reminder
collapses onto the same card rather than ringing a second bell for one piece of work. The module
declares its four `notificationTypes`, so they can be muted per type instead of arriving on the
defaults.

**The dashboard offered Approve on rows the server would refuse.** Three kinds of row came back from
the inbox and the card treated them alike: ones the reader is named on, ones they may decide only as
a delegate, and ones resting on a step further down a chain — `inboxFor` matches every step index,
so a two-step chain puts each request in the second approver's inbox the moment it is raised. The
last two fail identically, and both landed on a generic error.

The card now classifies from `people.me` and the row's own approvers, and hands anything it cannot
decide honestly to the approvals page. It deliberately does not name a delegator: that needs a
permission-gated query, and a reader holding a delegation but not that key would have been offered
the decision *as themselves* — the precise refusal this fixes. A card that never files a delegated
decision beats one that files it under a name the reader never saw.
