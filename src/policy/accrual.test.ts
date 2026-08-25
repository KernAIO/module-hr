import { describe, expect, it } from 'vitest'
import {
  type AccrualPolicy,
  accrueForPeriod,
  carryExpiryDate,
  carryForward,
  completedMonths,
  completedYears,
  daysPerYearFor,
  overtimeFor,
} from './accrual.js'

const DAY = 8 * 60

/** Turkish annual leave: 14 days under five years, 20 up to fifteen, 26 beyond. */
const TR: AccrualPolicy = {
  frequency: 'monthly',
  daysPerYear: 14,
  minutesPerDay: DAY,
  seniorityTiers: [
    { afterYears: 0, daysPerYear: 14 },
    { afterYears: 5, daysPerYear: 20 },
    { afterYears: 15, daysPerYear: 26 },
  ],
}

describe('completedYears', () => {
  it('counts by anniversary, not by dividing days', () => {
    // A day before the anniversary is still four years, not five. Dividing by 365 gets this wrong
    // across leap years and puts somebody over a seniority threshold days early.
    expect(completedYears('2021-06-15', '2026-06-14')).toBe(4)
    expect(completedYears('2021-06-15', '2026-06-15')).toBe(5)
    expect(completedYears('2021-06-15', '2026-06-16')).toBe(5)
  })

  it('handles a leap-day hire', () => {
    expect(completedYears('2024-02-29', '2026-02-28')).toBe(1)
    expect(completedYears('2024-02-29', '2028-02-29')).toBe(4)
  })

  it('is never negative for a future hire date', () => {
    expect(completedYears('2027-01-01', '2026-01-01')).toBe(0)
  })
})

describe('completedMonths', () => {
  it('counts only whole months', () => {
    expect(completedMonths('2026-01-15', '2026-02-14')).toBe(0)
    expect(completedMonths('2026-01-15', '2026-02-15')).toBe(1)
    expect(completedMonths('2026-01-15', '2027-01-15')).toBe(12)
  })
})

describe('daysPerYearFor', () => {
  it('picks the tier that has actually been reached', () => {
    expect(daysPerYearFor(TR, 0)).toBe(14)
    expect(daysPerYearFor(TR, 4)).toBe(14)
    expect(daysPerYearFor(TR, 5)).toBe(20)
    expect(daysPerYearFor(TR, 14)).toBe(20)
    expect(daysPerYearFor(TR, 15)).toBe(26)
    expect(daysPerYearFor(TR, 40)).toBe(26)
  })

  it('does not depend on the order the tiers were written in', () => {
    const shuffled: AccrualPolicy = {
      ...TR,
      seniorityTiers: [
        { afterYears: 15, daysPerYear: 26 },
        { afterYears: 0, daysPerYear: 14 },
        { afterYears: 5, daysPerYear: 20 },
      ],
    }
    expect(daysPerYearFor(shuffled, 7)).toBe(20)
  })

  it('falls back to the flat entitlement with no tiers', () => {
    expect(daysPerYearFor({ ...TR, seniorityTiers: [] }, 20)).toBe(14)
  })
})

describe('accrueForPeriod', () => {
  const january = { from: '2026-01-01', to: '2026-01-31' }

  it('accrues a twelfth of the entitlement for a full month', () => {
    const r = accrueForPeriod({ policy: TR, period: january, hiredOn: '2020-01-01', fte: 1 })
    // Six years' service → 20 days; a twelfth of 20 days is 1.667 days.
    expect(r.minutes).toBe(Math.round((20 * DAY) / 12))
    expect(r.proration).toBe(1)
  })

  /**
   * The case an HR system is most often quietly wrong about: rounding a mid-month joiner to a whole
   * month, which leaves every such person a fraction of a day out for ever.
   */
  it('prorates a mid-month joiner by days, not months', () => {
    const r = accrueForPeriod({ policy: TR, period: january, hiredOn: '2026-01-20', fte: 1 })
    // 20th to 31st inclusive is 12 of 31 days.
    expect(r.proration).toBeCloseTo(12 / 31, 5)
    expect(r.minutes).toBe(Math.round(14 * DAY * (1 / 12) * (12 / 31)))
    expect(r.reason).toContain('% of period')
  })

  it('prorates a leaver the same way', () => {
    const r = accrueForPeriod({
      policy: TR,
      period: january,
      hiredOn: '2020-01-01',
      terminatedOn: '2026-01-10',
      fte: 1,
    })
    expect(r.proration).toBeCloseTo(10 / 31, 5)
  })

  it('accrues nothing for somebody who joined after the period', () => {
    const r = accrueForPeriod({ policy: TR, period: january, hiredOn: '2026-03-01', fte: 1 })
    expect(r.minutes).toBe(0)
    expect(r.reason).toContain('not employed')
  })

  it('scales by FTE, and proration and FTE multiply', () => {
    const half = accrueForPeriod({ policy: TR, period: january, hiredOn: '2020-01-01', fte: 0.5 })
    const full = accrueForPeriod({ policy: TR, period: january, hiredOn: '2020-01-01', fte: 1 })
    expect(half.minutes).toBe(Math.round(full.minutes / 2))

    // A half-time joiner on the 20th has earned a sixth of a month: both facts are true at once, so
    // the larger must not simply win.
    const both = accrueForPeriod({ policy: TR, period: january, hiredOn: '2026-01-20', fte: 0.5 })
    expect(both.minutes).toBe(Math.round(14 * DAY * (1 / 12) * (12 / 31) * 0.5))
  })

  it('does not accrue against unpaid leave', () => {
    const r = accrueForPeriod({
      policy: TR,
      period: january,
      hiredOn: '2020-01-01',
      fte: 1,
      unpaidDays: 10,
    })
    expect(r.proration).toBeCloseTo(21 / 31, 5)
    expect(r.reason).toContain('10d unpaid')
  })

  it('honours a waiting period', () => {
    const withWait = { ...TR, waitingPeriodMonths: 3 }
    const early = accrueForPeriod({ policy: withWait, period: january, hiredOn: '2025-12-01', fte: 1 })
    expect(early.minutes).toBe(0)
    expect(early.reason).toContain('waiting period')

    const later = accrueForPeriod({ policy: withWait, period: january, hiredOn: '2025-06-01', fte: 1 })
    expect(later.minutes).toBeGreaterThan(0)
  })

  it('crosses a seniority threshold using the date the period ends', () => {
    // Five years complete on 2026-01-20, inside the period, so January accrues at the higher tier.
    const r = accrueForPeriod({ policy: TR, period: january, hiredOn: '2021-01-20', fte: 1 })
    expect(r.minutes).toBe(Math.round((20 * DAY) / 12))
    expect(r.reason).toContain('20d/yr')
  })

  it('rounds to the policy step when one is set', () => {
    const r = accrueForPeriod({
      policy: { ...TR, roundToMinutes: 30 },
      period: january,
      hiredOn: '2026-01-20',
      fte: 1,
    })
    expect(r.minutes % 30).toBe(0)
  })

  it('never returns a negative or a fraction of a minute', () => {
    const r = accrueForPeriod({ policy: TR, period: january, hiredOn: '2026-01-31', fte: 0.1 })
    expect(r.minutes).toBeGreaterThanOrEqual(0)
    expect(Number.isInteger(r.minutes)).toBe(true)
  })
})

describe('carryForward', () => {
  const policy = { maxMinutes: 5 * DAY, expiresAfterMonths: 3 }

  it('carries everything under the cap', () => {
    expect(carryForward(3 * DAY, policy)).toEqual({ carriedMinutes: 3 * DAY, expiredMinutes: 0 })
  })

  /**
   * Returns both halves on purpose: the ledger needs an explicit `expiry` entry for the difference.
   * A balance that silently shrinks at midnight on the 1st of January is the most disputed number
   * in any leave system.
   */
  it('expires the excess and says how much', () => {
    expect(carryForward(9 * DAY, policy)).toEqual({
      carriedMinutes: 5 * DAY,
      expiredMinutes: 4 * DAY,
    })
  })

  it('carries nothing from a zero or negative balance', () => {
    expect(carryForward(0, policy).carriedMinutes).toBe(0)
    expect(carryForward(-DAY, policy)).toEqual({ carriedMinutes: 0, expiredMinutes: 0 })
  })

  it('expires everything when the cap is zero', () => {
    expect(carryForward(4 * DAY, { maxMinutes: 0, expiresAfterMonths: null })).toEqual({
      carriedMinutes: 0,
      expiredMinutes: 4 * DAY,
    })
  })
})

describe('carryExpiryDate', () => {
  it('measures from the start of the new year, not the carry date', () => {
    expect(carryExpiryDate('2026-01-01', { maxMinutes: 0, expiresAfterMonths: 3 })).toBe('2026-04-01')
  })
  it('crosses a year boundary', () => {
    expect(carryExpiryDate('2026-11-01', { maxMinutes: 0, expiresAfterMonths: 4 })).toBe('2027-03-01')
  })
  it('clamps to a short month', () => {
    // 31 January plus one month is 28 February, not 31 February.
    expect(carryExpiryDate('2026-01-31', { maxMinutes: 0, expiresAfterMonths: 1 })).toBe('2026-02-28')
    expect(carryExpiryDate('2024-01-31', { maxMinutes: 0, expiresAfterMonths: 1 })).toBe('2024-02-29')
  })
  it('is null when carried leave never expires', () => {
    expect(carryExpiryDate('2026-01-01', { maxMinutes: 0, expiresAfterMonths: null })).toBeNull()
  })
})

describe('overtimeFor', () => {
  it('counts time past the schedule', () => {
    expect(overtimeFor({ workedMinutes: 600, scheduledMinutes: 480 }).overtimeMinutes).toBe(120)
  })
  it('ignores anything under the threshold', () => {
    expect(
      overtimeFor({ workedMinutes: 495, scheduledMinutes: 480, thresholdMinutes: 30 }).overtimeMinutes,
    ).toBe(0)
  })
  it('never counts negative overtime for a short day', () => {
    expect(overtimeFor({ workedMinutes: 300, scheduledMinutes: 480 }).overtimeMinutes).toBe(0)
  })

  /**
   * Several jurisdictions cap how much overtime may be *worked*, not just how it is paid — Turkish
   * law at 270 hours a year. The excess is returned rather than discarded so a report can show
   * hours somebody actually worked but may not be credited.
   */
  it('caps, and reports what went beyond the cap', () => {
    const r = overtimeFor({
      workedMinutes: 600,
      scheduledMinutes: 480,
      capMinutes: 100,
      alreadyCountedMinutes: 40,
    })
    expect(r.overtimeMinutes).toBe(60)
    expect(r.beyondCapMinutes).toBe(60)
  })

  it('counts nothing once the cap is already used up', () => {
    const r = overtimeFor({
      workedMinutes: 600,
      scheduledMinutes: 480,
      capMinutes: 100,
      alreadyCountedMinutes: 100,
    })
    expect(r.overtimeMinutes).toBe(0)
    expect(r.beyondCapMinutes).toBe(120)
  })
})
