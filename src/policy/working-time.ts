import type { IsoDate } from '../contract/index.js'
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
 * Which business day a punch belongs to.
 *
 * For a day shift, the local date. For a night shift, **the date the shift started**: somebody
 * clocking out at 06:00 on Tuesday finished Monday's shift, and putting those minutes on Tuesday
 * leaves Monday short and Tuesday long — which is how a month's total comes out right while every
 * individual day is wrong.
 *
 * The zone is the person's, from their primary office. A punch on a business trip records the zone
 * it happened in for audit but is still attributed here, or a week abroad splits somebody's month
 * across two calendars.
 */
export function businessDateFor(instantMs: number, timeZone: string, shift: ShiftSpec | null): IsoDate {
  const localDate = dateIn(instantMs, timeZone)
  if (!shift || !crossesMidnight(shift)) return localDate

  const minutes = minutesOfDayIn(instantMs, timeZone)
  const startMin = toMinutes(shift.start)
  const endMin = toMinutes(shift.end)
  // Anything in the small hours up to a margin past the shift's end belongs to the previous day, so
  // a late clock-out is still attributed to the shift it actually finished.
  const tail = Math.min(startMin, endMin + 240)
  return minutes < tail ? previousDate(localDate) : localDate
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
  /** Approved leave or a holiday: not an absence, whatever the punches say. */
  excused?: boolean
}): DayComputation {
  const { businessDate, timeZone, shift, excused } = opts
  const rounding = opts.rounding ?? NO_ROUNDING
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

  const overtimeMinutes = Math.max(0, workedMinutes - scheduledMinutes)

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
    lateMinutes,
    earlyLeaveMinutes,
    status,
    anomalies,
    firstIn,
    lastOut,
  }
}
