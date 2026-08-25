import type { IsoDate } from '../contract/index.js'

/**
 * Turning a wall clock into an instant, and back, without lying about daylight saving.
 *
 * A schedule says "09:00". That is a *wall clock reading*, not a moment: on 2026-03-29 in Amsterdam
 * there is no 02:30 at all, and on 2026-10-25 there are two. Storing an offset instead of a zone
 * loses the ability to tell — `+02:00` is a fact about one instant, `Europe/Amsterdam` is a fact
 * about a place.
 *
 * Everything here goes through `Intl`, which carries the real zone database. Nothing adds 86400
 * seconds to anything, and nothing constructs a `Date` from a date string and reads it back in the
 * runtime's own zone — which is where most date bugs come from.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(timeZone, f)
  }
  return f
}

export interface CivilParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The civil (wall-clock) time in a zone at a given instant. */
export function civilAt(instantMs: number, timeZone: string): CivilParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // `h23` still emits 24 for midnight in some engines. Left unhandled it puts every midnight on
    // the wrong day — the kind of bug that only shows up in one timezone.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  }
}

/** A zone's offset from UTC, in milliseconds, at a given instant. */
export function offsetMsAt(instantMs: number, timeZone: string): number {
  const c = civilAt(instantMs, timeZone)
  const asIfUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second)
  return asIfUtc - instantMs
}

/**
 * The instant at which a wall clock read this, in this zone.
 *
 * A wall-clock reading is not always one instant. On the autumn transition it is **two** — 02:30
 * happens once in summer time and again an hour later in winter time — and on the spring one it can
 * be **none**, because the clock jumps straight from 02:00 to 03:00.
 *
 * The rule here: an ambiguous reading resolves to the **earlier** instant, and a skipped one to the
 * moment the clock jumps to. Both are deliberate. Somebody whose shift starts at 02:30 started it
 * the first time the clock said so; and somebody claiming a wall time that never existed still
 * turned up, so refusing to produce an instant would only move the problem.
 *
 * The obvious implementation — guess, measure the offset, correct, repeat — silently picks the
 * *later* of an ambiguous pair, because it converges from the naive UTC guess downwards. That was
 * this function's first version, and its own test caught it. Candidates are therefore built from
 * the offsets on either side of the transition and the earliest match wins.
 */
export function zonedToInstant(date: IsoDate, wallClock: string, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const [h, mi] = wallClock.split(':').map(Number) as [number, number]
  const naive = Date.UTC(y, mo - 1, d, h, mi)

  // The offsets a day either side bracket any transition in between, so between them they cover
  // both readings of an ambiguous hour.
  const DAY = 86_400_000
  const candidates = new Set([
    naive - offsetMsAt(naive - DAY, timeZone),
    naive - offsetMsAt(naive + DAY, timeZone),
    naive - offsetMsAt(naive, timeZone),
  ])

  // Keep only the candidates that really do read back as the time asked for. On a skipped hour that
  // is none of them, which is how the fallback below is reached.
  const valid = [...candidates].filter((ms) => {
    const c = civilAt(ms, timeZone)
    return c.hour === h && c.minute === mi && c.day === d && c.month === mo && c.year === y
  })
  if (valid.length) return Math.min(...valid)

  // Skipped: converge on the instant the clock jumped to.
  let ms = naive - offsetMsAt(naive, timeZone)
  ms = naive - offsetMsAt(ms, timeZone)
  return ms
}

/** The calendar date in a zone at an instant — what "today" means for somebody in Istanbul. */
export function dateIn(instantMs: number, timeZone: string): IsoDate {
  const c = civilAt(instantMs, timeZone)
  return `${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`
}

/** Minutes past local midnight. Used to compare a punch against a schedule. */
export function minutesOfDayIn(instantMs: number, timeZone: string): number {
  const c = civilAt(instantMs, timeZone)
  return c.hour * 60 + c.minute
}

/**
 * How long a local day actually is, in minutes.
 *
 * 1440 almost always; 1380 on a spring transition and 1500 on an autumn one. Anything computing a
 * day's span by assuming 1440 is wrong twice a year in every zone that observes daylight saving,
 * by an hour each time — big enough to matter on a timesheet, small enough that nobody notices for
 * a year.
 */
export function dayLengthMinutes(date: IsoDate, timeZone: string): number {
  const start = zonedToInstant(date, '00:00', timeZone)
  const end = zonedToInstant(nextDate(date), '00:00', timeZone)
  return Math.round((end - start) / 60000)
}

/** The civil day after this one. Pure date arithmetic — no instants involved. */
export function nextDate(date: IsoDate): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const lengths = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  let day = d + 1
  let month = m
  let year = y
  if (day > lengths[m - 1]!) {
    day = 1
    month++
    if (month > 12) {
      month = 1
      year++
    }
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function previousDate(date: IsoDate): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  if (d > 1) return `${y}-${String(m).padStart(2, '0')}-${String(d - 1).padStart(2, '0')}`
  const month = m === 1 ? 12 : m - 1
  const year = m === 1 ? y - 1 : y
  const lengths = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return `${year}-${String(month).padStart(2, '0')}-${String(lengths[month - 1]).padStart(2, '0')}`
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
