import { hrCapabilities } from '../contract/capabilities.js'

/**
 * The capability ids, so a client contribution gates on a constant rather than a retyped string.
 *
 * Named unqualified — `capability: HR_CAPABILITIES.offices` gives `'offices'`, not `'hr.offices'` —
 * because from inside a module there is only one namespace. The shell adds this module's id when it
 * builds the workspace's set, which is where several modules' capabilities meet.
 *
 * This lives in its own file rather than in the barrel, and the reason is not tidiness. The barrel
 * re-exports `hrClientModule`, so importing it from `module.ts` (through `permissions.ts`) made a
 * cycle: a re-export is hoisted, `module.ts` ran first, and its top-level `defineClientModule({…})`
 * read a `const` the barrel had not reached yet. Every HR screen died on
 * "Cannot access 'HR_CAPABILITIES' before initialization" — at runtime only, so nothing but opening
 * the page could find it. Import this module directly, never through `./index.js`.
 */
export const HR_CAPABILITIES = {
  core: 'core',
  offices: 'offices',
  legalEntities: 'legal_entities',
  calendars: 'calendars',
  documents: 'documents',
  leave: 'leave',
  leaveAccrual: 'leave_accrual',
  periods: 'periods',
  approvals: 'approvals',
  attendance: 'attendance',
} as const

export type HrCapabilityId = (typeof HR_CAPABILITIES)[keyof typeof HR_CAPABILITIES]

/** The contract's declarations, so a test can prove this map has not drifted from them. */
export const HR_DECLARED_CAPABILITY_IDS: readonly string[] = hrCapabilities.map((c) => c.id)
