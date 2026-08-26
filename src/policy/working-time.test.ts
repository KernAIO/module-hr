import { describe, expect, it } from 'vitest'
import { weekdayOf } from './calendar.js'
import { zonedToInstant } from './time.js'
import {
  attributeToShift,
  computeDay,
  crossesMidnight,
  NOTHING_OPEN,
  type OpenShifts,
  openState,
  type ShiftSpec,
  scheduledMinutesOn,
} from './working-time.js'

const DAY_SHIFT: ShiftSpec = {
  start: '09:00',
  end: '18:00',
  breakMinutes: 60,
  graceInMinutes: 5,
  graceOutMinutes: 5,
}
const NIGHT_SHIFT: ShiftSpec = {
  start: '22:00',
  end: '06:00',
  breakMinutes: 30,
  graceInMinutes: 5,
  graceOutMinutes: 5,
}

const AMS = 'Europe/Amsterdam'
const IST = 'Europe/Istanbul'

const at = (date: string, wall: string, tz = IST) => zonedToInstant(date, wall, tz)

describe('crossesMidnight', () => {
  it('tells a night shift from a day shift', () => {
    expect(crossesMidnight(DAY_SHIFT)).toBe(false)
    expect(crossesMidnight(NIGHT_SHIFT)).toBe(true)
    // A shift ending exactly when it starts is 24 hours, and still crosses.
    expect(crossesMidnight({ ...DAY_SHIFT, start: '09:00', end: '09:00' })).toBe(true)
  })
})

describe('scheduledMinutesOn', () => {
  it('is the span minus the break', () => {
    // 09:00–18:00 is nine hours; less a one-hour break, eight.
    expect(scheduledMinutesOn('2026-06-15', IST, DAY_SHIFT)).toBe(480)
  })

  it('covers a night shift into the next morning', () => {
    // 22:00–06:00 is eight hours; less a thirty-minute break.
    expect(scheduledMinutesOn('2026-06-15', IST, NIGHT_SHIFT)).toBe(450)
  })

  /**
   * The reason this is computed from instants rather than clock readings.
   *
   * A 09:00–18:00 shift really is an hour shorter on the day the clock springs forward and an hour
   * longer when it falls back. Subtracting wall times reports eight hours every day and pays for an
   * hour nobody worked, once a year, in one direction.
   */
  it('is an hour shorter on the spring transition', () => {
    expect(scheduledMinutesOn('2026-03-29', AMS, { ...DAY_SHIFT, start: '00:00', end: '12:00' })).toBe(
      11 * 60 - 60,
    )
  })

  it('is an hour longer on the autumn transition', () => {
    expect(scheduledMinutesOn('2026-10-25', AMS, { ...DAY_SHIFT, start: '00:00', end: '12:00' })).toBe(
      13 * 60 - 60,
    )
  })

  it('is unchanged all year where there are no transitions', () => {
    for (const date of ['2026-03-29', '2026-10-25', '2026-06-15'])
      expect(scheduledMinutesOn(date, IST, DAY_SHIFT), date).toBe(480)
  })
})

describe('openState', () => {
  const rows = (...directions: string[]) => directions.map((direction) => ({ direction }))

  it('is open from a clock-in and closed by the clock-out that follows it', () => {
    expect(openState(rows())).toEqual({ clockedIn: false, onBreak: false })
    expect(openState(rows('in'))).toEqual({ clockedIn: true, onBreak: false })
    expect(openState(rows('in', 'out'))).toEqual({ clockedIn: false, onBreak: false })
    expect(openState(rows('in', 'out', 'in'))).toEqual({ clockedIn: true, onBreak: false })
  })

  it('closes a break the person never ended, because clocking out ends it', () => {
    expect(openState(rows('in', 'break_start'))).toEqual({ clockedIn: true, onBreak: true })
    expect(openState(rows('in', 'break_start', 'break_end'))).toEqual({ clockedIn: true, onBreak: false })
    expect(openState(rows('in', 'break_start', 'out'))).toEqual({ clockedIn: false, onBreak: false })
  })
})

/**
 * The shift a punch belongs to.
 *
 * The hard case is the morning between a night shift and the day shift that follows it, and it has
 * been got wrong three times by drawing a line through that morning — at the night's end, at the
 * day's start, at the midpoint of the gap widened by grace. Every line has a bad minute on each
 * side of it, because at 06:59 somebody who worked the night is leaving and somebody who did not is
 * arriving, and the instant is identical.
 *
 * So the fact that separates them is a parameter now: whether a shift is still open. These tests
 * supply it the way `AttendanceService.attribute` does — from punches — and the two readings of the
 * same instant are asserted side by side, minute by minute, rather than at chosen examples.
 *
 * They also attribute **pairs** wherever a shift is involved. An `in` and the `out` that closes it
 * landing on two dates is the whole defect: the day sheet loses one end of the shift, and the
 * router refuses the clock-out as "You are not clocked in."
 */
describe('attributeToShift', () => {
  const NY = 'America/New_York'
  // 22:00–06:00, Monday to Friday. Saturday and Sunday have no shift at all.
  const mondayToFriday = (date: string) => {
    const day = weekdayOf(date)
    return day === 'sat' || day === 'sun' ? null : NIGHT_SHIFT
  }

  /** Nothing filed and unclosed, so every punch is an arrival. */
  const arriving = NOTHING_OPEN
  /** Last night's shift is still running: whatever comes next is leaving it. */
  const leaving: OpenShifts = { onLocalDate: false, onPreviousDate: true, workedPreviousDate: true }

  it('attributes a Saturday-morning clock-out to the Friday night still open', () => {
    // 06:00 on Saturday is 10:00Z — Saturday by either clock, and Saturday has no shift. Asking the
    // week for Saturday therefore gets nothing, never consults `crossesMidnight`, and puts eight
    // hours on a day nobody worked while Friday's sheet goes short.
    const r = attributeToShift(zonedToInstant('2026-06-20', '06:00', NY), NY, mondayToFriday, leaving)
    expect(r.businessDate).toBe('2026-06-19')
    expect(r.shift).toEqual(NIGHT_SHIFT)
  })

  it('attributes the clock-in that opened it to the same Friday', () => {
    // 22:00 on Friday is already 02:00Z on Saturday, so the UTC date disagrees with the local one
    // here too — in the other direction.
    const r = attributeToShift(zonedToInstant('2026-06-19', '22:00', NY), NY, mondayToFriday, arriving)
    expect(r.businessDate).toBe('2026-06-19')
    expect(r.shift).toEqual(NIGHT_SHIFT)
  })

  it('leaves a day shift on its own date', () => {
    const alwaysDay = () => DAY_SHIFT
    expect(attributeToShift(zonedToInstant('2026-06-15', '09:05', IST), IST, alwaysDay, arriving)).toEqual({
      businessDate: '2026-06-15',
      shift: DAY_SHIFT,
    })
  })

  it('does not borrow a shift from a day that had none', () => {
    // Monday 06:00 with nothing scheduled on Sunday is Monday's problem, early though it is.
    const r = attributeToShift(zonedToInstant('2026-06-22', '06:00', NY), NY, mondayToFriday, arriving)
    expect(r.businessDate).toBe('2026-06-22')
    expect(r.shift).toEqual(NIGHT_SHIFT)
  })

  it('reports no shift at all rather than throwing when the week is empty', () => {
    expect(attributeToShift(zonedToInstant('2026-06-20', '06:00', IST), IST, () => null, arriving)).toEqual({
      businessDate: '2026-06-20',
      shift: null,
    })
  })

  it('uses the person’s zone, not the server’s', () => {
    // 22:30Z is already the next day in Istanbul and still the same day in New York.
    const instant = Date.parse('2026-06-15T22:30:00Z')
    const where = (tz: string) => attributeToShift(instant, tz, () => null, arriving).businessDate
    expect(where(IST)).toBe('2026-06-16')
    expect(where(NY)).toBe('2026-06-15')
  })

  /**
   * The night-shift rule, and the reason it exists.
   *
   * Clocking out at 06:00 on Tuesday finishes *Monday's* shift. Attributing those minutes to Tuesday
   * leaves Monday short and Tuesday long — so the month adds up while every individual day is wrong,
   * which is the version nobody catches until somebody disputes a single day.
   */
  it('attributes a night shift to the day it started', () => {
    const everyNight = () => NIGHT_SHIFT
    const filed = (date: string, wall: string, open = arriving) =>
      attributeToShift(at(date, wall), IST, everyNight, open).businessDate

    expect(filed('2026-06-15', '22:00')).toBe('2026-06-15')
    expect(filed('2026-06-15', '23:59')).toBe('2026-06-15')
    // Past midnight, still Monday's shift: somebody clocking in at half past midnight is late for
    // last night, not early for tonight, and that holds with nothing open at all.
    expect(filed('2026-06-16', '00:30')).toBe('2026-06-15')
    expect(filed('2026-06-16', '05:59')).toBe('2026-06-15')
    // From the night's own end, an arrival is an arrival: there is nothing left to be leaving.
    expect(filed('2026-06-16', '06:00')).toBe('2026-06-16')
    // Unless there is. Then it is a departure, and the night keeps it.
    expect(filed('2026-06-16', '06:00', leaving)).toBe('2026-06-15')
    // Late morning is nobody's night shift any more.
    expect(filed('2026-06-16', '14:00')).toBe('2026-06-16')
  })

  /**
   * A day shift that ran past midnight — the case no boundary could even express.
   *
   * 09:00–18:00 says nothing about tomorrow, so `crossesMidnight` is false and every time-only rule
   * files the 00:30 clock-out on the next day, where there is no clock-in to close. The open shift
   * is the only thing that knows better, and it does not have to be told which shifts are allowed
   * to overrun.
   */
  it('keeps a day shift that ran past midnight on the day it started', () => {
    const alwaysDay = () => DAY_SHIFT
    expect(attributeToShift(at('2026-06-16', '00:30'), IST, alwaysDay, leaving)).toEqual({
      businessDate: '2026-06-15',
      shift: DAY_SHIFT,
    })
    expect(attributeToShift(at('2026-06-16', '00:30'), IST, alwaysDay, arriving).businessDate).toBe(
      '2026-06-16',
    )
  })

  /**
   * The rotating week — nights Monday to Friday, then a 08:00–16:00 shift on Saturday.
   *
   * Between the night's 06:00 finish and the morning's 08:00 start lie two hours both shifts have a
   * claim on, and the three previous versions of this function each moved a line through them:
   *
   * - Ask the previous day first, unconditionally, and Saturday's whole shift lands on Friday.
   * - Cut at the morning's start exactly, and arriving eight minutes early lands on Friday instead.
   * - Cut at the midpoint, and 06:59 does the same thing while 07:05 refuses a night worker's
   *   clock-out outright.
   *
   * All three are one failure — the two ends of one shift on two sheets — and none of them could be
   * fixed by moving the line, because the two punches they confuse are the same instant.
   */
  const MORNING_SHIFT: ShiftSpec = {
    start: '08:00',
    end: '16:00',
    breakMinutes: 0,
    graceInMinutes: 5,
    graceOutMinutes: 5,
  }
  // Nights Monday to Friday, a morning shift on Saturday, nothing on Sunday.
  const rotating = (date: string) => {
    const day = weekdayOf(date)
    if (day === 'sun') return null
    return day === 'sat' ? MORNING_SHIFT : NIGHT_SHIFT
  }

  /** The business date every punch in a sequence is filed on, in order. */
  const filedOn = (
    punches: Array<[string, string]>,
    shiftFor: (date: string) => ShiftSpec | null,
    open: OpenShifts = arriving,
    tz = NY,
  ) =>
    punches.map(
      ([date, wall]) => attributeToShift(zonedToInstant(date, wall, tz), tz, shiftFor, open).businessDate,
    )

  /**
   * The contested window, every minute of it, read both ways.
   *
   * This is the assertion the previous three rounds could not have passed and the chosen-instant
   * tests they shipped with could not have caught: the same 136 instants, once as a departure from
   * a night that is still open and once as an arrival with nothing open, have to answer differently
   * and consistently — with no minute anywhere in between where either reading changes its mind.
   */
  it('gives every minute of the contested window to whichever shift is actually running', () => {
    const window: string[] = []
    for (let minute = 6 * 60; minute <= 8 * 60 + 15; minute++)
      window.push(
        `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
      )
    expect(window).toHaveLength(136)

    for (const wall of window) {
      expect(filedOn([['2026-06-20', wall]], rotating, leaving), `leaving at ${wall}`).toEqual(['2026-06-19'])
      expect(filedOn([['2026-06-20', wall]], rotating, arriving), `arriving at ${wall}`).toEqual([
        '2026-06-20',
      ])
    }
  })

  it('files a whole Saturday morning shift on Saturday, however early it is started', () => {
    // The pair is the assertion, and the second half of it is what the open shift changes: once the
    // arrival has opened Saturday, the clock-out that closes it is a departure from Saturday.
    for (const arrival of ['06:00', '06:59', '07:00', '07:52', '08:00', '08:04'])
      expect(
        [
          ...filedOn([['2026-06-20', arrival]], rotating, arriving),
          ...filedOn([['2026-06-20', '16:00']], rotating, {
            onLocalDate: true,
            onPreviousDate: false,
            workedPreviousDate: false,
          }),
        ],
        arrival,
      ).toEqual(['2026-06-20', '2026-06-20'])
  })

  it('files the night that ran into that morning on Friday, at both ends', () => {
    expect(filedOn([['2026-06-19', '22:00']], rotating, arriving)).toEqual(['2026-06-19'])
    const out = attributeToShift(zonedToInstant('2026-06-20', '06:00', NY), NY, rotating, leaving)
    expect(out.businessDate).toBe('2026-06-19')
    expect(out.shift).toEqual(NIGHT_SHIFT)
  })

  /**
   * The mirror of arriving early is leaving late, and it is what stops "give the morning the gap"
   * being an acceptable answer.
   *
   * There is no longer a distance at which a night worker's clock-out stops being theirs. The shift
   * is open; only a clock-out closes it; so it closes it, at 06:45 or at 09:30.
   */
  it('keeps a late clock-out from that night on Friday, however far past the end it comes', () => {
    for (const wall of ['06:01', '06:45', '07:05', '08:00', '09:30', '14:00'])
      expect(filedOn([['2026-06-20', wall]], rotating, leaving), wall).toEqual(['2026-06-19'])
  })

  /**
   * Somebody who forgot to clock out and is now arriving for today.
   *
   * The open shift wins, and it has to: a punch filed on today closes nothing, and last night stays
   * open behind it. So this punch ends the night — truthfully, at the moment they made it — and the
   * next one is an arrival. The person is not guessing about any of it, because `attendance.state`
   * reads this same attribution and has already told them they are still clocked in.
   */
  it('ends the forgotten night first, and files the day that follows it on the day', () => {
    expect(filedOn([['2026-06-20', '08:00']], rotating, leaving)).toEqual(['2026-06-19'])
    expect(filedOn([['2026-06-20', '08:01']], rotating, arriving)).toEqual(['2026-06-20'])
  })

  it('joins the shift open on today rather than the one open on yesterday', () => {
    // Two open shifts is not a state punching alone can reach — a regularization can — and the one
    // somebody is actually on is the one that started most recently.
    expect(
      filedOn([['2026-06-20', '16:00']], rotating, {
        onLocalDate: true,
        onPreviousDate: true,
        workedPreviousDate: true,
      }),
    ).toEqual(['2026-06-20'])
  })

  /**
   * `graceInMinutes` no longer has anything to do with this.
   *
   * Round three let a generous grace widen the day's half of the gap, which sounded principled and
   * was another constant with a bad minute beside it. Lateness is what grace is for; which shift a
   * punch is on is settled by whether a shift is open.
   */
  it('ignores grace entirely when deciding which shift a punch is on', () => {
    const generous = (date: string) => {
      const day = weekdayOf(date)
      if (day === 'sun') return null
      return day === 'sat' ? { ...MORNING_SHIFT, graceInMinutes: 90 } : NIGHT_SHIFT
    }
    for (const wall of ['06:00', '06:29', '06:30', '07:30'])
      expect(filedOn([['2026-06-20', wall]], generous, arriving), wall).toEqual(['2026-06-20'])
    for (const wall of ['06:00', '06:29', '06:30', '07:30'])
      expect(filedOn([['2026-06-20', wall]], generous, leaving), wall).toEqual(['2026-06-19'])
  })

  it('gives the morning the instant itself when the two shifts meet with no gap', () => {
    // 22:00–08:00 straight into 08:00–16:00. There is no gap to contest, and somebody clocking in
    // on time must not open yesterday.
    const backToBack = (date: string) => {
      const day = weekdayOf(date)
      if (day === 'sun') return null
      return day === 'sat' ? MORNING_SHIFT : { ...NIGHT_SHIFT, start: '22:00', end: '08:00', breakMinutes: 0 }
    }
    expect(filedOn([['2026-06-20', '07:59']], backToBack, arriving)).toEqual(['2026-06-19'])
    expect(filedOn([['2026-06-20', '08:00']], backToBack, arriving)).toEqual(['2026-06-20'])
  })

  it('sends an arrival to the day once the day’s own shift has started, even mid-night', () => {
    // Overlapping schedules: a 22:00–08:00 night and a 07:00 start. From 07:00 the day is the shift
    // that began most recently, so an arrival opens it rather than joining a night nobody is on.
    const overlapping = (date: string) => {
      const day = weekdayOf(date)
      if (day === 'sun') return null
      return day === 'sat'
        ? { ...MORNING_SHIFT, start: '07:00', end: '15:00' }
        : { ...NIGHT_SHIFT, start: '22:00', end: '08:00', breakMinutes: 0 }
    }
    expect(filedOn([['2026-06-20', '06:59']], overlapping, arriving)).toEqual(['2026-06-19'])
    expect(filedOn([['2026-06-20', '07:00']], overlapping, arriving)).toEqual(['2026-06-20'])
    // A departure is still a departure, whatever has started since.
    expect(filedOn([['2026-06-20', '07:00']], overlapping, leaving)).toEqual(['2026-06-19'])
  })
})

describe('computeDay', () => {
  const day = (punches: Array<[string, string]>, extra: Partial<Parameters<typeof computeDay>[0]> = {}) =>
    computeDay({
      businessDate: '2026-06-15',
      timeZone: IST,
      shift: DAY_SHIFT,
      punches: punches.map(([wall, direction]) => ({
        at: at('2026-06-15', wall),
        direction: direction as never,
      })),
      ...extra,
    })

  it('counts a plain day, deducting the scheduled break', () => {
    const r = day([
      ['09:00', 'in'],
      ['18:00', 'out'],
    ])
    expect(r.workedMinutes).toBe(480)
    expect(r.status).toBe('present')
    expect(r.anomalies).toEqual([])
  })

  it('deducts a punched break instead of the scheduled one, not both', () => {
    // Somebody who clocks their lunch must not have it taken off twice.
    const r = day([
      ['09:00', 'in'],
      ['12:00', 'break_start'],
      ['12:30', 'break_end'],
      ['18:00', 'out'],
    ])
    expect(r.breakMinutes).toBe(30)
    expect(r.workedMinutes).toBe(540 - 30)
  })

  it('counts late arrival past the grace period', () => {
    expect(
      day([
        ['09:04', 'in'],
        ['18:00', 'out'],
      ]).lateMinutes,
    ).toBe(0)
    expect(
      day([
        ['09:20', 'in'],
        ['18:00', 'out'],
      ]).lateMinutes,
    ).toBe(15)
  })

  it('counts leaving early past the grace period', () => {
    expect(
      day([
        ['09:00', 'in'],
        ['17:57', 'out'],
      ]).earlyLeaveMinutes,
    ).toBe(0)
    expect(
      day([
        ['09:00', 'in'],
        ['17:00', 'out'],
      ]).earlyLeaveMinutes,
    ).toBe(55)
  })

  it('counts overtime beyond the scheduled span', () => {
    const r = day([
      ['09:00', 'in'],
      ['20:00', 'out'],
    ])
    expect(r.overtimeMinutes).toBe(660 - 60 - 480)
  })

  it('flags a missing clock-out and leaves the day pending', () => {
    // Somebody who forgot to clock out still worked. Refusing to produce a row would leave the sheet
    // silent about a day that needs a human, which is worse than saying so.
    const r = day([['09:00', 'in']])
    expect(r.anomalies).toContain('missing_clock_out')
    expect(r.status).toBe('pending')
  })

  it('flags a clock-out with no clock-in rather than counting it', () => {
    const r = day([['18:00', 'out']])
    expect(r.anomalies).toContain('clock_out_without_in')
    expect(r.workedMinutes).toBe(0)
  })

  it('closes a break left open at the end of the shift', () => {
    // Not working, so it must not be paid — but it also must be visible.
    const r = day([
      ['09:00', 'in'],
      ['12:00', 'break_start'],
      ['18:00', 'out'],
    ])
    expect(r.anomalies).toContain('break_not_ended')
    expect(r.breakMinutes).toBe(360)
  })

  it('is absent with no punches and a schedule, present when excused', () => {
    expect(day([]).status).toBe('absent')
    expect(day([], { excused: true }).status).toBe('present')
  })

  it('rounds in the direction the policy asks for', () => {
    const punches = [
      { at: at('2026-06-15', '09:00'), direction: 'in' as const },
      { at: at('2026-06-15', '17:52'), direction: 'out' as const },
    ]
    const base = { businessDate: '2026-06-15', timeZone: IST, shift: DAY_SHIFT, punches }
    // 8h52m minus the 60-minute break is 472.
    expect(computeDay(base).workedMinutes).toBe(472)
    expect(computeDay({ ...base, rounding: { stepMinutes: 15, direction: 'nearest' } }).workedMinutes).toBe(
      465,
    )
    expect(computeDay({ ...base, rounding: { stepMinutes: 15, direction: 'employee' } }).workedMinutes).toBe(
      480,
    )
    expect(computeDay({ ...base, rounding: { stepMinutes: 15, direction: 'employer' } }).workedMinutes).toBe(
      465,
    )
  })

  it('spans midnight for a night shift', () => {
    const r = computeDay({
      businessDate: '2026-06-15',
      timeZone: IST,
      shift: NIGHT_SHIFT,
      punches: [
        { at: at('2026-06-15', '22:00'), direction: 'in' },
        { at: at('2026-06-16', '06:00'), direction: 'out' },
      ],
    })
    expect(r.workedMinutes).toBe(480 - 30)
    expect(r.lateMinutes).toBe(0)
    expect(r.earlyLeaveMinutes).toBe(0)
    expect(r.status).toBe('present')
  })

  /**
   * The clock moved during the shift.
   *
   * Somebody who works 00:00–12:00 in Amsterdam on the spring transition is at work for eleven real
   * hours, not twelve — and on the autumn one, thirteen. The worked total has to follow the
   * instants, which is the whole reason punches are stored as instants rather than local times.
   */
  it('follows real elapsed time across a daylight-saving transition', () => {
    const spring = computeDay({
      businessDate: '2026-03-29',
      timeZone: AMS,
      shift: { ...DAY_SHIFT, start: '00:00', end: '12:00', breakMinutes: 0 },
      punches: [
        { at: zonedToInstant('2026-03-29', '00:00', AMS), direction: 'in' },
        { at: zonedToInstant('2026-03-29', '12:00', AMS), direction: 'out' },
      ],
    })
    expect(spring.workedMinutes).toBe(11 * 60)
    expect(spring.overtimeMinutes).toBe(0)

    const autumn = computeDay({
      businessDate: '2026-10-25',
      timeZone: AMS,
      shift: { ...DAY_SHIFT, start: '00:00', end: '12:00', breakMinutes: 0 },
      punches: [
        { at: zonedToInstant('2026-10-25', '00:00', AMS), direction: 'in' },
        { at: zonedToInstant('2026-10-25', '12:00', AMS), direction: 'out' },
      ],
    })
    expect(autumn.workedMinutes).toBe(13 * 60)
  })

  it('handles punches arriving out of order', () => {
    // A device syncing a backlog does not promise order.
    const r = computeDay({
      businessDate: '2026-06-15',
      timeZone: IST,
      shift: DAY_SHIFT,
      punches: [
        { at: at('2026-06-15', '18:00'), direction: 'out' },
        { at: at('2026-06-15', '09:00'), direction: 'in' },
      ],
    })
    expect(r.workedMinutes).toBe(480)
    expect(r.anomalies).toEqual([])
  })

  it('never reports negative minutes', () => {
    const r = day([
      ['09:00', 'in'],
      ['09:10', 'out'],
    ])
    expect(r.workedMinutes).toBeGreaterThanOrEqual(0)
  })
})
