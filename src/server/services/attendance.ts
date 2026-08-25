import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { ScheduleWeek } from '../../contract/index.js'
import { weekdayOf } from '../../policy/calendar.js'
import {
  businessDateFor,
  computeDay,
  type PunchInput,
  type RoundingPolicy,
  type ShiftSpec,
} from '../../policy/working-time.js'
import { attendanceDays, leaveRequestDays, punches, scheduleAssignments, schedules } from '../schema.js'
import { inForceOn } from './db.js'

/**
 * Punches and the day sheet.
 *
 * The two rules this service exists to enforce:
 *
 * - **The server stamps the time.** A client's clock is a claim, recorded for audit and never
 *   trusted. Client clocks are wrong by accident constantly and on purpose occasionally, and a
 *   system that cannot tell an offline sync from an edited phone clock cannot defend any of its
 *   numbers.
 * - **The day sheet is derived.** Every figure on it comes from punches + schedule + calendar +
 *   leave, and can be thrown away and rebuilt. Nothing is ever repaired by hand.
 */

export interface ResolvedSchedule {
  shiftFor(date: string): ShiftSpec | null
  rounding: RoundingPolicy
  autoClockOutAfterMinutes: number | null
  scheduleId: string | null
}

/** A schedule with no shifts: somebody with no assignment still clocks in, they just owe no hours. */
export const NO_SCHEDULE: ResolvedSchedule = {
  shiftFor: () => null,
  rounding: { stepMinutes: 0, direction: 'nearest' },
  autoClockOutAfterMinutes: null,
  scheduleId: null,
}

export class AttendanceService {
  /** The schedule in force for a person on a date, as something the pure layer can use. */
  async scheduleFor(tx: Tx, workspaceId: string, personId: string, on: string): Promise<ResolvedSchedule> {
    const [assignment] = await tx
      .select()
      .from(scheduleAssignments)
      .where(
        and(
          eq(scheduleAssignments.workspaceId, workspaceId),
          eq(scheduleAssignments.personId, personId),
          inForceOn(scheduleAssignments.effectiveFrom, scheduleAssignments.effectiveTo, on),
        ),
      )
      .limit(1)
    if (!assignment) return NO_SCHEDULE

    const [schedule] = await tx
      .select()
      .from(schedules)
      .where(and(eq(schedules.workspaceId, workspaceId), eq(schedules.id, assignment.scheduleId)))
      .limit(1)
    if (!schedule) return NO_SCHEDULE

    const week = (schedule.week ?? {}) as ScheduleWeek
    return {
      scheduleId: schedule.id,
      shiftFor: (date: string) => {
        const day = week[weekdayOf(date)]
        if (!day) return null
        return {
          start: day.start,
          end: day.end,
          breakMinutes: day.breakMinutes ?? 0,
          graceInMinutes: schedule.graceInMinutes,
          graceOutMinutes: schedule.graceOutMinutes,
        }
      },
      rounding: {
        stepMinutes: schedule.roundingStepMinutes,
        direction: schedule.roundingDirection as RoundingPolicy['direction'],
      },
      autoClockOutAfterMinutes: schedule.autoClockOutAfterMinutes,
    }
  }

  /**
   * Record a punch.
   *
   * `at` is the server's clock, always. `clientReportedAt` is kept beside it with the measured skew
   * so an offline sync can be told from a device whose clock is wrong — and a claim beyond the
   * threshold is marked `disputed` rather than silently accepted or silently dropped.
   */
  async record(
    tx: Tx,
    workspaceId: string,
    input: {
      personId: string
      direction: 'in' | 'out' | 'break_start' | 'break_end'
      timezone: string
      method: string
      clientReportedAt?: string | null
      officeId?: string | null
      geo?: Record<string, number> | null
      note?: string | null
      idempotencyKey?: string | null
      /** Set only by the offline sync path, where the instant genuinely is the client's claim. */
      claimedAt?: Date | null
    },
    schedule: ResolvedSchedule,
  ) {
    const serverNow = new Date()
    const at = input.claimedAt ?? serverNow
    const clientAt = input.clientReportedAt ? new Date(input.clientReportedAt) : null
    const skewMs = clientAt ? clientAt.getTime() - serverNow.getTime() : null

    // A claim more than an hour out is not a slow network; it is a clock somebody should look at.
    const trust = input.claimedAt ? (Math.abs(skewMs ?? 0) > 3600_000 ? 'disputed' : 'claimed') : 'trusted'

    const businessDate = businessDateFor(
      at.getTime(),
      input.timezone,
      schedule.shiftFor(new Date(at.getTime()).toISOString().slice(0, 10)),
    )

    const [row] = await tx
      .insert(punches)
      .values({
        id: uuidv7(),
        workspaceId,
        personId: input.personId,
        direction: input.direction,
        at,
        clientReportedAt: clientAt,
        skewMs,
        businessDate,
        timezone: input.timezone,
        method: input.method,
        officeId: input.officeId ?? null,
        geo: input.geo ?? null,
        trust,
        idempotencyKey: input.idempotencyKey ?? null,
        note: input.note ?? null,
      })
      .returning()
    return row!
  }

  /** Live punches for a person on a business date, oldest first. Voided rows are excluded. */
  async punchesOn(tx: Tx, workspaceId: string, personId: string, businessDate: string) {
    return tx
      .select()
      .from(punches)
      .where(
        and(
          eq(punches.workspaceId, workspaceId),
          eq(punches.personId, personId),
          eq(punches.businessDate, businessDate),
          isNull(punches.voidedByPunchId),
        ),
      )
      .orderBy(asc(punches.at))
  }

  /**
   * Rebuild one day from its punches.
   *
   * Idempotent by construction, which is what makes it safe to call on every punch, from a nightly
   * sweep, and from a support request without thinking about it. A locked day is left alone and
   * reported, never silently skipped — a recomputation that quietly declines to touch a closed
   * month looks identical to one that had nothing to do.
   */
  async recomputeDay(
    tx: Tx,
    workspaceId: string,
    personId: string,
    businessDate: string,
    timezone: string,
    schedule: ResolvedSchedule,
  ): Promise<{ locked: boolean }> {
    const [existing] = await tx
      .select({ locked: attendanceDays.locked })
      .from(attendanceDays)
      .where(
        and(
          eq(attendanceDays.workspaceId, workspaceId),
          eq(attendanceDays.personId, personId),
          eq(attendanceDays.businessDate, businessDate),
        ),
      )
      .limit(1)
    if (existing?.locked) return { locked: true }

    const rows = await this.punchesOn(tx, workspaceId, personId, businessDate)
    const punchInputs: PunchInput[] = rows.map((r) => ({
      at: r.at.getTime(),
      direction: r.direction as PunchInput['direction'],
    }))

    // Approved leave excuses the day: somebody on holiday is not absent, and a sheet that says
    // otherwise generates a disciplinary conversation about a day HR themselves approved.
    const [onLeave] = await tx
      .select({ requestId: leaveRequestDays.requestId })
      .from(leaveRequestDays)
      .where(
        and(
          eq(leaveRequestDays.workspaceId, workspaceId),
          eq(leaveRequestDays.personId, personId),
          eq(leaveRequestDays.date, businessDate),
          eq(leaveRequestDays.counted, true),
          eq(leaveRequestDays.status, 'approved'),
        ),
      )
      .limit(1)

    const computed = computeDay({
      businessDate,
      timeZone: timezone,
      shift: schedule.shiftFor(businessDate),
      punches: punchInputs,
      rounding: schedule.rounding,
      excused: !!onLeave,
    })

    const status = onLeave && computed.workedMinutes === 0 ? 'leave' : computed.status

    await tx
      .insert(attendanceDays)
      .values({
        id: uuidv7(),
        workspaceId,
        personId,
        businessDate,
        scheduledMinutes: computed.scheduledMinutes,
        workedMinutes: computed.workedMinutes,
        breakMinutes: computed.breakMinutes,
        overtimeMinutes: computed.overtimeMinutes,
        lateMinutes: computed.lateMinutes,
        earlyLeaveMinutes: computed.earlyLeaveMinutes,
        status,
        leaveRequestId: onLeave?.requestId ?? null,
        anomalies: computed.anomalies,
        firstIn: computed.firstIn ? new Date(computed.firstIn) : null,
        lastOut: computed.lastOut ? new Date(computed.lastOut) : null,
        policyHash: hashSchedule(schedule),
        computedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [attendanceDays.workspaceId, attendanceDays.personId, attendanceDays.businessDate],
        set: {
          scheduledMinutes: computed.scheduledMinutes,
          workedMinutes: computed.workedMinutes,
          breakMinutes: computed.breakMinutes,
          overtimeMinutes: computed.overtimeMinutes,
          lateMinutes: computed.lateMinutes,
          earlyLeaveMinutes: computed.earlyLeaveMinutes,
          status,
          leaveRequestId: onLeave?.requestId ?? null,
          anomalies: computed.anomalies,
          firstIn: computed.firstIn ? new Date(computed.firstIn) : null,
          lastOut: computed.lastOut ? new Date(computed.lastOut) : null,
          policyHash: hashSchedule(schedule),
          computedAt: new Date(),
        },
      })

    return { locked: false }
  }

  /** Which business dates a person has punches on, in a range. Drives a bulk recompute. */
  async datesWithPunches(
    tx: Tx,
    workspaceId: string,
    personId: string,
    from: string,
    to: string,
  ): Promise<string[]> {
    const rows = await tx
      .selectDistinct({ businessDate: punches.businessDate })
      .from(punches)
      .where(
        and(
          eq(punches.workspaceId, workspaceId),
          eq(punches.personId, personId),
          gte(punches.businessDate, from),
          lte(punches.businessDate, to),
        ),
      )
    return rows.map((r) => r.businessDate).sort()
  }

  /**
   * Void a punch by writing a correcting row that points at it.
   *
   * The original stays exactly as it was. Two rows is the point: "this was recorded and then
   * corrected" and "this was never recorded" are different facts, and only one of them is true.
   */
  async voidPunch(
    tx: Tx,
    workspaceId: string,
    punchId: string,
    reason: string,
    actorPersonId: string | null,
  ) {
    const [original] = await tx
      .select()
      .from(punches)
      .where(and(eq(punches.workspaceId, workspaceId), eq(punches.id, punchId)))
      .limit(1)
    if (!original) throw KernError.notFound('Punch')
    if (original.voidedByPunchId) throw KernError.conflict('That punch is already voided')

    const [correction] = await tx
      .insert(punches)
      .values({
        id: uuidv7(),
        workspaceId,
        personId: original.personId,
        direction: original.direction,
        at: original.at,
        businessDate: original.businessDate,
        timezone: original.timezone,
        method: 'manual',
        trust: 'trusted',
        note: `Voids ${punchId}: ${reason}`,
      })
      .returning()

    await tx
      .update(punches)
      .set({ voidedByPunchId: correction!.id })
      .where(and(eq(punches.id, punchId), eq(punches.businessDate, original.businessDate)))

    // The correcting row is itself voided: it exists to carry the reason and to point at what it
    // replaced, not to be counted as a punch.
    await tx
      .update(punches)
      .set({ voidedByPunchId: correction!.id })
      .where(and(eq(punches.id, correction!.id), eq(punches.businessDate, original.businessDate)))

    void actorPersonId
    return { original, correction: correction! }
  }
}

/**
 * A short stamp of what produced a derived row.
 *
 * Not cryptographic — it only has to change when the schedule does, so a recomputation can tell a
 * stale row from a current one without re-deriving it.
 */
function hashSchedule(schedule: ResolvedSchedule): string {
  return `${schedule.scheduleId ?? 'none'}:${schedule.rounding.stepMinutes}:${schedule.rounding.direction}`
}

export { inArray, sql }
