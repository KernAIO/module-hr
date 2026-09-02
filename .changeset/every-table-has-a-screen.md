---
'@kernhq/module-hr': minor
---

Every server-complete area of HR now has a screen, and the directory is searchable.

Five contract groups were implemented and tested on the server with nothing on the client calling
them. They are reachable now: **shift rosters** (Settings → People → Rosters for shifts, rotations
and assignments; a Rosters page with a coverage grid and each person's rostered days, with one-day
overrides), **reports** (attendance, overtime, absence and leave balances, each stating its
denominator, its finality and the permission that produced it), **payroll export** (entity, period,
preview with the refusals named, and the three v1 files downloaded as returned), **privacy**
(retention horizons with a dry-run count per class, subject-access bundles, erasure with a preview
and a typed confirmation, and the sensitive-access log on a person's card — readable by the subject
without asking anybody), and **custom fields** (defined in Settings → People → Fields, edited on the
person form, sensitive ones behind the sensitive record's gate).

The directory is in the workspace-wide search index: a person's card carries the display name,
employee number, work email, position and department, and nothing the card hides from a reader
without a personnel key; terminated and erased people are taken back out.

Fixed on the way: `people.update` from a reader who cannot see sensitive custom values no longer
wipes them, because the values they were never shown are carried over unless the patch names them.
The README is the module's own rather than the template's.
