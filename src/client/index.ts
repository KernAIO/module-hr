import { createModuleClient, type KernClientOptions } from '@kernhq/sdk'
import type { ContractRouterClient } from '@orpc/contract'
import type { HrContract } from '../contract/index.js'

/**
 * The client half.
 *
 * Published as **source**, not compiled: the consumer builds the TypeScript and Svelte with its own
 * toolchain, which is what lets `$state` in a module store stay reactive inside the app. Two
 * consequences worth knowing before you edit anything here — nothing in this package compiles it,
 * so `pnpm build` passes over a syntax error and only the app finds it; and `files` in package.json
 * must cover every directory this entry reaches, contract source included.
 *
 * What lives here: the typed API client, and any logic that is about this module but not about a
 * screen (formatting, grouping, parsing). What does not: the `defineClientModule` manifest and the
 * Svelte components, which live in the app so their labels can go through its message catalogue.
 * `pnpm new-module` generates both halves.
 */
export type HrApi = ContractRouterClient<HrContract>

export function createHrClient(opts: KernClientOptions): HrApi {
  return createModuleClient<HrApi>(opts, 'hr')
}

export {
  type ApprovalChain,
  type ApprovalRequest,
  type AttendanceDay,
  type Calendar,
  type CalendarDay,
  type ClockState,
  type CostCenter,
  type CustomFieldDef,
  type Delegation,
  type Employment,
  HR_PERMISSIONS,
  hrCapabilities,
  hrPermissions,
  type IsoDate,
  type LeaveBalance,
  type LeaveLedgerEntry,
  type LeaveRequest,
  type LeaveSimulation,
  type LeaveType,
  type LegalEntity,
  MODULE_ID,
  type Office,
  type OfficeAssignment,
  type OrgUnit,
  type Person,
  type PersonDocument,
  type PersonResolution,
  type PersonStatus,
  type Position,
  type Punch,
  type Regularization,
  type ResolvedCalendarDay,
  type Schedule,
  type WorkingWeek,
} from '../contract/index.js'

/**
 * The capability ids, so a client contribution gates on a constant rather than a retyped string.
 *
 * Named unqualified — `capability: HR_CAPABILITIES.offices` gives `'offices'`, not `'hr.offices'` —
 * because from inside a module there is only one namespace. The shell adds this module's id when it
 * builds the workspace's set, which is where several modules' capabilities meet.
 */
export const HR_CAPABILITIES = {
  core: 'core',
  offices: 'offices',
  legalEntities: 'legal_entities',
  calendars: 'calendars',
  documents: 'documents',
  leave: 'leave',
  leaveAccrual: 'leave_accrual',
  approvals: 'approvals',
  attendance: 'attendance',
  overtime: 'overtime',
} as const
