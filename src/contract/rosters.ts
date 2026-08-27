import { Timestamp, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import { IsoDate, WallClock } from './models.js'

const ws = { workspaceId: WorkspaceId }

/**
 * Rosters: which shift a person works on a **date**.
 *
 * A `Schedule` is a week that repeats for ever, so `ScheduleWeek` is keyed by weekday name. That is
 * the right shape for an office and cannot express a factory: 4-on-4-off has no weekly period at
 * all, and neither does any 2- or 3-week rotation, so there is no length of `ScheduleWeek` that
 * describes one. A roster is keyed by the calendar instead, and adds exactly three things a
 * schedule does not have:
 *
 * - **A shift on a date.** The key is the day, not a modulus of seven.
 * - **Coverage** — "who is on Early on Tuesday" is a question about an office-day, not about a
 *   person, and it cannot be asked of a set of weekly schedules without walking everybody's week.
 * - **A one-day exception that survives.** A schedule change is effective-dated and rewrites every
 *   day after it; a roster override changes one day and leaves the rotation alone.
 *
 * Everything else attendance already does — grace, rounding, overnight shifts, night-shift business
 * date attribution, the auto-close sweep — stays where it is. A roster is not a second computation
 * of hours; it is a different answer to "what was this person meant to work today".
 *
 * **The rotation is computed, never stored per day.** A `RosterPattern` is a cycle of days and the
 * date `days[0]` falls on; what somebody works on any date at all is arithmetic from those two.
 * Generating a year of rows per person is what makes a roster impossible to change afterwards —
 * moving a crew forward by a day becomes a bulk rewrite of thousands of rows with no way to say
 * which of them a human had touched. Only the exceptions are rows.
 */

/**
 * A named shift: Early, Late, Night.
 *
 * Named rather than inlined into each pattern because coverage groups by it — "Early" in the
 * warehouse pattern and "Early" in the picking pattern have to be the same column of the same grid.
 * `graceInMinutes` / `graceOutMinutes` sit here rather than on the schedule for the same reason a
 * night shift usually has a wider grace than a day one: they are properties of the shift.
 */
export const RosterShift = z.object({
  id: z.uuid(),
  ...ws,
  name: z.string().min(1).max(80),
  /** A one- or two-letter code, for a grid too dense to carry a name. */
  code: z.string().max(8).nullable(),
  start: WallClock,
  /** Earlier than `start` for a shift that ends the next morning — the same rule `ShiftSpec` uses. */
  end: WallClock,
  breakMinutes: z.number().int().min(0).max(480),
  graceInMinutes: z.number().int().min(0).max(240),
  graceOutMinutes: z.number().int().min(0).max(240),
  color: z.string().max(32).nullable(),
  archivedAt: Timestamp.nullable(),
})
export type RosterShift = z.infer<typeof RosterShift>

/**
 * One position in a rotation: the shifts worked on that day of the cycle.
 *
 * An **array**, so a split shift — 06:00–10:00 and 16:00–20:00, ordinary in hospitality — is a
 * cycle day with two entries rather than something the model forbids. An empty array is a rest day,
 * which is a different fact from "nothing is rostered": a rest day is planned.
 */
export const RosterCycleDay = z.array(z.uuid()).max(4)
export type RosterCycleDay = z.infer<typeof RosterCycleDay>

/**
 * A rotation, as a cycle and the date it starts from.
 *
 * The cycle length is `days.length` and is not stored separately — two numbers that must agree is
 * one number and a bug. `anchorDate` is the date `days[0]` applies to; every other date is
 * `(dayNumber(date) - dayNumber(anchorDate) + cycleOffset) mod days.length`, which answers for
 * dates before the anchor as readily as after it.
 */
export const RosterPattern = z.object({
  id: z.uuid(),
  ...ws,
  name: z.string().min(1).max(120),
  /** The date `days[0]` falls on. Moving it rotates every assignment on this pattern at once. */
  anchorDate: IsoDate,
  days: z.array(RosterCycleDay).min(1).max(56),
  archivedAt: Timestamp.nullable(),
})
export type RosterPattern = z.infer<typeof RosterPattern>

/**
 * A person on a rotation, over a period.
 *
 * Effective-dated like every other assignment here, and at most one may be in force on a day — the
 * exclusion constraint in migration 0012 is what guarantees that rather than the handler, because
 * two concurrent requests cannot both win against a constraint.
 *
 * `cycleOffset` is what puts two crews on one pattern out of phase: crew B on a 4-on-4-off cycle
 * with `cycleOffset: 4` works exactly the days crew A is off. Without it every crew needs its own
 * copy of the same rotation, and a change to the rotation has to be made once per crew.
 */
export const RosterAssignment = z.object({
  id: z.uuid(),
  ...ws,
  personId: z.uuid(),
  patternId: z.uuid(),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable(),
  cycleOffset: z.number().int().min(0).max(55),
  createdAt: Timestamp,
})
export type RosterAssignment = z.infer<typeof RosterAssignment>

/**
 * Where a rostered day came from.
 *
 * `none` is not the same as a rest day: it means nothing rosters this person on this date at all,
 * and a screen that renders it identically to a planned day off is telling somebody their absence
 * was intended. A rest day is `pattern` with no shifts.
 */
export const RosterDaySource = z.enum(['pattern', 'override', 'none'])
export type RosterDaySource = z.infer<typeof RosterDaySource>

export const RosterDay = z.object({
  personId: z.uuid(),
  businessDate: IsoDate,
  shifts: z.array(RosterShift),
  source: RosterDaySource,
  /** Why this day differs from the rotation. Only ever set on an override. */
  note: z.string().max(500).nullable(),
})
export type RosterDay = z.infer<typeof RosterDay>

/** Enough of a person to fill a coverage grid. The name every member may already read. */
export const RosterPerson = z.object({ personId: z.uuid(), displayName: z.string() })
export type RosterPerson = z.infer<typeof RosterPerson>

/**
 * One office-day, which is the question a roster exists to answer.
 *
 * `off` carries the people a pattern covers on this date and does not put on a shift — the answer
 * to "who could I call in", which is the second thing anybody looking at a coverage grid wants and
 * the one a list of who is working cannot give.
 */
export const RosterCoverageDay = z.object({
  businessDate: IsoDate,
  slots: z.array(z.object({ shift: RosterShift, people: z.array(RosterPerson) })),
  off: z.array(RosterPerson),
})
export type RosterCoverageDay = z.infer<typeof RosterCoverageDay>

/**
 * How long a roster range may be.
 *
 * Expansion is arithmetic and cheap; the cost is the person-days a coverage grid resolves and the
 * size of what comes back. A quarter covers the longest rotation anybody plans by hand, and
 * coverage is capped tighter because it multiplies by the population of an office.
 */
export const MAX_ROSTER_DAYS = 186
export const MAX_COVERAGE_DAYS = 42
