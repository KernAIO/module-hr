import { describe, expect, it } from 'vitest'
import { zonedToInstant } from './time.js'
import {
  businessDateFor,
  computeDay,
  crossesMidnight,
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

describe('businessDateFor', () => {
  it('is the local date for a day shift', () => {
    expect(businessDateFor(at('2026-06-15', '09:05'), IST, DAY_SHIFT)).toBe('2026-06-15')
    expect(businessDateFor(at('2026-06-15', '17:55'), IST, DAY_SHIFT)).toBe('2026-06-15')
  })

  /**
   * The night-shift rule, and the reason it exists.
   *
   * Clocking out at 06:00 on Tuesday finishes *Monday's* shift. Attributing those minutes to Tuesday
   * leaves Monday short and Tuesday long — so the month adds up while every individual day is wrong,
   * which is the version nobody catches until somebody disputes a single day.
   */
  it('attributes a night shift to the day it started', () => {
    expect(businessDateFor(at('2026-06-15', '22:00'), IST, NIGHT_SHIFT)).toBe('2026-06-15')
    expect(businessDateFor(at('2026-06-15', '23:59'), IST, NIGHT_SHIFT)).toBe('2026-06-15')
    // Past midnight, still Monday's shift.
    expect(businessDateFor(at('2026-06-16', '00:30'), IST, NIGHT_SHIFT)).toBe('2026-06-15')
    expect(businessDateFor(at('2026-06-16', '06:00'), IST, NIGHT_SHIFT)).toBe('2026-06-15')
  })

  it('starts a new business day once the next shift could begin', () => {
    // Late morning is nobody's night shift any more.
    expect(businessDateFor(at('2026-06-16', '14:00'), IST, NIGHT_SHIFT)).toBe('2026-06-16')
  })

  it('falls back to the local date with no schedule', () => {
    expect(businessDateFor(at('2026-06-16', '02:00'), IST, null)).toBe('2026-06-16')
  })

  it('uses the person’s zone, not the server’s', () => {
    // 22:30Z is already the next day in Istanbul and still the same day in New York.
    const instant = Date.parse('2026-06-15T22:30:00Z')
    expect(businessDateFor(instant, IST, null)).toBe('2026-06-16')
    expect(businessDateFor(instant, 'America/New_York', null)).toBe('2026-06-15')
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
