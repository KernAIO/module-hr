import { Timestamp, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import { IsoDate, TimeZone, WallClock } from './models.js'

const ws = { workspaceId: WorkspaceId }

/**
 * Attendance: who was at work, when, and for how long.
 *
 * Two rules shape everything here:
 *
 * - **Raw punches are immutable.** A wrong punch is *voided* by a correcting row, never edited. An
 *   attendance record somebody can quietly rewrite is worth nothing in the dispute it exists for.
 * - **The day sheet is derived.** `AttendanceDay` is a projection of punches + schedule + calendar +
 *   leave, recomputable from scratch at any time. It is never the source of truth, so a bad
 *   computation is a bug to fix and re-run rather than data to repair by hand.
 */

export const PunchDirection = z.enum(['in', 'out', 'break_start', 'break_end'])
export type PunchDirection = z.infer<typeof PunchDirection>

export const PunchMethod = z.enum(['web', 'mobile', 'kiosk', 'qr', 'device', 'import', 'manual'])
export type PunchMethod = z.infer<typeof PunchMethod>

/**
 * How much the recorded instant can be trusted.
 *
 * `trusted` was stamped by the server as it happened. `claimed` came from a client that was offline
 * and is asserting when it happened — believed within a policy threshold, flagged beyond it.
 * `disputed` is a claim somebody has to look at. Client clocks lie, sometimes by accident and
 * sometimes not, and a system that cannot say which is which cannot defend any of its numbers.
 */
export const PunchTrust = z.enum(['trusted', 'claimed', 'disputed'])
export type PunchTrust = z.infer<typeof PunchTrust>

export const Punch = z.object({
  id: z.uuid(),
  ...ws,
  personId: z.uuid(),
  direction: PunchDirection,
  /** Server-stamped, or the client's claim when it was offline. Always an instant, never a local time. */
  at: Timestamp,
  /** What the client believed the time was. Kept for audit even when it disagrees. */
  clientReportedAt: Timestamp.nullable(),
  /** How far the client's clock was out, in milliseconds. Null when the server stamped it. */
  skewMs: z.number().int().nullable(),
  /** The day this belongs to, in the person's schedule zone. A night shift lands on its start date. */
  businessDate: IsoDate,
  /** The zone the punch actually happened in — for audit, not for attribution. */
  timezone: TimeZone,
  method: PunchMethod,
  /** The office whose geofence or allowlist accepted it; any office the person is assigned to. */
  officeId: z.uuid().nullable(),
  deviceId: z.uuid().nullable(),
  geo: z.object({ lat: z.number(), lng: z.number(), accuracyM: z.number().optional() }).nullable(),
  trust: PunchTrust,
  /** Set when a later correction voided this row. The row itself never changes otherwise. */
  voidedByPunchId: z.uuid().nullable(),
  note: z.string().max(500).nullable(),
  createdAt: Timestamp,
})
export type Punch = z.infer<typeof Punch>

export const AttendanceStatus = z.enum([
  'present',
  'absent',
  'leave',
  'holiday',
  'weekend',
  'partial',
  /** Something is unpaired — usually a missing clock-out. Needs a human. */
  'pending',
])
export type AttendanceStatus = z.infer<typeof AttendanceStatus>

/**
 * One person, one day, derived.
 *
 * Recomputable from punches, schedule, calendar and leave at any moment. `policyHash` records what
 * produced it, so a recomputation can tell whether a row is stale; `locked` mirrors the period, so
 * a closed month cannot silently move.
 */
export const AttendanceDay = z.object({
  id: z.uuid(),
  ...ws,
  personId: z.uuid(),
  businessDate: IsoDate,
  scheduledMinutes: z.number().int(),
  workedMinutes: z.number().int(),
  breakMinutes: z.number().int(),
  overtimeMinutes: z.number().int(),
  lateMinutes: z.number().int(),
  earlyLeaveMinutes: z.number().int(),
  status: AttendanceStatus,
  leaveRequestId: z.uuid().nullable(),
  anomalies: z.array(z.string()),
  firstIn: Timestamp.nullable(),
  lastOut: Timestamp.nullable(),
  policyHash: z.string().max(64).nullable(),
  locked: z.boolean(),
  computedAt: Timestamp,
})
export type AttendanceDay = z.infer<typeof AttendanceDay>

/** A week of shifts, in wall-clock readings. Meaningless until a date and a zone arrive. */
export const ScheduleWeek = z.record(
  z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  z
    .object({
      start: WallClock,
      end: WallClock,
      breakMinutes: z.number().int().min(0).max(480).default(0),
    })
    .nullable(),
)
export type ScheduleWeek = z.infer<typeof ScheduleWeek>

export const Schedule = z.object({
  id: z.uuid(),
  ...ws,
  name: z.string().min(1).max(120),
  kind: z.enum(['fixed', 'flexible', 'shift']),
  week: ScheduleWeek,
  /** `office` means the person's primary office — the default, and almost always right. */
  tzMode: z.enum(['office', 'person', 'fixed']),
  tz: TimeZone.nullable(),
  graceInMinutes: z.number().int().min(0).max(240),
  graceOutMinutes: z.number().int().min(0).max(240),
  roundingStepMinutes: z.number().int().min(0).max(60),
  roundingDirection: z.enum(['nearest', 'employee', 'employer']),
  /** Close an open shift automatically after this many minutes. Null leaves it for a human. */
  autoClockOutAfterMinutes: z.number().int().min(60).nullable(),
  archivedAt: Timestamp.nullable(),
})
export type Schedule = z.infer<typeof Schedule>

export const ScheduleAssignment = z.object({
  id: z.uuid(),
  ...ws,
  personId: z.uuid(),
  scheduleId: z.uuid(),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable(),
})
export type ScheduleAssignment = z.infer<typeof ScheduleAssignment>

/**
 * A request to fix a wrong or missing punch.
 *
 * It does not edit anything. Approving it writes *new* punches that void the old ones, so the
 * original record and the correction both survive — which is the difference between a corrected
 * timesheet and an edited one.
 */
export const Regularization = z.object({
  id: z.uuid(),
  ...ws,
  personId: z.uuid(),
  businessDate: IsoDate,
  /** Null when the person never punched at all and is asking for the whole day to be recorded. */
  punchId: z.uuid().nullable(),
  proposed: z.array(z.object({ direction: PunchDirection, at: Timestamp })),
  reason: z.string().min(1).max(1000),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  approvalRequestId: z.uuid().nullable(),
  appliedAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type Regularization = z.infer<typeof Regularization>

/** The person's own live state: are they clocked in, since when, on a break? */
export const ClockState = z.object({
  personId: z.uuid(),
  businessDate: IsoDate,
  clockedIn: z.boolean(),
  onBreak: z.boolean(),
  since: Timestamp.nullable(),
  workedMinutesToday: z.number().int(),
  timezone: TimeZone,
})
export type ClockState = z.infer<typeof ClockState>
