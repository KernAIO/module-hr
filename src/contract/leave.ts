import { Timestamp, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import { IsoDate } from './models.js'

const ws = { workspaceId: WorkspaceId }

/**
 * Leave, and the one rule everything here follows: **a balance is a sum, never a stored number.**
 *
 * Every grant, accrual, consumption, reversal, expiry and adjustment is an append-only ledger entry.
 * Cancelling approved leave inserts a reversal; it does not delete the consumption. That costs a
 * little arithmetic and buys the only thing that matters when an employee and HR disagree about a
 * balance: a list of what happened, in order, that nobody edited.
 */

export const LeaveUnit = z.enum(['day', 'half_day', 'hour'])
export type LeaveUnit = z.infer<typeof LeaveUnit>

export const LeaveType = z.object({
  id: z.uuid(),
  ...ws,
  key: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1).max(120),
  /** Unpaid leave still consumes calendar days; it just does not cost money. */
  paid: z.boolean(),
  unit: LeaveUnit,
  color: z.string().max(32).nullable(),
  icon: z.string().max(48).nullable(),
  /** A sick note after N consecutive days. Null means never. */
  requiresDocumentAfterDays: z.number().int().min(1).nullable(),
  /** Weekends and public holidays inside a request do not consume balance. Almost always true. */
  countsWorkingDaysOnly: z.boolean(),
  allowNegative: z.boolean(),
  /** How far below zero, in minutes. Only consulted when `allowNegative`. */
  maxNegativeMinutes: z.number().int().min(0),
  /** Sort order in pickers. */
  order: z.number().int(),
  archivedAt: Timestamp.nullable(),
})
export type LeaveType = z.infer<typeof LeaveType>

/**
 * Why a ledger entry exists. The set is closed on purpose — a new kind of movement is a decision,
 * not a string somebody passes in.
 */
export const LedgerKind = z.enum([
  /** An allowance handed out: the annual entitlement, a one-off award. */
  'grant',
  /** Earned over time by an accrual policy. */
  'accrual',
  /** Spent by an approved request. Negative. */
  'consumption',
  /** Undoes an earlier entry, cancellation or a retroactive correction. Points at what it reverses. */
  'reversal',
  /** Unused balance lapsing at a carry-forward deadline. Negative. */
  'expiry',
  /** A human decided. Always carries a reason. */
  'adjustment',
  'carry_in',
  'carry_out',
  /** Paid out instead of taken. Negative. */
  'encashment',
])
export type LedgerKind = z.infer<typeof LedgerKind>

export const LeaveLedgerEntry = z.object({
  id: z.uuid(),
  ...ws,
  personId: z.uuid(),
  leaveTypeId: z.uuid(),
  kind: LedgerKind,
  /**
   * Signed, in minutes. Minutes rather than days because half-days, hourly leave and part-time
   * fractions all divide a day, and a decimal day accumulates rounding error across a year of them.
   */
  amountMinutes: z.number().int(),
  effectiveOn: IsoDate,
  /** Which entitlement year this belongs to. Carry-forward and expiry work on it. */
  periodYear: z.number().int(),
  requestId: z.uuid().nullable(),
  reversesEntryId: z.uuid().nullable(),
  /** Which policy version produced it, so a recomputation can tell what it was computed with. */
  policyHash: z.string().max(64).nullable(),
  reason: z.string().max(500).nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: Timestamp,
})
export type LeaveLedgerEntry = z.infer<typeof LeaveLedgerEntry>

export const LeaveBalance = z.object({
  personId: z.uuid(),
  leaveTypeId: z.uuid(),
  leaveTypeName: z.string(),
  unit: LeaveUnit,
  periodYear: z.number().int(),
  /** The sum of every entry. Minutes. */
  balanceMinutes: z.number().int(),
  /** Approved but not yet taken — already spent, shown separately so "remaining" is not a surprise. */
  bookedMinutes: z.number().int(),
  /** Submitted and not yet decided. Not spent, but not available either. */
  pendingMinutes: z.number().int(),
  /** `balance - pending`. What a person can actually request today without going negative. */
  availableMinutes: z.number().int(),
  /** The same figures in whatever unit the type uses, for display. */
  balance: z.number(),
  available: z.number(),
})
export type LeaveBalance = z.infer<typeof LeaveBalance>

export const LeaveRequestStatus = z.enum([
  'draft',
  'pending',
  'approved',
  'rejected',
  'cancelled',
  /** Approved, then cancelled or corrected afterwards. The ledger carries a reversal. */
  'withdrawn',
])
export type LeaveRequestStatus = z.infer<typeof LeaveRequestStatus>

/** Which half of a day a request starts or ends on. */
export const DayPart = z.enum(['full', 'morning', 'afternoon'])
export type DayPart = z.infer<typeof DayPart>

export const LeaveRequest = z.object({
  id: z.uuid(),
  ...ws,
  personId: z.uuid(),
  leaveTypeId: z.uuid(),
  startsOn: IsoDate,
  endsOn: IsoDate,
  startPart: DayPart,
  endPart: DayPart,
  /** For hourly leave. Null for day-based types. */
  hours: z.number().min(0).max(24).nullable(),
  /** Working days consumed, after the calendar is applied. Recomputed on approval. */
  workingDays: z.number(),
  minutes: z.number().int(),
  status: LeaveRequestStatus,
  reason: z.string().max(1000).nullable(),
  documentFileId: z.uuid().nullable(),
  approvalRequestId: z.uuid().nullable(),
  decidedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type LeaveRequest = z.infer<typeof LeaveRequest>

/** What a request would cost, before anybody submits it. */
export const LeaveSimulation = z.object({
  workingDays: z.number(),
  minutes: z.number().int(),
  /** Day by day, so somebody can see *why* a five-day request costs three. */
  days: z.array(
    z.object({
      date: IsoDate,
      fraction: z.number(),
      counted: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  balanceBeforeMinutes: z.number().int(),
  balanceAfterMinutes: z.number().int(),
  /** Reasons this would be refused if submitted. Empty means it would go through. */
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
})
export type LeaveSimulation = z.infer<typeof LeaveSimulation>
