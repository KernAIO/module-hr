---
'@kernhq/module-hr': minor
---

Take the `overtime` capability and both `hr.overtime.*` permission keys out of the contract until
something sits behind them.

BREAKING CHANGE: `hrCapabilities` no longer contains `overtime`, and `HR_PERMISSIONS` no longer
exports `overtimeView` or `overtimeManage`. Nothing in this workspace referenced them. A stored
`{"overtime": true}` in a workspace's module settings is pruned by `resolveCapabilities`, which only
ever reads ids it iterates from the declarations — so no migration is needed and no data is touched.

They were declared ahead of the feature. `overtime` had two permission keys, an entry in the
approval chain editor, a member of `ApprovalSubjectType` and a summary renderer — and no procedure,
no screen, and not one `requiresCapability` site. An administrator could switch it on and off and
change nothing, which is the failure the registry's own doc comment is written to prevent: a
switchboard full of dead switches teaches you the nine live ones mean nothing either. The comment
even names `overtime` among the capabilities that "arrive with the phases that implement them";
`rosters` and `payroll_export` obeyed that and are absent.

Overtime detection is untouched and still ships. `overtimeMinutes` and `beyondCapMinutes` are still
computed, stored and shown on the attendance sheet, because they are real numbers about real worked
time — this removes a promise nothing kept, not a feature. Gating the computation would have been
worse than leaving it: with no policy resolved `thresholdMinutes` falls back to 0, so *more* minutes
would count, and toggling a switch would silently rewrite stored numbers. The nightly reconcile job
has no request context to check a capability in anyway.

`ApprovalSubjectType` keeps `overtime`, `timesheet` and `shift_swap` deliberately. Narrowing the
enum would make `approvals.chains.list` fail output validation for any workspace holding a saved
chain of that subject — a 500 that takes the approvals settings page down. Dead code behind a wire
seam costs nothing and is the pre-work for the phase that builds this.

The approval chain editor now offers only the two subjects this module can actually raise, `leave`
and `regularization`. It had offered all five, so an admin could design, name and save a chain for
overtime, timesheets or shift swaps and then wait for approvals that could never arrive — which
looks configured, and is worse than the feature being absent. `subjectLabel` stays exhaustive so a
chain that was already saved still renders with a name rather than a raw enum value.

`module.test.ts` gains the assertion that was missing. Every check there asked whether a gate names
something real; none asked whether a declared capability has anything behind it, which is why this
survived. Verified failing before the fix.
