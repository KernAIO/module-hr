import { Timestamp, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import { IsoDate } from './models.js'

const ws = { workspaceId: WorkspaceId }

/**
 * Policies as data, and the ladder that decides which one applies.
 *
 * Leave entitlement, overtime rules and rounding differ per company and per country, and encoding
 * that as `if (country === 'TR')` is how a product acquires a branch per customer. A policy is a
 * row: a kind, a config validated by that kind's schema, an effective range, and an assignment to
 * somebody — a person, an office, a department, or the whole workspace.
 *
 * **One ladder, used by everything**: `person → primary office → legal entity → org unit →
 * position → workspace`, nearest wins. The same order resolves a calendar, so there is never a
 * second precedence rule to remember.
 */

export const PolicyKind = z.enum(['accrual', 'carry_forward', 'overtime', 'rounding', 'working_time'])
export type PolicyKind = z.infer<typeof PolicyKind>

/**
 * Rungs of the ladder, and the priority each carries.
 *
 * The numbers are the ladder made explicit so a query can order by them rather than a service
 * knowing the sequence by heart.
 */
export const PolicySubjectKind = z.enum([
  'person',
  'office',
  'legal_entity',
  'org_unit',
  'position',
  'workspace',
])
export type PolicySubjectKind = z.infer<typeof PolicySubjectKind>

export const SUBJECT_PRIORITY: Record<PolicySubjectKind, number> = {
  person: 100,
  office: 80,
  legal_entity: 60,
  org_unit: 40,
  position: 30,
  workspace: 0,
}

// ---------------------------------------------------------------- config per kind

export const SeniorityTier = z.object({
  afterYears: z.number().int().min(0).max(60),
  daysPerYear: z.number().min(0).max(365),
})

export const AccrualConfig = z.object({
  frequency: z.enum(['monthly', 'annual', 'anniversary', 'per_hour_worked']),
  daysPerYear: z.number().min(0).max(365),
  minutesPerDay: z.number().int().min(1).max(1440),
  /** Most senior tier reached wins; the order they are written in does not matter. */
  seniorityTiers: z.array(SeniorityTier).default([]),
  waitingPeriodMonths: z.number().int().min(0).max(24).default(0),
  /** Which calendar decides a period boundary. Iran accrues on Jalali months. */
  calendar: z.enum(['gregorian', 'persian']).default('gregorian'),
  roundToMinutes: z.number().int().min(0).max(480).default(0),
  /** Which leave type this accrues into. */
  leaveTypeKey: z.string().min(1).max(48),
})
export type AccrualConfig = z.infer<typeof AccrualConfig>

export const CarryForwardConfig = z.object({
  leaveTypeKey: z.string().min(1).max(48),
  maxDays: z.number().min(0).max(365),
  /** Months into the new year before carried leave lapses. Null never expires. */
  expiresAfterMonths: z.number().int().min(1).max(24).nullable(),
})
export type CarryForwardConfig = z.infer<typeof CarryForwardConfig>

export const OvertimeConfig = z.object({
  /** Minutes past the schedule before overtime starts counting. */
  thresholdMinutes: z.number().int().min(0).max(480).default(0),
  /** Cap for the period. Null is uncapped — several jurisdictions cap hours *worked*, not just pay. */
  capMinutesPerYear: z.number().int().min(0).nullable().default(null),
  /** Multiplier for reporting and payroll export. Kern does not compute pay. */
  rate: z.number().min(1).max(5).default(1.5),
  /** Overtime must be approved before it counts towards anything. */
  requiresApproval: z.boolean().default(true),
  /** Convert approved overtime into compensatory leave of this type instead of paying it. */
  compOffLeaveTypeKey: z.string().max(48).nullable().default(null),
})
export type OvertimeConfig = z.infer<typeof OvertimeConfig>

export const RoundingConfig = z.object({
  stepMinutes: z.number().int().min(0).max(60),
  direction: z.enum(['nearest', 'employee', 'employer']),
})
export type RoundingConfig = z.infer<typeof RoundingConfig>

export const WorkingTimeConfig = z.object({
  minutesPerDay: z.number().int().min(1).max(1440),
  maxMinutesPerWeek: z.number().int().min(1).max(10080).nullable(),
  /** Minimum rest between shifts, in minutes. Reported, not enforced by refusing a punch. */
  minRestMinutes: z.number().int().min(0).max(1440).nullable(),
})
export type WorkingTimeConfig = z.infer<typeof WorkingTimeConfig>

/** The config union, keyed by kind. Each kind validates its own shape before it runs. */
export const PolicyConfig = z.union([
  AccrualConfig,
  CarryForwardConfig,
  OvertimeConfig,
  RoundingConfig,
  WorkingTimeConfig,
])

export const Policy = z.object({
  id: z.uuid(),
  ...ws,
  kind: PolicyKind,
  name: z.string().min(1).max(120),
  config: z.record(z.string(), z.unknown()),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable(),
  source: z.enum(['pack', 'custom']),
  packKey: z.string().max(32).nullable(),
  /** What a derived row records, so a recomputation can tell a stale figure from a current one. */
  configHash: z.string().max(64),
  archivedAt: Timestamp.nullable(),
})
export type Policy = z.infer<typeof Policy>

export const PolicyAssignment = z.object({
  id: z.uuid(),
  ...ws,
  policyId: z.uuid(),
  subjectKind: PolicySubjectKind,
  /** Null for `workspace`, which needs no id. */
  subjectId: z.uuid().nullable(),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable(),
  priority: z.number().int(),
})
export type PolicyAssignment = z.infer<typeof PolicyAssignment>

/**
 * Which policy of a kind applies to a person on a date, and which rung answered.
 *
 * The rung is not decoration: "why does she accrue differently from her team" is the question this
 * module gets asked, and answering it without a database session is the whole reason the ladder is
 * inspectable.
 */
export const ResolvedPolicy = z.object({
  kind: PolicyKind,
  policyId: z.uuid().nullable(),
  policyName: z.string().nullable(),
  config: z.record(z.string(), z.unknown()).nullable(),
  from: PolicySubjectKind.nullable(),
  fromSubjectId: z.uuid().nullable(),
})
export type ResolvedPolicy = z.infer<typeof ResolvedPolicy>

// ---------------------------------------------------------------- periods

/**
 * A closed month, and the boundary every recomputation respects.
 *
 * Locking is what makes a filed payroll safe: nothing may silently move a day inside a locked
 * period, so a policy changed with a retroactive `effectiveFrom` produces an adjustment in the open
 * period rather than rewriting history.
 *
 * Per legal entity, because a Dutch entity closes on a different day from a Turkish one.
 */
export const Period = z.object({
  id: z.uuid(),
  ...ws,
  kind: z.enum(['payroll', 'attendance']),
  legalEntityId: z.uuid().nullable(),
  startsOn: IsoDate,
  endsOn: IsoDate,
  status: z.enum(['open', 'locked']),
  lockedAt: Timestamp.nullable(),
  lockedBy: z.uuid().nullable(),
  note: z.string().max(500).nullable(),
})
export type Period = z.infer<typeof Period>

/** What an accrual run would do, per person, before it writes anything. */
export const AccrualPreview = z.object({
  periodFrom: IsoDate,
  periodTo: IsoDate,
  rows: z.array(
    z.object({
      personId: z.uuid(),
      displayName: z.string(),
      leaveTypeId: z.uuid(),
      leaveTypeName: z.string(),
      minutes: z.number().int(),
      days: z.number(),
      /** Why it is that number: entitlement, service, proration, FTE. */
      reason: z.string(),
      /** Already accrued for this period — a re-run must not double-credit. */
      alreadyAccrued: z.boolean(),
    }),
  ),
  totalMinutes: z.number().int(),
  skipped: z.array(z.object({ personId: z.uuid(), displayName: z.string(), reason: z.string() })),
})
export type AccrualPreview = z.infer<typeof AccrualPreview>
