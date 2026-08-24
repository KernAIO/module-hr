import { describe, expect, it } from 'vitest'
import {
  composeDays,
  countWorkingDays,
  datesBetween,
  daysInMonth,
  weekdayOf,
  workingDays,
} from './calendar.js'

const MON_FRI = { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 }
/** Iran: Friday is the weekend and Thursday is a half day. */
const IRAN = { sat: 1, sun: 1, mon: 1, tue: 1, wed: 1, thu: 0.5, fri: 0 }
/** Much of the Gulf until recently, and still some employers. */
const FRI_SAT = { sun: 1, mon: 1, tue: 1, wed: 1, thu: 1, fri: 0, sat: 0 }

describe('weekdayOf', () => {
  it('names the right day', () => {
    expect(weekdayOf('2026-08-24')).toBe('mon')
    expect(weekdayOf('2026-08-30')).toBe('sun')
    expect(weekdayOf('2000-01-01')).toBe('sat')
    expect(weekdayOf('1900-01-01')).toBe('mon')
  })

  it('is the same answer regardless of the runtime timezone', () => {
    // `new Date('2026-08-24')` is UTC midnight read back in the local zone, so west of Greenwich it
    // reports the 23rd. Every off-by-one-day date bug is a version of that, so this must not use it.
    const original = process.env.TZ
    const answers = new Set<string>()
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Tehran']) {
      process.env.TZ = tz
      answers.add(weekdayOf('2026-08-24'))
    }
    process.env.TZ = original
    expect([...answers]).toEqual(['mon'])
  })

  it('handles leap days', () => {
    expect(weekdayOf('2024-02-29')).toBe('thu')
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2100, 2)).toBe(28) // divisible by 100, not by 400
    expect(daysInMonth(2000, 2)).toBe(29)
  })
})

describe('datesBetween', () => {
  it('is inclusive at both ends', () => {
    expect(datesBetween('2026-08-24', '2026-08-26')).toEqual(['2026-08-24', '2026-08-25', '2026-08-26'])
  })
  it('crosses a month boundary', () => {
    expect(datesBetween('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ])
  })
  it('crosses a year boundary', () => {
    expect(datesBetween('2026-12-30', '2027-01-02')).toHaveLength(4)
  })
  it('crosses a leap day', () => {
    expect(datesBetween('2024-02-28', '2024-03-01')).toEqual(['2024-02-28', '2024-02-29', '2024-03-01'])
  })
  it('returns a single day for a zero-length range, and nothing for a reversed one', () => {
    expect(datesBetween('2026-08-24', '2026-08-24')).toEqual(['2026-08-24'])
    expect(datesBetween('2026-08-26', '2026-08-24')).toEqual([])
  })
  it('spans a daylight-saving transition without losing or gaining a day', () => {
    // 2026-03-29 is 23 hours long in Amsterdam and 2026-10-25 is 25. A range built by adding 86400
    // seconds skips or repeats a date across these; this must not.
    expect(datesBetween('2026-03-28', '2026-03-30')).toHaveLength(3)
    expect(datesBetween('2026-10-24', '2026-10-26')).toHaveLength(3)
  })
})

describe('workingDays', () => {
  it('counts a plain Monday-to-Friday week', () => {
    const r = workingDays('2026-08-24', '2026-08-30', MON_FRI, [])
    expect(countWorkingDays(r)).toBe(5)
    expect(r.filter((d) => d.reason === 'weekend')).toHaveLength(2)
  })

  it('counts an Iranian week, half Thursday included', () => {
    // Sat 22 → Fri 28 August 2026.
    const r = workingDays('2026-08-22', '2026-08-28', IRAN, [])
    expect(countWorkingDays(r)).toBe(5.5)
    expect(r.find((d) => d.date === '2026-08-28')?.fraction).toBe(0) // Friday off
    expect(r.find((d) => d.date === '2026-08-27')?.fraction).toBe(0.5) // half Thursday
  })

  it('counts a Friday-Saturday weekend', () => {
    expect(countWorkingDays(workingDays('2026-08-23', '2026-08-29', FRI_SAT, []))).toBe(5)
  })

  it('lets a public holiday take a working day out', () => {
    const r = workingDays('2026-08-24', '2026-08-28', MON_FRI, [
      { date: '2026-08-26', name: 'A public holiday', workingFraction: 0 },
    ])
    expect(countWorkingDays(r)).toBe(4)
    expect(r.find((d) => d.date === '2026-08-26')?.reason).toBe('A public holiday')
  })

  it('lets a half day cost half', () => {
    const r = workingDays('2026-08-24', '2026-08-28', MON_FRI, [
      { date: '2026-08-26', name: 'Half day', workingFraction: 0.5 },
    ])
    expect(countWorkingDays(r)).toBe(4.5)
  })

  it('lets a calendar day override the working week in both directions', () => {
    // The company works through a national holiday…
    const worked = workingDays('2026-08-29', '2026-08-29', MON_FRI, [
      { date: '2026-08-29', name: 'We work this Saturday', workingFraction: 1 },
    ])
    expect(countWorkingDays(worked)).toBe(1)
    // …and closes on an ordinary Tuesday.
    const closed = workingDays('2026-08-25', '2026-08-25', MON_FRI, [
      { date: '2026-08-25', name: 'Company closure', workingFraction: 0 },
    ])
    expect(countWorkingDays(closed)).toBe(0)
  })

  it('does not double-count a holiday that lands on a weekend', () => {
    const r = workingDays('2026-08-24', '2026-08-30', MON_FRI, [
      { date: '2026-08-30', name: 'Holiday on a Sunday', workingFraction: 0 },
    ])
    expect(countWorkingDays(r)).toBe(5)
  })

  it('adds halves exactly rather than to 4.499999999999999', () => {
    const r = workingDays('2026-08-24', '2026-08-28', MON_FRI, [
      { date: '2026-08-24', name: 'Half', workingFraction: 0.5 },
      { date: '2026-08-25', name: 'Half', workingFraction: 0.5 },
      { date: '2026-08-26', name: 'Half', workingFraction: 0.5 },
    ])
    expect(countWorkingDays(r)).toBe(3.5)
  })
})

describe('composeDays', () => {
  const pack = {
    calendarId: 'pack',
    days: [
      { date: '2026-01-01', kind: 'public_holiday' as const, calendarId: 'pack' },
      { date: '2026-04-23', kind: 'public_holiday' as const, calendarId: 'pack' },
    ],
  }
  const office = {
    calendarId: 'office',
    days: [
      { date: '2026-04-23', kind: 'public_holiday' as const, calendarId: 'office' },
      { date: '2026-07-15', kind: 'company_closure' as const, calendarId: 'office' },
    ],
  }

  it('lets the nearest calendar win for the same date and kind', () => {
    const composed = composeDays([office, pack])
    const apr = composed.filter((d) => d.date === '2026-04-23')
    expect(apr).toHaveLength(1)
    expect(apr[0]?.calendarId).toBe('office')
  })

  it('keeps days only the pack has', () => {
    expect(composeDays([office, pack]).some((d) => d.date === '2026-01-01')).toBe(true)
  })

  it('keeps days only the office has', () => {
    expect(composeDays([office, pack]).some((d) => d.date === '2026-07-15')).toBe(true)
  })

  it('returns them in date order', () => {
    const dates = composeDays([office, pack]).map((d) => d.date)
    expect(dates).toEqual([...dates].sort())
  })

  it('is just the pack when nothing extends it', () => {
    expect(composeDays([pack])).toHaveLength(2)
  })
})
