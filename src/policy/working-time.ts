import type { IsoDate } from '../contract/index.js'
// Overtime lives beside the accrual arithmetic because a capped hour often becomes compensatory
// leave rather than pay. It is the same function either way, so it is imported rather than copied.
import { overtimeFor } from './accrual.js'
import { dateIn, minutesOfDayIn, nextDate, previousDate, zonedToInstant } from './time.js'

/**
 * Turning raw punches into a day's worked minutes.
 *
 * Pure: punches and a schedule in, numbers out. No database, no clock of its own. That is what makes
 * the cases which actually break a payroll — a night shift, a daylight-saving boundary, a missing
 * clock-out, a break somebody forgot to end — testable as a table rather than against a service.
 */

/** A shift as a schedule declares it: wall-clock readings, meaningless until a date and zone arrive. */
export interface ShiftSpec {
  /** `09:00` */
  start: string
  /** `18:00`, or `06:00` for a shift that ends the next morning. */
  end: string
  /** Unpaid break subtracted from the worked total. */
  breakMinutes: number
  /** Minutes after `start` that are not counted late. */
  graceInMinutes: number
  /** Minutes before `end` that are not counted as leaving early. */
  graceOutMinutes: number
}

export interface RoundingPolicy {
  /** Round the worked total to a multiple of this many minutes. 0 disables rounding. */
  stepMinutes: number
  /**
   * Which way. `nearest` is even-handed; `employee` always rounds in their favour; `employer`
   * always against. The third exists because some contracts specify it, not because it is a good
   * idea.
   */
  direction: 'nearest' | 'employee' | 'employer'
}

export const NO_ROUNDING: RoundingPolicy = { stepMinutes: 0, direction: 'nearest' }

/**
 * An overtime policy as a day sees it, already resolved.
 *
 * `computeDay` is pure and stays pure, so which policy applies to this person on this date — and
 * how much of the cap the year has already used — are answered by the caller against the ladder and
 * the sheet, and arrive here as numbers. Absent, every minute past the schedule counts, which is
 * what a workspace with no overtime policy means.
 */
export interface OvertimePolicy {
  /** Minutes past the schedule before overtime starts counting. */
  thresholdMinutes: number
  /** Cap for the containing period, in minutes. Null is uncapped. */
  capMinutes: number | null
  /** Overtime already counted in that period, on days before this one. */
  alreadyCountedMinutes: number
}

export type PunchDirection = 'in' | 'out' | 'break_start' | 'break_end'

export interface PunchInput {
  /** The instant, server-stamped. Milliseconds since the epoch. */
  at: number
  direction: PunchDirection
}

export interface DayComputation {
  businessDate: IsoDate
  scheduledMinutes: number
  workedMinutes: number
  breakMinutes: number
  overtimeMinutes: number
  /**
   * Hours worked past the schedule that the cap would not take.
   *
   * Reported rather than dropped: a jurisdiction capping overtime caps what may be *worked*, so
   * these are hours somebody actually put in and a compliance report has to be able to sum them.
   *
   * **Null and zero say different things.** Null is no cap in force — nothing to exceed, and
   * nothing a report should count as compliant. Zero is a cap in force that this day stayed inside.
   * Only the policy separates them, so the distinction is drawn here rather than re-derived
   * wherever the number is stored.
   */
  beyondCapMinutes: number | null
  lateMinutes: number
  earlyLeaveMinutes: number
  status: 'present' | 'absent' | 'partial' | 'pending'
  /** Things a human should look at: an unpaired punch, a break left open. */
  anomalies: string[]
  firstIn: number | null
  lastOut: number | null
}

/**
 * Does this shift cross midnight?
 *
 * `22:00`–`06:00` does; `09:00`–`18:00` does not. Every night-shift decision follows from this one
 * question, so it is answered in one place.
 */
export const crossesMidnight = (shift: ShiftSpec): boolean => toMinutes(shift.end) <= toMinutes(shift.start)

const toMinutes = (wall: string): number => {
  const [h, m] = wall.split(':').map(Number) as [number, number]
  return h * 60 + m
}

/**
 * Whether a shift is already running, by business date — the fact a clock reading cannot supply.
 *
 * Both are read from punches already filed: a clock-in with no clock-out after it. Gathering them is
 * the caller's job and deciding what they mean is this file's, the same split `computeDay` already
 * makes with the punches themselves.
 */
export interface OpenShifts {
  /** A shift left open on the punch's own local date. */
  onLocalDate: boolean
  /** A shift left open on the date before it — the night that may still be running. */
  onPreviousDate: boolean
  /**
   * The previous date already holds punches, open or closed.
   *
   * Distinct from `onPreviousDate`, and the difference is a day sheet nobody can explain. A night
   * worked 22:00–05:30 and clocked out of is *closed*, so it is not open — but it is also not
   * waiting for anybody, and an arrival at 05:50 that joined it rewrote a finished Friday from
   * 450 minutes to 1060, with four punches and nine hours of overtime, from somebody turning up
   * early for Saturday.
   */
  workedPreviousDate: boolean
}

/** Nobody is mid-shift and nothing was worked yesterday, so every punch is an arrival. */
export const NOTHING_OPEN: OpenShifts = {
  onLocalDate: false,
  onPreviousDate: false,
  workedPreviousDate: false,
}

/**
 * What one business date's punches say about whether a shift, and a break, are still running.
 *
 * One reduction behind three questions that must never disagree: which shift the next punch joins,
 * whether the transition it asks for is possible, and what the clock widget tells the person before
 * they press anything. Rows have to arrive sorted by instant. `out` closes a break as well as a
 * shift, because somebody who clocks out without ending their break has still stopped working.
 */
export function openState(punches: Array<{ direction: string }>): {
  clockedIn: boolean
  onBreak: boolean
} {
  let clockedIn = false
  let onBreak = false
  for (const punch of punches) {
    if (punch.direction === 'in') clockedIn = true
    else if (punch.direction === 'out') {
      clockedIn = false
      onBreak = false
    } else if (punch.direction === 'break_start') onBreak = true
    else if (punch.direction === 'break_end') onBreak = false
  }
  return { clockedIn, onBreak }
}

/**
 * Which shift a punch belongs to, and the business date that follows from it.
 *
 * A punch in the morning between a night shift and a day shift has two readings and **the clock
 * cannot separate them**: at 06:59 on a Saturday, somebody who worked the 22:00–06:00 night is
 * leaving it, and somebody who did not is arriving early for the 08:00 morning. Three versions of
 * this function drew a line through that window — at the night's scheduled end, at the morning's
 * start, at the midpoint of the gap widened by `graceInMinutes` — and every one of them filed one of
 * those two people on the wrong day, one minute either side of wherever the line had moved to. There
 * is no line to draw. What separates the two readings is not in the instant.
 *
 * It is in the punches. A shift is **open** when a clock-in has been filed on a business date with
 * nothing closing it, and at most one shift is open at a time, because a person is in one place. So:
 *
 * 1. **A departure belongs to the shift it is leaving.** Where a shift is open the punch joins it,
 *    however far past the scheduled end it is made, because nothing else can close it. The most
 *    recent open one wins: that is the shift they are actually on.
 * 2. **Everything else is an arrival**, and it opens the shift the clock says is running — the
 *    previous night while that night is still scheduled to run and the day's own shift has not
 *    started yet, otherwise the day it happened on.
 *
 * An open shift is a fact in the database rather than a guess about an instant, which is why this
 * degrades correctly at both ends where a boundary could not: somebody who never clocked in last
 * night has nothing open, so their early arrival is an arrival at any hour, and somebody who worked
 * the night has something open, so their late departure is a departure however long they overran.
 * No constant appears in either rule, so there is no minute left to get wrong.
 *
 * Rule (1) reaches exactly one calendar day back, and that is what stops a shift nobody ever closed
 * claiming punches for ever: a day later the date in between holds no punches, nothing is open, and
 * arrivals resume. Until then the person is *told* they are still clocked in, because
 * `attendance.state` reads this same attribution from the same rows — so the action offered to them
 * is the one that closes it, and no refusal arrives that the screen did not predict.
 *
 * One thing stays undecided, and it costs a date rather than a refusal. Where the night was NEVER
 * WORKED — nothing open and nothing filed — a punch inside its scheduled span reads as a late
 * arrival for it: at 05:59 that files a two-hour-early arrival for the morning on the night's date.
 * Both ends of that shift still land together, since the clock-out follows the shift the clock-in
 * opened, so nobody is turned away. The sheet is wrong about which day, and says somebody was very
 * late for a shift they were in fact early for.
 *
 * It is left because nothing available at that instant settles it: at 05:59 a person with a night
 * scheduled and nothing filed is either eleven minutes from the end of a shift they never started
 * or two hours early for the next one, and only the clock-out — which has not happened — tells them
 * apart. Deciding it on how much of the night is left would be a fourth constant, and three have
 * been tried. A night already worked is a different question and is answered above.
 */
export function attributeToShift(
  instantMs: number,
  timeZone: string,
  shiftFor: (date: IsoDate) => ShiftSpec | null,
  open: OpenShifts,
): { businessDate: IsoDate; shift: ShiftSpec | null } {
  const local = dateIn(instantMs, timeZone)
  const yesterday = previousDate(local)

  // (1) A departure. Deliberately before anything reads the clock: an open shift outranks every
  // schedule, including one that says this punch is hours past when the night should have ended.
  if (open.onLocalDate) return { businessDate: local, shift: shiftFor(local) }
  if (open.onPreviousDate) return { businessDate: yesterday, shift: shiftFor(yesterday) }

  // (2) An arrival. The previous night still holds the small hours — somebody clocking in at 02:00
  // is late for last night's shift, not early for tonight's — but only while it is scheduled to be
  // running and only until the day's own shift starts, so overlapping schedules go to the one that
  // began most recently.
  const own = shiftFor(local)
  const overnight = shiftFor(yesterday)
  // A night already worked is not waiting for anybody. `open` is false either way once it is
  // clocked out of, so without this an early arrival for the morning joined a finished night and
  // rewrote its sheet — the one thing this function's own comment promised could not happen.
  if (overnight && crossesMidnight(overnight) && !open.workedPreviousDate) {
    const minute = minutesOfDayIn(instantMs, timeZone)
    const dayStart = own ? toMinutes(own.start) : Number.POSITIVE_INFINITY
    if (minute < toMinutes(overnight.end) && minute < dayStart)
      return { businessDate: yesterday, shift: overnight }
  }
  return { businessDate: local, shift: own }
}

/**
 * Round a **worked total** to the policy's step.
 *
 * Applied to the total rather than to each punch, so a day is rounded once. Rounding both ends
 * separately compounds — a fifteen-minute step can move a single day by half an hour, which is how
 * a rounding policy nobody objected to turns into a month somebody does.
 */
function roundMinutes(minutes: number, policy: RoundingPolicy): number {
  if (policy.stepMinutes <= 0) return minutes
  const step = policy.stepMinutes
  switch (policy.direction) {
    case 'nearest':
      return Math.round(minutes / step) * step
    // In the employee's favour means *more* paid time, so up; the employer's, down. An earlier
    // version took a `favour` argument meant for per-punch rounding and inverted both.
    case 'employee':
      return Math.ceil(minutes / step) * step
    case 'employer':
      return Math.floor(minutes / step) * step
  }
}

/**
 * The scheduled span of a shift on a date — computed from instants, not from clock readings.
 *
 * A 09:00–18:00 shift is nine hours on almost every day and eight or ten across a transition,
 * because the clock moved underneath it. Subtracting wall-clock times reports nine every time, and
 * quietly pays somebody for an hour they did not work, once a year, in one direction.
 */
export function scheduledMinutesOn(date: IsoDate, timeZone: string, shift: ShiftSpec): number {
  const start = zonedToInstant(date, shift.start, timeZone)
  const endDate = crossesMidnight(shift) ? nextDate(date) : date
  const end = zonedToInstant(endDate, shift.end, timeZone)
  return Math.max(0, Math.round((end - start) / 60000) - shift.breakMinutes)
}

/**
 * Compute one day from its punches.
 *
 * Punches pair in order: `in` opens a span, `out` closes it, `break_start`/`break_end` carve unpaid
 * time out of it. An unpaired punch does not throw — it is flagged and the day becomes `pending`,
 * because somebody who forgot to clock out still worked, and the sheet has to say something useful
 * rather than nothing.
 */
export function computeDay(opts: {
  businessDate: IsoDate
  timeZone: string
  shift: ShiftSpec | null
  punches: PunchInput[]
  rounding?: RoundingPolicy
  /** The resolved overtime policy. Absent, everything past the schedule is overtime. */
  overtime?: OvertimePolicy
  /** Approved leave or a holiday: not an absence, whatever the punches say. */
  excused?: boolean
}): DayComputation {
  const { businessDate, timeZone, shift, excused } = opts
  const rounding = opts.rounding ?? NO_ROUNDING
  const capMinutes = opts.overtime?.capMinutes ?? null
  const punches = [...opts.punches].sort((a, b) => a.at - b.at)
  const anomalies: string[] = []

  const scheduledMinutes = shift ? scheduledMinutesOn(businessDate, timeZone, shift) : 0

  if (!punches.length)
    return {
      businessDate,
      scheduledMinutes,
      workedMinutes: 0,
      breakMinutes: 0,
      overtimeMinutes: 0,
      beyondCapMinutes: capMinutes === null ? null : 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      status: excused ? 'present' : scheduledMinutes > 0 ? 'absent' : 'present',
      anomalies: [],
      firstIn: null,
      lastOut: null,
    }

  let workedMs = 0
  let breakMs = 0
  let openIn: number | null = null
  let openBreak: number | null = null
  let firstIn: number | null = null
  let lastOut: number | null = null

  for (const punch of punches) {
    switch (punch.direction) {
      case 'in':
        if (openIn !== null) anomalies.push('double_clock_in')
        else openIn = punch.at
        if (firstIn === null) firstIn = punch.at
        break
      case 'out':
        if (openIn === null) anomalies.push('clock_out_without_in')
        else {
          workedMs += punch.at - openIn
          openIn = null
          lastOut = punch.at
        }
        // A break still open when the shift ends is closed here rather than dropped: the person was
        // not working, and discarding it would pay them for it.
        if (openBreak !== null) {
          breakMs += punch.at - openBreak
          openBreak = null
          anomalies.push('break_not_ended')
        }
        break
      case 'break_start':
        if (openBreak !== null) anomalies.push('double_break_start')
        else openBreak = punch.at
        break
      case 'break_end':
        if (openBreak === null) anomalies.push('break_end_without_start')
        else {
          breakMs += punch.at - openBreak
          openBreak = null
        }
        break
    }
  }

  if (openIn !== null) anomalies.push('missing_clock_out')
  if (openBreak !== null && !anomalies.includes('break_not_ended')) anomalies.push('break_not_ended')

  let workedMinutes = Math.max(0, Math.round(workedMs / 60000) - Math.round(breakMs / 60000))
  // The schedule's declared break applies only when nobody punched one — otherwise somebody who
  // clocked their lunch has it deducted twice.
  if (shift && breakMs === 0 && shift.breakMinutes > 0 && workedMinutes > shift.breakMinutes)
    workedMinutes -= shift.breakMinutes

  workedMinutes = roundMinutes(workedMinutes, rounding)

  let lateMinutes = 0
  let earlyLeaveMinutes = 0
  if (shift && firstIn !== null) {
    const scheduledStart = zonedToInstant(businessDate, shift.start, timeZone)
    lateMinutes = Math.max(0, Math.round((firstIn - scheduledStart) / 60000) - shift.graceInMinutes)
  }
  if (shift && lastOut !== null) {
    const endDate = crossesMidnight(shift) ? nextDate(businessDate) : businessDate
    const scheduledEnd = zonedToInstant(endDate, shift.end, timeZone)
    earlyLeaveMinutes = Math.max(0, Math.round((scheduledEnd - lastOut) / 60000) - shift.graceOutMinutes)
  }

  // The threshold and the cap an admin configured, applied here rather than validated on save and
  // then ignored: `max(0, worked - scheduled)` obeyed neither, so a 30-minute threshold and the
  // Turkish 270-hour annual cap both saved successfully and changed nothing.
  const overtime = overtimeFor({
    workedMinutes,
    scheduledMinutes,
    thresholdMinutes: opts.overtime?.thresholdMinutes ?? 0,
    capMinutes,
    alreadyCountedMinutes: opts.overtime?.alreadyCountedMinutes ?? 0,
  })
  const overtimeMinutes = overtime.overtimeMinutes
  const beyondCapMinutes = capMinutes === null ? null : overtime.beyondCapMinutes
  // The number is for a report to sum; this is what puts it in front of the person reviewing the
  // day. Both are derived here, from the same value, so the two cannot disagree about one fact.
  if (beyondCapMinutes) anomalies.push('overtime_beyond_cap')

  const status: DayComputation['status'] = anomalies.includes('missing_clock_out')
    ? 'pending'
    : workedMinutes > 0
      ? 'present'
      : 'partial'

  return {
    businessDate,
    scheduledMinutes,
    workedMinutes,
    breakMinutes: Math.round(breakMs / 60000),
    overtimeMinutes,
    beyondCapMinutes,
    lateMinutes,
    earlyLeaveMinutes,
    status,
    anomalies,
    firstIn,
    lastOut,
  }
}
