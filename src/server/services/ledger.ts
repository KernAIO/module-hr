import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { LedgerKind } from '../../contract/index.js'
import { leaveBalanceCursor, leaveLedger, leaveRequestDays, leaveTypes } from '../schema.js'

/**
 * The leave balance, and the concurrency that makes it hard.
 *
 * A balance is `sum(leave_ledger.amount_minutes)`. Reading that is easy. Spending it safely is not:
 * two overlapping requests can both read the same balance, both see enough for the last day, and
 * both succeed — leaving somebody minus a day and nobody able to say which request caused it.
 *
 * Two things stop that, and they are deliberately in the database rather than here:
 *
 * 1. `SELECT … FOR UPDATE` on the person's cursor row serialises spending. The second transaction
 *    waits, re-reads, and sees the first one's consumption.
 * 2. A partial unique index on `(person, date)` for counted days in a live status means the
 *    database refuses to double-book a Tuesday whatever this code believes.
 *
 * Application-level checks alone cannot do either. They are here as well, because a readable error
 * beats a constraint violation — but they are not what makes it correct.
 */

export interface BalanceRow {
  personId: string
  leaveTypeId: string
  periodYear: number
  balanceMinutes: number
  bookedMinutes: number
  pendingMinutes: number
}

/** A minute count in whatever unit the type displays. Hours to one place, days to two. */
export const toUnit = (minutes: number, unit: string): number =>
  unit === 'hour' ? Math.round((minutes / 60) * 10) / 10 : Math.round((minutes / (60 * 8)) * 100) / 100

/** Minutes in one working day. A constant here; a policy in Phase 4, per contract. */
export const MINUTES_PER_DAY = 8 * 60

export class LedgerService {
  /**
   * Balances for one person, per leave type.
   *
   * Summed from the ledger rather than read from the cursor: the cursor exists to be locked, and a
   * cache that is also the source of truth is a cache that eventually disagrees with it. The sum is
   * one indexed aggregate over a person's own rows, which is small.
   */
  async balances(tx: Tx, workspaceId: string, personId: string, periodYear: number) {
    const types = await tx
      .select()
      .from(leaveTypes)
      .where(and(eq(leaveTypes.workspaceId, workspaceId), sql`${leaveTypes.archivedAt} is null`))

    const sums = await tx
      .select({
        leaveTypeId: leaveLedger.leaveTypeId,
        total: sql<number>`coalesce(sum(${leaveLedger.amountMinutes}), 0)::int`,
      })
      .from(leaveLedger)
      .where(
        and(
          eq(leaveLedger.workspaceId, workspaceId),
          eq(leaveLedger.personId, personId),
          eq(leaveLedger.periodYear, periodYear),
        ),
      )
      .groupBy(leaveLedger.leaveTypeId)
    const byType = new Map(sums.map((r) => [r.leaveTypeId, Number(r.total)]))

    // Pending requests are not spent, but they are not available either — showing a balance that
    // ignores them is how somebody books the same day twice and only finds out at approval.
    const pending = await tx
      .select({
        leaveTypeId: sql<string>`lr.leave_type_id`,
        status: sql<string>`lr.status`,
        minutes: sql<number>`coalesce(sum(lr.minutes), 0)::int`,
      })
      .from(sql`${leaveRequestDays} d join mod_hr.leave_requests lr on lr.id = d.request_id`)
      .where(
        sql`d.workspace_id = ${workspaceId} and d.person_id = ${personId}
            and lr.status in ('pending','approved')`,
      )
      .groupBy(sql`lr.leave_type_id, lr.status`)

    const pendingBy = new Map<string, number>()
    const bookedBy = new Map<string, number>()
    for (const row of pending) {
      const target = row.status === 'approved' ? bookedBy : pendingBy
      target.set(row.leaveTypeId, (target.get(row.leaveTypeId) ?? 0) + Number(row.minutes))
    }

    return types.map((type) => {
      const balanceMinutes = byType.get(type.id) ?? 0
      const pendingMinutes = pendingBy.get(type.id) ?? 0
      return {
        personId,
        leaveTypeId: type.id,
        leaveTypeName: type.name,
        unit: type.unit as 'day' | 'half_day' | 'hour',
        periodYear,
        balanceMinutes,
        bookedMinutes: bookedBy.get(type.id) ?? 0,
        pendingMinutes,
        availableMinutes: balanceMinutes - pendingMinutes,
        balance: toUnit(balanceMinutes, type.unit),
        available: toUnit(balanceMinutes - pendingMinutes, type.unit),
      }
    })
  }

  /**
   * Take the lock for one person and leave type, creating the cursor row if it is missing.
   *
   * Everything that *spends* balance must call this first, inside the same transaction. It returns
   * the balance as of the moment the lock was acquired, which is the only balance safe to decide on.
   */
  async lockAndRead(
    tx: Tx,
    workspaceId: string,
    personId: string,
    leaveTypeId: string,
    periodYear: number,
  ): Promise<number> {
    await tx
      .insert(leaveBalanceCursor)
      .values({ id: uuidv7(), workspaceId, personId, leaveTypeId, periodYear })
      .onConflictDoNothing()

    await tx.execute(sql`
      select 1 from ${leaveBalanceCursor}
       where workspace_id = ${workspaceId}
         and person_id = ${personId}
         and leave_type_id = ${leaveTypeId}
         and period_year = ${periodYear}
         for update
    `)

    const [row] = await tx
      .select({ total: sql<number>`coalesce(sum(${leaveLedger.amountMinutes}), 0)::int` })
      .from(leaveLedger)
      .where(
        and(
          eq(leaveLedger.workspaceId, workspaceId),
          eq(leaveLedger.personId, personId),
          eq(leaveLedger.leaveTypeId, leaveTypeId),
          eq(leaveLedger.periodYear, periodYear),
        ),
      )
    return Number(row?.total ?? 0)
  }

  /** Append an entry. The only way anything enters the ledger. */
  async append(
    tx: Tx,
    workspaceId: string,
    entry: {
      personId: string
      leaveTypeId: string
      kind: LedgerKind
      amountMinutes: number
      effectiveOn: string
      periodYear: number
      requestId?: string | null
      reversesEntryId?: string | null
      reason?: string | null
      createdBy?: string | null
      policyHash?: string | null
    },
  ) {
    const [row] = await tx
      .insert(leaveLedger)
      .values({ id: uuidv7(), workspaceId, ...entry })
      .returning()
    await tx
      .update(leaveBalanceCursor)
      .set({
        cachedBalanceMinutes: sql`${leaveBalanceCursor.cachedBalanceMinutes} + ${entry.amountMinutes}`,
        asOfEntryId: row!.id,
        version: sql`${leaveBalanceCursor.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(leaveBalanceCursor.workspaceId, workspaceId),
          eq(leaveBalanceCursor.personId, entry.personId),
          eq(leaveBalanceCursor.leaveTypeId, entry.leaveTypeId),
          eq(leaveBalanceCursor.periodYear, entry.periodYear),
        ),
      )
    return row!
  }

  /**
   * Undo an entry by writing its opposite.
   *
   * Never a delete and never an update. A cancelled request has to leave both the consumption and
   * the reversal visible, because "she booked it and then cancelled" and "she never booked it" are
   * different facts and only one of them is true.
   */
  async reverse(
    tx: Tx,
    workspaceId: string,
    entryId: string,
    reason: string,
    actorId: string | null,
    on: string,
  ) {
    const [original] = await tx
      .select()
      .from(leaveLedger)
      .where(and(eq(leaveLedger.workspaceId, workspaceId), eq(leaveLedger.id, entryId)))
      .limit(1)
    if (!original) throw KernError.notFound('Ledger entry')

    const [already] = await tx
      .select({ id: leaveLedger.id })
      .from(leaveLedger)
      .where(and(eq(leaveLedger.workspaceId, workspaceId), eq(leaveLedger.reversesEntryId, entryId)))
      .limit(1)
    // Reversing twice would credit the balance twice. The check is here rather than in a constraint
    // because a partial unique index on a nullable column is easy to get subtly wrong, and this
    // path is always inside a transaction that already holds the cursor lock.
    if (already) throw KernError.conflict('That entry has already been reversed')

    return this.append(tx, workspaceId, {
      personId: original.personId,
      leaveTypeId: original.leaveTypeId,
      kind: 'reversal',
      amountMinutes: -original.amountMinutes,
      effectiveOn: on,
      periodYear: original.periodYear,
      requestId: original.requestId,
      reversesEntryId: original.id,
      reason,
      createdBy: actorId,
    })
  }

  /** Every entry a request produced, for cancelling it. */
  async entriesFor(tx: Tx, workspaceId: string, requestId: string) {
    return tx
      .select()
      .from(leaveLedger)
      .where(and(eq(leaveLedger.workspaceId, workspaceId), eq(leaveLedger.requestId, requestId)))
  }

  /** Rebuild every cursor from the ledger. Cheap insurance after a bulk import or a bad migration. */
  async rebuildCursors(tx: Tx, workspaceId: string, personIds: string[]) {
    if (!personIds.length) return
    await tx.execute(sql`
      update ${leaveBalanceCursor} c
         set cached_balance_minutes = coalesce(s.total, 0),
             version = c.version + 1,
             updated_at = now()
        from (
          select person_id, leave_type_id, period_year, sum(amount_minutes)::int as total
            from ${leaveLedger}
           where workspace_id = ${workspaceId}
             and person_id in (${sql.join(
               personIds.map((p) => sql`${p}`),
               sql`, `,
             )})
           group by 1, 2, 3
        ) s
       where c.workspace_id = ${workspaceId}
         and c.person_id = s.person_id
         and c.leave_type_id = s.leave_type_id
         and c.period_year = s.period_year
    `)
  }
}

export const yearOf = (isoDate: string): number => Number(isoDate.slice(0, 4))
export { inArray }
