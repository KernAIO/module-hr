# @kernhq/module-hr

## 0.13.1

### Patch Changes

- fix(hr): stop claiming the whole sensitive dialog is encrypted

## 0.13.0

### Minor Changes

- 65b2195: Take the `overtime` capability and both `hr.overtime.*` permission keys out of the contract until
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
  worse than leaving it: with no policy resolved `thresholdMinutes` falls back to 0, so _more_ minutes
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

## 0.12.0

### Minor Changes

- feat(hr): answer the accrual procedures in the mock, with a fixture that tests

## 0.11.0

### Minor Changes

- feat(hr): mount the accrual settings page

## 0.10.5

### Patch Changes

- 7261434: Declare the framework this is built against: `@kernhq/contracts@0.7.0`.

  `^0.6.1` cannot install 0.7.0 — a caret on 0.x never crosses a minor — so a host resolving this
  module from the registry would be told it needs a contracts two releases behind the one every
  service now runs. Typechecked against 0.7.0 in the workspace before the range moved, which is the
  only order that means anything: the umbrella pins contracts to `workspace:*`, so raising a range
  first and compiling second compiles against the old copy and proves nothing.

  The lockfile is refreshed in the same change, because `--frozen-lockfile` compares specifiers and
  a range edit alone fails install before anything is built.

## 0.10.4

### Patch Changes

- fix(hr): make every migration survive being applied twice

## 0.10.3

### Patch Changes

- a3c32a5: Make every migration survive being applied twice.

  `create policy` and `add constraint` have no `if not exists` at all, and `create table` and
  `create index` do not get one by default — so a replay throws. A module migration that throws takes
  down the **whole host service**, not just its own module; `core` hosts five, so one module's replay
  is an outage for every other module in the process.

  A replay is not hypothetical, and this change causes one: drizzle keys applied migrations by content
  hash, so editing these files makes them all run again against schemas that already have their
  objects. That is exactly the case they now survive.

  `src/server/migrations.test.ts` applies the whole folder to a database created from nothing, applies
  it a second time, and asserts each policy exists once and that RLS is forced on every table carrying
  one. Calling `migrateModule` twice does not test this — the second call reads `__migrations`, sees
  the work is done and returns.

## 0.10.2

### Patch Changes

- fix(hr): feed the two settings that were implemented and fed by nobody

## 0.10.1

### Patch Changes

- 834c51d: Publish the framework ranges that were corrected but never shipped.

  The manifest already said `@kernhq/contracts ^0.6.0` and `@kernhq/ui ^0.10.0`, and `check-ranges`
  was green on it — but 0.10.0 on npm still declared `contracts ^0.5.1` and `ui ^0.8.0`, because the
  correction landed without a changeset and so could not be released. Every host resolving this module
  today gets the old peers, and no check could see it: the repository looks right, the registry is not.

  The committed lockfile was stale against the same edit, which is what the last publish actually died
  on — `--frozen-lockfile` compares specifiers, so a corrected range fails install before anything is
  built.

## 0.10.0

### Minor Changes

- 0fbfccf: The approvals inbox names who is asking and reads in the approver's language. An approval request now
  carries its requester as an employee (`requesterPersonId`, resolved to a display name on read — the
  old `requestedBy` was a user id, and employees need not have accounts) and its summary as data
  (`summaryParams`), so the row renders in the reader's locale instead of the sentence the server
  composed in English. `summary` stays as the fallback for rows raised before this migration.

  Decisions are confirmed in a dialog that says what the decision actually does to whom — approving
  leave spends somebody's balance, a middle step only passes the request on — rather than asking a bare
  "are you sure". A person may delegate their queue to a colleague for a window of dates: the request
  appears in the delegate's inbox, a decision made through the delegation records both names against
  the step, and only the person who delegated may revoke it. Delegating is gated behind a new
  `hr.approval.delegate` permission; deciding stays ungated, because your own inbox is yours.

  Offices move from cards to a table — office, type, country, headcount, current local time read down
  columns — with stat tiles above and a settings shortcut for people who may manage them.

## 0.9.3

### Patch Changes

- fix: declare @kernhq/kernel and @kernhq/contracts as peerDependencies

## 0.9.2

### Patch Changes

- chore: refresh the lockfile for the changesets dependency

## 0.9.1

### Patch Changes

- fix(deps): reach the framework that was just published

## 0.9.0

### Minor Changes

- abda72e: HR ships its own screens.

  Five pages, six components, five dashboard widgets, five settings screens, 118 strings in five
  locales, the mock and the API instance move into this package. It is the first migrated module with
  capabilities, and they work unchanged: a contribution declares `capability: 'attendance'` and the
  shell drops it when the workspace has that switched off.

  `core-api.ts` names the slice of core's API this module calls, structurally rather than by importing
  core's router type — hr does not depend on core, and core does not know hr exists.

  Two bugs the move exposed, both invisible while this code lived in the app:

  - `const typeLabel = (t: string) => t('employment_full_time')` — a parameter named `t` shadowing the
    message function, so every branch was a call on a string. It only became visible once the package
    type-checked its own client, which it did not do before.
  - `types.map((t) => …)` was the same shadow, one rename away from the same bug.

## 0.8.0

### Minor Changes

- 73b78aa: Add the monthly accrual and yearly carry-forward jobs.

  Both fan out per workspace and write through the same paths the API uses, so a scheduled credit and
  a manual one are the same operation and cannot drift. The accrual job is idempotent per person, per
  type, per period — a retry after a partial failure credits only what is missing.

  Carry-forward writes **three** entries rather than performing a transfer: what lapsed and what left
  close the old year, and what survived opens the new one. Each year's ledger then sums to what that
  year actually held, which is what turns "your balance went down" into "you had 9 days, 5 carried, 4
  expired above the cap" — a sentence somebody can check against the list. It runs on the 2nd of
  January so a late December accrual has already landed.

## 0.7.0

### Minor Changes

- 0ff46a5: Add policies, accrual and payroll periods.

  **A policy is a row, not a branch.** Leave entitlement, overtime rules and rounding differ per
  company and per country, and encoding that as `if (country === 'TR')` is how a product acquires a
  branch per customer and a release cycle per rule change. A policy carries a kind, a config validated
  by that kind's own schema, and an effective range — so a rule that changed in July is still
  answerable for June.

  **One ladder decides which applies**: `person → office → legal entity → org unit → position →
workspace`, nearest wins. The same order already resolves a calendar, so there is never a second
  precedence rule to remember. It is stored as a `priority` on the assignment, so the database orders
  it rather than a service knowing the sequence by heart, and `policies.resolveFor` reports which rung
  answered — because "why does she accrue differently from her team" is the question this module gets
  asked.

  **Accrual `preview` and `run` are the same computation.** `run` credits exactly what `preview`
  returned; a preview written separately eventually disagrees with the number that lands in somebody's
  balance. It is idempotent per person, per type, per period, because a job that double-credits when
  somebody clicks twice is worse than one that never ran. People who accrue nothing are returned with
  the reason rather than being silently absent.

  **Periods make a filed payroll safe.** Locking a month sets `locked` on every derived day inside it,
  so a recomputation leaves them alone and says which dates it refused to touch. Unlocking is
  deliberately loud — it logs a warning with the reason and reports how many days became movable
  again, because a payroll has usually already been filed against a closed month.

  Two exclusion constraints do work application code should not have to: one assignment of a policy at
  a rung over a period (two overlapping ones at the same priority would make the ladder's answer
  depend on row order), and no two periods of a kind covering the same day for one entity ("is this
  date locked" has to have exactly one answer).

## 0.6.0

### Minor Changes

- feat(hr): the accrual, carry-forward and overtime arithmetic

## 0.5.0

### Minor Changes

- feat(hr): resolve each person's primary office in the directory list

## 0.4.0

### Minor Changes

- c058848: Add attendance: punches, schedules and a derived day sheet.

  **The server stamps the time.** A client's clock is a claim — recorded beside the server's instant
  with the measured skew, and marked `disputed` beyond a threshold — never the thing that decides. A
  system that cannot tell an offline sync from an edited phone clock cannot defend any of its numbers.

  **Raw punches are immutable and the day sheet is derived.** A wrong punch is voided by a correcting
  row that points at it, so "recorded then corrected" and "never recorded" stay distinguishable.
  Everything on the day sheet comes from punches, schedule, calendar and leave and can be thrown away
  and rebuilt, which makes a bad computation a bug to fix rather than data to repair.

  The time arithmetic is a pure layer with no database and no clock of its own, so daylight saving is
  testable as a table. A 09:00–18:00 shift really is an hour shorter on the spring transition and an
  hour longer in autumn; subtracting wall-clock readings reports nine hours every day and quietly pays
  for an hour nobody worked, once a year. An ambiguous wall time resolves to the earlier instant and a
  skipped one to the moment the clock jumps — both deliberate, both tested. Istanbul is in the test
  matrix precisely because Türkiye abolished the change in 2016: proving the code handles transitions
  is worth less if it has invented one.

  A night shift is attributed to **the day it started**, so clocking out at 06:00 on Tuesday finishes
  Monday. The alternative leaves Monday short and Tuesday long — the month adds up while every
  individual day is wrong.

  Punches are partitioned monthly by business date, with a DEFAULT partition so a missing month is a
  slow insert rather than a refused punch. Partitions are created through a SQL function that also
  enables row-level security on them: a partition created with a bare `CREATE TABLE ... PARTITION OF`
  is readable directly by any role holding SELECT on it, whatever the parent's policy says. An
  integration test caught that, not a review.

  Regularization goes through the same approval engine leave uses — which is why that engine was keyed
  by subject type rather than bolted onto leave requests. Jobs fan out per office rather than firing
  once in UTC, because "it is past 3am" is a different moment in every office.

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
