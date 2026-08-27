import type { Principal, WorkspaceId } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { EmploymentType, HrSettings, PersonSensitive, PersonStatus } from '../../contract/index.js'
import { employments, officeAssignments, people, peopleSensitive, personHistory } from '../schema.js'
import { HrAccessService } from './access.js'
import { fieldsPresent, HrAuditService, type SensitiveReadVia, viaFor } from './audit.js'
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
  private readonly audit: HrAuditService

  constructor(private readonly kernel: Kernel) {
    this.audit = new HrAuditService(kernel, new HrAccessService(kernel))
  }

  /**
   * Read a person's identity number, birth date and bank details — and record that it happened.
   *
   * **The decryption and the record are one function because they have to be one decision.** The
   * router used to select, decrypt and return inline, and "every path that decrypts also logs" was
   * then a rule somebody had to remember at each new call site: the subject-access export is the
   * second such path and would have been the first chance to forget. Here there is nothing to
   * remember. `kernel.secrets.decrypt` is called on these columns in exactly one place in the
   * module, and it is this one, five lines above the insert that records it.
   *
   * ## A failure to record fails the read, and that is the decision
   *
   * The insert is in the same transaction as the select, on the same database, so if it fails the
   * transaction rolls back and the caller gets an error instead of a national identity number.
   *
   * That direction is deliberate, and the argument for it is that the alternative buys almost
   * nothing. The insert has no failure mode the select does not already have — a lost connection, a
   * full disk, an unset `app.workspace_id`. There is no realistic world in which the read is healthy
   * and the record alone fails, so catching it would not keep a working feature working; it would
   * only convert the rare broken case from a loud error into a silent hole. And a hole is the exact
   * failure this log exists to prevent: a subject-access response assembled from a log with gaps
   * states in writing that nobody read a record that was read, which is worse than no log at all,
   * because it is wrong with authority. Refusing is also the safer half of the trade in the other
   * direction — the plaintext never leaves the process, because the transaction that would have
   * returned it did not commit.
   *
   * The cost is real and worth naming: if this table or its policy is ever broken, sensitive reads
   * stop rather than degrade. For this class of data that is the correct outcome, and it is a loud
   * one somebody fixes in minutes instead of a quiet one nobody discovers until a regulator asks.
   *
   * The best-effort copy sent to core's activity feed falls the other way — see `HrAuditService`.
   * It is sent after the transaction has committed, so a read that rolled back is never announced.
   *
   * `purpose` is recorded only where a caller has a real one to give, which today means an export
   * run against a subject-access request. `sensitive.get` passes `null`: its contract has no field
   * for a reason and inventing one would put a sentence in the reader's mouth.
   */
  async readSensitive(input: {
    workspaceId: WorkspaceId
    personId: string
    principal: Principal
    /** Omitted for an ordinary request, where the principal says it. Passed by a bulk reader. */
    via?: SensitiveReadVia
    purpose?: string | null
  }): Promise<PersonSensitive> {
    const { workspaceId, personId } = input
    const via = input.via ?? viaFor(input.principal)
    const { value, reader, access } = await this.kernel.database.withWorkspace(workspaceId, async (tx) => {
      // Before the select, so an unattributable reader is refused without the row ever being loaded.
      const reader = await this.audit.readerFor(tx, workspaceId, input.principal, via, input.purpose ?? null)
      const [row] = await tx
        .select()
        .from(peopleSensitive)
        .where(and(eq(peopleSensitive.workspaceId, workspaceId), eq(peopleSensitive.personId, personId)))
        .limit(1)
      const value: PersonSensitive = {
        personId,
        workspaceId,
        nationalId: row?.nationalIdEnc ? this.kernel.secrets.decrypt(row.nationalIdEnc) : null,
        birthDate: row?.birthDate ?? null,
        iban: row?.ibanEnc ? this.kernel.secrets.decrypt(row.ibanEnc) : null,
        emergencyContact: (row?.emergencyContact as PersonSensitive['emergencyContact']) ?? null,
      }
      // `fieldsPresent(value)` and not the columns selected: what is recorded is what came back, so a
      // record holding only a birth date is not filed as though the bank details had been read too.
      const access = [{ personId, fields: fieldsPresent(value) }]
      await this.audit.record(tx, workspaceId, reader, access)
      return { value, reader, access }
    })
    // After the commit, never inside it: a mirror sent from a transaction that then rolled back
    // announces a read that did not happen. The same `access` the row was written from, so the
    // console and the evidence cannot drift apart.
    await this.audit.mirror(workspaceId, reader, access)
    return value
  }

  /** Serialise a row for the wire. Postgres `numeric` arrives as a string; the contract says number. */
  static toPerson(row: PersonRow) {
    return {
      ...row,
      // `status`, `employment_type` and friends are `text` in Postgres and unions in the contract.
      // Narrowing here rather than widening the contract keeps the enum meaningful for every
      // consumer; the column is only ever written from the same union.
      status: row.status as PersonStatus,
      custom: row.custom ?? {},
      // False here and set true by `forViewer` alone, which is the only thing that withholds these
      // fields. A record that never passed through it was never redacted.
      personnelHidden: false,
      erasedAt: row.erasedAt?.toISOString() ?? null,
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
