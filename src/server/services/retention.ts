import type { Kernel, Tx } from '@kernhq/kernel'
import { and, count, desc, eq, inArray, lt, not, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  MODULE_ID,
  type RetentionClass,
  type RetentionClassRun,
  type RetentionRun,
} from '../../contract/index.js'
import {
  attendanceDays,
  employments,
  leaveBalanceCursor,
  leaveLedger,
  leaveRequestDays,
  leaveRequests,
  people,
  periods,
  personDocuments,
  personHistory,
  punches,
  retentionRuns,
  sensitiveAccessLog,
} from '../schema.js'
import { todayIso } from './db.js'
import {
  PrivacyService,
  RETENTION_CLASSES,
  type RetentionScope,
  retentionCutoff,
  retentionWhere,
} from './privacy.js'
import type { HrSearchService } from './search.js'

/**
 * The retention sweep: what acts on the horizons `retention_settings` holds.
 *
 * The one unattended act in this module that re-running nothing can undo. Everything else HR does
 * on a timer — accrue, carry forward, close a forgotten shift, remind an approver — writes rows
 * that can be reversed by writing more rows. This deletes. So it is built the way `privacy.erase`
 * is, and then some:
 *
 * - **One predicate per class, shared with the count.** `retentionWhere` in `privacy.ts` is what
 *   the settings screen counts and what this file acts on; there is no third reading of "past the
 *   horizon". `matched` on the run record is therefore the number the screen showed that morning.
 * - **A dry run first, by the same code.** `dryRun` skips the statements that write and nothing
 *   else — the counts, the locked-period check and the person list are computed identically, so a
 *   preview cannot drift from the act. Both are recorded.
 * - **A locked period is never touched.** A punch or a day sheet whose business date falls in a
 *   locked period, for the entity that employed its person on that date, is skipped and counted
 *   as `skippedLocked`. The same question `PolicyService.isLocked` asks, as one SQL predicate so a
 *   sweep over half a million punches asks it per statement rather than per row. Reopen the period
 *   and the next sweep finishes the job; the run record is what says there is a job to finish.
 * - **One transaction per workspace.** Every class commits or none does, and the run record commits
 *   with them — so the report and the act cannot disagree about what happened. A failure rolls the
 *   whole workspace back and is recorded afterwards as a run with an error and no counts.
 * - **Off until turned on.** Nothing here reads the switch: the nightly job asks
 *   `retention_settings.sweep_enabled` before calling `run`, and a manual run is a deliberate act
 *   by somebody holding `hr.privacy.manage`, which needs no switch.
 */

export interface SweepOptions {
  dryRun: boolean
  /** The account that pressed the button, or null for the nightly job. */
  actorUserId: string | null
  /** When the run began, so the record says when it was asked for rather than when it finished. */
  startedAt?: Date
  /** Overridable for a test; the boundary a horizon is measured from. */
  today?: string
}

export interface SweepOutcome {
  run: typeof retentionRuns.$inferSelect
  /**
   * People `terminatedPeople` redacted — the ones whose directory card is a different record now,
   * and the ones a caller has to announce and reindex. Empty on a dry run.
   */
  erasedPersonIds: string[]
}

/** What one class produced, before it is folded into the run. */
interface ClassOutcome {
  matched: number
  affected: number
  skippedLocked: number
  personIds: string[]
  fileIds: string[]
  erasedPersonIds: string[]
}

/** `select count(*)` reduced to the number, which is the only thing any caller here wants. */
const total = async (query: Promise<Array<{ n: number }>>): Promise<number> => (await query)[0]?.n ?? 0

const unique = (ids: Iterable<string | null>): string[] => [
  ...new Set([...ids].filter((id): id is string => !!id)),
]

/**
 * Does this row's business date fall inside a locked period?
 *
 * The same answer `PolicyService.isLocked(tx, ws, on, legalEntityId)` gives, with the legal entity
 * resolved the way that method's callers resolve it: the entity of the employment in force **on
 * that date**, not the one the person is in today — a month filed under an entity somebody has
 * since left must still read as locked. A period with no entity locks the workspace; one with an
 * entity locks only that entity's people, and a person with no entity on that date is locked only
 * by the workspace-wide kind, which is what `p.legal_entity_id = null` evaluating to null gives.
 */
const inLockedPeriod = (workspaceId: string, personId: AnyPgColumn, businessDate: AnyPgColumn) => sql`exists (
  select 1 from ${periods} p
   where p.workspace_id = ${workspaceId}
     and p.status = 'locked'
     and p.starts_on <= ${businessDate}
     and p.ends_on >= ${businessDate}
     and (p.legal_entity_id is null or p.legal_entity_id = (
       select e.legal_entity_id from ${employments} e
        where e.workspace_id = ${workspaceId}
          and e.person_id = ${personId}
          and e.effective_from <= ${businessDate}
          and (e.effective_to is null or e.effective_to >= ${businessDate})
        limit 1)))`

export class RetentionSweep {
  constructor(private readonly privacy: PrivacyService = new PrivacyService()) {}

  /**
   * Sweep one workspace, or say what sweeping it would do. Runs inside the caller's transaction.
   *
   * Classes with no horizon are not visited and not reported: a class kept indefinitely has no
   * "past the horizon" to act on, and listing it with zeros would read as a sweep that found
   * nothing rather than one that was never asked.
   */
  async run(tx: Tx, workspaceId: string, opts: SweepOptions): Promise<SweepOutcome> {
    const startedAt = opts.startedAt ?? new Date()
    const today = opts.today ?? todayIso()
    const { retention } = await this.privacy.retention(tx, workspaceId)

    const classes: RetentionClassRun[] = []
    const personIds = new Set<string>()
    const fileIds = new Set<string>()
    const erasedPersonIds: string[] = []

    for (const cls of RETENTION_CLASSES) {
      const days = retention[cls]
      if (days === null) continue
      const scope: RetentionScope = { workspaceId, cutoff: retentionCutoff(days, today) }
      const out = await this.sweepClass(tx, cls, scope, opts)
      classes.push({
        class: cls,
        days,
        matched: out.matched,
        affected: out.affected,
        skippedLocked: out.skippedLocked,
      })
      for (const id of out.personIds) personIds.add(id)
      for (const id of out.fileIds) fileIds.add(id)
      erasedPersonIds.push(...out.erasedPersonIds)
    }

    const [run] = await tx
      .insert(retentionRuns)
      .values({
        workspaceId,
        startedAt,
        finishedAt: new Date(),
        dryRun: opts.dryRun,
        startedBy: opts.actorUserId,
        perClass: classes,
        personIds: [...personIds],
        fileIds: [...fileIds],
        error: null,
      })
      .returning()
    return { run: run!, erasedPersonIds }
  }

  /**
   * Record a run that threw. Called in a fresh transaction after the sweep's own rolled back: the
   * sweep changed nothing, and a run that changed nothing and left no trace would be a nightly job
   * failing in silence for as long as nobody read the logs.
   */
  async recordFailure(
    tx: Tx,
    workspaceId: string,
    opts: { startedAt: Date; dryRun: boolean; actorUserId: string | null; error: string },
  ): Promise<typeof retentionRuns.$inferSelect> {
    const [run] = await tx
      .insert(retentionRuns)
      .values({
        workspaceId,
        startedAt: opts.startedAt,
        finishedAt: new Date(),
        dryRun: opts.dryRun,
        startedBy: opts.actorUserId,
        perClass: [],
        personIds: [],
        fileIds: [],
        // The message, never the stack: this row is read on a settings screen.
        error: opts.error.slice(0, 2000),
      })
      .returning()
    return run!
  }

  /** Every run, newest first. */
  async list(tx: Tx, workspaceId: string, limit: number) {
    return tx
      .select()
      .from(retentionRuns)
      .where(eq(retentionRuns.workspaceId, workspaceId))
      .orderBy(desc(retentionRuns.startedAt), desc(retentionRuns.id))
      .limit(limit)
  }

  // ------------------------------------------------------------------ per class

  private async sweepClass(
    tx: Tx,
    cls: RetentionClass,
    scope: RetentionScope,
    opts: SweepOptions,
  ): Promise<ClassOutcome> {
    switch (cls) {
      case 'punchDetail':
        return this.punchDetail(tx, scope, opts.dryRun)
      case 'punches':
        return this.punches(tx, scope, opts.dryRun)
      case 'attendanceDays':
        return this.attendanceDays(tx, scope, opts.dryRun)
      case 'leave':
        return this.leave(tx, scope, opts.dryRun)
      case 'personHistory':
        return this.personHistory(tx, scope, opts.dryRun)
      case 'personDocuments':
        return this.personDocuments(tx, scope, opts.dryRun)
      case 'terminatedPeople':
        return this.terminatedPeople(tx, scope, opts)
      case 'sensitiveAccessLog':
        return this.sensitiveAccessLog(tx, scope, opts.dryRun)
    }
  }

  /**
   * The two classes on `punches`, which share the locked-period rule and differ in what they do to
   * an open row: detail clears three columns and keeps the punch, `punches` deletes it.
   */
  private async punchDetail(tx: Tx, scope: RetentionScope, dryRun: boolean): Promise<ClassOutcome> {
    const where = retentionWhere.punchDetail(scope)
    const locked = inLockedPeriod(scope.workspaceId, punches.personId, punches.businessDate)
    const open = and(where, not(locked))
    const matched = await total(tx.select({ n: count() }).from(punches).where(where))
    const skippedLocked = await total(tx.select({ n: count() }).from(punches).where(and(where, locked)))
    if (dryRun) {
      const who = await tx.selectDistinct({ personId: punches.personId }).from(punches).where(open)
      return {
        matched,
        affected: matched - skippedLocked,
        skippedLocked,
        personIds: unique(who.map((r) => r.personId)),
        fileIds: [],
        erasedPersonIds: [],
      }
    }
    const rows = await tx
      .update(punches)
      .set({ geo: null, deviceId: null, note: null })
      .where(open)
      .returning({ personId: punches.personId })
    return {
      matched,
      affected: rows.length,
      skippedLocked,
      personIds: unique(rows.map((r) => r.personId)),
      fileIds: [],
      erasedPersonIds: [],
    }
  }

  private async punches(tx: Tx, scope: RetentionScope, dryRun: boolean): Promise<ClassOutcome> {
    const where = retentionWhere.punches(scope)
    const locked = inLockedPeriod(scope.workspaceId, punches.personId, punches.businessDate)
    const open = and(where, not(locked))
    const matched = await total(tx.select({ n: count() }).from(punches).where(where))
    const skippedLocked = await total(tx.select({ n: count() }).from(punches).where(and(where, locked)))
    if (dryRun) {
      const who = await tx.selectDistinct({ personId: punches.personId }).from(punches).where(open)
      return {
        matched,
        affected: matched - skippedLocked,
        skippedLocked,
        personIds: unique(who.map((r) => r.personId)),
        fileIds: [],
        erasedPersonIds: [],
      }
    }
    const rows = await tx.delete(punches).where(open).returning({ personId: punches.personId })
    return {
      matched,
      affected: rows.length,
      skippedLocked,
      personIds: unique(rows.map((r) => r.personId)),
      fileIds: [],
      erasedPersonIds: [],
    }
  }

  /**
   * Day sheets. The predicate already excludes days flagged `locked`; the period is asked as well,
   * because the flag is a cache of the period's answer and is never believed ahead of it — a day
   * the period locks and the flag has not caught up with is skipped and counted, not deleted.
   */
  private async attendanceDays(tx: Tx, scope: RetentionScope, dryRun: boolean): Promise<ClassOutcome> {
    const where = retentionWhere.attendanceDays(scope)
    const locked = inLockedPeriod(scope.workspaceId, attendanceDays.personId, attendanceDays.businessDate)
    const open = and(where, not(locked))
    const matched = await total(tx.select({ n: count() }).from(attendanceDays).where(where))
    const skippedLocked = await total(
      tx.select({ n: count() }).from(attendanceDays).where(and(where, locked)),
    )
    if (dryRun) {
      const who = await tx
        .selectDistinct({ personId: attendanceDays.personId })
        .from(attendanceDays)
        .where(open)
      return {
        matched,
        affected: matched - skippedLocked,
        skippedLocked,
        personIds: unique(who.map((r) => r.personId)),
        fileIds: [],
        erasedPersonIds: [],
      }
    }
    const rows = await tx.delete(attendanceDays).where(open).returning({ personId: attendanceDays.personId })
    return {
      matched,
      affected: rows.length,
      skippedLocked,
      personIds: unique(rows.map((r) => r.personId)),
      fileIds: [],
      erasedPersonIds: [],
    }
  }

  /**
   * Ledger years that lie wholly before the horizon, with the balance cursors that cached them, and
   * requests that ended before it, with the days behind them.
   *
   * Whole years only, and `retentionWhere` says why: a balance is the sum of one year's ledger, and
   * the carry into the next year is a row in that next year. The cursor rows for a deleted year go
   * with it — a cursor is a cache of a sum that no longer exists, and `lockAndRead` recreates one
   * at zero if anything ever asks for that year again. The days are children of their request and
   * are not counted; `affected` is ledger entries plus requests, which is what `matched` counted.
   */
  private async leave(tx: Tx, scope: RetentionScope, dryRun: boolean): Promise<ClassOutcome> {
    const ledgerWhere = retentionWhere.leaveLedger(scope)
    const requestWhere = retentionWhere.leaveRequests(scope)
    const matched =
      (await total(tx.select({ n: count() }).from(leaveLedger).where(ledgerWhere))) +
      (await total(tx.select({ n: count() }).from(leaveRequests).where(requestWhere)))
    if (dryRun) {
      const ledgerWho = await tx
        .selectDistinct({ personId: leaveLedger.personId })
        .from(leaveLedger)
        .where(ledgerWhere)
      const requestWho = await tx
        .selectDistinct({ personId: leaveRequests.personId })
        .from(leaveRequests)
        .where(requestWhere)
      return {
        matched,
        affected: matched,
        skippedLocked: 0,
        personIds: unique([...ledgerWho, ...requestWho].map((r) => r.personId)),
        fileIds: [],
        erasedPersonIds: [],
      }
    }
    const ledgerRows = await tx
      .delete(leaveLedger)
      .where(ledgerWhere)
      .returning({ personId: leaveLedger.personId })
    await tx
      .delete(leaveBalanceCursor)
      .where(
        and(
          eq(leaveBalanceCursor.workspaceId, scope.workspaceId),
          lt(leaveBalanceCursor.periodYear, Number(scope.cutoff.slice(0, 4))),
        ),
      )
    const requestIds = (
      await tx.select({ id: leaveRequests.id }).from(leaveRequests).where(requestWhere)
    ).map((r) => r.id)
    if (requestIds.length)
      await tx
        .delete(leaveRequestDays)
        .where(
          and(
            eq(leaveRequestDays.workspaceId, scope.workspaceId),
            inArray(leaveRequestDays.requestId, requestIds),
          ),
        )
    const requestRows = await tx
      .delete(leaveRequests)
      .where(requestWhere)
      .returning({ personId: leaveRequests.personId })
    return {
      matched,
      affected: ledgerRows.length + requestRows.length,
      skippedLocked: 0,
      personIds: unique([...ledgerRows, ...requestRows].map((r) => r.personId)),
      fileIds: [],
      erasedPersonIds: [],
    }
  }

  /** The values go, the rows stay — the same reading `privacy.erase` gives this table. */
  private async personHistory(tx: Tx, scope: RetentionScope, dryRun: boolean): Promise<ClassOutcome> {
    const where = retentionWhere.personHistory(scope)
    const matched = await total(tx.select({ n: count() }).from(personHistory).where(where))
    if (dryRun) {
      const who = await tx
        .selectDistinct({ personId: personHistory.personId })
        .from(personHistory)
        .where(where)
      return {
        matched,
        affected: matched,
        skippedLocked: 0,
        personIds: unique(who.map((r) => r.personId)),
        fileIds: [],
        erasedPersonIds: [],
      }
    }
    const rows = await tx
      .update(personHistory)
      .set({ from: null, to: null })
      .where(where)
      .returning({ personId: personHistory.personId })
    return {
      matched,
      affected: rows.length,
      skippedLocked: 0,
      personIds: unique(rows.map((r) => r.personId)),
      fileIds: [],
      erasedPersonIds: [],
    }
  }

  /**
   * The metadata rows go; the files stay in core's storage and their ids go on the run record.
   * `core.files.get` is the only file procedure a module can reach, so this is the most a sweep can
   * honestly do — and recording the ids is what keeps it finishable rather than lost.
   */
  private async personDocuments(tx: Tx, scope: RetentionScope, dryRun: boolean): Promise<ClassOutcome> {
    const where = retentionWhere.personDocuments(scope)
    const matched = await total(tx.select({ n: count() }).from(personDocuments).where(where))
    const rows = dryRun
      ? await tx
          .select({ personId: personDocuments.personId, fileId: personDocuments.fileId })
          .from(personDocuments)
          .where(where)
      : await tx
          .delete(personDocuments)
          .where(where)
          .returning({ personId: personDocuments.personId, fileId: personDocuments.fileId })
    return {
      matched,
      affected: rows.length,
      skippedLocked: 0,
      personIds: unique(rows.map((r) => r.personId)),
      fileIds: unique(rows.map((r) => r.fileId)),
      erasedPersonIds: [],
    }
  }

  /**
   * Everybody who left before the horizon and has not been erased, redacted exactly as
   * `privacy.erase` would redact them — same predicates, same report, same caveats. The national
   * identity number goes: keeping it is a decision a person makes for one erasure, and a horizon
   * that has passed is the workspace having already made the opposite one.
   *
   * One erasure per person, which on a dry run is one round of its counts per person. A workspace
   * with hundreds of leavers past the horizon pays that once, on the night it turns the sweep on.
   */
  private async terminatedPeople(tx: Tx, scope: RetentionScope, opts: SweepOptions): Promise<ClassOutcome> {
    const rows = await tx.select({ id: people.id }).from(people).where(retentionWhere.terminatedPeople(scope))
    const personIds: string[] = []
    const fileIds = new Set<string>()
    for (const { id } of rows) {
      const report = await this.privacy.erase(tx, {
        workspaceId: scope.workspaceId,
        personId: id,
        dryRun: opts.dryRun,
        reason: 'retention-sweep',
        keepNationalIdForAudit: false,
        actorUserId: opts.actorUserId,
      })
      personIds.push(id)
      for (const fileId of report.filesRemaining) fileIds.add(fileId)
    }
    return {
      matched: rows.length,
      affected: rows.length,
      skippedLocked: 0,
      personIds,
      fileIds: [...fileIds],
      erasedPersonIds: opts.dryRun ? [] : personIds,
    }
  }

  private async sensitiveAccessLog(tx: Tx, scope: RetentionScope, dryRun: boolean): Promise<ClassOutcome> {
    const where = retentionWhere.sensitiveAccessLog(scope)
    const matched = await total(tx.select({ n: count() }).from(sensitiveAccessLog).where(where))
    if (dryRun) {
      const who = await tx
        .selectDistinct({ personId: sensitiveAccessLog.personId })
        .from(sensitiveAccessLog)
        .where(where)
      return {
        matched,
        affected: matched,
        skippedLocked: 0,
        personIds: unique(who.map((r) => r.personId)),
        fileIds: [],
        erasedPersonIds: [],
      }
    }
    const rows = await tx
      .delete(sensitiveAccessLog)
      .where(where)
      .returning({ personId: sensitiveAccessLog.personId })
    return {
      matched,
      affected: rows.length,
      skippedLocked: 0,
      personIds: unique(rows.map((r) => r.personId)),
      fileIds: [],
      erasedPersonIds: [],
    }
  }
}

/**
 * What a sweep announces once its transaction has committed — shared by the router and the job.
 *
 * The run itself, always: a dry run is a row the runs list should show without a reload. On a real
 * run, every person `terminatedPeople` redacted is a different directory record now and is
 * announced as one, which also takes them out of the search index; everybody else a row was deleted
 * for gets the change the attendance screens listen to, since punches and day sheets are the
 * classes that move most. After the commit and never inside it: a change pushed for a transaction
 * that then rolled back would blank cards across the workspace for nothing.
 */
export async function announceRetentionSweep(
  kernel: Kernel,
  search: HrSearchService,
  workspaceId: string,
  outcome: SweepOutcome,
): Promise<void> {
  await kernel.realtime.change(workspaceId, {
    module: MODULE_ID,
    entity: 'retention_run',
    id: outcome.run.id,
    op: 'created',
  })
  if (outcome.run.dryRun) return
  const erased = new Set(outcome.erasedPersonIds)
  for (const id of erased) {
    await kernel.realtime.change(workspaceId, { module: MODULE_ID, entity: 'person', id, op: 'updated' })
    await search.reindex(workspaceId, id)
  }
  for (const id of outcome.run.personIds) {
    if (erased.has(id)) continue
    await kernel.realtime.change(workspaceId, {
      module: MODULE_ID,
      entity: 'attendance_day',
      id,
      op: 'updated',
    })
  }
}

/** A stored run in the contract's shape. */
export const toRetentionRun = (row: typeof retentionRuns.$inferSelect): RetentionRun => ({
  id: row.id,
  workspaceId: row.workspaceId as RetentionRun['workspaceId'],
  startedAt: row.startedAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
  dryRun: row.dryRun,
  startedBy: row.startedBy,
  classes: row.perClass as RetentionClassRun[],
  personIds: row.personIds,
  fileIds: row.fileIds,
  error: row.error,
})
