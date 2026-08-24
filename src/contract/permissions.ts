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
  approvalManage: 'hr.approval.manage',
  approvalDelegate: 'hr.approval.delegate',
} as const
