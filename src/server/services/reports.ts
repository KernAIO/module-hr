import { KernError, type Tx } from '@kernhq/kernel'
import { and, type Column, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type {
  AbsenceBasis,
  CalendarDay,
  IsoDate,
  PersonResolution,
  ReportFinality,
  WorkingWeek,
} from '../../contract/index.js'
import { MAX_PERSON_DAYS, MAX_REPORT_DAYS, MAX_SLICED_REPORT_DAYS } from '../../contract/reports.js'
import { datesBetween, workingDays } from '../../policy/calendar.js'
import {
  attendanceDays,
  employments,
  leaveLedger,
  leaveRequests,
  leaveTypes,
  legalEntities,
  officeAssignments,
  offices,
  people,
  scheduleAssignments,
} from '../schema.js'
import { toUnit } from './ledger.js'
import type { ResolveService } from './resolve.js'

/**
 * The four reports, and the arithmetic they are not allowed to guess at.
 *
 * Everything above the class is pure — no `tx`, no clock, no kernel — because the decisions worth
 * pinning are decisions about *unknown*, and they are impossible to see in a query plan. Zero and
 * unknown are different answers, and a report that conflates them is wrong in the direction nobody
 * checks: a 100% attendance figure for somebody with no schedule, a confident "21 expected working
 * days" for an office whose calendar is Monday–Friday only because nothing was attached, an
 * overtime ceiling reported as "nothing exceeded" where no ceiling ever applied. Each of those
 * renders as a plausible number, and `reports.test.ts` is what holds them to `null`.
 *
 * Everything below the class is aggregated **in the database**. The one thing that cannot be — a
 * person's expected working days, which is calendar arithmetic living in `policy/calendar.ts` and
 * must not grow a second implementation in SQL — is pushed down as a `(date, fraction)` array of at
 * most one range's length, so the join and the sum still happen in Postgres. Nothing here reads a
 * year of day sheets into the process to add them up.
 */

// ====================================================================== pure

/** Halves and quarters add up exactly; floating point does not. Two places is enough for both. */
export const round2 = (n: number): number => Math.round(n * 100) / 100

/** Inclusive day count of a range, and `0` for a reversed one so a caller can refuse it. */
export function rangeDays(from: IsoDate, to: IsoDate): number {
  return to < from ? 0 : datesBetween(from, to).length
}

/**
 * A ratio, or **null when the denominator is not a number this module holds**.
 *
 * The case that matters is `worked / scheduled` for somebody with no schedule assignment:
 * `scheduleFor` returns `NO_SCHEDULE`, `computeDay` writes `scheduledMinutes: 0`, and the honest
 * answer to "what proportion of nothing did she work" is not 0% and not 100%. A screen renders this
 * as an em dash.
 */
export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  return round2(numerator / denominator)
}

/**
 * What a day sheet's policy stamp says about the schedule behind it.
 *
 * Read from `policy_hash` rather than from `scheduledMinutes === 0`, because the two are not the
 * same claim: a scheduled rest day also schedules nothing. `hashSchedule` writes
 * `${scheduleId ?? 'none'}:…`, so a `none:` prefix is the only positive evidence that no schedule
 * was in force. A row with no stamp at all predates it and answers `unknown` — neither state may be
 * claimed for it.
 */
export type ScheduleState = 'none' | 'scheduled' | 'unknown'
export function scheduleState(policyHash: string | null | undefined): ScheduleState {
  if (policyHash === null || policyHash === undefined || policyHash === '') return 'unknown'
  return policyHash.startsWith('none:') ? 'none' : 'scheduled'
}

/**
 * Total a column where **null means "not applicable"**, never zero.
 *
 * `attendance_days.beyond_cap_minutes` is nullable on purpose: null is "no annual ceiling was in
 * force on this day", zero is "one was and nothing passed it". Summing with `coalesce(…, 0)`
 * destroys exactly the distinction the column exists for — and it is the distinction a statutory
 * ceiling conversation turns on. So a person with no capped day at all reports `null`, and one with
 * a single capped day reports that day's figure even where it is zero.
 */
export function capTotal(values: ReadonlyArray<number | null>): {
  beyondCapMinutes: number | null
  cappedDays: number
  uncappedDays: number
} {
  let sum = 0
  let capped = 0
  let uncapped = 0
  for (const value of values) {
    if (value === null) uncapped++
    else {
      capped++
      sum += value
    }
  }
  return { beyondCapMinutes: capped === 0 ? null : sum, cappedDays: capped, uncappedDays: uncapped }
}

/**
 * Combine per-person or per-query finality into the report's.
 *
 * A range that crosses a lock boundary is neither final nor provisional, and the two halves have to
 * be nameable — "1–15 October locked, 16–31 October provisional" — because tonight's
 * `reconcile-days` will move the open half. A workspace with no periods at all has every day open,
 * which is the ordinary state and not a warning: the `periods` capability ships off.
 */
export function mergeFinality(parts: ReadonlyArray<Omit<ReportFinality, 'final'>>): ReportFinality {
  let lockedDays = 0
  let openDays = 0
  let firstOpenDay: string | null = null
  let lastLockedDay: string | null = null
  for (const part of parts) {
    lockedDays += part.lockedDays
    openDays += part.openDays
    if (part.firstOpenDay && (firstOpenDay === null || part.firstOpenDay < firstOpenDay))
      firstOpenDay = part.firstOpenDay
    if (part.lastLockedDay && (lastLockedDay === null || part.lastLockedDay > lastLockedDay))
      lastLockedDay = part.lastLockedDay
  }
  // `final` needs at least one locked day as well as no open one: a report over days that produced
  // no sheet at all has nothing to declare final, and saying it did would be the strongest claim
  // available made from the least evidence.
  return { lockedDays, openDays, final: lockedDays > 0 && openDays === 0, firstOpenDay, lastLockedDay }
}

/**
 * Expected days split into worked, excused and absent.
 *
 * `leaveDays` is null when the `leave` capability is off, and then nothing is subtracted for leave —
 * the report says `leaveCounted: false` beside the figure rather than showing a zero that reads as
 * "nobody was on leave". Floored at zero because somebody can work a public holiday, and a negative
 * absence is not a fact.
 */
export function absenceSplit(input: { expectedDays: number; workedDays: number; leaveDays: number | null }): {
  absentDays: number
  absenceRate: number | null
} {
  const absentDays = Math.max(0, round2(input.expectedDays - input.workedDays - (input.leaveDays ?? 0)))
  return { absentDays, absenceRate: ratio(absentDays, input.expectedDays) }
}

/**
 * Why a person has no expected-days figure, or `calendar` when they do.
 *
 * Two exclusions, both named rather than silent, and both of them populations a naive report gets
 * confidently wrong:
 *
 * - **No schedule.** Salaried staff who never clock in have no schedule assignment, owe no hours and
 *   are not absent. In most workspaces that switch attendance on for a subset they are the majority,
 *   and counting them absent would put every one of them at 100%.
 * - **No calendar.** `offices.calendarId` is nullable and the ladder then falls back to Monday–
 *   Friday. The arithmetic succeeds and is silently an assumption — wrong for every office whose
 *   weekend is Friday. A calendar that is attached but has no holidays in the range is a real
 *   answer; no calendar at all is not.
 */
export function absenceBasis(input: { hasSchedule: boolean; hasCalendar: boolean }): AbsenceBasis {
  if (!input.hasSchedule) return 'no_schedule'
  if (!input.hasCalendar) return 'no_calendar'
  return 'calendar'
}

/**
 * Whether a report of this shape may be run, and the sentence to refuse it with.
 *
 * Returns null when it may. The refusal carries both numbers rather than a limit nobody can act on,
 * because the reader's next move — narrow the slice, or shorten the range — depends on which of the
 * two is large.
 */
export function rangeRefusal(input: {
  from: IsoDate
  to: IsoDate
  perDay: boolean
  population?: number
}): string | null {
  const days = rangeDays(input.from, input.to)
  if (days === 0) return `The end date ${input.to} is before the start date ${input.from}.`
  const max = input.perDay ? MAX_SLICED_REPORT_DAYS : MAX_REPORT_DAYS
  if (days > max)
    return input.perDay
      ? `A report attributed day by day covers at most ${max} days, and this one asks for ${days}. Ask for a shorter range, or drop the slice.`
      : `A report covers at most ${max} days, and this one asks for ${days}.`
  if (input.perDay && input.population !== undefined) {
    const cells = input.population * days
    if (cells > MAX_PERSON_DAYS)
      return `${input.population} people over ${days} days is ${cells} person-days, and this report resolves at most ${MAX_PERSON_DAYS}. Ask for one office, or a shorter range.`
  }
  return null
}

/** One person's balance in one leave type, assembled from the three things that decide it. */
export function balanceRow(input: {
  balanceMinutes: number
  bookedMinutes: number
  pendingMinutes: number
  unit: string
}) {
  const availableMinutes = input.balanceMinutes - input.pendingMinutes
  return {
    balanceMinutes: input.balanceMinutes,
    bookedMinutes: input.bookedMinutes,
    pendingMinutes: input.pendingMinutes,
    availableMinutes,
    balance: toUnit(input.balanceMinutes, input.unit),
    available: toUnit(availableMinutes, input.unit),
  }
}

// ====================================================================== database

const int = (value: unknown): number => {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * A Postgres array literal, spelled out.
 *
 * `sql\`${someArray}::uuid[]\`` looks like it binds one array parameter and does not: drizzle
 * expands a JS array into a parameter **list**, so it renders `($1, $2)::uuid[]` and Postgres
 * rejects the statement. Nothing catches that — the types are fine, and a pure-function test never
 * reaches a database — so every report would have thrown on its first real call. `array[$1, $2]` is
 * the spelling that survives, and it is needed wherever a column is not available for drizzle's own
 * `inArray` (an aliased table inside a raw `from`, or an `unnest` of two parallel arrays).
 */
const pgArray = (values: ReadonlyArray<string | number>, type: string) =>
  sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::${sql.raw(type)}`

/**
 * A set of people over a set of dates, aggregated in one query.
 *
 * `personIds: null` means "no person filter", which is what an unsliced report has; `dates: null`
 * means the whole range, which is what a report nobody transferred through has. Both spellings
 * exist so the ordinary case stays a single grouped aggregate with a `between` the index leads on.
 */
interface DayGroup {
  personIds: string[] | null
  dates: string[] | null
}

/** What the slice resolved to, and who it covers on which day. */
export interface ReportPopulation {
  /** Everybody the slice covers on at least one day of the range. */
  personIds: string[]
  /** Null for an unsliced report; otherwise the dates each person belonged to the slice on. */
  datesByPerson: Map<string, string[]> | null
  /** The resolutions the slice was decided from, keyed date → person. Null when nothing was resolved. */
  resolutions: Map<string, Map<string, PersonResolution>> | null
  sliceName: string | null
}

export class ReportsService {
  constructor(private readonly resolve: ResolveService) {}

  /**
   * Who the report is about, and on which days.
   *
   * **Attributed as of each day, not as of today.** Every list handler in this module filters on an
   * assignment with no end date, and every *number* in it resolves per date instead — a day sheet is
   * rebuilt against the entity in force on the day it covers, a period lock resolves once per date,
   * the accrual job resolves on the last day of the period. A report is a number, so copying the
   * nearest list handler would hand a transfer's whole previous quarter to the receiving office.
   *
   * The ladder is asked rather than reimplemented. `ResolveService` is the only thing that knows
   * that a person may hold several concurrent office assignments and that only the primary decides,
   * or that a legal entity falls back from the employment to the office. What is done here is a
   * cheap **superset** query first — everybody who could conceivably be in this slice — so the
   * ladder walks over an office rather than over a workspace. A superset that is too wide costs
   * time and never correctness; the answer still comes from `forPeople`.
   */
  async population(
    tx: Tx,
    workspaceId: string,
    slice: { by: 'workspace' | 'office' | 'legal_entity'; id: string | null },
    from: string,
    to: string,
  ): Promise<ReportPopulation> {
    if (slice.by === 'workspace' || !slice.id) {
      const rows = await tx.select({ id: people.id }).from(people).where(eq(people.workspaceId, workspaceId))
      return {
        personIds: rows.map((r) => r.id),
        datesByPerson: null,
        resolutions: null,
        sliceName: null,
      }
    }

    const superset = await this.superset(tx, workspaceId, slice.by, slice.id, from, to)
    const dates = datesBetween(from, to)
    const resolutions = await this.resolveByDate(tx, workspaceId, superset, dates)

    const datesByPerson = new Map<string, string[]>()
    for (const date of dates) {
      for (const [personId, resolution] of resolutions.get(date) ?? []) {
        const here = slice.by === 'office' ? resolution.primaryOfficeId : resolution.legalEntityId
        if (here !== slice.id) continue
        const list = datesByPerson.get(personId)
        if (list) list.push(date)
        else datesByPerson.set(personId, [date])
      }
    }

    return {
      personIds: [...datesByPerson.keys()],
      datesByPerson,
      resolutions,
      sliceName: await this.sliceName(tx, workspaceId, slice.by, slice.id),
    }
  }

  /**
   * Everybody who could be in this slice on any day of the range.
   *
   * Deliberately loose. An office assignment that is not primary still puts somebody in the
   * superset, because whether it is primary on a given date is the ladder's answer and not this
   * query's. The workspace's default office is the one case with no narrowing available at all:
   * anybody with no primary assignment on a date falls back to it, so slicing by the default office
   * — or by the entity it belongs to — has to consider the whole directory.
   */
  private async superset(
    tx: Tx,
    workspaceId: string,
    by: 'office' | 'legal_entity',
    id: string,
    from: string,
    to: string,
  ): Promise<string[]> {
    // `inForceOn` next door answers "in force on this date"; the superset asks the range version of
    // the same question, because somebody who was in this office for a fortnight of the range still
    // belongs in the set the ladder is then asked about day by day.
    const overlapsRange = (fromCol: Column, toCol: Column) =>
      and(lte(fromCol, to), or(isNull(toCol), gte(toCol, from)))

    const fallback = await this.resolve.defaultOffice(tx, workspaceId)
    const defaultCovers = by === 'office' ? fallback?.id === id : !!fallback && fallback.legalEntityId === id
    if (defaultCovers) {
      const rows = await tx.select({ id: people.id }).from(people).where(eq(people.workspaceId, workspaceId))
      return rows.map((r) => r.id)
    }

    const ids = new Set<string>()

    if (by === 'office') {
      const rows = await tx
        .select({ personId: officeAssignments.personId })
        .from(officeAssignments)
        .where(
          and(
            eq(officeAssignments.workspaceId, workspaceId),
            eq(officeAssignments.officeId, id),
            overlapsRange(officeAssignments.effectiveFrom, officeAssignments.effectiveTo),
          ),
        )
      for (const row of rows) ids.add(row.personId)
      return [...ids]
    }

    const byEmployment = await tx
      .select({ personId: employments.personId })
      .from(employments)
      .where(
        and(
          eq(employments.workspaceId, workspaceId),
          eq(employments.legalEntityId, id),
          overlapsRange(employments.effectiveFrom, employments.effectiveTo),
        ),
      )
    for (const row of byEmployment) ids.add(row.personId)

    const entityOffices = await tx
      .select({ id: offices.id })
      .from(offices)
      .where(and(eq(offices.workspaceId, workspaceId), eq(offices.legalEntityId, id)))
    if (entityOffices.length) {
      const byOffice = await tx
        .select({ personId: officeAssignments.personId })
        .from(officeAssignments)
        .where(
          and(
            eq(officeAssignments.workspaceId, workspaceId),
            inArray(
              officeAssignments.officeId,
              entityOffices.map((o) => o.id),
            ),
            overlapsRange(officeAssignments.effectiveFrom, officeAssignments.effectiveTo),
          ),
        )
      for (const row of byOffice) ids.add(row.personId)
    }
    return [...ids]
  }

  /**
   * The ladder, once per date.
   *
   * The cost is one ladder walk per day in the range, which is why the per-day reports are capped at
   * a quarter. The fix is a range-aware batch inside `ResolveService` — one walk that answers a span
   * — and it belongs there rather than here, because a second implementation of "what applies to a
   * person on a date" is the drift that service exists to prevent.
   */
  async resolveByDate(
    tx: Tx,
    workspaceId: string,
    personIds: string[],
    dates: string[],
  ): Promise<Map<string, Map<string, PersonResolution>>> {
    const out = new Map<string, Map<string, PersonResolution>>()
    if (!personIds.length || !dates.length) {
      for (const date of dates) out.set(date, new Map())
      return out
    }
    // Refused with both numbers in it rather than left to run for minutes. The refusal names the
    // two things a reader can act on — how many people, over how many days — because which of them
    // to shrink is their decision and not this module's.
    const refusal = rangeRefusal({
      from: dates[0]!,
      to: dates[dates.length - 1]!,
      perDay: true,
      population: personIds.length,
    })
    if (refusal) throw KernError.badRequest(refusal)
    for (const date of dates) out.set(date, await this.resolve.forPeople(tx, workspaceId, personIds, date))
    return out
  }

  private async sliceName(
    tx: Tx,
    workspaceId: string,
    by: 'office' | 'legal_entity',
    id: string,
  ): Promise<string | null> {
    if (by === 'office') {
      const [row] = await tx
        .select({ name: offices.name })
        .from(offices)
        .where(and(eq(offices.workspaceId, workspaceId), eq(offices.id, id)))
        .limit(1)
      return row?.name ?? null
    }
    const [row] = await tx
      .select({ name: legalEntities.name })
      .from(legalEntities)
      .where(and(eq(legalEntities.workspaceId, workspaceId), eq(legalEntities.id, id)))
      .limit(1)
    return row?.name ?? null
  }

  /**
   * Turn a per-day membership into the fewest queries that can express it.
   *
   * People who belonged to the slice on the same set of days share one group, so a report nobody
   * transferred through — which is nearly all of them — is a single aggregate over the whole range
   * rather than one per day.
   */
  groupsFor(population: ReportPopulation, from: string, to: string): DayGroup[] {
    if (!population.datesByPerson) return [{ personIds: null, dates: null }]
    const whole = datesBetween(from, to).join(',')
    const bySignature = new Map<string, DayGroup>()
    for (const [personId, dates] of population.datesByPerson) {
      const signature = dates.join(',')
      const existing = bySignature.get(signature)
      if (existing) existing.personIds?.push(personId)
      else bySignature.set(signature, { personIds: [personId], dates: signature === whole ? null : dates })
    }
    return [...bySignature.values()]
  }

  /**
   * Every figure the attendance and overtime reports need, per person, in one grouped aggregate.
   *
   * `attendance_days` only — never `punches`. Punches are raw, append-only and partitioned, and a
   * voided punch survives beside the correction that replaced it, so summing them double-counts
   * every fix that has ever been made. The day sheet is the projection those punches produce and the
   * only thing that has already applied the schedule, the calendar and the rounding.
   *
   * `beyond_cap_minutes` is summed **without** `coalesce`: Postgres answers NULL when every row in
   * the group is null, which is exactly "no annual ceiling was in force on any of these days".
   */
  async dayAggregate(
    tx: Tx,
    workspaceId: string,
    group: DayGroup,
    from: string,
    to: string,
  ): Promise<DayAggregateRow[]> {
    const where = [eq(attendanceDays.workspaceId, workspaceId)]
    if (group.dates === null) {
      where.push(gte(attendanceDays.businessDate, from), lte(attendanceDays.businessDate, to))
    } else {
      if (!group.dates.length) return []
      where.push(inArray(attendanceDays.businessDate, group.dates))
    }
    if (group.personIds !== null) {
      if (!group.personIds.length) return []
      where.push(inArray(attendanceDays.personId, group.personIds))
    }

    const rows = await tx
      .select({
        personId: attendanceDays.personId,
        days: sql<string>`count(*)`,
        scheduledMinutes: sql<string>`coalesce(sum(${attendanceDays.scheduledMinutes}), 0)`,
        workedMinutes: sql<string>`coalesce(sum(${attendanceDays.workedMinutes}), 0)`,
        // `workedRatio`'s numerator, and it is not `workedMinutes`. Work on a day no schedule was in
        // force adds to the top of that fraction and nothing to the bottom, so a team that turned up
        // exactly as asked reports 121% because one colleague clocked in on a day nobody rostered
        // them. A row with no stamp at all is counted here: it has scheduled minutes, so it is in the
        // denominator, and leaving it out of the numerator would understate the same fraction.
        scheduledWorkedMinutes: sql<string>`coalesce(sum(${attendanceDays.workedMinutes}) filter (where ${attendanceDays.policyHash} is null or ${attendanceDays.policyHash} not like 'none:%'), 0)`,
        breakMinutes: sql<string>`coalesce(sum(${attendanceDays.breakMinutes}), 0)`,
        lateMinutes: sql<string>`coalesce(sum(${attendanceDays.lateMinutes}), 0)`,
        earlyLeaveMinutes: sql<string>`coalesce(sum(${attendanceDays.earlyLeaveMinutes}), 0)`,
        overtimeMinutes: sql<string>`coalesce(sum(${attendanceDays.overtimeMinutes}), 0)`,
        // No coalesce. NULL here is the answer, not a missing one.
        beyondCapMinutes: sql<string | null>`sum(${attendanceDays.beyondCapMinutes})`,
        cappedDays: sql<string>`count(${attendanceDays.beyondCapMinutes})`,
        uncappedDays: sql<string>`count(*) filter (where ${attendanceDays.beyondCapMinutes} is null)`,
        noScheduleDays: sql<string>`count(*) filter (where ${attendanceDays.policyHash} like 'none:%')`,
        unknownScheduleDays: sql<string>`count(*) filter (where ${attendanceDays.policyHash} is null)`,
        lockedDays: sql<string>`count(*) filter (where ${attendanceDays.locked})`,
        openDays: sql<string>`count(*) filter (where not ${attendanceDays.locked})`,
        firstOpenDay: sql<
          string | null
        >`(min(${attendanceDays.businessDate}) filter (where not ${attendanceDays.locked}))::text`,
        lastLockedDay: sql<
          string | null
        >`(max(${attendanceDays.businessDate}) filter (where ${attendanceDays.locked}))::text`,
      })
      .from(attendanceDays)
      .where(and(...where))
      .groupBy(attendanceDays.personId)

    return rows.map((r) => ({
      personId: r.personId,
      days: int(r.days),
      scheduledMinutes: int(r.scheduledMinutes),
      workedMinutes: int(r.workedMinutes),
      scheduledWorkedMinutes: int(r.scheduledWorkedMinutes),
      breakMinutes: int(r.breakMinutes),
      lateMinutes: int(r.lateMinutes),
      earlyLeaveMinutes: int(r.earlyLeaveMinutes),
      overtimeMinutes: int(r.overtimeMinutes),
      beyondCapMinutes: r.beyondCapMinutes === null ? null : int(r.beyondCapMinutes),
      cappedDays: int(r.cappedDays),
      uncappedDays: int(r.uncappedDays),
      noScheduleDays: int(r.noScheduleDays),
      unknownScheduleDays: int(r.unknownScheduleDays),
      lockedDays: int(r.lockedDays),
      openDays: int(r.openDays),
      firstOpenDay: r.firstOpenDay ?? null,
      lastLockedDay: r.lastLockedDay ?? null,
    }))
  }

  /**
   * Expected, worked and excused days for one set of people who share one expectation.
   *
   * The expectation arrives as parallel `(date, fraction)` arrays — at most one range long — because
   * `workingDays()` in `policy/calendar.ts` is the only implementation of working-day arithmetic
   * this module has, and rewriting it as `generate_series` plus a weekday case would be a second one
   * that drifts. Everything else stays in the database: the join to the day sheets, the join to
   * approved leave and the sums are all Postgres's, so a quarter of a large office is one query
   * rather than tens of thousands of rows crossing the wire.
   *
   * A day is expected only where a **schedule assignment is in force**, which is the module's own
   * rule for whether somebody owes hours at all. It is what keeps a joiner's first fortnight, a
   * leaver's last, and every salaried colleague who never clocks in out of the denominator without
   * this file reading a hire date.
   */
  async absenceAggregate(
    tx: Tx,
    workspaceId: string,
    personIds: string[],
    expected: ReadonlyArray<{ date: string; fraction: number }>,
    countLeave: boolean,
  ): Promise<AbsenceAggregateRow[]> {
    const worked = expected.filter((e) => e.fraction > 0)
    if (!personIds.length || !worked.length) return []
    const dates = worked.map((e) => e.date)
    const fractions = worked.map((e) => e.fraction)

    const scheduled = sql`
      (select distinct sa.person_id as person_id, e.d as d, e.f as f
         from unnest(${pgArray(dates, 'date[]')}, ${pgArray(fractions, 'numeric[]')}) as e(d, f)
         join ${scheduleAssignments} sa
           on sa.workspace_id = ${workspaceId}
          and sa.person_id = any(${pgArray(personIds, 'uuid[]')})
          and sa.effective_from <= e.d
          and (sa.effective_to is null or sa.effective_to >= e.d)) s`

    // Left-joined rather than filtered, so a day with no sheet at all still counts towards the
    // expectation — that missing row is the whole point of the report and is ambiguous between
    // "not scheduled", "on approved leave" and "absent" until these joins have spoken.
    const sheets = sql`
      left join ${attendanceDays} ad
        on ad.workspace_id = ${workspaceId} and ad.person_id = s.person_id and ad.business_date = s.d`
    const leave = countLeave
      ? sql`
      left join mod_hr.leave_request_days lrd
        on lrd.workspace_id = ${workspaceId} and lrd.person_id = s.person_id and lrd.date = s.d
       and lrd.counted and lrd.status = 'approved'`
      : sql``

    const rows = await tx
      .select({
        personId: sql<string>`s.person_id::text`,
        expectedDays: sql<string>`coalesce(sum(s.f), 0)::float8`,
        workedDays: sql<string>`coalesce(sum(s.f) filter (where coalesce(ad.worked_minutes, 0) > 0), 0)::float8`,
        leaveDays: countLeave
          ? sql<string>`coalesce(sum(least(s.f, lrd.fraction)) filter (where coalesce(ad.worked_minutes, 0) = 0 and lrd.id is not null), 0)::float8`
          : sql<string>`0::float8`,
        lockedDays: sql<string>`count(ad.id) filter (where ad.locked)`,
        openDays: sql<string>`count(ad.id) filter (where not ad.locked)`,
        firstOpenDay: sql<string | null>`(min(ad.business_date) filter (where not ad.locked))::text`,
        lastLockedDay: sql<string | null>`(max(ad.business_date) filter (where ad.locked))::text`,
      })
      .from(sql`${scheduled}${sheets}${leave}`)
      .groupBy(sql`s.person_id`)

    return rows.map((r) => ({
      personId: r.personId,
      expectedDays: round2(Number(r.expectedDays ?? 0)),
      workedDays: round2(Number(r.workedDays ?? 0)),
      leaveDays: countLeave ? round2(Number(r.leaveDays ?? 0)) : null,
      lockedDays: int(r.lockedDays),
      openDays: int(r.openDays),
      firstOpenDay: r.firstOpenDay ?? null,
      lastLockedDay: r.lastLockedDay ?? null,
    }))
  }

  /** Who has any schedule assignment overlapping the range, so "no schedule" is a fact rather than a guess. */
  async scheduledPeople(
    tx: Tx,
    workspaceId: string,
    personIds: string[],
    from: string,
    to: string,
  ): Promise<Set<string>> {
    if (!personIds.length) return new Set()
    const rows = await tx
      .select({ personId: scheduleAssignments.personId })
      .from(scheduleAssignments)
      .where(
        and(
          eq(scheduleAssignments.workspaceId, workspaceId),
          inArray(scheduleAssignments.personId, personIds),
          lte(scheduleAssignments.effectiveFrom, to),
          or(isNull(scheduleAssignments.effectiveTo), gte(scheduleAssignments.effectiveTo, from)),
        ),
      )
    return new Set(rows.map((r) => r.personId))
  }

  /**
   * Every balance in the population, per leave type, in three queries rather than three per person.
   *
   * The single-person path runs three queries per person, which over five hundred people is fifteen
   * hundred round trips — the shape `ResolveService.forPeople` and `PolicyService.forPeople` were
   * both rescued from. This is the batched twin and it belongs in `LedgerService` the next time that
   * file is opened.
   *
   * It differs from the single-person path in one figure, deliberately. That one joins
   * `leave_request_days` to `leave_requests` and sums `lr.minutes`, so a request contributes its
   * whole minute total **once per day it covers** — a five-day request counts five times, and
   * `available = balance − pending` inherits it. Summing over `leave_requests` directly is both
   * correct and simpler, and a report that goes into a payroll conversation is the wrong place to
   * reproduce an off-by-a-factor.
   */
  async leaveBalances(
    tx: Tx,
    workspaceId: string,
    personIds: string[],
    periodYear: number,
  ): Promise<LeaveBalanceRowData[]> {
    if (!personIds.length) return []

    const types = await tx
      .select({ id: leaveTypes.id, name: leaveTypes.name, unit: leaveTypes.unit, order: leaveTypes.order })
      .from(leaveTypes)
      .where(and(eq(leaveTypes.workspaceId, workspaceId), isNull(leaveTypes.archivedAt)))
    if (!types.length) return []
    const typeById = new Map(types.map((t) => [t.id, t]))

    const sums = await tx
      .select({
        personId: leaveLedger.personId,
        leaveTypeId: leaveLedger.leaveTypeId,
        total: sql<string>`coalesce(sum(${leaveLedger.amountMinutes}), 0)`,
      })
      .from(leaveLedger)
      .where(
        and(
          eq(leaveLedger.workspaceId, workspaceId),
          eq(leaveLedger.periodYear, periodYear),
          inArray(leaveLedger.personId, personIds),
        ),
      )
      .groupBy(leaveLedger.personId, leaveLedger.leaveTypeId)

    const live = await tx
      .select({
        personId: leaveRequests.personId,
        leaveTypeId: leaveRequests.leaveTypeId,
        status: leaveRequests.status,
        minutes: sql<string>`coalesce(sum(${leaveRequests.minutes}), 0)`,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.workspaceId, workspaceId),
          inArray(leaveRequests.personId, personIds),
          inArray(leaveRequests.status, ['pending', 'approved']),
        ),
      )
      .groupBy(leaveRequests.personId, leaveRequests.leaveTypeId, leaveRequests.status)

    const key = (personId: string, typeId: string) => `${personId}:${typeId}`
    const seen = new Map<string, { personId: string; leaveTypeId: string }>()
    const balance = new Map<string, number>()
    const booked = new Map<string, number>()
    const pending = new Map<string, number>()

    for (const row of sums) {
      if (!typeById.has(row.leaveTypeId)) continue
      const k = key(row.personId, row.leaveTypeId)
      seen.set(k, { personId: row.personId, leaveTypeId: row.leaveTypeId })
      balance.set(k, int(row.total))
    }
    for (const row of live) {
      if (!typeById.has(row.leaveTypeId)) continue
      const k = key(row.personId, row.leaveTypeId)
      seen.set(k, { personId: row.personId, leaveTypeId: row.leaveTypeId })
      const target = row.status === 'approved' ? booked : pending
      target.set(k, (target.get(k) ?? 0) + int(row.minutes))
    }

    return [...seen.entries()].map(([k, ref]) => {
      const type = typeById.get(ref.leaveTypeId)!
      return {
        personId: ref.personId,
        leaveTypeId: ref.leaveTypeId,
        leaveTypeName: type.name,
        unit: type.unit as 'day' | 'half_day' | 'hour',
        order: type.order,
        ...balanceRow({
          balanceMinutes: balance.get(k) ?? 0,
          bookedMinutes: booked.get(k) ?? 0,
          pendingMinutes: pending.get(k) ?? 0,
          unit: type.unit,
        }),
      }
    })
  }

  /**
   * Display names for the rows a report is about to return.
   *
   * Asked after the rows are chosen rather than for the whole population, and shown exactly as
   * stored: an erased person keeps their row and carries the erasure token in `display_name`.
   * Dropping the row would change the total, and printing "Unknown" would hide that this is a person
   * the workspace deliberately redacted.
   */
  async namesOf(tx: Tx, workspaceId: string, personIds: string[]): Promise<Map<string, string>> {
    if (!personIds.length) return new Map()
    const rows = await tx
      .select({ id: people.id, displayName: people.displayName })
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, personIds)))
    return new Map(rows.map((r) => [r.id, r.displayName]))
  }
}

export interface DayAggregateRow {
  personId: string
  days: number
  scheduledMinutes: number
  workedMinutes: number
  /** Worked minutes on days a schedule was in force — `workedRatio`'s numerator, not `workedMinutes`. */
  scheduledWorkedMinutes: number
  breakMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  overtimeMinutes: number
  beyondCapMinutes: number | null
  cappedDays: number
  uncappedDays: number
  noScheduleDays: number
  unknownScheduleDays: number
  lockedDays: number
  openDays: number
  firstOpenDay: string | null
  lastLockedDay: string | null
}

export interface AbsenceAggregateRow {
  personId: string
  expectedDays: number
  workedDays: number
  leaveDays: number | null
  lockedDays: number
  openDays: number
  firstOpenDay: string | null
  lastLockedDay: string | null
}

export interface LeaveBalanceRowData {
  personId: string
  leaveTypeId: string
  leaveTypeName: string
  unit: 'day' | 'half_day' | 'hour'
  order: number
  balanceMinutes: number
  bookedMinutes: number
  pendingMinutes: number
  availableMinutes: number
  balance: number
  available: number
}

/**
 * One person's expected working days, per date, from the ladder's answer for each date.
 *
 * Pure but for its inputs, and kept beside the reports rather than in `policy/calendar.ts` because
 * it is a *report's* composition of two things that already exist — the ladder's resolution for a
 * date, and `workingDays()` for the calendar behind it. The calendar is asked per date because a
 * person who changes office mid-month changes calendar mid-month, and averaging the two would be an
 * invented number.
 */
export function expectedDaysFor(
  dates: readonly string[],
  resolutionFor: (date: string) => PersonResolution | undefined,
  calendarDaysFor: (
    calendarId: string,
  ) => ReadonlyArray<Pick<CalendarDay, 'date' | 'name' | 'workingFraction'>>,
): { expected: Array<{ date: string; fraction: number }>; hasCalendar: boolean } {
  const expected: Array<{ date: string; fraction: number }> = []
  let hasCalendar = true
  for (const date of dates) {
    const resolution = resolutionFor(date)
    if (!resolution) {
      // Not in the population on this date — no expectation, and not evidence about the calendar.
      continue
    }
    if (resolution.calendarId === null) hasCalendar = false
    const week = resolution.workingWeek as WorkingWeek
    const days = resolution.calendarId ? calendarDaysFor(resolution.calendarId) : []
    const [result] = workingDays(date, date, week, days)
    expected.push({ date, fraction: result?.fraction ?? 0 })
  }
  return { expected, hasCalendar }
}
