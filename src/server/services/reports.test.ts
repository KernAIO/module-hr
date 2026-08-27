/**
 * The report arithmetic that decides **unknown**, pinned without a database.
 *
 * Every case here is one a report gets confidently, plausibly wrong: a percentage for somebody with
 * no schedule, an overtime ceiling reported as "nothing exceeded" where no ceiling ever applied, an
 * expected-working-days figure for an office whose calendar is Monday–Friday only because nothing
 * was attached. None of them throws, none of them fails a type-check, and each of them renders as a
 * number a manager would act on. So they are held to `null` here, where the answer is visible.
 */
import { describe, expect, it } from 'vitest'
import type { PersonResolution, ReportFinality } from '../../contract/index.js'
import { MAX_PERSON_DAYS, MAX_REPORT_DAYS, MAX_SLICED_REPORT_DAYS } from '../../contract/reports.js'
import {
  absenceBasis,
  absenceSplit,
  balanceRow,
  capTotal,
  expectedDaysFor,
  mergeFinality,
  rangeDays,
  rangeRefusal,
  ratio,
  round2,
  scheduleState,
} from './reports.js'
import { DEFAULT_WORKING_WEEK } from './resolve.js'

describe('a percentage nobody can compute is not zero', () => {
  it('answers null when nothing was scheduled', () => {
    // Somebody with no schedule assignment resolves to NO_SCHEDULE, owes no hours, and is written
    // down as `present` with `scheduledMinutes: 0`. Worked ÷ scheduled is a division by zero, and
    // both plausible answers — 0% for a salaried colleague, 100% for one who clocked in anyway —
    // are inventions.
    expect(ratio(0, 0)).toBeNull()
    expect(ratio(480, 0)).toBeNull()
  })

  it('answers null rather than a negative or infinite denominator', () => {
    expect(ratio(100, -5)).toBeNull()
    expect(ratio(100, Number.NaN)).toBeNull()
    expect(ratio(Number.POSITIVE_INFINITY, 100)).toBeNull()
  })

  it('answers the ratio when there is one, to two places', () => {
    expect(ratio(480, 480)).toBe(1)
    expect(ratio(240, 480)).toBe(0.5)
    expect(ratio(1, 3)).toBe(0.33)
  })
})

describe('"no schedule" is read off the policy stamp, never off zero minutes', () => {
  it('recognises the none: prefix hashSchedule writes', () => {
    expect(scheduleState('none:0:nearest')).toBe('none')
  })

  it('does not mistake a scheduled rest day for an absent schedule', () => {
    // A Sunday under a Mon–Fri schedule also has scheduledMinutes 0. The stamp is the only thing
    // that tells the two apart, which is why this function takes the hash and not the minutes.
    expect(scheduleState('0198f0c0-0000-7000-8000-000000000001:15:nearest')).toBe('scheduled')
  })

  it('claims neither state for a row with no stamp', () => {
    expect(scheduleState(null)).toBe('unknown')
    expect(scheduleState(undefined)).toBe('unknown')
    expect(scheduleState('')).toBe('unknown')
  })
})

describe('a ceiling that never applied is not a ceiling nothing exceeded', () => {
  it('answers null when every day is null', () => {
    expect(capTotal([null, null, null])).toEqual({
      beyondCapMinutes: null,
      cappedDays: 0,
      uncappedDays: 3,
    })
  })

  it('answers zero when a ceiling applied and nothing passed it', () => {
    // The distinction the nullable column exists for, and the one a statutory-ceiling conversation
    // turns on. `coalesce(sum(beyond_cap_minutes), 0)` collapses this case into the one above.
    expect(capTotal([0, 0])).toEqual({ beyondCapMinutes: 0, cappedDays: 2, uncappedDays: 0 })
  })

  it('sums only the days a ceiling was in force', () => {
    expect(capTotal([null, 30, null, 15])).toEqual({
      beyondCapMinutes: 45,
      cappedDays: 2,
      uncappedDays: 2,
    })
  })

  it('answers null for an empty population rather than zero', () => {
    expect(capTotal([]).beyondCapMinutes).toBeNull()
  })
})

describe('a mixed range is neither final nor provisional', () => {
  const part = (over: Partial<ReportFinality>): ReportFinality => ({
    lockedDays: 0,
    openDays: 0,
    final: false,
    firstOpenDay: null,
    lastLockedDay: null,
    ...over,
  })

  it('names both edges so the split can be shown', () => {
    const merged = mergeFinality([
      part({ lockedDays: 11, lastLockedDay: '2026-10-15' }),
      part({ openDays: 12, firstOpenDay: '2026-10-16' }),
    ])
    expect(merged).toEqual({
      lockedDays: 11,
      openDays: 12,
      final: false,
      firstOpenDay: '2026-10-16',
      lastLockedDay: '2026-10-15',
    })
  })

  it('is final only when something was locked and nothing is open', () => {
    expect(mergeFinality([part({ lockedDays: 22, lastLockedDay: '2026-10-31' })]).final).toBe(true)
    // A workspace with no periods at all has every day open. That is the ordinary state — the
    // `periods` capability ships off — and must never render as a warning.
    expect(mergeFinality([part({ openDays: 22, firstOpenDay: '2026-10-01' })]).final).toBe(false)
  })

  it('declares nothing final when there was nothing to lock', () => {
    // A range that produced no day sheet at all has no evidence either way, and "final" would be
    // the strongest available claim made from the least.
    expect(mergeFinality([]).final).toBe(false)
    expect(mergeFinality([part({})]).final).toBe(false)
  })
})

describe('absence is expected minus worked minus excused', () => {
  it('subtracts approved leave when the capability is on', () => {
    expect(absenceSplit({ expectedDays: 22, workedDays: 16, leaveDays: 4 })).toEqual({
      absentDays: 2,
      absenceRate: 0.09,
    })
  })

  it('subtracts nothing for leave when the column is absent', () => {
    // `leaveDays: null` is "the leave capability is off", not "nobody was away". The report says so
    // beside the figure with `leaveCounted: false` rather than showing a zero that reads as a fact.
    expect(absenceSplit({ expectedDays: 22, workedDays: 16, leaveDays: null }).absentDays).toBe(6)
  })

  it('never reports a negative absence', () => {
    // Somebody can work a public holiday, or take leave on a day they also clocked in on.
    expect(absenceSplit({ expectedDays: 20, workedDays: 22, leaveDays: 1 }).absentDays).toBe(0)
  })

  it('answers an unknown rate rather than 0% when nothing was expected', () => {
    expect(absenceSplit({ expectedDays: 0, workedDays: 0, leaveDays: 0 })).toEqual({
      absentDays: 0,
      absenceRate: null,
    })
  })

  it('adds halves exactly', () => {
    expect(absenceSplit({ expectedDays: 21.5, workedDays: 20, leaveDays: 0.5 }).absentDays).toBe(1)
  })
})

describe('two populations are named rather than counted absent', () => {
  it('holds somebody with no schedule out of the denominator', () => {
    // In a workspace that clocks in only its shift staff, salaried colleagues are the majority.
    // Counting them absent puts every one of them at 100%.
    expect(absenceBasis({ hasSchedule: false, hasCalendar: true })).toBe('no_schedule')
    expect(absenceBasis({ hasSchedule: false, hasCalendar: false })).toBe('no_schedule')
  })

  it('holds an office with no calendar out of the denominator', () => {
    // The ladder falls back to Monday–Friday, so the arithmetic succeeds and is silently an
    // assumption — wrong for every office whose weekend is Friday.
    expect(absenceBasis({ hasSchedule: true, hasCalendar: false })).toBe('no_calendar')
  })

  it('measures somebody with both', () => {
    expect(absenceBasis({ hasSchedule: true, hasCalendar: true })).toBe('calendar')
  })
})

describe('expected working days come from the calendar in force on each day', () => {
  const resolution = (over: Partial<PersonResolution>): PersonResolution =>
    ({
      personId: '0198f0c0-0000-7000-8000-00000000000a',
      on: '2026-10-01',
      primaryOfficeId: null,
      primaryOfficeName: null,
      otherOfficeIds: [],
      country: null,
      timezone: 'UTC',
      timezoneFrom: 'office',
      calendarId: '0198f0c0-0000-7000-8000-0000000000c1',
      calendarFrom: 'office',
      workingWeek: DEFAULT_WORKING_WEEK,
      legalEntityId: null,
      orgUnitId: null,
      orgUnitPath: null,
      managerPersonId: null,
      ...over,
    }) as PersonResolution

  // Thursday, Friday, Saturday, Sunday, Monday.
  const week = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']

  it('reports the working week when a calendar is attached and has no days in the range', () => {
    // A month with no public holiday in it is an ordinary answer, not a missing one.
    const { expected, hasCalendar } = expectedDaysFor(
      week,
      () => resolution({}),
      () => [],
    )
    expect(hasCalendar).toBe(true)
    expect(expected.map((e) => e.fraction)).toEqual([1, 1, 0, 0, 1])
  })

  it('flags the person when no calendar is attached at all', () => {
    const { hasCalendar } = expectedDaysFor(
      week,
      () => resolution({ calendarId: null }),
      () => [],
    )
    expect(hasCalendar).toBe(false)
  })

  it('follows a working week that is not Monday to Friday', () => {
    // The case `ResolveService`'s fallback is wrong for: an Iranian office works Saturday to
    // Wednesday and rests on Friday.
    const iran = { mon: 1, tue: 1, wed: 1, thu: 0, fri: 0, sat: 1, sun: 1 }
    const { expected } = expectedDaysFor(
      week,
      () => resolution({ workingWeek: iran }),
      () => [],
    )
    expect(expected.map((e) => e.fraction)).toEqual([0, 0, 1, 1, 1])
  })

  it('lets a calendar day beat the working week, in both directions', () => {
    const { expected } = expectedDaysFor(
      week,
      () => resolution({}),
      () => [
        { date: '2026-10-01', name: 'Republic Day', workingFraction: 0 },
        { date: '2026-10-03', name: 'Stocktake Saturday', workingFraction: 1 },
        { date: '2026-10-05', name: 'Half day', workingFraction: 0.5 },
      ],
    )
    expect(expected.map((e) => e.fraction)).toEqual([0, 1, 1, 0, 0.5])
  })

  it('asks the ladder per date, so a transfer mid-range changes the calendar mid-range', () => {
    // Attributing the whole range to today's office is the bug every list handler in this module
    // has and every number in it avoids.
    const istanbul = '0198f0c0-0000-7000-8000-0000000000c1'
    const tehran = '0198f0c0-0000-7000-8000-0000000000c2'
    const { expected } = expectedDaysFor(
      week,
      (date) => resolution({ calendarId: date < '2026-10-03' ? istanbul : tehran }),
      (calendarId) =>
        calendarId === tehran ? [{ date: '2026-10-05', name: 'Closure', workingFraction: 0 }] : [],
    )
    expect(expected.map((e) => e.fraction)).toEqual([1, 1, 0, 0, 0])
  })

  it('skips a date the person was not in the population on', () => {
    const { expected } = expectedDaysFor(
      week,
      (date) => (date === '2026-10-05' ? undefined : resolution({})),
      () => [],
    )
    expect(expected.map((e) => e.date)).toEqual(week.slice(0, 4))
  })
})

describe('a report refuses rather than running for minutes', () => {
  it('refuses a reversed range', () => {
    // Both dates are named, and labelled: "2026-10-01 is before 2026-10-31" is true of a reversed
    // range and of a correct one read the other way round, which is no help to whoever typed it.
    expect(rangeRefusal({ from: '2026-10-31', to: '2026-10-01', perDay: false })).toBe(
      'The end date 2026-10-01 is before the start date 2026-10-31.',
    )
  })

  it('allows a year when no day-by-day attribution is needed', () => {
    expect(rangeRefusal({ from: '2026-01-01', to: '2026-12-31', perDay: false })).toBeNull()
    expect(rangeDays('2026-01-01', '2026-12-31')).toBe(365)
  })

  it('refuses more than a year even unsliced', () => {
    const refusal = rangeRefusal({ from: '2025-01-01', to: '2026-12-31', perDay: false })
    expect(refusal).toContain(String(MAX_REPORT_DAYS))
  })

  it('holds a day-by-day report to a shorter range, and says why', () => {
    const refusal = rangeRefusal({ from: '2026-01-01', to: '2026-12-31', perDay: true })
    expect(refusal).toContain(String(MAX_SLICED_REPORT_DAYS))
    expect(refusal).toContain('365')
  })

  it('names both numbers when the population is what makes it too large', () => {
    const refusal = rangeRefusal({
      from: '2026-10-01',
      to: '2026-10-31',
      perDay: true,
      population: 4000,
    })
    // Which of the two to shrink is the reader's decision, so the refusal has to carry both.
    expect(refusal).toContain('4000')
    expect(refusal).toContain('31')
    expect(refusal).toContain(String(MAX_PERSON_DAYS))
  })

  it('lets an ordinary month of an ordinary company through', () => {
    expect(rangeRefusal({ from: '2026-10-01', to: '2026-10-31', perDay: true, population: 500 })).toBeNull()
  })

  it('counts an inclusive range, and refuses a reversed one as zero days', () => {
    expect(rangeDays('2026-10-01', '2026-10-01')).toBe(1)
    expect(rangeDays('2026-10-01', '2026-10-31')).toBe(31)
    expect(rangeDays('2026-10-31', '2026-10-01')).toBe(0)
  })
})

describe('a balance is the ledger sum, and pending is not spent', () => {
  it('takes pending out of available and leaves booked in the balance', () => {
    const row = balanceRow({
      balanceMinutes: 9600,
      bookedMinutes: 960,
      pendingMinutes: 480,
      unit: 'day',
    })
    expect(row.availableMinutes).toBe(9120)
    expect(row.balanceMinutes).toBe(9600)
  })

  it('renders a day-unit figure at the constant this module actually has', () => {
    // 9,600 minutes is twenty eight-hour days. It is not twenty of *this workspace's* days, which
    // is why the report publishes `dayLengthMinutes` beside the figure rather than leaving a reader
    // to assume their own.
    expect(
      balanceRow({ balanceMinutes: 9600, bookedMinutes: 0, pendingMinutes: 0, unit: 'day' }).balance,
    ).toBe(20)
    expect(
      balanceRow({ balanceMinutes: 9600, bookedMinutes: 0, pendingMinutes: 0, unit: 'hour' }).balance,
    ).toBe(160)
  })

  it('carries a negative balance through rather than flooring it', () => {
    // A leave type may allow going negative, and a balance shown as zero would hide it.
    const row = balanceRow({ balanceMinutes: -480, bookedMinutes: 0, pendingMinutes: 0, unit: 'day' })
    expect(row.balanceMinutes).toBe(-480)
    expect(row.balance).toBe(-1)
  })
})

describe('rounding', () => {
  it('keeps halves and quarters exact', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round2(21.5 - 20 - 0.5)).toBe(1)
  })
})
