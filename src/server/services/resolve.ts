import { KernError, type Tx } from '@kernhq/kernel'
import { and, eq, inArray } from 'drizzle-orm'
import type { PersonResolution, ResolutionRung, WorkingWeek } from '../../contract/index.js'
import { calendars, employments, officeAssignments, offices, orgUnits, people } from '../schema.js'
import { inForceOn, todayIso } from './db.js'

/**
 * What actually applies to a person on a date — and which rung of the ladder answered.
 *
 * ```
 * person override  →  primary office  →  org unit  →  workspace default
 * ```
 *
 * **This is the only implementation of that order.** Calendars, timezones and (later) accrual,
 * overtime and rounding policies all resolve through here. Four services each growing their own
 * slightly different version of the ladder is the classic way a multi-office HR model rots: they
 * agree for a year, then one of them forgets that a non-primary office does not vote, and a report
 * quietly disagrees with a payslip.
 *
 * Two rules it enforces so nothing else has to:
 *
 * - **Only the primary office decides.** A person may hold several concurrent office assignments —
 *   somebody splitting the week between two sites — and the others grant presence, not authority.
 *   Otherwise "how many days off do I have" has two answers, which no employee or auditor accepts.
 * - **Everything is asked "on a date".** A person who moved offices in March gets March's answer for
 *   a March question and today's for a today question. Resolving against the *current* row is the
 *   bug that makes a backdated leave request cost the wrong number of days.
 */
export class ResolveService {
  /**
   * Resolve for several people at once.
   *
   * Batched deliberately. A report over five hundred people that resolves row by row is five hundred
   * ladder walks, and the ladder is four queries deep — the same shape the tracker's field-value
   * loader had to be rescued from. Callers with one person use `forPerson`, which is this with a
   * single-element array.
   */
  async forPeople(
    tx: Tx,
    workspaceId: string,
    personIds: string[],
    on: string = todayIso(),
  ): Promise<Map<string, PersonResolution>> {
    const out = new Map<string, PersonResolution>()
    if (!personIds.length) return out

    const personRows = await tx
      .select({ id: people.id, timezone: people.timezone })
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, personIds)))

    const assignments = await tx
      .select()
      .from(officeAssignments)
      .where(
        and(
          eq(officeAssignments.workspaceId, workspaceId),
          inArray(officeAssignments.personId, personIds),
          inForceOn(officeAssignments.effectiveFrom, officeAssignments.effectiveTo, on),
        ),
      )

    const employmentRows = await tx
      .select()
      .from(employments)
      .where(
        and(
          eq(employments.workspaceId, workspaceId),
          inArray(employments.personId, personIds),
          inForceOn(employments.effectiveFrom, employments.effectiveTo, on),
        ),
      )

    const officeIds = [...new Set(assignments.map((a) => a.officeId))]
    const officeRows = officeIds.length
      ? await tx
          .select()
          .from(offices)
          .where(and(eq(offices.workspaceId, workspaceId), inArray(offices.id, officeIds)))
      : []
    const officeById = new Map(officeRows.map((o) => [o.id, o]))

    const unitIds = [...new Set(employmentRows.map((e) => e.orgUnitId).filter((x): x is string => !!x))]
    const unitRows = unitIds.length
      ? await tx
          .select()
          .from(orgUnits)
          .where(and(eq(orgUnits.workspaceId, workspaceId), inArray(orgUnits.id, unitIds)))
      : []
    const unitById = new Map(unitRows.map((u) => [u.id, u]))

    const calendarIds = [...new Set(officeRows.map((o) => o.calendarId).filter((x): x is string => !!x))]
    const calendarRows = calendarIds.length
      ? await tx
          .select()
          .from(calendars)
          .where(and(eq(calendars.workspaceId, workspaceId), inArray(calendars.id, calendarIds)))
      : []
    const calendarById = new Map(calendarRows.map((c) => [c.id, c]))

    const defaultOffice = await this.defaultOffice(tx, workspaceId)

    for (const p of personRows) {
      const mine = assignments.filter((a) => a.personId === p.id)
      // Only the primary decides. If a workspace somehow has none on this date — a person created
      // before any assignment, a gap left by a backdated move — the default office answers, which is
      // why there is always exactly one.
      const primaryAssignment = mine.find((a) => a.isPrimary)
      const primary = primaryAssignment ? officeById.get(primaryAssignment.officeId) : undefined
      const office = primary ?? defaultOffice
      const employment = employmentRows.find((e) => e.personId === p.id)
      const unit = employment?.orgUnitId ? unitById.get(employment.orgUnitId) : undefined
      const calendar = office?.calendarId ? calendarById.get(office.calendarId) : undefined

      const timezoneFrom: ResolutionRung = p.timezone ? 'person' : 'office'

      out.set(p.id, {
        personId: p.id,
        on,
        primaryOfficeId: office?.id ?? null,
        primaryOfficeName: office?.name ?? null,
        otherOfficeIds: mine.filter((a) => a.officeId !== office?.id).map((a) => a.officeId),
        country: office?.country ?? null,
        // A person override beats the office, for somebody who genuinely works from another zone.
        // Falling back to UTC rather than the server's zone is deliberate: a server's zone is an
        // accident of deployment, and a wrong answer that moves when you redeploy is the worst kind.
        timezone: p.timezone ?? office?.timezone ?? 'UTC',
        timezoneFrom,
        calendarId: calendar?.id ?? null,
        calendarFrom: calendar ? 'office' : null,
        workingWeek: (calendar?.workingWeek as WorkingWeek | undefined) ?? DEFAULT_WORKING_WEEK,
        legalEntityId: employment?.legalEntityId ?? office?.legalEntityId ?? null,
        orgUnitId: unit?.id ?? null,
        orgUnitPath: unit?.path ?? null,
        managerPersonId: employment?.managerPersonId ?? null,
      })
    }
    return out
  }

  async forPerson(tx: Tx, workspaceId: string, personId: string, on?: string): Promise<PersonResolution> {
    const map = await this.forPeople(tx, workspaceId, [personId], on)
    const found = map.get(personId)
    if (!found) throw KernError.notFound('Person')
    return found
  }

  /**
   * The workspace's default office.
   *
   * Always exists: HR creates it when the module is enabled for a workspace, built from the
   * workspace country. That is what lets the `offices` capability be a *reveal* rather than a
   * migration, and why nothing above has a "no office at all" branch to get wrong.
   */
  async defaultOffice(tx: Tx, workspaceId: string) {
    const [row] = await tx
      .select()
      .from(offices)
      .where(and(eq(offices.workspaceId, workspaceId), eq(offices.isDefault, true)))
      .limit(1)
    return row
  }
}

/** Monday to Friday. Overridden per calendar — Iran's weekend is Friday, the Gulf's Friday and Saturday. */
export const DEFAULT_WORKING_WEEK: WorkingWeek = {
  mon: 1,
  tue: 1,
  wed: 1,
  thu: 1,
  fri: 1,
  sat: 0,
  sun: 0,
}
