---
'@kernhq/module-hr': minor
---

Scoped personnel records, a real `hr.approval.requested`, and an automatic clock-out that says so.

BREAKING CHANGE: `Person` gains `personnelHidden`, and `clockIn`/`clockOut` accept
`ClientPunchMethod` rather than `PunchMethod` — the same set minus `auto`, which only the nightly
sweep may write. `PunchMethod` itself gains `auto`, so a client that renders a method must handle
it; an unrecognised method now renders its own code rather than claiming a person typed it.

**Three permission keys meant nothing.** `hr.person.view_team`, `hr.person.view_office` and
`hr.person.view_all` were checkboxes in the role editor that no procedure asked about, and
`people.list` applied no viewer scoping at all — so with `hr.person.view` defaulting to `member`,
every member read every colleague's personal email, phone, and hire and termination dates.

The split is by **field, not by row**: a staff directory everyone can open is what a company wants,
so every card still shows name, employee number, work email, photo, status, timezone and office. The
three keys now widen who sees the personnel record behind the card — your own always, then the
org-unit subtree you head plus your direct reports, then an office you head, then the workspace.
`hr.person.manage` implies unbounded read, because `PersonPanel` seeds its edit form from the record
it saves back and would otherwise have blanked a colleague's phone number on an ordinary save.

Enforcement is a computed id set, not middleware. `requires('hr.person.view_team')` would have
looked like it worked and scoped nothing: `Authz.can` falls through to the workspace-level set when
no object-scope binding matches.

**Scope is asked as of today**, through `inForceOn`, not "the row with no end date" — and the office
roster moved to the same predicate, because the two answered one screen differently. Both directions
were wrong: `offboard` writes a last working day that is normally in the future, so a null-end-date
test drops somebody the moment their leaving is recorded and their manager loses the record for the
whole notice period, including the field that says when they go; while a transfer dated in October
and recorded in August would hand the record over five weeks early.

**A redacted field is marked, not blank.** An empty phone field reads as "this person has no phone
number", which is a different and wrong fact — and the directory's Started column was drawing an em
dash for the whole company to every ordinary member. The client cannot infer withheld-versus-empty,
because which people fall inside a team or an office is resolved server-side from the org chart, so
`personnelHidden` is set at the one place that does the nulling.

**`hr.approval.requested` is emitted.** It was declared, carried a doc block describing exactly when
it fires, and fired nowhere — the same defect the `overtime` capability was removed for, made worse
by documenting it. Now emitted from both paths that raise an approval, after the transaction
commits, carrying the first step's approvers only, nothing for a chain that resolved to nobody, and
skipped on an idempotent replay. `hr.attendance.day_computed` is deleted instead: its own comment
said it fires on every punch, and nothing subscribes.

**An automatic clock-out is labelled automatic.** The sweep wrote `method: 'manual'` and a hardcoded
English note, so the machine's punch was presented to the employee as something a person typed, with
its only explanation untranslated on a Persian screen. It writes `auto`; the note is dropped, since
the label and the day's existing `missing_clock_out` anomaly both say it in every locale.

**Carry-forward and expiry are configurable**, which the capability card already promised — the
engine, the job and the ledger entries were all real and only the screen was missing.
`directoryVisibleToMembers` is removed: nothing enforced it, and no route can even reach it.

Also corrects two comments that contradicted the code, one of which claimed a partial settings write
would be dropped when core in fact merges it.
