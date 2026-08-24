import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { EmploymentType, HrSettings, PersonStatus } from '../../contract/index.js'
import { employments, officeAssignments, people, personHistory } from '../schema.js'
import { isOpen, todayIso } from './db.js'

/** Row shapes the router turns into contract objects. */
export type PersonRow = typeof people.$inferSelect
export type EmploymentRow = typeof employments.$inferSelect

/**
 * Writing people, employment and office moves — the three things that must stay consistent.
 *
 * Everything effective-dated goes through here rather than through the router, because "close the
 * open row, then insert the new one" has to happen in one transaction and in that order. Done the
 * other way round, a unique or exclusion constraint fires on the overlap and the change looks like
 * a validation error instead of a race.
 */
export class PeopleService {
  constructor(private readonly kernel: Kernel) {}

  /** Serialise a row for the wire. Postgres `numeric` arrives as a string; the contract says number. */
  static toPerson(row: PersonRow) {
    return {
      ...row,
      // `status`, `employment_type` and friends are `text` in Postgres and unions in the contract.
      // Narrowing here rather than widening the contract keeps the enum meaningful for every
      // consumer; the column is only ever written from the same union.
      status: row.status as PersonStatus,
      custom: row.custom ?? {},
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  static toEmployment(row: EmploymentRow) {
    return {
      ...row,
      employmentType: row.employmentType as EmploymentType,
      fte: Number.parseFloat(row.fte ?? '1'),
      contractHoursWeek: row.contractHoursWeek === null ? null : Number.parseFloat(row.contractHoursWeek),
      createdAt: row.createdAt.toISOString(),
    }
  }

  async load(tx: Tx, workspaceId: string, personId: string): Promise<PersonRow> {
    const [row] = await tx
      .select()
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), eq(people.id, personId)))
      .limit(1)
    if (!row) throw KernError.notFound('Person')
    return row
  }

  async byUserId(tx: Tx, workspaceId: string, userId: string): Promise<PersonRow | undefined> {
    const [row] = await tx
      .select()
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), eq(people.userId, userId)))
      .limit(1)
    return row
  }

  /**
   * The next employee number, from workspace settings.
   *
   * Read-modify-write rather than a sequence, because the prefix and the counter are things an
   * administrator edits — and a Postgres sequence cannot be edited without surprising them. Two
   * people created in the same instant can therefore collide; the unique index catches it and the
   * caller retries, which is the right trade for something that happens a handful of times a day.
   */
  async nextEmployeeNo(workspaceId: string, settings: HrSettings): Promise<string | null> {
    if (!settings.employeeNumberPrefix && settings.employeeNumberNext <= 1) return null
    const next = settings.employeeNumberNext
    await this.kernel.settings.setModule(workspaceId, 'hr', {
      ...settings,
      employeeNumberNext: next + 1,
    })
    return `${settings.employeeNumberPrefix}${next}`
  }

  /** Append-only. Every field change lands here, and nothing rewrites it. */
  async record(
    tx: Tx,
    workspaceId: string,
    personId: string,
    actorId: string | null,
    changes: Array<{ field: string; from: unknown; to: unknown }>,
    source = 'app',
  ) {
    if (!changes.length) return
    await tx.insert(personHistory).values(
      changes.map((c) => ({
        id: uuidv7(),
        workspaceId,
        personId,
        field: c.field,
        from: (c.from ?? null) as never,
        to: (c.to ?? null) as never,
        actorId,
        source,
      })),
    )
  }

  /**
   * Close the open employment row and open a new one from `effectiveFrom`.
   *
   * The new row inherits everything the caller did not name, so "change her manager" does not
   * silently blank her department. A change dated before the current row's start is refused rather
   than than quietly reordering history — that is a correction, and corrections need their own path.
   */
  async changeEmployment(
    tx: Tx,
    workspaceId: string,
    personId: string,
    effectiveFrom: string,
    patch: Partial<Omit<EmploymentRow, 'id' | 'workspaceId' | 'personId' | 'createdAt'>>,
  ): Promise<EmploymentRow> {
    const [open] = await tx
      .select()
      .from(employments)
      .where(
        and(
          eq(employments.workspaceId, workspaceId),
          eq(employments.personId, personId),
          isOpen(employments.effectiveTo),
        ),
      )
      .limit(1)

    if (open && effectiveFrom < open.effectiveFrom)
      throw KernError.badRequest(
        `This person's current record starts on ${open.effectiveFrom}; a change cannot be dated before it.`,
      )

    if (open) {
      // The previous period ends the day before the new one starts. Computed in SQL so the boundary
      // is Postgres's own date arithmetic rather than a string manipulation that has to know about
      // month lengths and leap years.
      await tx
        .update(employments)
        .set({ effectiveTo: sql`${effectiveFrom}::date - 1` })
        .where(eq(employments.id, open.id))
    }

    const [row] = await tx
      .insert(employments)
      .values({
        id: uuidv7(),
        workspaceId,
        personId,
        effectiveFrom,
        effectiveTo: null,
        orgUnitId: patch.orgUnitId ?? open?.orgUnitId ?? null,
        positionId: patch.positionId ?? open?.positionId ?? null,
        legalEntityId: patch.legalEntityId ?? open?.legalEntityId ?? null,
        costCenterId: patch.costCenterId ?? open?.costCenterId ?? null,
        managerPersonId: patch.managerPersonId ?? open?.managerPersonId ?? null,
        employmentType: patch.employmentType ?? open?.employmentType ?? 'full_time',
        fte: patch.fte ?? open?.fte ?? '1.000',
        contractHoursWeek: patch.contractHoursWeek ?? open?.contractHoursWeek ?? null,
        reason: patch.reason ?? null,
      })
      .returning()
    return row!
  }

  /**
   * Assign somebody to an office from a date, optionally as their primary.
   *
   * Making one primary demotes the other primary rather than leaving two — the database refuses two
   * anyway, and finding that out as a constraint violation would turn an ordinary office move into
   * an error the person doing it cannot act on.
   */
  async assignOffice(
    tx: Tx,
    workspaceId: string,
    personId: string,
    officeId: string,
    isPrimary: boolean,
    effectiveFrom: string,
    reason: string | null,
  ) {
    const open = await tx
      .select()
      .from(officeAssignments)
      .where(
        and(
          eq(officeAssignments.workspaceId, workspaceId),
          eq(officeAssignments.personId, personId),
          isNull(officeAssignments.effectiveTo),
        ),
      )

    for (const row of open) {
      if (row.officeId === officeId) {
        // Already here. Close it so the new row carries the new primary flag and start date rather
        // than leaving two rows for one office.
        await tx
          .update(officeAssignments)
          .set({ effectiveTo: sql`${effectiveFrom}::date - 1` })
          .where(eq(officeAssignments.id, row.id))
      } else if (isPrimary && row.isPrimary) {
        // Demote, do not close: somebody moving their primary from Istanbul to Amsterdam usually
        // keeps a presence in Istanbul, and closing it would remove them from that directory.
        await tx.update(officeAssignments).set({ isPrimary: false }).where(eq(officeAssignments.id, row.id))
      }
    }

    await tx.insert(officeAssignments).values({
      id: uuidv7(),
      workspaceId,
      personId,
      officeId,
      isPrimary,
      effectiveFrom,
      reason,
    })

    return tx
      .select()
      .from(officeAssignments)
      .where(
        and(
          eq(officeAssignments.workspaceId, workspaceId),
          eq(officeAssignments.personId, personId),
          isNull(officeAssignments.effectiveTo),
        ),
      )
  }

  static toAssignment(row: typeof officeAssignments.$inferSelect) {
    return { ...row, createdAt: row.createdAt.toISOString() }
  }

  today = todayIso
}
