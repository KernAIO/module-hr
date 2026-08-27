---
'@kernhq/module-hr': minor
---

A payroll export: versioned, per legal entity, behind `hr.payroll.export` and a `payroll_export`
capability.

**Kern does not compute pay, and the export is where that boundary is drawn.** It carries minutes,
days and the employment facts that decide a rate — no rates, no gross, no tax. Everything a payroll
provider needs to do its own job, and nothing that would make Kern look like it had done it for them.

**`v1` is a procedure, not a parameter.** A later column set ships as `payroll.export.v2` beside it
rather than changing what `v1` returns, so a customer's import cannot be broken by a release they
did not ask for. The version travels in the data as well as the filename, because a file renamed on
the way to a payroll system must still say what shape it is.

**Per legal entity, and `legalEntityId` is required.** A workspace is not an employer: a group
employs people through several companies with different providers and different closing days, so
there is no workspace-wide export to ask for.

**It refuses rather than guesses.** An open period, a person with no employment row covering their
days, an entity with nobody in it — each is an error naming what is wrong, not a row of zeros. A
row of zeros is something a payroll clerk will pay from; an error is not.

The capability is its own switch rather than riding on `attendance` and `periods`, which it also
requires. A company can clock people in and close its months and still not want every employee's pay
basis leaving the building as a file: the permission decides *who* may export, the capability decides
whether the workspace does it at all, and those are different questions.
