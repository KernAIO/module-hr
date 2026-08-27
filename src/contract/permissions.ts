import { definePermissions } from '@kernhq/contracts'

/**
 * Who may see and change what.
 *
 * HR holds the most sensitive data in the product, so the split is finer than other modules':
 *
 * - **Your own record is not a permission.** Everybody reads and edits their own profile; there is
 *   no `hr.person.view_self` because a permission somebody can never lack is noise in the role
 *   editor. The router enforces it by identity instead.
 * - **Three widths of "other people".** `view_team` is the org-unit subtree you head plus your direct
 *   reports; `view_office` is everybody assigned to an office you administer, which is what a local
 *   HR person in Amsterdam holds; `view_all` is the workspace. None of them implies the others, so a
 *   country HR manager does not silently become a global one.
 * - **Sensitive fields are their own pair.** A directory is `hr.person.view`. A national identity
 *   number, a birth date and a bank account are `hr.person.view_sensitive`, which nobody holds by
 *   default — not even an owner's role, though an owner passes every check anyway.
 *
 * `scope: 'object'` on the team and office reads is deliberate: `PermissionScopeKind` has no
 * `org_unit` or `office` member, and adding one is a change to `@kernhq/contracts` that would have
 * to roll through the kernel and core. Binding at object scope with the unit or office id gets the
 * same result today; `HrAccessService` is what resolves it.
 */
export const hrPermissions = definePermissions([
  // ---------------------------------------------------------------- people
  {
    key: 'hr.person.view',
    label: 'View the staff directory',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'hr.person.view_team',
    label: "View your team's records",
    scope: 'object',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.person.view_office',
    label: "View an office's records",
    scope: 'object',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.person.view_all',
    label: 'View every record in the workspace',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.person.manage',
    label: 'Add, edit and offboard people',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.person.view_sensitive',
    label: 'View identity, birth date and bank details',
    description: 'Personal data protected under GDPR and KVKK. Grant to HR only.',
    scope: 'workspace',
    // Nobody by default. An owner passes every check regardless of the grant, which is the one
    // unavoidable hole; every other holder had to be given it deliberately.
    defaultRoles: [],
    dangerous: true,
  },
  {
    key: 'hr.person.manage_sensitive',
    label: 'Edit identity, birth date and bank details',
    scope: 'workspace',
    defaultRoles: [],
    dangerous: true,
  },

  // ---------------------------------------------------------------- employment
  {
    key: 'hr.employment.view',
    label: 'View employment records and history',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.employment.manage',
    label: 'Change job, manager, department or hours',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: true,
  },

  // ---------------------------------------------------------------- org
  {
    key: 'hr.org.view',
    label: 'View the org chart, departments and positions',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'hr.org.manage',
    label: 'Change departments, positions and reporting lines',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },

  // ---------------------------------------------------------------- offices
  {
    key: 'hr.office.view',
    label: 'View offices',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'hr.office.manage',
    label: 'Add and edit offices',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.office.assign',
    label: 'Assign people to offices',
    // Separate from `manage`: a local HR person moves people between their own offices without being
    // able to create one or change its country, which would change everybody's holidays.
    scope: 'object',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },

  // ---------------------------------------------------------------- legal entities
  {
    key: 'hr.entity.view',
    label: 'View legal entities and cost centres',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.entity.manage',
    label: 'Add and edit legal entities and cost centres',
    scope: 'workspace',
    defaultRoles: ['owner'],
    dangerous: false,
  },

  // ---------------------------------------------------------------- calendars
  {
    key: 'hr.calendar.view',
    label: 'View holiday calendars',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member', 'guest'],
    dangerous: false,
  },
  {
    key: 'hr.calendar.manage',
    label: 'Add and edit holidays and closures',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },

  // ---------------------------------------------------------------- documents
  {
    key: 'hr.document.view',
    label: 'View employee documents',
    scope: 'workspace',
    defaultRoles: [],
    dangerous: true,
  },
  {
    key: 'hr.document.manage',
    label: 'Attach and remove employee documents',
    scope: 'workspace',
    defaultRoles: [],
    dangerous: true,
  },

  // ---------------------------------------------------------------- leave
  {
    key: 'hr.leave.request',
    label: 'Request time off',
    // Everybody. A permission an employee cannot lack is noise, but this one is genuinely revocable
    // — a contractor who books time off through their agency should not have the button.
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'hr.leave.view',
    label: 'View leave types and your own balance',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'hr.leave.view_team',
    label: "View your team's leave and balances",
    scope: 'object',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.leave.view_ledger',
    label: "View the movements behind somebody's balance",
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.leave.manage',
    label: 'Configure leave types',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.leave.adjust',
    label: "Change somebody's balance by hand",
    description: 'Adds or removes leave directly. Every adjustment is recorded with its reason.',
    scope: 'workspace',
    defaultRoles: [],
    dangerous: true,
  },

  // ---------------------------------------------------------------- attendance
  {
    key: 'hr.attendance.punch',
    label: 'Clock yourself in and out',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'hr.attendance.view',
    label: 'View your own attendance',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'hr.attendance.view_team',
    label: "View your team's attendance",
    scope: 'object',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.attendance.manage',
    label: 'Correct punches and set schedules, rosters and day sheets',
    description:
      'Voids punches and recomputes days. Every change leaves the original visible. Also edits ' +
      'shifts and rotations and puts people on them, which decides what a shift worker is ' +
      'expected to turn up for.',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: true,
  },
  // No `hr.overtime.*` here. Overtime is detected, stored and shown as part of attendance, and
  // nothing asks a question these keys could answer — a role checkbox that gates nothing teaches an
  // administrator the same lesson a dead capability switch does. They come back with the approval
  // flow that needs them.
  //
  // No `hr.roster.*` either, for the same reason and after weighing it. Rostering is `manage`:
  // deciding what somebody was meant to work is the same authority as correcting what they did, and
  // both feed the same day sheet. Reading a roster is `hr.attendance.view` for your own and
  // `hr.attendance.view_team` for anybody else's — the coverage grid asks for the second, which is
  // already what `attendance.days.list` costs to read a whole office. Four new keys would gate
  // nothing the three existing ones do not already gate, which is how `hr.overtime.*` came to be
  // deleted. They arrive if a workspace ever needs a planner who may roster and may not correct.

  // ---------------------------------------------------------------- reports
  {
    key: 'hr.report.view',
    label: 'Open HR reports',
    description:
      'Aggregate attendance, absence, overtime and leave balances across a team or an office. ' +
      'Each report also needs the key for the data it sums.',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  // Four procedures, one key, one commit — `reports.attendance`, `reports.overtime`,
  // `reports.absence` and `reports.leaveBalance` all ship gated on it, exactly as `hr.privacy.manage`
  // ships across four. It is a **second** check rather than a replacement: a report must not answer
  // a question its row-level procedure would refuse, so each one also asks for the key that already
  // guards the rows it sums — `hr.attendance.view_team` for the three attendance reports (which is
  // what `attendance.days.list` costs to read a whole office) and `hr.leave.view_team` for balances
  // (which is what `leave.balance.get` costs to read somebody else's).
  //
  // Why a key of its own at all, when the two above would do: a reports surface is the one place a
  // whole population's figures are put in front of somebody in a form that goes into a payroll or a
  // performance conversation, and a workspace has to be able to grant a manager their team's day
  // sheets without granting them that. There is still no `hr.report.export` — the reports write no
  // file — and the one thing in this module that does have its own key below.

  // ---------------------------------------------------------------- payroll export
  {
    key: 'hr.payroll.export',
    label: 'Export a payroll file',
    description:
      "Writes every employee's period, employment basis and hours out of Kern as CSV, for one " +
      'legal entity. The file leaves the building. Grant to whoever files payroll, not to a role.',
    scope: 'workspace',
    // Nobody by default, like `hr.person.view_sensitive` and `hr.privacy.manage`. An owner passes
    // every check regardless; every other holder had to be given it deliberately.
    defaultRoles: [],
    dangerous: true,
  },
  // This is the key the note above says did not exist yet, and it exists now because something
  // finally writes a file: `payroll.export.v1` and `payroll.export.preview` both ship gated on it in
  // this same change, which is the rule — a capability, a permission key and an entitlement key are
  // all lies until something enforces them.
  //
  // It is not `hr.report.export`, and the difference is not cosmetic. A report is a screen somebody
  // reads inside Kern; this is a file that leaves it, addressed to an organisation that will pay
  // people from it. The two audiences are different and so is the blast radius, so a workspace has to
  // be able to grant every report without granting this.
  //
  // Like the reports, it is a **second** check rather than a replacement: both procedures also ask
  // for `hr.attendance.view_team` (the hours file) and `hr.leave.view_team` (the leave file), because
  // an export must not answer what the row-level procedure would refuse.
  //
  // It reads no sensitive field, so it writes no `sensitive_access_log` row. A later version that
  // adds `iban` becomes a bulk sensitive read and owes one row per person with `via: 'export'` — the
  // enum member already exists — and its own key on top of this one.

  // ---------------------------------------------------------------- policies and periods
  {
    key: 'hr.policy.view',
    label: 'View accrual, overtime and rounding policies',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.policy.manage',
    label: 'Change policies and who they apply to',
    description: 'Changes what everybody accrues. A retroactive change is an adjustment, not a rewrite.',
    scope: 'workspace',
    defaultRoles: ['owner'],
    dangerous: true,
  },
  {
    key: 'hr.period.manage',
    label: 'Open, lock and unlock payroll periods',
    description: 'Locking freezes a month against recomputation. Unlocking lets it move again.',
    scope: 'workspace',
    defaultRoles: ['owner'],
    dangerous: true,
  },

  // ---------------------------------------------------------------- approvals
  {
    key: 'hr.approval.manage',
    label: 'Configure approval chains',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'hr.approval.delegate',
    label: 'Hand your approvals to somebody else while away',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },

  // ---------------------------------------------------------------- privacy
  {
    key: 'hr.privacy.manage',
    label: 'Handle privacy requests: export, erase and retention',
    description:
      'Subject access requests, erasure and retention horizons under GDPR and KVKK. An export ' +
      'contains decrypted bank and identity details, and an erasure cannot be undone. Grant to a ' +
      'named data-protection owner, not to a role.',
    scope: 'workspace',
    // Nobody by default, like `hr.person.view_sensitive` and for the same reason: whether anybody
    // below an owner may erase a colleague is the workspace's decision, and it has to be made
    // deliberately rather than inherited by everyone who happens to be an admin.
    defaultRoles: [],
    dangerous: true,
  },
  // One key, four procedures, one commit — `privacy.subjectAccess`, `privacy.erase`,
  // `privacy.retention.get` and `privacy.retention.set` all ship gated on it. Four screens suggest
  // four keys and the temptation is real; the cost of taking it is recorded twice in this repository
  // already, at the removed `hr.overtime.*` keys above and at `directoryVisibleToMembers` in
  // `settings.ts`. A separate `hr.privacy.view` arrives when a procedure asks for it and not before.

  // ---------------------------------------------------------------- fields
  {
    key: 'hr.field.manage',
    label: 'Add and edit custom fields',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
])

/** The keys, so nothing gates on a string somebody retyped. */
export const HR_PERMISSIONS = {
  personView: 'hr.person.view',
  personViewTeam: 'hr.person.view_team',
  personViewOffice: 'hr.person.view_office',
  personViewAll: 'hr.person.view_all',
  personManage: 'hr.person.manage',
  personViewSensitive: 'hr.person.view_sensitive',
  personManageSensitive: 'hr.person.manage_sensitive',
  employmentView: 'hr.employment.view',
  employmentManage: 'hr.employment.manage',
  orgView: 'hr.org.view',
  orgManage: 'hr.org.manage',
  officeView: 'hr.office.view',
  officeManage: 'hr.office.manage',
  officeAssign: 'hr.office.assign',
  entityView: 'hr.entity.view',
  entityManage: 'hr.entity.manage',
  calendarView: 'hr.calendar.view',
  calendarManage: 'hr.calendar.manage',
  documentView: 'hr.document.view',
  documentManage: 'hr.document.manage',
  fieldManage: 'hr.field.manage',
  leaveRequest: 'hr.leave.request',
  leaveView: 'hr.leave.view',
  leaveViewTeam: 'hr.leave.view_team',
  leaveViewLedger: 'hr.leave.view_ledger',
  leaveManage: 'hr.leave.manage',
  leaveAdjust: 'hr.leave.adjust',
  attendancePunch: 'hr.attendance.punch',
  attendanceView: 'hr.attendance.view',
  attendanceViewTeam: 'hr.attendance.view_team',
  attendanceManage: 'hr.attendance.manage',
  reportView: 'hr.report.view',
  payrollExport: 'hr.payroll.export',
  policyView: 'hr.policy.view',
  policyManage: 'hr.policy.manage',
  periodManage: 'hr.period.manage',
  approvalManage: 'hr.approval.manage',
  approvalDelegate: 'hr.approval.delegate',
  privacyManage: 'hr.privacy.manage',
} as const
