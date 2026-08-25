import { describe, expect, it } from 'vitest'
import {
  civilAt,
  dateIn,
  dayLengthMinutes,
  minutesOfDayIn,
  nextDate,
  offsetMsAt,
  previousDate,
  zonedToInstant,
} from './time.js'

const HOUR = 3600_000

/**
 * Daylight saving, in the four zones this module actually ships packs for.
 *
 * Istanbul is in the list precisely *because* it has no transitions — Türkiye abolished them in
 * 2016 and sits on UTC+3 all year. A test suite made only of zones that shift proves the code
 * handles shifts; including one that does not proves it has not invented one.
 */
describe('zonedToInstant', () => {
  it('resolves an ordinary morning', () => {
    const ms = zonedToInstant('2026-06-15', '09:00', 'Europe/Amsterdam')
    // June: CEST, UTC+2.
    expect(new Date(ms).toISOString()).toBe('2026-06-15T07:00:00.000Z')
  })

  it('is exact for a zone with no transitions', () => {
    const winter = zonedToInstant('2026-01-15', '09:00', 'Europe/Istanbul')
    const summer = zonedToInstant('2026-07-15', '09:00', 'Europe/Istanbul')
    expect(new Date(winter).toISOString()).toBe('2026-01-15T06:00:00.000Z')
    expect(new Date(summer).toISOString()).toBe('2026-07-15T06:00:00.000Z')
    // Same offset in both halves of the year: Türkiye abolished the change in 2016.
    expect(offsetMsAt(winter, 'Europe/Istanbul')).toBe(offsetMsAt(summer, 'Europe/Istanbul'))
  })

  it('handles the spring forward, where the clock skips an hour', () => {
    // 2026-03-29, Amsterdam: 02:00 becomes 03:00. 01:00 CET is 00:00Z; 04:00 CEST is 02:00Z.
    const before = zonedToInstant('2026-03-29', '01:00', 'Europe/Amsterdam')
    const after = zonedToInstant('2026-03-29', '04:00', 'Europe/Amsterdam')
    expect(new Date(before).toISOString()).toBe('2026-03-29T00:00:00.000Z')
    expect(new Date(after).toISOString()).toBe('2026-03-29T02:00:00.000Z')
    // Three wall-clock hours apart, but only two real hours: the missing one is the point.
    expect(after - before).toBe(2 * HOUR)
  })

  it('resolves a wall time that never existed to the instant the clock jumps to', () => {
    // 02:30 does not happen on 2026-03-29 in Amsterdam. Somebody who says they clocked in then
    // still turned up, so this must produce a usable instant rather than throw or drift a day.
    const ms = zonedToInstant('2026-03-29', '02:30', 'Europe/Amsterdam')
    expect(Number.isFinite(ms)).toBe(true)
    expect(dateIn(ms, 'Europe/Amsterdam')).toBe('2026-03-29')
    const local = civilAt(ms, 'Europe/Amsterdam')
    expect(local.hour).toBe(3)
  })

  it('handles the autumn back, where an hour happens twice', () => {
    // 2026-10-25, Amsterdam: 03:00 becomes 02:00. Two wall-clock hours apart, three real hours.
    const before = zonedToInstant('2026-10-25', '01:00', 'Europe/Amsterdam')
    const after = zonedToInstant('2026-10-25', '04:00', 'Europe/Amsterdam')
    expect(after - before).toBe(4 * HOUR)
  })

  it('resolves an ambiguous wall time to its first occurrence', () => {
    // 02:30 happens twice on 2026-10-25. The earlier one is what "the shift started" means.
    const ms = zonedToInstant('2026-10-25', '02:30', 'Europe/Amsterdam')
    expect(new Date(ms).toISOString()).toBe('2026-10-25T00:30:00.000Z')
  })

  it('handles the American transitions, which are on different dates', () => {
    // The US changed on 2026-03-08 and 2026-11-01 — a fortnight before and a week after Europe.
    // A system assuming one global transition date is wrong for weeks at a time.
    const march = zonedToInstant('2026-03-15', '09:00', 'America/New_York')
    const feb = zonedToInstant('2026-02-15', '09:00', 'America/New_York')
    expect(new Date(march).toISOString()).toBe('2026-03-15T13:00:00.000Z') // EDT, UTC-4
    expect(new Date(feb).toISOString()).toBe('2026-02-15T14:00:00.000Z') // EST, UTC-5
  })

  it('handles a half-hour offset zone', () => {
    // Tehran is UTC+3:30 and, like Istanbul, no longer changes. A whole-hour assumption anywhere in
    // the arithmetic shows up here.
    const ms = zonedToInstant('2026-06-15', '09:00', 'Asia/Tehran')
    expect(new Date(ms).toISOString()).toBe('2026-06-15T05:30:00.000Z')
  })
})

describe('dateIn', () => {
  it('gives the local date, not the UTC one', () => {
    // 22:30Z on the 14th is already the 15th in Tehran and still the 14th in New York.
    const instant = Date.parse('2026-06-14T22:30:00Z')
    expect(dateIn(instant, 'Asia/Tehran')).toBe('2026-06-15')
    expect(dateIn(instant, 'America/New_York')).toBe('2026-06-14')
    expect(dateIn(instant, 'UTC')).toBe('2026-06-14')
  })

  it('puts local midnight on the right day', () => {
    // The `hour: 24` case: an engine reporting midnight as 24 would put this on the previous day.
    const ms = zonedToInstant('2026-06-15', '00:00', 'Europe/Istanbul')
    expect(dateIn(ms, 'Europe/Istanbul')).toBe('2026-06-15')
    expect(minutesOfDayIn(ms, 'Europe/Istanbul')).toBe(0)
  })
})

describe('dayLengthMinutes', () => {
  it('is 1440 on an ordinary day', () => {
    expect(dayLengthMinutes('2026-06-15', 'Europe/Amsterdam')).toBe(1440)
  })

  it('is 1380 on the day the clock springs forward', () => {
    expect(dayLengthMinutes('2026-03-29', 'Europe/Amsterdam')).toBe(1380)
  })

  it('is 1500 on the day the clock falls back', () => {
    expect(dayLengthMinutes('2026-10-25', 'Europe/Amsterdam')).toBe(1500)
  })

  it('is always 1440 where there are no transitions', () => {
    for (const date of ['2026-03-29', '2026-10-25', '2026-06-15'])
      expect(dayLengthMinutes(date, 'Europe/Istanbul'), date).toBe(1440)
  })
})

describe('nextDate and previousDate', () => {
  it('crosses months, years and leap days', () => {
    expect(nextDate('2026-01-31')).toBe('2026-02-01')
    expect(nextDate('2026-12-31')).toBe('2027-01-01')
    expect(nextDate('2024-02-28')).toBe('2024-02-29')
    expect(nextDate('2026-02-28')).toBe('2026-03-01')
    expect(previousDate('2026-03-01')).toBe('2026-02-28')
    expect(previousDate('2024-03-01')).toBe('2024-02-29')
    expect(previousDate('2027-01-01')).toBe('2026-12-31')
  })

  it('round-trips', () => {
    for (const d of ['2026-01-01', '2026-02-28', '2024-02-29', '2026-12-31', '2026-03-29'])
      expect(previousDate(nextDate(d)), d).toBe(d)
  })
})
