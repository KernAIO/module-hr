---
'@kernhq/module-hr': minor
---

Onboarding and offboarding checklists, and the retention sweep — the last two things HR declared
and had not built.

**Checklists** are a new capability. A template names each task, who it falls to (the person, their
manager, HR's pool, or one named person) and when it is due as days from the hire date or the last
day. The default template of each kind starts itself when somebody is hired, moved to `offboarding`
or offboarded; a template is copied at that moment, so editing it never changes a list already
running. Assignees are notified, overdue tasks are chased once each by a nightly sweep, the last tick
closes the list, and every member sees the lists about themselves and the tasks that are theirs
(`checklists.*`, `hr.checklist.view` / `hr.checklist.manage`, `hr.checklist.started` /
`.completed`, Settings → People → Checklists, a Checklists page, a section on the person card and a
dashboard widget). `people.update` now takes `status`, `hiredOn` and `terminatedOn`, and emits
`hr.person.status_changed` when the status moves — until now no API call could move a person
through the lifecycle short of terminating them.

**The retention sweep** acts on the horizons the privacy settings hold, and `sweepEnabled` is a
real switch rather than a literal `false`. Off by default; a dry run by the same code first; a
confirmation naming every class and count; a record of every run — dry, real, nightly, by hand —
with the people it touched; nothing in a locked period is touched (`privacy.retention.run`,
`privacy.retention.runs.list`, migration 0014 adding `retention_runs` and `sweep_enabled`).
