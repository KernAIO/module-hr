import { KernError, type Tx } from '@kernhq/kernel'
import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm'
import type { RosterDaySource } from '../../contract/rosters.js'
import { MAX_COVERAGE_DAYS, MAX_ROSTER_DAYS } from '../../contract/rosters.js'
import { datesBetween } from '../../policy/calendar.js'
import type { ShiftSpec } from '../../policy/working-time.js'
import { rosterAssignments, rosterOverrides, rosterPatterns, rosterShifts } from '../schema.js'

/**
 * What a person is rostered to work on a date.
 *
 * The arithmetic is the point of this file, and all of it is pure. A rotation is a cycle plus the
 * date the cycle starts from, so what somebody works on any date at all — including dates before
 * the anchor and dates years after it — is one modulus. Nothing is generated, stored, or swept:
 * expanding a year of shifts per person into rows is what makes a roster impossible to change
 * afterwards, because moving a crew forward by a day then means rewriting thousands of rows with no
 * way left to tell which of them a human had already corrected.
 *
 * Only exceptions are rows. `roster_overrides` holds one day that differs, and an override that
 * says "off" is a row with an empty `shift_ids` — the reason it is a row rather than a deletion is
 * that "planned rest" and "nothing rosters this person" are different facts, and a screen that
 * renders them the same tells somebody their absence was intended.
 */

// ---------------------------------------------------------------------------------------------
// pure: the calendar arithmetic
// ---------------------------------------------------------------------------------------------

/**
 * Days since 1970-01-01 for a civil date, by pure arithmetic.
 *
 * Not `new Date(iso).getTime() / 86400000`: that parses as UTC midnight and then everything the
 * result touches is a step away from the runtime's own zone, and it is wrong by a day for anybody
 * west of Greenwich the moment a caller formats it back. This is Howard Hinnant's `days_from_civil`
 * — exact for every proleptic Gregorian date, with no `Date`, no zone and no daylight saving
 * anywhere near it. A cycle index computed from instants would slip by one twice a year in every
 * zone that observes it, which on a 4-on-4-off rotation puts a whole crew on the wrong shift.
 */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const year = y - (m <= 2 ? 1 : 0)
  const era = Math.floor(year / 400)
  const yoe = year - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146_097 + doe - 719_468
}

/** Whole days from `from` to `to`. Negative when `to` is the earlier date. */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from)

export interface RosterPatternSpec {
  id: string
  anchorDate: string
  days: readonly (readonly string[])[]
}

export interface RosterAssignmentSpec {
  patternId: string
  effectiveFrom: string
  effectiveTo: string | null
  cycleOffset: number
}

export interface RosterOverrideSpec {
  businessDate: string
  shiftIds: readonly string[]
  note: string | null
}

export interface PlannedDay {
  businessDate: string
  shiftIds: string[]
  source: RosterDaySource
  note: string | null
}

/**
 * Which position of the cycle a date falls on.
 *
 * `((raw % len) + len) % len` rather than `raw % len`, because JavaScript's `%` keeps the sign of
 * the dividend: a date before the anchor gives a negative index, and `days[-3]` is `undefined` —
 * which reads as a rest day rather than as an error. A roster asked about last month would then
 * quietly report that everybody was off.
 *
 * Returns -1 for a pattern with no cycle at all, which is a misconfiguration rather than a rest day
 * and is reported as `none` by the caller.
 */
export function cycleIndexFor(
  pattern: Pick<RosterPatternSpec, 'anchorDate' | 'days'>,
  date: string,
  cycleOffset = 0,
): number {
  const len = pattern.days.length
  if (len <= 0) return -1
  const raw = daysBetween(pattern.anchorDate, date) + cycleOffset
  return ((raw % len) + len) % len
}

/** The shifts a rotation puts on a date. `[]` is a planned rest day; null is no cycle to read. */
export function patternShiftIdsOn(
  pattern: Pick<RosterPatternSpec, 'anchorDate' | 'days'>,
  date: string,
  cycleOffset = 0,
): string[] | null {
  const index = cycleIndexFor(pattern, date, cycleOffset)
  if (index < 0) return null
  return [...(pattern.days[index] ?? [])]
}

/**
 * The assignment in force on a date.
 *
 * The exclusion constraint makes two-in-force impossible in the database, so this is not resolving
 * a conflict — it is refusing to depend on row order for the answer. `schedule_assignments` did
 * depend on it for five migrations, and the symptom was a day sheet whose figures changed between
 * one recomputation and the next on rows a locked payroll period had been filed against.
 */
export function assignmentOn<A extends RosterAssignmentSpec>(
  assignments: readonly A[],
  date: string,
): A | null {
  let best: A | null = null
  for (const a of assignments) {
    if (a.effectiveFrom > date) continue
    if (a.effectiveTo !== null && a.effectiveTo < date) continue
    if (!best || a.effectiveFrom > best.effectiveFrom) best = a
  }
  return best
}

/**
 * The roster for one person over a set of dates.
 *
 * Takes the dates rather than a range so a caller asking about two adjacent days — which is what
 * the night-shift attribution needs — does not have to expand a range to get them.
 *
 * The precedence is override, then rotation, then nothing, and it is deliberate that an override
 * wins even when it is empty: somebody taken off a Tuesday they were rostered for is off that
 * Tuesday, and a rotation that could still speak over the top of that would undo the correction.
 */
export function rosterPlan(input: {
  dates: readonly string[]
  assignments: readonly RosterAssignmentSpec[]
  patterns: ReadonlyMap<string, RosterPatternSpec>
  overrides: readonly RosterOverrideSpec[]
}): PlannedDay[] {
  const byDate = new Map(input.overrides.map((o) => [o.businessDate, o]))
  return input.dates.map((businessDate) => {
    const override = byDate.get(businessDate)
    if (override)
      return {
        businessDate,
        shiftIds: [...override.shiftIds],
        source: 'override' as const,
        note: override.note,
      }
    const assignment = assignmentOn(input.assignments, businessDate)
    const pattern = assignment ? input.patterns.get(assignment.patternId) : undefined
    const ids = pattern ? patternShiftIdsOn(pattern, businessDate, assignment?.cycleOffset ?? 0) : null
    if (ids === null) return { businessDate, shiftIds: [], source: 'none' as const, note: null }
    return { businessDate, shiftIds: ids, source: 'pattern' as const, note: null }
  })
}

export type RosterShiftRow = typeof rosterShifts.$inferSelect

/** A rostered shift as the working-time layer wants it. The one seam between the two. */
export const toShiftSpec = (shift: RosterShiftRow): ShiftSpec => ({
  start: shift.startTime,
  end: shift.endTime,
  breakMinutes: shift.breakMinutes,
  graceInMinutes: shift.graceInMinutes,
  graceOutMinutes: shift.graceOutMinutes,
})

/**
 * A stable string for what a day was rostered as.
 *
 * `attendance_days.policy_hash` is what tells a recomputation whether a stored figure is stale, and
 * `hashSchedule` keys only on the schedule id and the rounding policy. That is enough while a
 * schedule is a week that only changes when the schedule row does; it is not enough once a roster
 * can change one Tuesday, because the id and the rounding are identical either side of the change
 * and the sheet would stay stale with nothing able to notice.
 *
 * So this folds in what the day was actually rostered as — the shift ids **and** their wall clocks,
 * because editing a shift from 06:00 to 07:00 changes every day it appears on without changing an
 * id anywhere.
 */
export function rosterFingerprint(day: {
  source: RosterDaySource
  shifts: readonly RosterShiftRow[]
}): string {
  const parts = day.shifts.map(
    (s) => `${s.id}@${s.startTime}-${s.endTime}/${s.breakMinutes}/${s.graceInMinutes}/${s.graceOutMinutes}`,
  )
  return `${day.source}:${parts.join('+')}`
}

/** The ceiling on a coverage grid's person-days — a hundred people for a six-week rotation. */
export const MAX_COVERAGE_CELLS = 4200

/**
 * Why a range is refused, as a sentence.
 *
 * A roster range is cheap to expand and expensive to send, and a coverage grid multiplies by the
 * population of an office. Both refusals name the number asked for as well as the ceiling, because
 * "too long" without either is a message somebody has to guess their way out of.
 */
export function rosterRefusal(input: {
  from: string
  to: string
  coverage: boolean
  population?: number
}): string | null {
  if (input.to < input.from) return `The end date ${input.to} is before the start date ${input.from}.`
  const days = daysBetween(input.from, input.to) + 1
  const max = input.coverage ? MAX_COVERAGE_DAYS : MAX_ROSTER_DAYS
  if (days > max)
    return input.coverage
      ? `A coverage grid covers at most ${max} days, and this one asks for ${days}. Ask for a shorter range.`
      : `A roster covers at most ${max} days, and this one asks for ${days}. Ask for a shorter range.`
  if (input.coverage && input.population !== undefined) {
    const cells = input.population * days
    if (cells > MAX_COVERAGE_CELLS)
      return `${input.population} people over ${days} days is ${cells} person-days, and a coverage grid resolves at most ${MAX_COVERAGE_CELLS}. Ask for one office, or a shorter range.`
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// the database half
// ---------------------------------------------------------------------------------------------

export interface ResolvedRosterDay {
  businessDate: string
  shifts: RosterShiftRow[]
  source: RosterDaySource
  note: string | null
}

export class RosterService {
  /**
   * Every shift in the workspace by id, **archived ones included**.
   *
   * A pattern and a stored override both point at a shift by id, so resolving only the live ones
   * would silently empty out every rostered day that used a shift somebody archived last week —
   * which reads as "nobody is working" rather than as "this shift is retired".
   */
  async shiftsById(tx: Tx, workspaceId: string): Promise<Map<string, RosterShiftRow>> {
    const rows = await tx.select().from(rosterShifts).where(eq(rosterShifts.workspaceId, workspaceId))
    return new Map(rows.map((r) => [r.id, r]))
  }

  /**
   * What each of `personIds` is rostered for on each of `dates`.
   *
   * One query per table for the whole population rather than one per person: a coverage grid over
   * an office of eighty is otherwise 240 round trips for arithmetic that takes microseconds.
   *
   * `inArray` renders an expanded parameter list — `person_id in ($1, $2, …)`. That is deliberate
   * and is not the same as binding one array: `= any($1::uuid[])` with drizzle expanding the array
   * into a list produces `any(($1,$2)::uuid[])`, which Postgres rejects with 42846, "cannot cast
   * type record to uuid[]".
   */
  async plan(
    tx: Tx,
    workspaceId: string,
    personIds: readonly string[],
    dates: readonly string[],
  ): Promise<Map<string, ResolvedRosterDay[]>> {
    const out = new Map<string, ResolvedRosterDay[]>()
    if (!personIds.length || !dates.length) return out

    const sorted = [...dates].sort()
    const first = sorted[0]!
    const last = sorted[sorted.length - 1]!
    const ids = [...new Set(personIds)]

    const assignments = await tx
      .select()
      .from(rosterAssignments)
      .where(
        and(
          eq(rosterAssignments.workspaceId, workspaceId),
          inArray(rosterAssignments.personId, ids),
          lte(rosterAssignments.effectiveFrom, last),
          or(isNull(rosterAssignments.effectiveTo), gte(rosterAssignments.effectiveTo, first)),
        ),
      )

    const overrides = await tx
      .select()
      .from(rosterOverrides)
      .where(
        and(
          eq(rosterOverrides.workspaceId, workspaceId),
          inArray(rosterOverrides.personId, ids),
          inArray(rosterOverrides.businessDate, [...new Set(sorted)]),
        ),
      )

    const patternIds = [...new Set(assignments.map((a) => a.patternId))]
    const patternRows = patternIds.length
      ? await tx
          .select()
          .from(rosterPatterns)
          .where(and(eq(rosterPatterns.workspaceId, workspaceId), inArray(rosterPatterns.id, patternIds)))
      : []
    const patterns = new Map<string, RosterPatternSpec>(
      patternRows.map((p) => [p.id, { id: p.id, anchorDate: p.anchorDate, days: p.days ?? [] }]),
    )
    const shifts = await this.shiftsById(tx, workspaceId)

    for (const personId of ids) {
      const plan = rosterPlan({
        dates,
        assignments: assignments.filter((a) => a.personId === personId),
        patterns,
        overrides: overrides
          .filter((o) => o.personId === personId)
          .map((o) => ({ businessDate: o.businessDate, shiftIds: o.shiftIds ?? [], note: o.note })),
      })
      out.set(
        personId,
        plan.map((day) => ({
          businessDate: day.businessDate,
          // A shift id with no row behind it is dropped rather than rendered as a hole: the only
          // way to produce one is to point a pattern at an id that was never a shift, and the
          // procedures below refuse that on write.
          shifts: day.shiftIds.flatMap((id) => {
            const shift = shifts.get(id)
            return shift ? [shift] : []
          }),
          source: day.source,
          note: day.note,
        })),
      )
    }
    return out
  }

  /** One person over a contiguous range — the shape a roster screen asks for. */
  async forPerson(
    tx: Tx,
    workspaceId: string,
    personId: string,
    from: string,
    to: string,
  ): Promise<ResolvedRosterDay[]> {
    const plan = await this.plan(tx, workspaceId, [personId], datesBetween(from, to))
    return plan.get(personId) ?? []
  }

  /**
   * Refuse a pattern or an override that names a shift this workspace does not have.
   *
   * Checked on write rather than tolerated on read: a dangling id is invisible on the screen that
   * created it and shows up weeks later as a person who is somehow rostered for nothing.
   */
  async assertShiftsExist(tx: Tx, workspaceId: string, shiftIds: readonly string[]): Promise<void> {
    const wanted = [...new Set(shiftIds)]
    if (!wanted.length) return
    const found = await tx
      .select({ id: rosterShifts.id })
      .from(rosterShifts)
      .where(and(eq(rosterShifts.workspaceId, workspaceId), inArray(rosterShifts.id, wanted)))
    const have = new Set(found.map((r) => r.id))
    const missing = wanted.filter((id) => !have.has(id))
    if (missing.length)
      throw KernError.badRequest(
        missing.length === 1
          ? `This roster names a shift this workspace does not have: ${missing[0]}.`
          : `This roster names shifts this workspace does not have: ${missing.join(', ')}.`,
      )
  }
}
