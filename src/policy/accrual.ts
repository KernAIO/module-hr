import type { IsoDate } from '../contract/index.js'
import { datesBetween } from './calendar.js'

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
  /** Maximum minutes that survive into the next entitlement year. 0 means none carries. */
  maxMinutes: number
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

  const proration = countedDays / periodDays
  const years = completedYears(hiredOn, end)
  const entitlementDays = daysPerYearFor(policy, years)

  // How much of a *year* this period represents. Monthly is a twelfth; anything else is measured
  // from the period itself so a part-year run does not silently become a full one.
  const periodShareOfYear = policy.frequency === 'monthly' ? 1 / 12 : periodDays / 365

  const raw = entitlementDays * policy.minutesPerDay * periodShareOfYear * proration * fte
  const minutes = roundTo(raw, policy.roundToMinutes ?? 0)

  const parts = [`${entitlementDays}d/yr`]
  if (years > 0 && policy.seniorityTiers?.length) parts.push(`${years}y service`)
  if (proration < 1) parts.push(`${Math.round(proration * 100)}% of period`)
  if (fte !== 1) parts.push(`${fte} FTE`)
  if (unpaid > 0) parts.push(`${unpaid}d unpaid`)

  return { minutes, proration, reason: parts.join(' · ') }
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
): { carriedMinutes: number; expiredMinutes: number } {
  if (balanceMinutes <= 0) return { carriedMinutes: 0, expiredMinutes: 0 }
  const carried = Math.min(balanceMinutes, policy.maxMinutes)
  return { carriedMinutes: carried, expiredMinutes: balanceMinutes - carried }
}

/**
 * The date carried leave lapses, if it does.
 *
 * Computed from the start of the new entitlement year rather than from the carry date, because
 * "three months to use it" means three months of the new year for everybody — not three months from
 * whenever the job happened to run.
 */
export function carryExpiryDate(yearStart: IsoDate, policy: CarryForwardPolicy): IsoDate | null {
  if (policy.expiresAfterMonths === null) return null
  const [y, m, d] = yearStart.split('-').map(Number) as [number, number, number]
  let month = m + policy.expiresAfterMonths
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
