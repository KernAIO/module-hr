import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { ScheduleWeek } from '../../contract/index.js'
import { weekdayOf } from '../../policy/calendar.js'
import { dateIn, previousDate } from '../../policy/time.js'
import {
  attributeToShift,
  computeDay,
  type OvertimePolicy,
  openState,
  type PunchInput,
  type RoundingPolicy,
  type ShiftSpec,
} from '../../policy/working-time.js'
import { attendanceDays, leaveRequestDays, punches, scheduleAssignments, schedules } from '../schema.js'
import { inForceOn } from './db.js'
import { PolicyService } from './policies.js'
import { ResolveService } from './resolve.js'

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

/** A punch exactly as it is stored. What `attribute` hands back, and what the router's guard reads. */
export type PunchRow = typeof punches.$inferSelect

/**
 * One decision about one instant, and everything that follows from it.
 *
 * A punch needs three answers that must agree: which day it counts towards, whether the transition
 * it asks for is possible at all, and what the clock widget was showing the person before they
 * pressed anything. They used to be computed in three places from three reads. Here they are one
 * value, so a disagreement between them is not something the code can express.
 */
export interface Attribution {
  /** The business date this punch belongs to. */
  businessDate: string
  /** What that date schedules, if anything. */
  shift: ShiftSpec | null
  /** The live punches already filed on it, oldest first. */
  punches: PunchRow[]
  /** What those say: whether a shift, and a break, are still running. */
  open: { clockedIn: boolean; onBreak: boolean }
}

export class AttendanceService {
  /**
   * Both collaborators are defaulted so `new AttendanceService()` still reads as a leaf service.
   * The period is asked about on every recomputation, and who belongs to a legal entity is asked
   * on every lock — neither question has a second implementation in this module and neither may
   * grow one here.
   */
  constructor(
    private readonly resolve: ResolveService = new ResolveService(),
    private readonly policies: PolicyService = new PolicyService(resolve),
  ) {}

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
   * Which shift a punch made at `atMs` joins — decided once, from the punches that are already filed.
   *
   * This is the circularity that made the last three attempts at the night-shift boundary
   * unfixable. The shift a punch belonged to was worked out from the clock alone; the guard that
   * decides whether the punch is even possible was then built by reading `punchesOn(that date)`. So
   * the guard could only ever confirm the attribution's own choice, and where the choice was wrong
   * the person was told they were not clocked in at the end of a shift they had just worked. The
   * fact that settles it — is a shift still open — is a question about punches, so it is asked
   * *before* the attribution instead of after it.
   *
   * Both candidate dates come back in one statement, the punch's own local date and the one before
   * it, on `hr_punches_person_idx`. That is fewer queries than the path it replaces, and it is what
   * makes the guard and the attribution incapable of drifting apart: they are the same rows.
   */
  async attribute(
    tx: Tx,
    workspaceId: string,
    personId: string,
    atMs: number,
    timezone: string,
    schedule: ResolvedSchedule,
  ): Promise<Attribution> {
    const local = dateIn(atMs, timezone)
    const yesterday = previousDate(local)

    const rows = await tx
      .select()
      .from(punches)
      .where(
        and(
          eq(punches.workspaceId, workspaceId),
          eq(punches.personId, personId),
          inArray(punches.businessDate, [yesterday, local]),
          isNull(punches.voidedByPunchId),
        ),
      )
      .orderBy(asc(punches.at))

    const filedOn = (date: string) => rows.filter((r) => r.businessDate === date)
    const { businessDate, shift } = attributeToShift(atMs, timezone, (d) => schedule.shiftFor(d), {
      onLocalDate: openState(filedOn(local)).clockedIn,
      onPreviousDate: openState(filedOn(yesterday)).clockedIn,
      workedPreviousDate: filedOn(yesterday).length > 0,
    })
    const mine = filedOn(businessDate)
    return { businessDate, shift, punches: mine, open: openState(mine) }
  }

  /**
   * Record a punch.
   *
   * Both the instant and the day it counts towards arrive decided. `at` is the server's clock unless
   * the offline sync path says otherwise, and `businessDate` is `attribute`'s answer for that same
   * instant — this method used to attribute the punch a second time, from its own `new Date()`
   * rather than from the instant the caller had already reasoned about. Two answers to one question,
   * a millisecond apart, is how both ends of one shift end up on two sheets.
   *
   * `clientReportedAt` is kept beside the instant with the measured skew so an offline sync can be
   * told from a device whose clock is wrong — and a claim beyond the threshold is marked `disputed`
   * rather than silently accepted or silently dropped.
   */
  async record(
    tx: Tx,
    workspaceId: string,
    input: {
      personId: string
      direction: 'in' | 'out' | 'break_start' | 'break_end'
      /** The instant, exactly as it was attributed. */
      at: Date
      /** `attribute`'s answer for that instant, never re-derived here. */
      businessDate: string
      timezone: string
      method: string
      clientReportedAt?: string | null
      officeId?: string | null
      geo?: Record<string, number> | null
      note?: string | null
      idempotencyKey?: string | null
      /** Set only by the offline sync path, where `at` genuinely is the client's claim. */
      claimed?: boolean
    },
  ) {
    const serverNow = new Date()
    const clientAt = input.clientReportedAt ? new Date(input.clientReportedAt) : null
    const skewMs = clientAt ? clientAt.getTime() - serverNow.getTime() : null

    // A claim more than an hour out is not a slow network; it is a clock somebody should look at.
    const trust = input.claimed ? (Math.abs(skewMs ?? 0) > 3600_000 ? 'disputed' : 'claimed') : 'trusted'

    const [row] = await tx
      .insert(punches)
      .values({
        id: uuidv7(),
        workspaceId,
        personId: input.personId,
        direction: input.direction,
        at: input.at,
        clientReportedAt: clientAt,
        skewMs,
        businessDate: input.businessDate,
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
    const day = and(
      eq(attendanceDays.workspaceId, workspaceId),
      eq(attendanceDays.personId, personId),
      eq(attendanceDays.businessDate, businessDate),
    )
    const [existing] = await tx
      .select({ locked: attendanceDays.locked })
      .from(attendanceDays)
      .where(day)
      .limit(1)

    // Which entity's payroll a day belongs to is a question **about that day**, so it is asked here
    // rather than taken as an argument. Every caller had one to hand and three of them had the
    // wrong one: `clockContext` resolves as of today and its answer was then applied to arbitrary
    // past dates by `punches.void`, `days.recompute` over a whole range, and an approved
    // regularization — so somebody who changed legal entity had March recomputed against the entity
    // they joined in April, found it open, and wrote into a month already filed.
    const { legalEntityId } = await this.resolve.forPerson(tx, workspaceId, personId, businessDate)

    // The column is a *cache* of the period's status, and the period is the authority — asked
    // first, every time, and in both directions. A cache that defaults to false lies about every
    // date the lock swept before the row existed: `periods.lock` stamps the rows that are there,
    // and the first punch on a date inside a closed month then creates a fresh one at the default.
    // Believing a `true` before asking lied the other way, and only ever grew: a row stamped by a
    // lock that has since been reopened, or by a person's employment being corrected underneath
    // one, refused recomputation for ever with nothing behind it.
    //
    // So where a row exists the flag is repaired from the period in whichever direction disagrees —
    // upwards here, downwards in the rebuild below. Where none exists none is written: an absent
    // sheet reads as "nothing was filed for that day", which is true, while a permanently frozen
    // half-day reads as a figure somebody can act on, which it is not.
    if (await this.policies.isLocked(tx, workspaceId, businessDate, legalEntityId)) {
      if (existing && !existing.locked) await tx.update(attendanceDays).set({ locked: true }).where(day)
      return { locked: true }
    }

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

    const overtimePolicy = await this.overtimePolicyFor(tx, workspaceId, personId, businessDate)
    const computed = computeDay({
      businessDate,
      timeZone: timezone,
      shift: schedule.shiftFor(businessDate),
      punches: punchInputs,
      rounding: schedule.rounding,
      overtime: overtimePolicy,
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
        beyondCapMinutes: computed.beyondCapMinutes,
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
          beyondCapMinutes: computed.beyondCapMinutes,
          lateMinutes: computed.lateMinutes,
          earlyLeaveMinutes: computed.earlyLeaveMinutes,
          status,
          leaveRequestId: onLeave?.requestId ?? null,
          anomalies: computed.anomalies,
          firstIn: computed.firstIn ? new Date(computed.firstIn) : null,
          lastOut: computed.lastOut ? new Date(computed.lastOut) : null,
          policyHash: hashSchedule(schedule),
          computedAt: new Date(),
          // The other half of the repair: no period closes this date, so a row still carrying the
          // flag lets go of it here. Rebuilding the figures while leaving `locked` true would
          // publish a sheet nothing can move next to a flag saying nothing may.
          locked: false,
        },
      })

    return { locked: false }
  }

  /**
   * The overtime rules that apply to one person on one date, as numbers a pure function can use.
   *
   * Resolved here rather than passed in, unlike the schedule: `computeDay` may not touch the
   * database and every caller of `recomputeDay` would otherwise have to walk the policy ladder
   * itself, which is how a rule ends up applied on three paths out of four.
   *
   * Undefined where no policy applies, which is what a workspace that never configured overtime
   * means — every minute past the schedule counts, exactly as it did before the policy was read at
   * all.
   */
  private async overtimePolicyFor(
    tx: Tx,
    workspaceId: string,
    personId: string,
    businessDate: string,
  ): Promise<OvertimePolicy | undefined> {
    const resolved = await this.policies.forPerson(tx, workspaceId, personId, 'overtime', businessDate)
    if (!resolved.config) return undefined
    const config = resolved.config as { thresholdMinutes?: number; capMinutesPerYear?: number | null }
    const capMinutes = config.capMinutesPerYear ?? null
    return {
      thresholdMinutes: config.thresholdMinutes ?? 0,
      capMinutes,
      alreadyCountedMinutes:
        capMinutes === null ? 0 : await this.overtimeCountedBefore(tx, workspaceId, personId, businessDate),
    }
  }

  /**
   * Overtime already counted this year, on the days *before* this one.
   *
   * Strictly before, so a day's figure depends only on days that precede it and recomputing one
   * cannot depend on the order the sweep happens to visit them in. The days after it are then stale
   * against a cap that filled earlier, which the nightly recomputation settles — an order-dependent
   * sheet would not settle at all.
   *
   * The year is the calendar one, because `capMinutesPerYear` is what the config offers; a legal
   * entity closing its year elsewhere would need the cap to say so first.
   */
  private async overtimeCountedBefore(
    tx: Tx,
    workspaceId: string,
    personId: string,
    businessDate: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ minutes: sql<string>`coalesce(sum(${attendanceDays.overtimeMinutes}), 0)` })
      .from(attendanceDays)
      .where(
        and(
          eq(attendanceDays.workspaceId, workspaceId),
          eq(attendanceDays.personId, personId),
          gte(attendanceDays.businessDate, `${businessDate.slice(0, 4)}-01-01`),
          lt(attendanceDays.businessDate, businessDate),
        ),
      )
    return Number(row?.minutes ?? 0)
  }

  /**
   * Stamp `locked` on every day a period covers — and on nobody else's.
   *
   * A period with no legal entity is the whole workspace's. One that names an entity closes *that
   * entity's* month: `PolicyService.isLocked` has always read it that way, and until this method
   * existed the day sheet did not, so closing the Turkish entity's January froze the Dutch and
   * Iranian ones too. Two enforcement mechanisms disagreeing about who a period covers is worse
   * than either of them being wrong on its own, because each looks right from where it is read.
   *
   * Membership is asked of the resolution ladder rather than joined here: which entity somebody is
   * in is not a column on `people` — the employment in force says, and where it does not, their
   * primary office does — and that order has exactly one implementation in this module. It is asked
   * **as of each day**, the same date `isLocked` will be asked about later, because the day is what
   * belongs to an entity: resolving everybody once at the period's last day stamped the whole month
   * of somebody who transferred in halfway through it, including the half they spent elsewhere —
   * days no Dutch period had closed, frozen by a Turkish one.
   *
   * Releasing is not the mirror of stamping. The exclusion constraint keys on
   * `coalesce(legal_entity_id, …)`, so a workspace-wide period and an entity's period may cover the
   * same dates on purpose — and reopening the narrower one must not unlock a month the wider one
   * has filed. So a day is released only where nothing still closes it. That reads the period's own
   * status, which the handler writes before calling this: a period reopening itself would otherwise
   * be the reason it cannot let go.
   */
  async setPeriodLock(
    tx: Tx,
    workspaceId: string,
    period: { legalEntityId: string | null; startsOn: string; endsOn: string },
    locked: boolean,
  ): Promise<number> {
    const inRange = [
      eq(attendanceDays.workspaceId, workspaceId),
      gte(attendanceDays.businessDate, period.startsOn),
      lte(attendanceDays.businessDate, period.endsOn),
    ]

    // Closing a period that names no entity closes the workspace, and there is nothing to ask the
    // ladder about: one statement, as it always was. Every other combination needs to know which
    // entity somebody was in on the day — to decide whether the period covers them, or whether
    // anything else still does.
    if (!period.legalEntityId && locked) {
      const swept = await tx
        .update(attendanceDays)
        .set({ locked })
        .where(and(...inRange))
        .returning({ id: attendanceDays.id })
      return swept.length
    }

    const candidates = await tx
      .selectDistinct({ personId: attendanceDays.personId, businessDate: attendanceDays.businessDate })
      .from(attendanceDays)
      .where(and(...inRange))
    if (!candidates.length) return 0

    // One resolution per date rather than per row: a month is at most thirty-one ladder walks
    // whatever the headcount, where a walk per person-day would be that times everybody.
    const peopleOn = new Map<string, string[]>()
    for (const c of candidates)
      peopleOn.set(c.businessDate, [...(peopleOn.get(c.businessDate) ?? []), c.personId])
    const entityOn = new Map<string, string | null>()
    for (const [date, ids] of peopleOn) {
      const resolved = await this.resolve.forPeople(tx, workspaceId, [...new Set(ids)], date)
      for (const id of ids) entityOn.set(`${id}|${date}`, resolved.get(id)?.legalEntityId ?? null)
    }

    const stillClosed = new Map<string, boolean>()
    const closedByAnything = async (date: string, entity: string | null) => {
      const key = `${entity ?? 'workspace'}|${date}`
      const seen = stillClosed.get(key)
      if (seen !== undefined) return seen
      const answer = await this.policies.isLocked(tx, workspaceId, date, entity)
      stillClosed.set(key, answer)
      return answer
    }

    const mine: Array<{ personId: string; businessDate: string }> = []
    for (const c of candidates) {
      const entity = entityOn.get(`${c.personId}|${c.businessDate}`) ?? null
      if (period.legalEntityId && entity !== period.legalEntityId) continue
      if (!locked && (await closedByAnything(c.businessDate, entity))) continue
      mine.push(c)
    }
    if (!mine.length) return 0

    const days = new Map<string, string[]>()
    for (const m of mine) days.set(m.personId, [...(days.get(m.personId) ?? []), m.businessDate])

    const rows = await tx
      .update(attendanceDays)
      .set({ locked })
      .where(
        and(
          eq(attendanceDays.workspaceId, workspaceId),
          or(
            ...[...days].map(([personId, dates]) =>
              and(eq(attendanceDays.personId, personId), inArray(attendanceDays.businessDate, dates)),
            ),
          ),
        ),
      )
      .returning({ id: attendanceDays.id })
    return rows.length
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
