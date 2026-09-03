import { defineCapabilities } from '@kernhq/contracts'

/**
 * How much HR this workspace has.
 *
 * HR is the module capabilities were built for. One company wants a staff directory and nothing
 * else; a second wants leave, balances and approvals; a third runs shift rosters and clocks people
 * in at a factory gate. Those are three products under one name, and the alternatives to this
 * registry are a code fork per customer or a navigation rail full of features nobody uses.
 *
 * **A capability is declared here only once something is behind it.** A switch that changes nothing
 * is worse than a missing switch: it teaches an administrator that the switchboard does not mean
 * anything. So this list grows with the module rather than describing where the module is going —
 * `leave`, `attendance`, `overtime`, `rosters`, `periods` and `payroll_export` arrive with the
 * phases that implement them.
 *
 * Two rules that decide whether something belongs here at all:
 *
 * - **Not a permission.** "May Ayşe approve leave" is a permission — true for her, false for someone
 *   else, in the same workspace. "Does this company do leave" is a capability: one answer for
 *   everyone, the owner included.
 * - **Reversible without a migration.** Switching one off writes a boolean into module settings;
 *   the rows stay exactly where they are and switching it back on restores them. Anything that would
 *   need data thrown away is not a capability, however much it looks like one.
 */
export const hrCapabilities = defineCapabilities([
  {
    id: 'core',
    label: 'People',
    description: 'The staff directory, employment records and reporting lines',
    required: true,
    level: 1,
  },
  {
    id: 'offices',
    label: 'Offices',
    description: 'More than one place of work, each with its own country, timezone and holidays',
    dependsOn: ['core'],
    // Off by default, and invisible when off — but the *concept* is never absent. A workspace always
    // has exactly one office, built from its country when HR is enabled, and everybody is assigned
    // to it. Switching this on reveals the list and the assignment control; it does not migrate
    // anything, because the shape was there from the first day. A workspace that only ever has one
    // office never meets the word.
    defaultEnabled: false,
    level: 2,
  },
  {
    id: 'legal_entities',
    label: 'Legal entities',
    description: 'Several employing companies, for a group operating across borders',
    // Depends on offices rather than core: a single-site company has one employer by definition, and
    // the question only becomes real once there is more than one place of work.
    dependsOn: ['offices'],
    defaultEnabled: false,
    level: 3,
  },
  {
    id: 'calendars',
    label: 'Holiday calendars',
    description: 'Public holidays, company closures and the working week',
    dependsOn: ['core'],
    // On by default. Every company has holidays, and a directory that does not know when people are
    // off is answering a question nobody asked.
    defaultEnabled: true,
    level: 1,
  },
  {
    id: 'leave',
    label: 'Leave',
    description: 'Time off: types, balances, requests and approvals',
    dependsOn: ['core', 'calendars'],
    // On by default. Leave is what most companies come to an HR system for, and a directory that
    // cannot answer "who is off next week" is answering a question nobody asked.
    defaultEnabled: true,
    level: 1,
  },
  {
    id: 'leave_accrual',
    label: 'Accrual',
    description: 'Earn leave over time, with proration, carry-forward and expiry',
    dependsOn: ['leave'],
    // Off by default. Plenty of companies grant a fixed allowance on 1 January and never accrue —
    // and for them an accrual engine is a screen full of settings that change nothing.
    defaultEnabled: false,
    // Carry-forward and expiry are named here because they are part of the same switch: a
    // `carry_forward` policy is a `policies` row, and every `policies.*` procedure is gated by
    // *this* capability rather than by `leave` — the `leave_accrual` list in
    // `hrCapabilityProcedures` below names all eight, and each carries `cap('leave_accrual')` in
    // `src/server/router.ts`. There is no `policies` capability; the whole record type lives behind
    // accrual, which is why switching accrual off takes carry-forward and expiry with it. The
    // policy is written on the accrual settings screen beside the accrual policies. The engine had
    // both from the start (`carryForward`, the `carry-forward` job, `carry_in` / `carry_out` /
    // `expiry` in the ledger) while nothing could write the policy, which is the one way this
    // description was ever untrue: the product did it and no administrator could reach it.
    level: 2,
  },
  {
    id: 'periods',
    label: 'Payroll periods',
    description: 'Close a month so a filed payroll cannot move underneath it',
    dependsOn: ['core'],
    defaultEnabled: false,
    level: 2,
  },
  {
    id: 'approvals',
    label: 'Approval chains',
    description: 'Named multi-step approvals with delegation, instead of a single manager',
    dependsOn: ['core'],
    // Off by default: at Level 1 the requester's manager approves, implicitly, and a company with
    // one approver does not need a chain editor to find out that it has one.
    defaultEnabled: false,
    level: 2,
  },
  {
    id: 'attendance',
    label: 'Attendance',
    description: 'Clock in and out, schedules and a daily sheet',
    dependsOn: ['core', 'calendars'],
    // Off by default. Plenty of companies never clock anybody in, and a directory that offers a
    // clock button to salaried staff is offering a feature nobody asked for.
    defaultEnabled: false,
    level: 1,
  },
  {
    id: 'rosters',
    label: 'Shift rosters',
    description: 'Rotating shifts on a calendar, and who covers which office-day',
    // Depends on attendance rather than on core: a roster is what the clock and the day sheet are
    // judged against, and rostering a workspace that never clocks anybody in is a planning grid
    // nothing reads. Off by default and level 3 — most companies work a week that repeats, and for
    // them a rotation editor is a screen full of settings that change nothing.
    dependsOn: ['attendance'],
    defaultEnabled: false,
    level: 3,
  },
  {
    id: 'documents',
    label: 'Employee documents',
    description: 'Contracts, identity documents and certificates against a person',
    dependsOn: ['core'],
    defaultEnabled: false,
    level: 2,
  },
  {
    id: 'payroll_export',
    label: 'Payroll export',
    description: 'Hand a closed period to a payroll provider as CSV, per legal entity',
    // Everything it reads: the day sheet, the periods that say the numbers have stopped moving, and
    // the employment facts under `core`.
    dependsOn: ['core', 'periods', 'attendance'],
    // Off by default, and its own switch rather than riding on the two above — which is the whole
    // argument for it existing. A company can perfectly well clock people in and close its months
    // and still not want every employee's pay basis leaving the building as a file. The permission
    // decides *who* may export; this decides whether the workspace does that at all, and the two
    // answer different questions.
    defaultEnabled: false,
    level: 3,
  },
])

export type HrCapabilityId = (typeof hrCapabilities)[number]['id']

/**
 * The message ids a screen reads a capability's `label` and `description` through.
 *
 * `CapabilityDef.label` is documented as "an i18n message id or an English fallback", and putting
 * the id *in* the field would leave the fallback nowhere: core's module admin and the shell's mock
 * read this manifest raw, with no HR bundle merged, so they would print `hr.cap_leave` at a person.
 * So the literals above stay the fallback and the id is derived from the capability's own id — a
 * capability added to the list becomes translatable the moment somebody writes its two strings, and
 * nothing that parses this list sees a new field.
 *
 * The `hr.` prefix is written out rather than left to `scopedT`, because a caller has to be able to
 * tell a resolved string from a key that resolved to itself, and `t()` answers a miss with the
 * *namespaced* key.
 */
export const capabilityLabelKey = (id: string) => `hr.cap_${id}`
export const capabilityDescriptionKey = (id: string) => `hr.cap_${id}_desc`

/**
 * Which procedures sit behind which capability.
 *
 * Declared as data because a missing `requiresCapability` is invisible: the procedure compiles,
 * every other test passes, and the only symptom is a workspace calling a feature it switched off.
 * `module.test.ts` reads this and fails when a procedure named here is not carrying the middleware.
 *
 * A procedure absent from this map belongs to the module as a whole and is reachable whenever HR is
 * on — which for `core` is always, because it is `required`.
 */
export const hrCapabilityProcedures: Record<string, readonly string[]> = {
  offices: [
    'offices.list',
    'offices.get',
    'offices.create',
    'offices.update',
    'offices.archive',
    'offices.setDefault',
    'offices.assign',
    'offices.unassign',
    'offices.people',
  ],
  legal_entities: [
    'entities.list',
    'entities.get',
    'entities.create',
    'entities.update',
    'entities.archive',
    'entities.costCenters.list',
    'entities.costCenters.create',
    'entities.costCenters.archive',
  ],
  calendars: [
    'calendars.list',
    'calendars.get',
    'calendars.create',
    'calendars.update',
    'calendars.archive',
    'calendars.days.list',
    'calendars.days.add',
    'calendars.days.update',
    'calendars.days.remove',
    'calendars.pack.preview',
    'calendars.pack.apply',
    'calendars.workingDays',
  ],
  documents: ['documents.list', 'documents.attach', 'documents.remove'],
  payroll_export: ['payroll.export.v1', 'payroll.export.preview'],
  leave: [
    'leave.types.list',
    'leave.types.create',
    'leave.types.update',
    'leave.types.archive',
    'leave.balance.get',
    'leave.ledger.list',
    'leave.adjust',
    'leave.requests.list',
    'leave.requests.get',
    'leave.requests.simulate',
    'leave.requests.create',
    'leave.requests.cancel',
    'leave.team.calendar',
    // Same reason as the attendance reports above: a balance report in a workspace with no leave is
    // not zero days, it is a question that does not apply.
    'reports.leaveBalance',
  ],
  attendance: [
    'attendance.state',
    'attendance.clockIn',
    'attendance.clockOut',
    'attendance.breakStart',
    'attendance.breakEnd',
    'attendance.punches.list',
    'attendance.punches.void',
    'attendance.days.list',
    'attendance.days.recompute',
    'attendance.schedules.list',
    'attendance.schedules.create',
    'attendance.schedules.update',
    'attendance.schedules.archive',
    'attendance.schedules.assign',
    'attendance.regularizations.list',
    'attendance.regularizations.request',
    // The three reports built from `attendance_days`. A workspace that never switched attendance on
    // has no day sheet to aggregate, so a report over it would answer zero rather than 404 — which
    // is the shape of lie this map exists to prevent: a number is a worse "not available" than an
    // error, because it looks like an answer.
    'reports.attendance',
    'reports.overtime',
    'reports.absence',
  ],
  rosters: [
    'rosters.shifts.list',
    'rosters.shifts.create',
    'rosters.shifts.update',
    'rosters.shifts.archive',
    'rosters.patterns.list',
    'rosters.patterns.create',
    'rosters.patterns.update',
    'rosters.patterns.archive',
    'rosters.assignments',
    'rosters.assign',
    'rosters.unassign',
    'rosters.days',
    'rosters.set',
    'rosters.clear',
    'rosters.coverage',
  ],
  leave_accrual: [
    'policies.list',
    'policies.get',
    'policies.create',
    'policies.update',
    'policies.archive',
    'policies.assign',
    'policies.unassign',
    'policies.resolveFor',
    'accrual.preview',
    'accrual.run',
  ],
  periods: ['periods.list', 'periods.create', 'periods.lock', 'periods.unlock'],
  approvals: [
    'approvals.chains.list',
    'approvals.chains.create',
    'approvals.chains.update',
    'approvals.chains.archive',
    'approvals.delegate',
    'approvals.revokeDelegation',
    'approvals.delegations',
  ],
}
