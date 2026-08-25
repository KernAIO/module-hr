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
    id: 'overtime',
    label: 'Overtime',
    description: 'Detect and approve time worked beyond the schedule',
    dependsOn: ['attendance'],
    defaultEnabled: false,
    level: 2,
  },
  {
    id: 'documents',
    label: 'Employee documents',
    description: 'Contracts, identity documents and certificates against a person',
    dependsOn: ['core'],
    defaultEnabled: false,
    level: 2,
  },
])

export type HrCapabilityId = (typeof hrCapabilities)[number]['id']

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
  legal_entities: ['entities.list', 'entities.get', 'entities.create', 'entities.update', 'entities.archive'],
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
