# @kernhq/module-hr

People for [Kern](https://github.com/KernAIO/app): the staff directory, and everything a company
records about the people in it — where they work, who they report to, when they are off, when they
clocked in, what they may be paid for, and who has read their file.

This is a first-party Kern module. Contract, server, screens, strings and manifest ship in one
package — `core` imports `hrModule`, the app shell registers `hrClientModule`, and deleting the
package removes the feature completely. Enable it per workspace in **Settings → Modules**; it
appears in the rail as **People**.

## Three products under one name

One company wants a directory and nothing else. A second wants leave, balances and approvals. A
third runs shift rosters and clocks people in at a factory gate. HR is the module Kern's
capabilities were built for, so each of those is a workspace with different switches on in
**Settings → People → Capabilities**, not a fork. A capability that is off is not greyed out — its
navigation, its settings pages, its widgets and its procedures are not there, and the API answers
**404 rather than 403**. Switching one off destroys nothing; the rows stay where they were and come
back with the switch.

The capabilities, and what each one puts behind itself:

- **People** (always on) — the directory, employment records, departments, positions, reporting
  lines and the org chart. A person is HR's noun; an account is core's. Plenty of employees
  never sign in, so a person may have no account, and an account leaving the workspace clears the
  link and keeps the record — employment history outlives an account, and "she left, so we deleted
  her file" is the answer that fails an audit.
- **Offices** — more than one place of work, each with a country, a time zone and its own holidays.
  Off by default and *invisible* when off, but the concept is never absent: every workspace has
  exactly one office, built from its country the moment HR is switched on, and everybody is assigned
  to it. Switching this on reveals the list; it migrates nothing.
- **Legal entities** — several employing companies in one workspace, for a group operating across
  borders. Payroll periods and the payroll export are per entity, because two entities are two
  filings, in two currencies, to two authorities. **Cost centres** sit behind the same switch: the
  budget hours are booked against, optionally following an office, a department or an employer, and
  carried into the payroll file as a code.
- **Holiday calendars** — public holidays, company closures and the working week. **Country packs**
  for Türkiye, Germany, the United Kingdom, the United States, the Netherlands and Iran ship as
  data a workspace applies one year at a time and then edits; a pack is a default, not legal advice,
  and every screen that offers one says so. Holidays that move — Easter, and every Islamic holiday —
  are published per year rather than computed, and the preview says when a year is not listed.
- **Leave** — leave types (days, half days or hours; paid or not), balances kept as an append-only
  ledger, requests exploded into days against the calendar, a team calendar that says somebody is
  away without saying why, and approvals.
- **Accrual** — earn leave over time, with proration, carry-forward and expiry, resolved through a
  policy ladder (person, then primary office, then legal entity, then org unit, then workspace) with
  a preview that is computed by the same code as the run. Accrual periods can follow the Persian
  calendar as well as the Gregorian one.
- **Payroll periods** — close a month so a filed payroll cannot move underneath it. A locked day is
  refused by every write that would change it, including the nightly reconciliation.
- **Approval chains** — named multi-step approvals with delegation, reminders, escalation and
  timeouts, instead of the implicit "your manager approves" a workspace gets without the switch.
- **Attendance** — clock in and out, breaks, weekly schedules with grace and rounding, overnight
  shifts attributed to the right business date, a daily sheet that carries scheduled, worked,
  late, early-leave and overtime minutes, regularisations, and an auto-clock-out sweep.
- **Shift rosters** — rotating shifts on a calendar for workplaces a weekly schedule cannot
  describe (4-on-4-off has no weekly period). Named shifts, a rotation as a cycle and an anchor
  date, people assigned out of phase with one another, one-day overrides that survive, and a
  coverage grid answering "who is on Early on Tuesday" and "who could I call in".
- **Employee documents** — contracts, identity documents and certificates against a person, held
  in core's file storage; HR records that a person has a file and never holds a byte.
- **Payroll export** — a closed period handed to a payroll provider as CSV, per legal entity, in a
  frozen v1 shape: identity, the period, the employment facts a provider picks a rate from, and
  quantities in minutes and days. **Kern computes no pay.** There is no gross, no net, no rate and no
  currency amount anywhere in the file, and the export refuses an open period, an entity with nobody
  in it, or a person with no employment covering their days — a draft is the one escape, and a draft
  stamps itself in the manifest, the filename and every row.

Two things are not capabilities, on purpose:

- **Reports** — attendance, overtime, absence and leave balances, each stating its own denominator
  ("47 hours · 12 of 38 people · 1–31 October · Istanbul office"), which permission produced it,
  and whether the figures are final. Unknown is never zero: a person with no schedule has no
  attendance percentage, an office with no calendar has no expected days, and overtime beyond a
  ceiling is null where no ceiling was in force.
- **Privacy** — subject access (everything HR holds about one person, in one bundle, decrypted and
  therefore logged as an export), erasure (redaction that clears what identifies a person and keeps
  every record a wage, an entitlement or an authorisation was computed from — and says, per class,
  what it kept and why), retention horizons per class with a dry-run count of what has passed each
  one, and the **sensitive access log**: every read of somebody's identity number, birth date or
  bank details is written in the same transaction as the read, and the subject can read their own
  log without asking anybody. A workspace that could switch privacy off would be a workspace that
  stopped honouring subject requests, so there is no switch.

Also always on: **custom fields** on a person (text, number, date, select, multi-select, yes/no,
URL; per section; optionally *sensitive*, which puts the value behind the same key as a national
identity number), and the directory in the **workspace-wide search index**, carrying exactly what
the directory card shows everybody and nothing it hides.

## Permissions

Thirty-nine keys, and the shape worth knowing is the **widening ladder** on a person's record:
`hr.person.view` is a `member` default and stays one — a staff directory a colleague cannot open is
a worse product, not a safer one — and what the three widening keys (`view_team`, `view_office`,
`view_all`) decide is how much of each row comes back. Everybody gets the card; the personnel
fields (personal email, phone, hire and termination dates) arrive only for the people the reader
may see the file of. `hr.person.view_sensitive` is held by nobody by default, and every read under
it is logged. Reports cost `hr.report.view` *and* the key that already guards the rows they sum, so
a report can never answer a question its row-level procedure would refuse. `hr.privacy.manage` is
granted to nobody by default.

## The API

One hundred and thirty-seven procedures under `/api/hr`, in groups: `people`, `employment`, `org`,
`offices`, `entities`, `calendars`, `documents`, `policies`, `accrual`, `periods`, `attendance`,
`rosters`, `leave`, `approvals`, `fields`, `reports`, `payroll` and `privacy`. Every procedure sits
behind the workspace gate, its capability where it has one, and a permission this module declares;
`src/module.test.ts` walks the contract and the router as data and fails when any of the three is
missing. Two more answers are reachable only from another service over `kernel.call` —
`hr.person.byUserId` and `hr.person.get` — so a module holding an id never has to learn the shape of
`mod_hr`.

Six scheduled jobs: partition maintenance for the punch table, leave accrual, carry-forward and
expiry, auto-clock-out, approval reminders and timeouts, and the nightly reconciliation of open
day sheets. Thirteen events, from `hr.person.created` to `hr.calendar.changed`, carry ids and never
rows.

## Not built

- **Onboarding and offboarding checklists.** A person has a status, and a leaver raises a return
  list in the inventory module; there is no task list attached to either transition.
- **Performance reviews.**
- **Retention sweeps.** The horizons are set and counted; no job acts on them yet. An unattended
  job that prunes personnel records is the one act here that re-running nothing can undo, so it
  ships off until it has a dry run and a per-run report naming every person it touched — and
  `sweepEnabled: false` on the settings says so rather than claiming otherwise.
- **Retention per legal entity.** Horizons are workspace-wide today; a Dutch and a Turkish entity
  have different obligations, and the row already carries the config to make that an added column.
- **Computed moving holidays.** Islamic and Easter dates are published per year in the packs.
- **A cost-centre slice on reports**, which waits on the resolution ladder carrying a cost centre.

## Developing

```bash
pnpm install
pnpm typecheck   # tsc + svelte-check over the client
pnpm test        # unit, and the integration suite against a scratch Postgres
pnpm build
pnpm db:generate # drizzle-kit → migrations/ (RLS policies are hand-written)
```

Twelve migrations, every one of them replayable: `src/server/migrations.test.ts` applies the folder
to a database created from nothing and then applies it again, `journal.test.ts` keeps the journal's
timestamps in order (a later entry with an earlier timestamp is skipped silently, and only on
databases that already exist), and `scripts/check-snapshot-drift.mjs` asks Postgres to build what the
newest snapshot describes and compares. The punch table is partitioned by month, and the
`ensure-partitions` job keeps a partition ahead.

This package follows the standard Kern module shape: one contract shared by both halves, a server
module hosted by core, and a client module whose screens ship inside this package. See
`docs/adr/0007-module-capabilities.md` and `docs/adr/0008-a-module-ships-its-own-screens.md` in the
app repository for the reasoning.

## Licence

AGPL-3.0-only. This module is part of the Kern product; anything you build for your own Kern
instance does not have to be released, but modifications to this module do.
