import type { CalendarDay, IsoDate, WorkingWeek } from '../contract/index.js'

/**
 * Working-day arithmetic, as pure functions.
 *
 * No database, no kernel, no `Date.now()`. Everything here takes the calendar and the week as
 * arguments and returns a number, which is what makes the cases that actually break payroll —
 * Iran's Friday weekend, a half Thursday, a company closure landing on a public holiday, a range
 * that spans a daylight-saving boundary — testable as a table rather than against a running
 * Postgres.
 *
 * **Dates here are calendar dates, never instants.** A working day is a property of a place's
 * calendar, not of a moment: whether 2026-03-29 is a working day in Amsterdam does not depend on
 * what time it is, and the fact that the day happens to be 23 hours long is somebody else's problem
 * (the attendance day sheet's, when it arrives). Doing this with `Date` arithmetic is where the DST
 * bugs come from, so nothing here adds 86400 seconds to anything.
 */

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number]

/**
 * Which weekday an ISO date falls on, without constructing a local `Date`.
 *
 * `new Date('2026-08-24')` is parsed as UTC midnight and then read back in the *runtime's* zone, so
 * west of Greenwich it reports the previous day. Every "off by one day" bug in a date library is
 * some version of that. This computes the weekday arithmetically from the civil date, so the answer
 * is the same on every machine.
 */
export function weekdayOf(date: IsoDate): WeekdayKey {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  // Sakamoto's algorithm — civil date in, day of week out, no Date object involved.
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const yy = m < 3 ? y - 1 : y
  const index = (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1]! + d) % 7
  return WEEKDAY_KEYS[index]!
}

/** Every date from `from` to `to` inclusive, as ISO strings. Pure civil-date arithmetic. */
export function datesBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = []
  let [y, m, d] = from.split('-').map(Number) as [number, number, number]
  const iso = () => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  // A guard rather than a `while (true)`: a reversed or absurd range should return nothing or stop,
  // never spin. Ten years of days is far more than any caller here asks for.
  for (let guard = 0; guard < 3700; guard++) {
    const here = iso()
    if (here > to) break
    out.push(here)
    d++
    if (d > daysInMonth(y, m)) {
      d = 1
      m++
      if (m > 12) {
        m = 1
        y++
      }
    }
  }
  return out
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}
export const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

export interface DayResult {
  date: IsoDate
  /** 1 a full working day, 0.5 a half, 0 not worked. */
  fraction: number
  /** Why it is not a plain working day — the holiday's name, or null. */
  reason: string | null
}

/**
 * How much of each day in a range is worked.
 *
 * Precedence, nearest wins: **a calendar day beats the working week.** A `working_override` on a
 * Saturday makes it a working day even though the week says otherwise, and a company closure on a
 * Tuesday makes it not one. That direction matters — the other way round, a company that works
 * through a national holiday could not say so.
 */
export function workingDays(
  from: IsoDate,
  to: IsoDate,
  week: WorkingWeek,
  days: ReadonlyArray<Pick<CalendarDay, 'date' | 'name' | 'workingFraction'>>,
): DayResult[] {
  const byDate = new Map(days.map((d) => [d.date, d]))
  return datesBetween(from, to).map((date) => {
    const special = byDate.get(date)
    if (special) return { date, fraction: clamp(special.workingFraction), reason: special.name }
    const fraction = clamp(week[weekdayOf(date)] ?? 0)
    return { date, fraction, reason: fraction === 0 ? 'weekend' : null }
  })
}

/** The number a leave request costs, or a month's expected working days. */
export const countWorkingDays = (results: readonly DayResult[]): number =>
  round2(results.reduce((sum, r) => sum + r.fraction, 0))

const clamp = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
/** Halves and quarters add up exactly; floating point does not. Two places is enough for both. */
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Compose a calendar with the ones it extends: nearest wins, per date and kind.
 *
 * `chain` runs nearest-first — the office's own calendar, then the country pack it extends. A
 * `custom` day on the near calendar overrides a `pack` day on the far one for the same date, which
 * is exactly what "we work through this national holiday" means.
 */
export function composeDays<T extends Pick<CalendarDay, 'date' | 'kind' | 'calendarId'>>(
  chain: ReadonlyArray<{ calendarId: string; days: readonly T[] }>,
): Array<T & { overrides: boolean }> {
  const seen = new Map<string, T & { overrides: boolean }>()
  for (const level of chain) {
    for (const day of level.days) {
      const key = `${day.date}:${day.kind}`
      // Nearest wins: a level further along the chain never replaces what an earlier one supplied.
      if (!seen.has(key)) seen.set(key, { ...day, overrides: false })
    }
  }
  // A near day that shadows a far day of a *different* kind on the same date still overrides it —
  // "company closure" on a date the pack calls a working day, for instance.
  const byDate = new Map<string, number>()
  for (const day of seen.values()) byDate.set(day.date, (byDate.get(day.date) ?? 0) + 1)
  const nearest = chain[0]?.calendarId
  return [...seen.values()]
    .map((d) => ({ ...d, overrides: (byDate.get(d.date) ?? 0) > 1 && d.calendarId === nearest }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
