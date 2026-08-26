import type { IsoDate } from '../contract/index.js'
import { datesBetween, daysInMonth } from './calendar.js'

/**
 * Earning leave over time, and the arithmetic that decides how much.
 *
 * Pure: a policy and a period in, minutes out. No database, no clock. Accrual is where an HR system
 * is most often quietly wrong — a joiner in March credited a full year, a leaver paid for months
 * they did not work, a carry-forward cap applied to the wrong balance — and all of those are table
 * cases rather than integration tests.
 *
 * Everything is **minutes**, because half-days, hourly leave and part-time fractions all divide a
 * day and a decimal day accumulates error across twelve accruals.
 */

export type AccrualFrequency = 'monthly' | 'annual' | 'anniversary' | 'per_hour_worked'

/** Which calendar decides where a period boundary falls. Iran accrues on Jalali months. */
export type PolicyCalendar = 'gregorian' | 'persian'

export interface AccrualPolicy {
  frequency: AccrualFrequency
  /** Days earned per full entitlement year, before proration. */
  daysPerYear: number
  /** Minutes in one working day for this policy. Part-timers scale by FTE, not by this. */
  minutesPerDay: number
  /**
   * Tiers by completed years of service, most senior first — Turkish annual leave is 14 days under
   * 5 years, 20 up to 15, 26 beyond. An empty list means `daysPerYear` applies to everyone.
   */
  seniorityTiers?: Array<{ afterYears: number; daysPerYear: number }>
  /** Accrue nothing until this many months after joining. */
  waitingPeriodMonths?: number
  calendar?: PolicyCalendar
  /** Round each accrual to this many minutes. 0 accrues exact fractions. */
  roundToMinutes?: number
}

export interface CarryForwardPolicy {
  /** Maximum days that survive into the next entitlement year. 0 means none carries. */
  maxDays: number
  /**
   * Minutes in one working day, for converting `maxDays` into the minutes the ledger holds.
   *
   * The same figure the accrual policy credits at, and it is an argument rather than a constant
   * because the contract lets it be anything from 1 to 1440. A cap converted at an assumed eight
   * hours is wrong in both directions: on a seven-and-a-half-hour day five days reads as 2400
   * minutes against 2250 accrued, so the cap never bites, and on a nine-hour day it expires leave
   * somebody was entitled to keep.
   */
  minutesPerDay: number
  /** Months into the new year before carried leave expires. Null never expires. */
  expiresAfterMonths: number | null
}

/**
 * Completed years between two dates, by anniversary rather than by dividing days.
 *
 * `(b - a) / 365` gets leap years wrong and puts somebody over a seniority threshold days early,
 * which is exactly the sort of error that shows up as one extra day of leave and takes an afternoon
 * to trace.
 */
export function completedYears(from: IsoDate, to: IsoDate): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  let years = ty - fy
  if (tm < fm || (tm === fm && td < fd)) years--
  return Math.max(0, years)
}

/** The entitlement that applies at a given length of service. */
export function daysPerYearFor(policy: AccrualPolicy, yearsOfService: number): number {
  if (!policy.seniorityTiers?.length) return policy.daysPerYear
  // Most senior tier that has been reached; the list is sorted here rather than trusted.
  const reached = [...policy.seniorityTiers]
    .sort((a, b) => b.afterYears - a.afterYears)
    .find((tier) => yearsOfService >= tier.afterYears)
  return reached?.daysPerYear ?? policy.daysPerYear
}

/** Whole months between two dates, counting only complete ones. */
export function completedMonths(from: IsoDate, to: IsoDate): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  let months = (ty - fy) * 12 + (tm - fm)
  if (td < fd) months--
  return Math.max(0, months)
}

export interface AccrualPeriod {
  from: IsoDate
  to: IsoDate
}

export interface AccrualResult {
  minutes: number
  /** Fraction of the period the person was actually entitled for, after proration. */
  proration: number
  /** Why the number is what it is — shown in the ledger entry rather than left to be guessed. */
  reason: string
}

/**
 * What one person earns over one period.
 *
 * **Prorated by the days of the period they were actually employed**, not by month count: somebody
 * joining on the 20th earns a third of that month, and rounding it to a whole month is how a
 * balance ends up a day out for everybody who ever joined mid-month.
 *
 * `fte` scales it again — a half-time contract earns half. The two multiply rather than the larger
 * winning, because a half-time joiner on the 20th has earned a sixth of a month and both facts are
 * true at once.
 *
 * The **frequency decides what a period grants**, and each of the four answers a different
 * question — see `grantForPeriod`. The job runs on the same schedule whichever is configured: an
 * annual or anniversary policy simply grants nothing in the months that hold no grant date, so
 * changing the frequency never means changing how often the job runs.
 */
export function accrueForPeriod(opts: {
  policy: AccrualPolicy
  period: AccrualPeriod
  /** When they joined. Nothing accrues before it. */
  hiredOn: IsoDate
  /** When they left, if they have. Nothing accrues after it. */
  terminatedOn?: IsoDate | null
  /** 1 is full time. */
  fte: number
  /** Unpaid leave inside the period, which most policies do not accrue against. */
  unpaidDays?: number
  /** Minutes actually worked in the period. `per_hour_worked` accrues against it. */
  workedMinutes?: number
  /** Minutes the schedule called for over the same period. `per_hour_worked` needs both. */
  scheduledMinutes?: number
}): AccrualResult {
  const { policy, period, hiredOn, terminatedOn, fte } = opts

  const periodDays = datesBetween(period.from, period.to).length
  if (periodDays <= 0) return { minutes: 0, proration: 0, reason: 'empty period' }

  // The window they were actually employed for, clipped to the period.
  const start = hiredOn > period.from ? hiredOn : period.from
  const end = terminatedOn && terminatedOn < period.to ? terminatedOn : period.to
  if (end < start) return { minutes: 0, proration: 0, reason: 'not employed in this period' }

  const waiting = policy.waitingPeriodMonths ?? 0
  if (waiting > 0 && completedMonths(hiredOn, end) < waiting)
    return { minutes: 0, proration: 0, reason: `within the ${waiting}-month waiting period` }

  const employedDays = datesBetween(start, end).length
  const unpaid = Math.min(opts.unpaidDays ?? 0, employedDays)
  const countedDays = Math.max(0, employedDays - unpaid)

  const years = completedYears(hiredOn, end)
  const entitlementDays = daysPerYearFor(policy, years)

  const grant = grantForPeriod({
    policy,
    period,
    periodDays,
    hiredOn,
    employedFrom: start,
    employedTo: end,
    employedProration: countedDays / periodDays,
    workedMinutes: opts.workedMinutes,
    scheduledMinutes: opts.scheduledMinutes,
  })
  if (grant.skipped) return { minutes: 0, proration: 0, reason: grant.skipped }

  const { shareOfYear, proration } = grant
  const raw = entitlementDays * policy.minutesPerDay * shareOfYear * proration * fte
  const minutes = roundTo(raw, policy.roundToMinutes ?? 0)

  const parts = [`${entitlementDays}d/yr`]
  if (years > 0 && policy.seniorityTiers?.length) parts.push(`${years}y service`)
  parts.push(...grant.notes)
  if (fte !== 1) parts.push(`${fte} FTE`)
  if (unpaid > 0) parts.push(`${unpaid}d unpaid`)

  return { minutes, proration, reason: parts.join(' · ') }
}

interface Grant {
  /** How much of a year's entitlement this period grants. */
  shareOfYear: number
  /** What scales that grant, beyond FTE. */
  proration: number
  /** Added to the ledger entry's reason. */
  notes: string[]
  /** Set instead of the rest when the period grants nothing, and says why. */
  skipped?: string
}

/**
 * What one period grants, per frequency.
 *
 * Four frequencies were offered and one was implemented, so three of them were a setting an admin
 * could save and nothing would obey. Each asks a different question:
 *
 * - **monthly** — a twelfth of the year, every period, prorated by the days they were employed.
 * - **annual** — the whole year at once, on the first day of the entitlement year, or on the hire
 *   date for somebody who joined after it. A mid-year joiner gets the share of the year that is
 *   left, so the grant lands once and is right the first time.
 * - **anniversary** — a whole year on each hire anniversary, earned in arrears. Nothing lands in
 *   the month somebody was *hired*: a hire date is not an anniversary, and granting there would
 *   pay a full year's entitlement to somebody with no service behind them.
 * - **per_hour_worked** — the period's share of the year, scaled by hours actually worked against
 *   hours scheduled. That ratio replaces the employed-days proration rather than multiplying it:
 *   somebody who joined mid-month was scheduled for less of it too, and applying both counts the
 *   same absence twice.
 *
 * The two point grants take no employed-days proration at all — their share of the year is measured
 * from the grant date, so prorating again would shrink the one period that holds the whole year.
 */
function grantForPeriod(opts: {
  policy: AccrualPolicy
  period: AccrualPeriod
  periodDays: number
  hiredOn: IsoDate
  employedFrom: IsoDate
  employedTo: IsoDate
  employedProration: number
  workedMinutes?: number
  scheduledMinutes?: number
}): Grant {
  const { policy, period, periodDays, hiredOn, employedFrom, employedTo, employedProration } = opts
  const pct = (fraction: number) => `${Math.round(fraction * 100)}%`

  switch (policy.frequency) {
    case 'monthly':
      return {
        shareOfYear: 1 / 12,
        proration: employedProration,
        notes: employedProration < 1 ? [`${pct(employedProration)} of period`] : [],
      }

    case 'annual': {
      const year = period.from.slice(0, 4)
      const yearStart = `${year}-01-01`
      const yearEnd = `${year}-12-31`
      const grantOn = hiredOn > yearStart ? hiredOn : yearStart
      if (grantOn < period.from || grantOn > period.to)
        return { shareOfYear: 0, proration: 0, notes: [], skipped: `the annual grant falls on ${grantOn}` }
      if (grantOn > employedTo)
        return { shareOfYear: 0, proration: 0, notes: [], skipped: 'not employed on the grant date' }
      // Against the year's own length rather than 365, so a leap year does not quietly overpay.
      const share = datesBetween(grantOn, yearEnd).length / datesBetween(yearStart, yearEnd).length
      return {
        shareOfYear: share,
        proration: 1,
        notes: share < 1 ? [`${pct(share)} of the year, from ${grantOn}`] : ['full year'],
      }
    }

    case 'anniversary': {
      const on = anniversaryIn(hiredOn, period.from, period.to)
      if (!on)
        return { shareOfYear: 0, proration: 0, notes: [], skipped: 'no service anniversary in this period' }
      if (completedYears(hiredOn, on) < 1)
        return { shareOfYear: 0, proration: 0, notes: [], skipped: 'the first anniversary is a year away' }
      if (on < employedFrom || on > employedTo)
        return { shareOfYear: 0, proration: 0, notes: [], skipped: 'not employed on the anniversary' }
      return { shareOfYear: 1, proration: 1, notes: [`anniversary on ${on}`] }
    }

    case 'per_hour_worked': {
      const scheduled = opts.scheduledMinutes ?? 0
      if (scheduled <= 0)
        return {
          shareOfYear: 0,
          proration: 0,
          notes: [],
          skipped: 'no scheduled hours in this period to accrue against',
        }
      const ratio = Math.max(0, opts.workedMinutes ?? 0) / scheduled
      return {
        shareOfYear: periodDays / 365,
        proration: ratio,
        notes: [`${pct(ratio)} of scheduled hours worked`],
      }
    }
  }
}

/**
 * The hire anniversary that falls inside a period, if one does.
 *
 * A 29 February hire has an anniversary in every year and a 29 February in one year of four, so it
 * is clamped to the 28th rather than skipped — otherwise three quarters of that person's
 * anniversaries land on a date the calendar does not have and grant nothing at all.
 */
function anniversaryIn(hiredOn: IsoDate, from: IsoDate, to: IsoDate): IsoDate | null {
  const [, month, day] = hiredOn.split('-').map(Number) as [number, number, number]
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    const on = `${year}-${String(month).padStart(2, '0')}-${String(
      Math.min(day, daysInMonth(year, month)),
    ).padStart(2, '0')}`
    if (on >= from && on <= to) return on
  }
  return null
}

const roundTo = (value: number, step: number): number =>
  step > 0 ? Math.round(value / step) * step : Math.round(value)

/**
 * What survives into the next entitlement year, and what lapses.
 *
 * Returns both halves rather than just the survivor, because the ledger needs an `expiry` entry for
 * the difference — a balance that silently shrinks at midnight on the 1st of January is the single
 * most disputed number in any leave system.
 */
export function carryForward(
  balanceMinutes: number,
  policy: CarryForwardPolicy,
  /** First day of the entitlement year the leave is carried *into*. */
  yearStart: IsoDate,
): { carriedMinutes: number; expiredMinutes: number; expiresOn: IsoDate | null } {
  if (balanceMinutes <= 0) return { carriedMinutes: 0, expiredMinutes: 0, expiresOn: null }
  const cap = Math.round(policy.maxDays * policy.minutesPerDay)
  const carried = Math.min(balanceMinutes, cap)
  return {
    carriedMinutes: carried,
    expiredMinutes: balanceMinutes - carried,
    // Nothing carried, nothing to lapse. The date is what the caller stamps on the `carry_in`
    // entry, so a balance of zero carrying an expiry date would be a lapse nobody can point at.
    expiresOn: carried > 0 ? carryExpiryDate(yearStart, policy.expiresAfterMonths) : null,
  }
}

/**
 * The date carried leave lapses, if it does.
 *
 * Computed from the start of the new entitlement year rather than from the carry date, because
 * "three months to use it" means three months of the new year for everybody — not three months from
 * whenever the job happened to run.
 */
export function carryExpiryDate(yearStart: IsoDate, expiresAfterMonths: number | null): IsoDate | null {
  if (expiresAfterMonths === null) return null
  const [y, m, d] = yearStart.split('-').map(Number) as [number, number, number]
  let month = m + expiresAfterMonths
  let year = y
  while (month > 12) {
    month -= 12
    year++
  }
  const lengths = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const day = Math.min(d, lengths[month - 1]!)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/**
 * Has carried leave lapsed by a date?
 *
 * The expiry date is the **first day it is no longer available**, so leave carried with three
 * months to use it survives the whole of March and is gone on 1 April. Somebody booking on the last
 * morning and the sweep that takes it away have to read the boundary the same way, so it is read
 * here and nowhere else.
 */
export function carryHasLapsed(on: IsoDate, expiresOn: IsoDate | null): boolean {
  return expiresOn !== null && on >= expiresOn
}

/**
 * Overtime beyond a threshold, with an optional weekly or monthly cap.
 *
 * The cap exists because several jurisdictions limit how much overtime may be *worked*, not just
 * how it is paid — Turkish law caps it at 270 hours a year. Returning the excess separately lets a
 * report show it rather than silently discarding the hours somebody actually worked.
 */
export function overtimeFor(opts: {
  workedMinutes: number
  scheduledMinutes: number
  /** Minutes past the schedule before overtime starts counting. */
  thresholdMinutes?: number
  /** Cap for the containing period. Null is uncapped. */
  capMinutes?: number | null
  /** Overtime already counted in this period. */
  alreadyCountedMinutes?: number
}): { overtimeMinutes: number; beyondCapMinutes: number } {
  const threshold = opts.thresholdMinutes ?? 0
  const raw = Math.max(0, opts.workedMinutes - opts.scheduledMinutes - threshold)
  if (opts.capMinutes === null || opts.capMinutes === undefined)
    return { overtimeMinutes: raw, beyondCapMinutes: 0 }
  const room = Math.max(0, opts.capMinutes - (opts.alreadyCountedMinutes ?? 0))
  const counted = Math.min(raw, room)
  return { overtimeMinutes: counted, beyondCapMinutes: raw - counted }
}
