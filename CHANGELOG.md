# @kernhq/module-hr

## 0.17.0

### Minor Changes

- 71a868e: Subject access, erasure that redacts, retention per data class, and a record of who read a national
  identity number.

  BREAKING CHANGE: `Person` gains `erasedAt`. Erasure is redaction, so an erased record still appears —
  in a headcount, behind a ledger entry, as the subject of a two-year-old approval — and a screen that
  cannot tell it from an ordinary row shows a blank name and reads as broken.

  **`privacy.subjectAccess`** returns what the module holds about one person: the record, the decrypted
  sensitive fields, employment, offices, history with its values, document metadata, leave with its
  ledger and closing balance, attendance, approvals both raised and decided, delegations in both
  directions, the policies in force, the access log — and a `manifest` naming what was truncated and
  what was excluded, because a bundle that quietly stops at a limit is a worse answer than one that
  says where it stopped.

  **`privacy.erase` deletes nothing.** Not one `delete` statement: every step writes through the same
  predicate — rows that still have something to clear — which is what makes the dry run unable to
  drift from the act, and a second run a no-op that leaves the first tombstone date alone. `dryRun`
  defaults to **true**, because core generates MCP tools from module OpenAPI and the no-argument call
  had to be the harmless one. `national_id_enc` and `iban_enc` are set to null rather than orphaned
  from their key: ciphertext whose key is still in `KERN_SECRET` is data behind one environment
  variable.

  Two limits are stated rather than implied. **Erasure makes somebody anonymous to a reader of Kern,
  not to a payroll system** — `employee_no` survives because it is the payroll join key, so anyone
  holding that number and a copy of the payroll can still re-identify an erased person. The stronger
  version costs the join and belongs to a workspace, not to a default. And **there is no `files.delete`
  a module can reach**, so document objects survive and the orphaned photo and sick-note ids are
  recorded in `people.erased_file_ids` for a release that can finish it.

  **Retention** is eight nullable horizons, every one shipping `null`: no legal number is a default,
  and Kern gives no legal advice. Nothing sweeps on a timer — `sweepEnabled` is a literal `false` —
  and the horizons are read in the two places that ship today, `retention.get` counting what has passed
  each one and `erase` citing them in what it kept. Leave retention is per closed `period_year` rather
  than a date cutoff, because ledger rows a live balance cursor still sums over cannot be removed by a
  date.

  **`sensitive_access_log`** records who read an identity number, a birth date or a bank account.
  `kernel.secrets.decrypt` on those columns now exists in exactly one place in the module, five lines
  above the insert that records it, so the export path cannot forget to log. A logging failure fails
  the read: the insert shares a transaction, a database and a connection with the select, so there is
  no state where the read is healthy and the log alone fails — and a subject-access response built on a
  log with silent holes states in writing that nobody read a record that was read. It is filed here
  rather than in core's activity log because `core.audit.view` is an owner/admin default while
  `hr.person.view_sensitive` is held by nobody, so core would publish it to a wider audience than the
  data itself.

  `privacy.accessLog.list` is self-service about yourself and therefore has no procedure-level
  permission — reading who looked at your own bank details is not a thing anybody may lack.
  `hr.privacy.manage` is required for somebody else's log, and for any query by actor, which is an
  investigation rather than a question about yourself.

  **Fixes a live defect found on the way:** `custom_field_defs.sensitive` was declared, stored,
  editable and documented as needing `hr.person.view_sensitive` — and nothing read it, so a field an
  administrator marked sensitive went to every holder of `hr.person.view`, a member default.

## 0.16.0

### Minor Changes

- 71fd126: An approval deadline can now finish the job, approvers are told a request exists, and the dashboard
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
  the decision _as themselves_ — the precise refusal this fixes. A card that never files a delegated
  decision beats one that files it under a name the reader never saw.

## 0.15.0

### Minor Changes

- e047d19: Approval deadlines fire, delegates can decide, and a delegation no longer covers more than it was
  granted for.

  BREAKING CHANGE: `approvals.inbox` takes `status: 'pending' | 'decided'` in place of
  `includeDecided: boolean`. The old flag was _inclusive_ — "also give me the decided ones" — while
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

  **Known limit, stated rather than implied:** the sweep will not _complete_ a request it cannot
  apply. Turning an approved request into booked leave lives in the router's closure where a job
  cannot reach it, so `auto_approve` advances an intermediate step and reminds on a final one. Passing
  those two appliers into the job is the whole of what is missing, and the call site says so.

  **A delegate can decide.** The server already validated delegations; the client never sent
  `onBehalfOfId`. The approvals page derives the identities the reader may file as from `people.me`,
  their live delegations and the step's approvers, and claims nothing without all three — so a caller
  with no delegation sees exactly what they saw before. The dialog states a single delegated identity
  outright and forces a choice when there is more than one, because a decision recorded against the
  wrong person is the worst outcome on that screen. Two buttons that always failed are replaced by
  what they mean: _You have decided_ and _Not your step yet_.

  Twelve message keys were shipping as their own names on the approvals screens and are now written in
  all five locales.

## 0.14.1

### Patch Changes

- refactor(hr): read the redaction flag instead of inferring it

## 0.14.0

### Minor Changes

- b742725: Scoped personnel records, a real `hr.approval.requested`, and an automatic clock-out that says so.

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

## 0.13.2

### Patch Changes

- fix(hr): make the screens and the API tell the truth

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
