# @kernhq/module-hr

## 0.3.0

### Minor Changes

- 8cc9f87: Add leave and the shared approval engine.

  **A balance is a sum, never a stored number.** Every grant, accrual, consumption, reversal, expiry
  and adjustment is an append-only ledger entry. Cancelling approved leave inserts a reversal; it does
  not delete the consumption, because "she booked it and cancelled" and "she never booked it" are
  different facts and only one of them is true. That costs a little arithmetic and buys the only thing
  that matters when an employee and HR disagree about a number: a list of what happened, in order,
  that nobody edited.

  The two ways a balance goes wrong under load are both refused by the database rather than by
  application code. A cursor row taken `FOR UPDATE` serialises spending, so two overlapping requests
  for the last day cannot both read "enough". A partial unique index across `(person, date)` for
  counted days in a live status means a person cannot hold two live requests covering one Tuesday —
  and it is partial so that a cancelled request stops blocking the date.

  **One approval engine, keyed by subject type**, so regularization, overtime and timesheets attach to
  it later without a schema change. The chain is snapshotted onto the request when it is raised and
  approvers are resolved to people then, so editing a workflow — or a reorganisation — cannot change
  who has to sign something already in flight. One decision per approver per step, enforced by a
  unique index: a double click is one decision, not two towards a quorum. Delegation records both
  people, so "who approved this" never becomes ambiguous. A chain that resolves to nobody
  auto-approves, because a one-person company has no manager and still has to book time off.

  Two capabilities: `leave` (on by default) and `approvals` (off — at Level 1 the requester's manager
  approves implicitly, and a company with one approver does not need a chain editor to discover that).

## 0.2.0

### Minor Changes

- 767c9e8: Add the HR module: people, offices, org chart and holiday calendars.

  A staff directory with effective-dated employment records, an ltree org chart, positions, employee
  documents and custom fields — plus the two things that make it work for a company with more than one
  place of work:

  **Offices are the unit of inheritance.** A workspace always has exactly one, built from its country
  when HR is enabled, so turning the `offices` capability on is a reveal rather than a migration and
  nothing has a "no office" branch. A person may hold several concurrently, but exactly one is primary
  and only the primary decides holidays, timezone and policy — otherwise "how many days off do I have"
  has two answers. `offices.resolveFor` reports which rung of the ladder answered, so a support
  question does not need a database session.

  **Calendars compose rather than copy.** An office calendar `extends` a country pack and its own days
  sit on top, with `source` tracked per day — so a pack refresh replaces pack days and never touches
  one HR added, and `calendars.pack.preview` lists what survives before anything is applied. Six packs
  ship (TR, DE, GB, US, NL, IR) as data with their sources named; Iran's Friday weekend and half
  Thursday are why the working week is a calendar field rather than an assumption.

  Capabilities: `core` (required), `offices`, `legal_entities`, `calendars`, `documents`. Declared only
  where something is behind them.

  The invariants are database constraints, not application code: one default office per workspace, no
  overlapping employment rows, one primary office per person per day.
