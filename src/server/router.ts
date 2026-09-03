import type { Principal, WorkspaceId } from '@kernhq/contracts'
import {
  KernError,
  type Kernel,
  packageVersion,
  type RequestContext,
  requires,
  requiresCapability,
  type Tx,
  uuidv7,
  workspaceScoped,
} from '@kernhq/kernel'
import { implement } from '@orpc/server'
import {
  and,
  asc,
  type Column,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm'
import {
  type AbsenceBasis,
  HrSettings,
  hrContract,
  hrEvents,
  MODULE_ID,
  type ReportAttribution,
  type ReportSlice,
  type ReportSliceBy,
  type WorkingWeek,
} from '../contract/index.js'
import {
  AccrualConfig,
  CarryForwardConfig,
  OvertimeConfig,
  type PolicyKind,
  RoundingConfig,
  WorkingTimeConfig,
} from '../contract/policies.js'
import { accrueForPeriod } from '../policy/accrual.js'
import { countWorkingDays, datesBetween, workingDays } from '../policy/calendar.js'
import { COUNTRY_PACKS, packDays, packFor } from './packs/index.js'
import {
  approvalChains,
  approvalDecisions,
  approvalRequests,
  approvalSteps,
  attendanceDays,
  calendarDays,
  calendars,
  costCenters,
  customFieldDefs,
  delegations,
  employments,
  leaveLedger,
  leaveRequestDays,
  leaveRequests,
  leaveTypes,
  legalEntities,
  officeAssignments,
  offices,
  orgUnits,
  people,
  peopleSensitive,
  periods,
  personDocuments,
  personHistory,
  policies,
  policyAssignments,
  positions,
  punches,
  regularizations,
  rosterAssignments,
  rosterOverrides,
  rosterPatterns,
  rosterShifts,
  scheduleAssignments,
  schedules,
} from './schema.js'
import { forViewer, HrAccessService, seesRecordOf, visibleSet } from './services/access.js'
import { ApprovalService, type SubjectAppliers } from './services/approvals.js'
import { AttendanceService } from './services/attendance.js'
import { accessLogSort, HrAuditService } from './services/audit.js'
import { inForceOn, todayIso } from './services/db.js'
import {
  assembleExport,
  exportManifest,
  type PayrollExportAssembly,
  type PayrollExportData,
  PayrollExportService,
} from './services/exports.js'
import { LedgerService, MINUTES_PER_DAY, yearOf } from './services/ledger.js'
import { PeopleService } from './services/people.js'
import { hashConfig, PolicyService } from './services/policies.js'
import {
  closingBalance,
  PrivacyService,
  RETENTION_CLASSES,
  stripSensitiveCustom,
} from './services/privacy.js'
import {
  type AbsenceAggregateRow,
  absenceBasis,
  absenceSplit,
  capTotal,
  type DayAggregateRow,
  expectedDaysFor,
  mergeFinality,
  ReportsService,
  rangeRefusal,
  ratio,
  round2,
} from './services/reports.js'
import { DEFAULT_WORKING_WEEK, ResolveService } from './services/resolve.js'
import { type ResolvedRosterDay, RosterService, rosterRefusal } from './services/rosters.js'
import { HrSearchService } from './services/search.js'

const os = implement(hrContract).$context<RequestContext>()

/** Shared so the ordinary case — no sensitive custom fields defined — allocates nothing per page. */
const NO_HIDDEN_FIELDS: ReadonlySet<string> = new Set<string>()

// ---------------------------------------------------------------------- pagination

/**
 * Keyset pagination, shared by every paged list below.
 *
 * `PageInput` has always declared a `cursor` and every handler here answered `nextCursor: null`, so
 * the contract offered pagination the server could not perform: a company with more people than one
 * page had no way of reaching the rest of them, and nothing said so.
 *
 * The cursor carries the last row's sort key **and** its id, because not one of the sort keys here
 * is unique — two people called Ali, four punches in a minute, a whole office starting leave on the
 * same Monday. A cursor on the key alone silently drops everything that ties with the last row on
 * the page, and an offset repeats or skips rows the moment somebody clocks in between two fetches.
 * The id is a uuidv7 in every one of these tables, so it also breaks ties in creation order.
 */
type PageCursor = { key: string; id: string }

const encodeCursor = (key: string, id: string) =>
  Buffer.from(JSON.stringify([key, id]), 'utf8').toString('base64url')

function decodeCursor(raw: string | undefined): PageCursor | null {
  if (!raw) return null
  try {
    const [key, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown[]
    if (typeof key !== 'string' || typeof id !== 'string') throw new Error('malformed cursor')
    return { key, id }
  } catch {
    // A cursor is opaque to the caller, so a broken one is a tampered URL or a bug on our side —
    // never something the reader can fix by asking again. Refusing beats quietly serving page one,
    // which reads as a list that jumps back to the top for no reason anybody can see.
    throw KernError.badRequest('That page cursor is not valid.')
  }
}

/**
 * `(sort, id) > (…)` as one row comparison rather than `sort > k or (sort = k and id > i)`:
 * Postgres can drive a row comparison straight off an index on `(sort, id)` and cannot do that with
 * the `or` spelling. Both halves of the cursor are cast to the column's own type, because an
 * untyped bind parameter beside a `date` or a `timestamptz` is not something to make the planner
 * guess at.
 */
const after = (sort: Column, id: Column, dir: 'asc' | 'desc', c: PageCursor) => {
  const from = sql`(${c.key}::${sql.raw(sort.getSQLType())}, ${c.id}::uuid)`
  return dir === 'asc' ? sql`(${sort}, ${id}) > ${from}` : sql`(${sort}, ${id}) < ${from}`
}

/**
 * Did this error come from one named unique index?
 *
 * The cause chain is walked rather than the error itself, because drizzle wraps what the driver
 * threw and the `code` a duplicate key arrives as — `23505` — is on the pg error underneath. The
 * index name is checked too: a handler that treats *any* duplicate key as its own idempotency
 * replay would silently swallow a collision on some other constraint, which is a bug reported as a
 * success.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const pg = e as { code?: unknown; constraint?: unknown }
    if (pg.code === '23505' && pg.constraint === constraint) return true
  }
  return false
}

/**
 * Cut a page out of the `limit + 1` rows the query asked for.
 *
 * The extra row is how "there is more" is known without a second count, and why a page that happens
 * to fill exactly does not advertise a next page that turns out to be empty.
 *
 * **The key is `string`, never a `Date`, and that is load-bearing.** A `timestamptz` is stored at
 * microsecond precision and node-postgres hands it back as a JS `Date`, which is milliseconds — so
 * a cursor built from the row object is *strictly less* than the value it came from, and
 * `(at, id) < (key, id)` then excludes every row that ties with the last row of the page. That is
 * silent: no error, the list just ends early, and it bites hardest exactly where the id tiebreaker
 * was supposed to save it — one edit writing several rows in a transaction, all sharing `now()`.
 * Measured on `person_history`: five rows in one statement, page size two, page two returned none
 * of the remaining three. A timestamp cursor therefore has to select the value `::text` and pass
 * that, which the type here forces rather than trusts.
 */
function paginate<R>(
  rows: R[],
  limit: number,
  cursorOf: (row: R) => [key: string, id: string],
): { items: R[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null }
  const items = rows.slice(0, limit)
  const [key, id] = cursorOf(items[items.length - 1]!)
  return { items, nextCursor: encodeCursor(key, id) }
}

async function loadCalendar(tx: Tx, workspaceId: string, calendarId: string) {
  const [row] = await tx
    .select()
    .from(calendars)
    .where(and(eq(calendars.workspaceId, workspaceId), eq(calendars.id, calendarId)))
    .limit(1)
  if (!row) throw KernError.notFound('Calendar')
  return row
}

/** The chain nearest-first: this calendar, then whatever it extends. */
async function calendarChain(tx: Tx, workspaceId: string, calendarId: string) {
  const chain: Array<typeof calendars.$inferSelect> = []
  let cursor: string | null = calendarId
  for (let depth = 0; depth < 4 && cursor; depth++) {
    const row = await loadCalendar(tx, workspaceId, cursor)
    chain.push(row)
    cursor = row.extendsId
  }
  return chain
}

/**
 * The composed calendar over a range: this calendar's days over the ones it extends.
 *
 * Nearest wins per date and kind, and a day that shadows one from a calendar further down is
 * marked `overrides` so the editor can show what it is replacing — which is what makes "we work
 * through this national holiday" legible rather than looking like a missing holiday.
 *
 * At module scope, because it never needed the router's closure — only a `tx`. That is what lets
 * `hrSubjects` below reach it, so the leave calculation a deadline runs reads the same calendar as
 * the one a person runs.
 */
export async function composedDays(
  tx: Tx,
  workspaceId: string,
  calendarId: string,
  from: string,
  to: string,
) {
  const chain = await calendarChain(tx, workspaceId, calendarId)
  const rows = await tx
    .select()
    .from(calendarDays)
    .where(
      and(
        eq(calendarDays.workspaceId, workspaceId),
        inArray(
          calendarDays.calendarId,
          chain.map((c) => c.id),
        ),
        gte(calendarDays.date, from),
        lte(calendarDays.date, to),
      ),
    )
  const nameById = new Map(chain.map((c) => [c.id, c.name]))
  const seen = new Map<string, ReturnType<typeof toResolvedDay>>()
  const datesFromNearest = new Set<string>()
  for (const cal of chain) {
    for (const row of rows.filter((r) => r.calendarId === cal.id)) {
      const key = `${row.date}:${row.kind}`
      if (seen.has(key)) continue
      const overrides = cal.id !== calendarId ? false : datesFromNearest.has(row.date)
      seen.set(key, toResolvedDay(row, cal.id, nameById.get(cal.id) ?? '', overrides))
      if (cal.id === calendarId) datesFromNearest.add(row.date)
    }
  }
  // Second pass: a nearest-calendar day covering a date the base also has *is* an override, and
  // the first pass cannot know that until the base has been read.
  const baseDates = new Set(rows.filter((r) => r.calendarId !== calendarId).map((r) => r.date))
  return [...seen.values()]
    .map((d) => ({ ...d, overrides: d.fromCalendarId === calendarId && baseDates.has(d.date) }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * What a *decided* request does to its subject, and the calculation both halves of that stand on.
 *
 * These lived inside `implement_`'s closure, and that is the whole reason `ApprovalService` had
 * appliers only when a person was on the other end of the call: a job cannot reach into a router's
 * closure, so `sweepTimeouts` would advance an intermediate step and then refuse the step that
 * *completes* a request — logging that it had reminded instead. A deadline an administrator set,
 * believed, and told their staff about did nothing on the one step that mattered.
 *
 * So it is a factory both callers can reach: `implement_` below, and `hrJobs` in `jobs.ts`. It is a
 * factory rather than a class because the closure is the point — `applyApproval` needs `simulate`,
 * `simulate` needs the ledger and the composed calendar, and threading those through method
 * arguments would buy nothing.
 *
 * The alternative was a second `simulate` in the job, and it is worth naming why not: two copies of
 * a leave calculation drift, both of them type-check while they drift, and the first sign of it is
 * an employee whose balance disagrees with the days they were granted.
 *
 * Services are passed in rather than constructed here so a caller keeps one instance of each — two
 * `AttendanceService`s is not a bug today and is one cache away from being one.
 */
export function hrSubjects(deps: {
  resolve: ResolveService
  ledger: LedgerService
  attendance: AttendanceService
}) {
  const { resolve, ledger, attendance } = deps

  async function loadRequest(tx: Tx, workspaceId: string, requestId: string) {
    const [row] = await tx
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.workspaceId, workspaceId), eq(leaveRequests.id, requestId)))
      .limit(1)
    if (!row) throw KernError.notFound('Leave request')
    return row
  }

  /**
   * What a request would cost, and every reason it would be refused.
   *
   * Used by `simulate` *and* by `create`, deliberately: a preview that runs different code from the
   * submission is a preview that eventually lies. The blockers are returned rather than thrown here
   * so the screen can show all of them at once instead of one per round trip.
   */
  async function simulate(
    tx: Tx,
    workspaceId: string,
    personId: string,
    input: {
      leaveTypeId: string
      startsOn: string
      endsOn: string
      startPart: 'full' | 'morning' | 'afternoon'
      endPart: 'full' | 'morning' | 'afternoon'
      hours?: number | null
    },
  ) {
    const blockers: Array<{ code: string; message: string }> = []
    if (input.endsOn < input.startsOn)
      blockers.push({ code: 'range', message: 'The end date is before the start date.' })

    const [type] = await tx
      .select()
      .from(leaveTypes)
      .where(and(eq(leaveTypes.workspaceId, workspaceId), eq(leaveTypes.id, input.leaveTypeId)))
      .limit(1)
    if (!type) throw KernError.notFound('Leave type')
    if (type.archivedAt) blockers.push({ code: 'archived', message: `${type.name} is no longer available.` })

    const resolution = await resolve.forPerson(tx, workspaceId, personId, input.startsOn)
    const calendarDaysInRange = resolution.calendarId
      ? await composedDays(tx, workspaceId, resolution.calendarId, input.startsOn, input.endsOn)
      : []

    const results = workingDays(
      input.startsOn,
      input.endsOn,
      resolution.workingWeek,
      type.countsWorkingDaysOnly
        ? calendarDaysInRange.map((d) => ({
            date: d.date,
            name: d.name,
            workingFraction: d.workingFraction,
          }))
        : [],
    )

    // Half-days trim the ends. Applied after the calendar, so asking for a half day on a public
    // holiday still costs nothing rather than costing half of nothing.
    const days = results.map((r) => {
      let fraction = r.fraction
      if (r.date === input.startsOn && input.startPart === 'afternoon') fraction = Math.min(fraction, 0.5)
      if (r.date === input.endsOn && input.endPart === 'morning') fraction = Math.min(fraction, 0.5)
      return { date: r.date, fraction, counted: fraction > 0, reason: r.reason }
    })

    const workingDaysTotal = Math.round(days.reduce((sum, d) => sum + d.fraction, 0) * 100) / 100
    const minutes =
      type.unit === 'hour' && input.hours
        ? Math.round(input.hours * 60)
        : Math.round(workingDaysTotal * MINUTES_PER_DAY)

    if (minutes <= 0)
      blockers.push({
        code: 'empty',
        message: 'That range contains no working days.',
      })

    const year = yearOf(input.startsOn)
    const balances = await ledger.balances(tx, workspaceId, personId, year)
    const balance = balances.find((b) => b.leaveTypeId === input.leaveTypeId)
    const before = balance?.availableMinutes ?? 0
    const after = before - minutes
    if (after < 0 && !type.allowNegative)
      blockers.push({
        code: 'insufficient',
        message: `Not enough ${type.name}: this would leave ${Math.round((after / MINUTES_PER_DAY) * 100) / 100} days.`,
      })
    if (after < 0 && type.allowNegative && Math.abs(after) > type.maxNegativeMinutes)
      blockers.push({
        code: 'below_floor',
        message: `${type.name} cannot go further than ${Math.round(type.maxNegativeMinutes / MINUTES_PER_DAY)} days negative.`,
      })

    // Overlap is refused by a unique index as well; checking here turns a constraint violation into
    // a sentence naming the dates.
    const counted = days.filter((d) => d.counted).map((d) => d.date)
    if (counted.length) {
      const clash = await tx
        .select({ date: leaveRequestDays.date })
        .from(leaveRequestDays)
        .where(
          and(
            eq(leaveRequestDays.workspaceId, workspaceId),
            eq(leaveRequestDays.personId, personId),
            eq(leaveRequestDays.counted, true),
            inArray(leaveRequestDays.status, ['pending', 'approved']),
            inArray(leaveRequestDays.date, counted),
          ),
        )
        .limit(3)
      if (clash.length)
        blockers.push({
          code: 'overlap',
          message: `You already have leave booked on ${clash.map((c) => c.date).join(', ')}.`,
        })
    }

    if (type.requiresDocumentAfterDays !== null && workingDaysTotal > type.requiresDocumentAfterDays)
      blockers.push({
        code: 'document_required',
        message: `${type.name} longer than ${type.requiresDocumentAfterDays} days needs a document.`,
      })

    return {
      workingDays: workingDaysTotal,
      minutes,
      days,
      balanceBeforeMinutes: before,
      balanceAfterMinutes: after,
      blockers,
    }
  }

  /**
   * Turn an approved request into a ledger consumption.
   *
   * The working days are **recomputed here** rather than trusted from submission time: a holiday
   * can be added to the calendar between asking and approving, and the number that costs somebody
   * balance should be the one that was true when it was granted.
   */
  async function applyApproval(tx: Tx, workspaceId: string, leaveRequestId: string, actorId: string | null) {
    const request = await loadRequest(tx, workspaceId, leaveRequestId)
    if (request.status === 'approved') return

    const sim = await simulate(tx, workspaceId, request.personId, {
      leaveTypeId: request.leaveTypeId,
      startsOn: request.startsOn,
      endsOn: request.endsOn,
      startPart: request.startPart as 'full' | 'morning' | 'afternoon',
      endPart: request.endPart as 'full' | 'morning' | 'afternoon',
      hours: request.hours === null ? null : Number.parseFloat(request.hours),
    })

    await ledger.append(tx, workspaceId, {
      personId: request.personId,
      leaveTypeId: request.leaveTypeId,
      kind: 'consumption',
      amountMinutes: -sim.minutes,
      effectiveOn: request.startsOn,
      periodYear: yearOf(request.startsOn),
      requestId: request.id,
      reason: null,
      createdBy: actorId,
    })

    await tx
      .update(leaveRequestDays)
      .set({ status: 'approved' })
      .where(and(eq(leaveRequestDays.workspaceId, workspaceId), eq(leaveRequestDays.requestId, request.id)))
    await tx
      .update(leaveRequests)
      .set({
        status: 'approved',
        minutes: sim.minutes,
        workingDays: String(sim.workingDays),
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(leaveRequests.workspaceId, workspaceId), eq(leaveRequests.id, request.id)))
  }

  /**
   * Everything a punch needs about a person: their zone, and the schedule that shapes their day.
   *
   * The zone comes from the resolution ladder — their primary office unless they have an override —
   * so a punch made on a business trip still counts towards the month they are employed in.
   *
   * Everything here is resolved **as of today**, which is what a punch is about. It is therefore
   * not the place to answer a question about a past date: this used to hand out today's legal
   * entity as well, and three callers applied it to business dates months back — so a person who
   * transferred entity had a filed month recomputed against the one they are in now. `recomputeDay`
   * asks that question of the day it is rebuilding.
   */
  async function personContext(tx: Tx, workspaceId: string, personId: string) {
    const today = todayIso()
    const resolution = await resolve.forPerson(tx, workspaceId, personId, today)
    const schedule = await attendance.scheduleFor(tx, workspaceId, personId, today)
    return { timezone: resolution.timezone, schedule, resolution }
  }

  /**
   * Apply an approved correction: write the proposed punches, void what they replace, rebuild.
   *
   * Nothing is edited. The original punch keeps its row and gains a pointer to what superseded it,
   * so a corrected timesheet and an edited one stay distinguishable — which is the entire reason
   * regularization exists rather than an update statement.
   */
  async function applyRegularization(tx: Tx, workspaceId: string, regularizationId: string) {
    const [row] = await tx
      .select()
      .from(regularizations)
      .where(and(eq(regularizations.workspaceId, workspaceId), eq(regularizations.id, regularizationId)))
      .limit(1)
    if (!row || row.status === 'approved') return

    if (row.punchId) await attendance.voidPunch(tx, workspaceId, row.punchId, 'Regularized', null)

    const { timezone, schedule } = await personContext(tx, workspaceId, row.personId)
    for (const proposal of row.proposed as Array<{ direction: string; at: string }>)
      await tx.insert(punches).values({
        id: uuidv7(),
        workspaceId,
        personId: row.personId,
        direction: proposal.direction,
        at: new Date(proposal.at),
        businessDate: row.businessDate,
        timezone,
        method: 'manual',
        trust: 'trusted',
        note: `Regularization ${row.id}`,
      })

    await attendance.recomputeDay(tx, workspaceId, row.personId, row.businessDate, timezone, schedule)
    await tx
      .update(regularizations)
      .set({ status: 'approved', appliedAt: new Date() })
      .where(and(eq(regularizations.workspaceId, workspaceId), eq(regularizations.id, row.id)))
  }

  /** A rejected request costs no balance and writes no punches; it just stops being live. */
  async function applyLeaveDecision(
    tx: Tx,
    workspaceId: string,
    leaveRequestId: string,
    status: 'approved' | 'rejected',
    actorId: string | null,
  ) {
    if (status === 'approved') return applyApproval(tx, workspaceId, leaveRequestId, actorId)
    await tx
      .update(leaveRequests)
      .set({ status: 'rejected', decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(leaveRequests.workspaceId, workspaceId), eq(leaveRequests.id, leaveRequestId)))
  }

  /** The same, for a correction. */
  async function applyRegularizationDecision(
    tx: Tx,
    workspaceId: string,
    regularizationId: string,
    status: 'approved' | 'rejected',
  ) {
    if (status === 'approved') return applyRegularization(tx, workspaceId, regularizationId)
    await tx
      .update(regularizations)
      .set({ status: 'rejected' })
      .where(and(eq(regularizations.workspaceId, workspaceId), eq(regularizations.id, regularizationId)))
  }

  return {
    loadRequest,
    simulate,
    applyApproval,
    applyRegularization,
    personContext,
    /**
     * The same two functions in the shape `ApprovalService` calls them in, keyed by `subjectType` —
     * the only thing the engine knows about a subject.
     *
     * Parameterised by the actor because that is the one thing the two callers genuinely disagree
     * about: a person approving leave is written onto the ledger entry as `created_by`, and a
     * deadline running out is written as nobody. Passing the approver's id for a timeout would put
     * a name against a decision that person did not make, which is exactly what
     * `TIMEOUT_APPROVER_ID` exists to avoid one table over.
     */
    appliersFor: (actorId: string | null): SubjectAppliers => ({
      leave: (tx, workspaceId, request, status) =>
        applyLeaveDecision(tx, workspaceId, request.subjectId, status, actorId),
      regularization: (tx, workspaceId, request, status) =>
        applyRegularizationDecision(tx, workspaceId, request.subjectId, status),
    }),
  }
}

/**
 * The router.
 *
 * Three middlewares, and `module.test.ts` fails if any is missing where it belongs:
 * `workspaceScoped` (a real membership, HR switched on for that workspace), `requiresCapability`
 * for anything behind a capability, and `requires` for the permission the call needs — in that
 * order, so a workspace with HR off is refused before anything reveals which capabilities it has.
 *
 * Every tenant query runs inside `withWorkspace`, which sets `app.workspace_id` for the transaction.
 * Outside it the RLS policy matches nothing and the query returns no rows — which is the failure
 * mode to expect if a new query mysteriously finds nothing.
 */
export function implement_(kernel: Kernel) {
  const scoped = os.use(workspaceScoped(MODULE_ID))
  const cap = (id: string) => requiresCapability(MODULE_ID, id)
  const resolve = new ResolveService()
  const svc = new PeopleService(kernel)
  const access = new HrAccessService(kernel)
  const ledger = new LedgerService()
  const policySvc = new PolicyService(resolve)
  const attendance = new AttendanceService(resolve, policySvc)
  const subjects = hrSubjects({ resolve, ledger, attendance })
  const { applyApproval, applyRegularization, loadRequest, personContext, simulate } = subjects
  /**
   * The engine gets the appliers here as well as in `jobs.ts`, so the two constructions read the
   * same and stay the same. A sweep started from a request is still nobody's decision, which is why
   * this one is built for no actor — the per-request actor arrives at `decide` below.
   */
  const approvals = new ApprovalService(kernel, subjects.appliersFor(null))
  const privacy = new PrivacyService()
  const reports = new ReportsService(resolve)
  const rosters = new RosterService()
  const payroll = new PayrollExportService(reports)
  const audit = new HrAuditService(kernel, access)
  const search = new HrSearchService(kernel)
  const db = kernel.database
  const settingsOf = (workspaceId: string) => kernel.settings.module(workspaceId, MODULE_ID, HrSettings)

  /**
   * Tell every open screen a row moved — and, for a person, tell the search index too.
   *
   * The index is folded in here rather than called beside each `changed(…, 'person', …)`, because
   * there are seven of those and the eighth would be the one somebody forgets: a directory card
   * that renames on every screen and still answers to the old name in the command palette. Every
   * caller already announces after its transaction has committed, which is the only place an index
   * write may happen — see `HrSearchService.reindex`.
   */
  const changed = async (
    workspaceId: string,
    entity: string,
    id: string,
    op: 'created' | 'updated' | 'deleted',
  ) => {
    await kernel.realtime.change(workspaceId, { module: MODULE_ID, entity, id, op })
    if (entity === 'person') await search.reindex(workspaceId, id)
  }

  return os.router({
    // ================================================================= people
    people: {
      /**
       * The directory: every person in the workspace, and as much of each as the reader may have.
       *
       * `hr.person.view` is a `member` default and stays one — a staff directory a colleague cannot
       * open is a worse product, not a safer one. What the three widening keys decide is how much
       * of each row comes back: `HrAccessService` resolves the people whose *personnel record* this
       * reader may see, and everybody else arrives as a card with the four personnel fields nulled.
       * The filters, the count and the cursor are unaffected — the page is the same page for
       * everybody, which is what keeps `total` honest.
       */
      list: scoped.people.list.use(requires('hr.person.view')).handler(({ input, context }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const visible = visibleSet(await access.visiblePersonIds(tx, input.workspaceId, context.principal))
          const where = [eq(people.workspaceId, input.workspaceId)]
          if (input.q) where.push(ilike(people.displayName, `%${input.q}%`))
          if (input.status?.length) where.push(inArray(people.status, input.status))

          if (input.officeId) {
            const here = await tx
              .select({ personId: officeAssignments.personId })
              .from(officeAssignments)
              .where(
                and(
                  eq(officeAssignments.workspaceId, input.workspaceId),
                  eq(officeAssignments.officeId, input.officeId),
                  isNull(officeAssignments.effectiveTo),
                ),
              )
            // An empty list must match nothing, not everything — `inArray(col, [])` is a false
            // predicate in drizzle, but spelling it out beats relying on that.
            where.push(
              here.length
                ? inArray(
                    people.id,
                    here.map((r) => r.personId),
                  )
                : sql`false`,
            )
          }

          if (input.orgUnitId) {
            const ids = await unitMemberIds(tx, input.workspaceId, input.orgUnitId, input.includeDescendants)
            where.push(ids.length ? inArray(people.id, ids) : sql`false`)
          }

          if (input.positionId) {
            const holders = await tx
              .select({ personId: employments.personId })
              .from(employments)
              .where(
                and(
                  eq(employments.workspaceId, input.workspaceId),
                  eq(employments.positionId, input.positionId),
                  isNull(employments.effectiveTo),
                ),
              )
            where.push(
              holders.length
                ? inArray(
                    people.id,
                    holders.map((r) => r.personId),
                  )
                : sql`false`,
            )
          }

          // The count is of everything the filters match, so it is taken before the cursor narrows
          // the set — `total` is the size of the directory, not of the page being looked at.
          const [total] = await tx
            .select({ n: count() })
            .from(people)
            .where(and(...where))

          const cursor = decodeCursor(input.cursor)
          if (cursor) where.push(after(people.displayName, people.id, 'asc', cursor))
          const { items: rows, nextCursor } = paginate(
            await tx
              .select()
              .from(people)
              .where(and(...where))
              .orderBy(asc(people.displayName), asc(people.id))
              .limit(input.limit + 1),
            input.limit,
            (r) => [r.displayName, r.id],
          )

          // One query for the whole page rather than a resolution per row: a directory of five
          // hundred people would otherwise be five hundred ladder walks.
          const assignments = rows.length
            ? await tx
                .select({
                  personId: officeAssignments.personId,
                  officeId: officeAssignments.officeId,
                  name: offices.name,
                })
                .from(officeAssignments)
                .innerJoin(offices, eq(offices.id, officeAssignments.officeId))
                .where(
                  and(
                    eq(officeAssignments.workspaceId, input.workspaceId),
                    inArray(
                      officeAssignments.personId,
                      rows.map((r) => r.id),
                    ),
                    eq(officeAssignments.isPrimary, true),
                    isNull(officeAssignments.effectiveTo),
                  ),
                )
            : []
          const officeBy = new Map(assignments.map((a) => [a.personId, a]))

          const hidden = await sensitiveCustomKeys(tx, input.workspaceId, context.principal)
          const own = hidden.size ? await access.personIdOf(tx, input.workspaceId, context.principal) : null

          return {
            items: rows.map((r) =>
              forViewer(
                {
                  ...PeopleService.toPerson(r),
                  custom: r.id === own ? (r.custom ?? {}) : stripSensitiveCustom(r.custom ?? {}, hidden),
                  // Spreading into a fresh literal drops the branded WorkspaceId that flowed through
                  // `toPerson`, so it is restored rather than widened to `string`.
                  workspaceId: r.workspaceId as WorkspaceId,
                  officeId: officeBy.get(r.id)?.officeId ?? null,
                  officeName: officeBy.get(r.id)?.name ?? null,
                },
                visible,
              ),
            ),
            nextCursor,
            total: total?.n ?? 0,
          }
        }),
      ),

      /**
       * One person, at the width `people.list` would have shown them.
       *
       * Not a 404 for somebody outside the reader's record scope: the person exists, the directory
       * says so, and answering "no such person" to a colleague looking up a work email would be a
       * lie the whole product contradicts. They get the card.
       */
      get: scoped.people.get.use(requires('hr.person.view')).handler(({ input, context }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const visible = visibleSet(await access.visiblePersonIds(tx, input.workspaceId, context.principal))
          const person = PeopleService.toPerson(await svc.load(tx, input.workspaceId, input.personId))
          const hidden = await sensitiveCustomKeys(tx, input.workspaceId, context.principal)
          const own = hidden.size ? await access.personIdOf(tx, input.workspaceId, context.principal) : null
          return forViewer(
            {
              ...person,
              custom: person.id === own ? person.custom : stripSensitiveCustom(person.custom, hidden),
            },
            visible,
          )
        }),
      ),

      /**
       * No permission check: everybody may read their own record, and a permission nobody can lack
       * is noise in the role editor. Returns null rather than 404 when the signed-in user has no HR
       * record — plenty of members are not employees, and that is an answer, not a failure.
       */
      me: scoped.people.me.handler(({ input, context }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const userId = context.principal.userId
          if (!userId) return null
          const row = await svc.byUserId(tx, input.workspaceId, userId)
          return row ? PeopleService.toPerson(row) : null
        }),
      ),

      create: scoped.people.create.use(requires('hr.person.manage')).handler(async ({ input, context }) => {
        const settings = await settingsOf(input.workspaceId)
        const row = await db.withWorkspace(input.workspaceId, async (tx) => {
          const employeeNo = input.employeeNo ?? (await svc.nextEmployeeNo(input.workspaceId, settings))
          const [person] = await tx
            .insert(people)
            .values({
              id: uuidv7(),
              workspaceId: input.workspaceId,
              userId: input.userId ?? null,
              employeeNo,
              displayName: input.displayName,
              workEmail: input.workEmail ?? null,
              hiredOn: input.hiredOn ?? null,
              status: input.hiredOn && input.hiredOn > todayIso() ? 'onboarding' : 'active',
            })
            .returning()

          const from = input.hiredOn ?? todayIso()
          await svc.changeEmployment(tx, input.workspaceId, person!.id, from, {
            orgUnitId: input.orgUnitId ?? null,
            positionId: input.positionId ?? null,
            managerPersonId: input.managerPersonId ?? null,
            employmentType: input.employmentType,
          })

          // Everybody lands in an office, even when the workspace has never heard the word: the
          // default office is what the calendar, timezone and every policy hang off.
          const office = input.officeId ?? (await resolve.defaultOffice(tx, input.workspaceId))?.id
          if (office) await svc.assignOffice(tx, input.workspaceId, person!.id, office, true, from, 'created')

          await svc.record(tx, input.workspaceId, person!.id, context.principal.userId ?? null, [
            { field: 'created', from: null, to: input.displayName },
          ])
          return person!
        })

        await kernel.emit(
          hrEvents.personCreated,
          { personId: row.id, workspaceId: input.workspaceId, userId: row.userId },
          { workspaceId: input.workspaceId, actorId: context.principal.userId },
        )
        await changed(input.workspaceId, 'person', row.id, 'created')
        return PeopleService.toPerson(row)
      }),

      update: scoped.people.update.use(requires('hr.person.manage')).handler(async ({ input, context }) => {
        const { workspaceId, personId, ...patch } = input
        const row = await db.withWorkspace(workspaceId, async (tx) => {
          const before = await svc.load(tx, workspaceId, personId)
          // `custom` replaces the whole map — and `people.get` handed this writer the map *without*
          // the sensitive keys they may not read, so a form that sends back what it was shown
          // would erase every sensitive value on the record. Those keys are carried over from the
          // row unless the patch names them itself.
          if (patch.custom) {
            const hidden = await sensitiveCustomKeys(tx, workspaceId, context.principal)
            if (hidden.size) {
              const kept = before.custom ?? {}
              for (const key of hidden)
                if (key in kept && !(key in patch.custom)) patch.custom[key] = kept[key]
            }
          }
          const set: Record<string, unknown> = { updatedAt: new Date() }
          const history: Array<{ field: string; from: unknown; to: unknown }> = []
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) continue
            set[k] = v
            history.push({ field: k, from: (before as Record<string, unknown>)[k] ?? null, to: v })
          }
          const [updated] = await tx
            .update(people)
            .set(set)
            .where(and(eq(people.workspaceId, workspaceId), eq(people.id, personId)))
            .returning()
          await svc.record(tx, workspaceId, personId, context.principal.userId ?? null, history)
          return { updated: updated!, fields: history.map((h) => h.field) }
        })
        await kernel.emit(
          hrEvents.personUpdated,
          { personId, workspaceId, fields: row.fields },
          { workspaceId, actorId: context.principal.userId },
        )
        await changed(workspaceId, 'person', personId, 'updated')
        return PeopleService.toPerson(row.updated)
      }),

      /**
       * Ends employment and keeps the record. A terminated person is history, not a deletion.
       *
       * The reason the dialog collects is written to `person_history` rather than to a column on
       * `people`: "why did she leave" is a fact about the *event*, it is asked for by an audit
       * alongside who ended the employment and when, and `person_history` is the append-only table
       * that already answers exactly that question. It used to be accepted and dropped on the
       * floor, which is the one thing an offboarding record must not do.
       */
      offboard: scoped.people.offboard
        .use(requires('hr.person.manage'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const before = await svc.load(tx, input.workspaceId, input.personId)
            const [updated] = await tx
              .update(people)
              .set({ status: 'terminated', terminatedOn: input.on, updatedAt: new Date() })
              .where(and(eq(people.workspaceId, input.workspaceId), eq(people.id, input.personId)))
              .returning()
            await tx
              .update(employments)
              .set({ effectiveTo: input.on })
              .where(
                and(
                  eq(employments.workspaceId, input.workspaceId),
                  eq(employments.personId, input.personId),
                  isNull(employments.effectiveTo),
                ),
              )
            await tx
              .update(officeAssignments)
              .set({ effectiveTo: input.on })
              .where(
                and(
                  eq(officeAssignments.workspaceId, input.workspaceId),
                  eq(officeAssignments.personId, input.personId),
                  isNull(officeAssignments.effectiveTo),
                ),
              )
            const reason = input.reason?.trim()
            await svc.record(tx, input.workspaceId, input.personId, context.principal.userId ?? null, [
              { field: 'status', from: before.status, to: 'terminated' },
              { field: 'terminatedOn', from: before.terminatedOn, to: input.on },
              // Only when there is one. A row saying the reason changed from nothing to nothing is
              // noise in the trail somebody reads to find out what happened.
              ...(reason ? [{ field: 'terminationReason', from: null, to: reason }] : []),
            ])
            return { before, updated: updated! }
          })
          await kernel.emit(
            hrEvents.personStatusChanged,
            {
              personId: input.personId,
              workspaceId: input.workspaceId,
              from: row.before.status,
              to: 'terminated',
              on: input.on,
            },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return PeopleService.toPerson(row.updated)
        }),

      /**
       * The audit trail, and the reason redacting the record alone would have been theatre.
       *
       * Every row carries the old and new *value* of a field — so `personalEmail`, `phone` and
       * `hiredOn` are all in here, in plain sight, for anybody who can list the history. It is a
       * personnel read however narrow the query looks, and it is refused for somebody whose record
       * the reader may not see. No permission is named on the refusal: three different keys would
       * each have opened it, and naming one of them would send the reader to ask for the wrong one.
       */
      history: scoped.people.history.use(requires('hr.person.view')).handler(({ input, context }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const visible = visibleSet(await access.visiblePersonIds(tx, input.workspaceId, context.principal))
          if (!seesRecordOf(visible, input.personId)) throw KernError.forbidden()
          const where = [
            eq(personHistory.workspaceId, input.workspaceId),
            eq(personHistory.personId, input.personId),
          ]
          // The id tiebreaker earns its keep here more than anywhere: one edit writes several rows
          // in one statement, and `now()` is frozen for a transaction, so they all share an `at`.
          const cursor = decodeCursor(input.cursor)
          if (cursor) where.push(after(personHistory.at, personHistory.id, 'desc', cursor))
          const { items: rows, nextCursor } = paginate(
            // `atText` rather than the `Date`: see `paginate`. `now()` is frozen for a transaction,
            // so a single edit's rows all share an `at` to the microsecond, and a millisecond cursor
            // would drop every one of them after the first page.
            await tx
              .select({ ...getTableColumns(personHistory), atText: sql<string>`${personHistory.at}::text` })
              .from(personHistory)
              .where(and(...where))
              .orderBy(desc(personHistory.at), desc(personHistory.id))
              .limit(input.limit + 1),
            input.limit,
            (r) => [r.atText, r.id],
          )
          return {
            items: rows.map((r) => ({
              id: r.id,
              field: r.field,
              from: r.from ?? null,
              to: r.to ?? null,
              at: r.at.toISOString(),
              actorId: r.actorId,
              source: r.source,
            })),
            nextCursor,
          }
        }),
      ),

      sensitive: {
        /**
         * Through `readSensitive`, not inline — this is the whole point of that method.
         *
         * It decrypts and writes the `sensitive_access_log` row in one transaction, so the read
         * cannot happen without being recorded. Decrypting here instead left the log recording
         * *exports* and nothing else: the one procedure that exists to read these fields was the
         * one procedure not logging them, and a subject-access answer built on that would have
         * stated in writing that nobody had opened her bank details.
         */
        get: scoped.people.sensitive.get
          .use(requires('hr.person.view_sensitive'))
          .handler(({ input, context }) =>
            svc.readSensitive({
              workspaceId: input.workspaceId,
              personId: input.personId,
              principal: context.principal,
            }),
          ),

        update: scoped.people.sensitive.update
          .use(requires('hr.person.manage_sensitive'))
          .handler(async ({ input, context }) => {
            const { workspaceId, personId } = input
            await db.withWorkspace(workspaceId, async (tx) => {
              const set: Record<string, unknown> = { workspaceId, personId, updatedAt: new Date() }
              if (input.nationalId !== undefined)
                set.nationalIdEnc = input.nationalId ? await kernel.secrets.encrypt(input.nationalId) : null
              if (input.iban !== undefined)
                set.ibanEnc = input.iban ? await kernel.secrets.encrypt(input.iban) : null
              if (input.birthDate !== undefined) set.birthDate = input.birthDate
              if (input.emergencyContact !== undefined) set.emergencyContact = input.emergencyContact
              await tx
                .insert(peopleSensitive)
                .values(set as never)
                .onConflictDoUpdate({ target: peopleSensitive.personId, set })
              // The values never enter the audit trail — only that they changed. An audit log that
              // records a national identity number defeats the reason this table is separate.
              await svc.record(tx, workspaceId, personId, context.principal.userId ?? null, [
                { field: 'sensitive', from: null, to: Object.keys(input).filter((k) => k !== 'workspaceId') },
              ])
            })
            return {
              personId,
              workspaceId,
              nationalId: input.nationalId ?? null,
              birthDate: input.birthDate ?? null,
              iban: input.iban ?? null,
              emergencyContact: (input.emergencyContact as never) ?? null,
            }
          }),
      },
    },

    // ================================================================= employment
    employment: {
      current: scoped.employment.current.use(requires('hr.employment.view')).handler(({ input }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const on = input.on ?? todayIso()
          const [row] = await tx
            .select()
            .from(employments)
            .where(
              and(
                eq(employments.workspaceId, input.workspaceId),
                eq(employments.personId, input.personId),
                inForceOn(employments.effectiveFrom, employments.effectiveTo, on),
              ),
            )
            .limit(1)
          return row ? PeopleService.toEmployment(row) : null
        }),
      ),

      history: scoped.employment.history.use(requires('hr.employment.view')).handler(({ input }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const rows = await tx
            .select()
            .from(employments)
            .where(
              and(eq(employments.workspaceId, input.workspaceId), eq(employments.personId, input.personId)),
            )
            .orderBy(desc(employments.effectiveFrom))
          return rows.map(PeopleService.toEmployment)
        }),
      ),

      change: scoped.employment.change
        .use(requires('hr.employment.manage'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, (tx) =>
            svc.changeEmployment(tx, input.workspaceId, input.personId, input.effectiveFrom, {
              orgUnitId: input.orgUnitId ?? undefined,
              positionId: input.positionId ?? undefined,
              legalEntityId: input.legalEntityId ?? undefined,
              costCenterId: input.costCenterId ?? undefined,
              managerPersonId: input.managerPersonId ?? undefined,
              employmentType: input.employmentType,
              fte: input.fte === undefined ? undefined : String(input.fte),
              contractHoursWeek:
                input.contractHoursWeek === undefined || input.contractHoursWeek === null
                  ? undefined
                  : String(input.contractHoursWeek),
              reason: input.reason ?? null,
            }),
          )
          await kernel.emit(
            hrEvents.employmentChanged,
            {
              personId: input.personId,
              workspaceId: input.workspaceId,
              employmentId: row.id,
              effectiveFrom: input.effectiveFrom,
            },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return PeopleService.toEmployment(row)
        }),
    },

    // ================================================================= org
    org: {
      units: {
        tree: scoped.org.units.tree.use(requires('hr.org.view')).handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(orgUnits.workspaceId, input.workspaceId)]
            if (!input.includeArchived) where.push(isNull(orgUnits.archivedAt))
            const rows = await tx
              .select()
              .from(orgUnits)
              .where(and(...where))
              .orderBy(asc(orgUnits.path))
            // Headcount per unit in one grouped query rather than one per node: an org chart with
            // two hundred departments would otherwise be two hundred round trips to draw.
            const counts = await tx
              .select({ unitId: employments.orgUnitId, n: count() })
              .from(employments)
              .where(and(eq(employments.workspaceId, input.workspaceId), isNull(employments.effectiveTo)))
              .groupBy(employments.orgUnitId)
            const byUnit = new Map(counts.map((c) => [c.unitId, c.n]))
            return rows.map((r) => ({
              ...r,
              archivedAt: r.archivedAt?.toISOString() ?? null,
              headcount: byUnit.get(r.id) ?? 0,
            }))
          }),
        ),

        create: scoped.org.units.create.use(requires('hr.org.manage')).handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const id = uuidv7()
            const path = await childPath(tx, input.workspaceId, input.parentId ?? null, id)
            const [created] = await tx
              .insert(orgUnits)
              .values({
                id,
                workspaceId: input.workspaceId,
                parentId: input.parentId ?? null,
                path,
                name: input.name,
                code: input.code ?? null,
                headPersonId: input.headPersonId ?? null,
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'org_unit', row.id, 'created')
          return { ...row, archivedAt: null }
        }),

        update: scoped.org.units.update.use(requires('hr.org.manage')).handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const set: Record<string, unknown> = { updatedAt: new Date() }
            if (input.name !== undefined) set.name = input.name
            if (input.code !== undefined) set.code = input.code
            if (input.headPersonId !== undefined) set.headPersonId = input.headPersonId
            const [updated] = await tx
              .update(orgUnits)
              .set(set)
              .where(and(eq(orgUnits.workspaceId, input.workspaceId), eq(orgUnits.id, input.unitId)))
              .returning()
            if (!updated) throw KernError.notFound('Department')
            return updated
          })
          await changed(input.workspaceId, 'org_unit', row.id, 'updated')
          return { ...row, archivedAt: row.archivedAt?.toISOString() ?? null }
        }),

        /**
         * Reparent a unit and rewrite the ltree path of everything beneath it.
         *
         * One `UPDATE` over the subtree rather than a walk, and it refuses to move a unit under its
         * own descendant — which would detach that whole branch from the root and is the one way an
         * ltree hierarchy can be corrupted beyond repair by an ordinary drag.
         */
        move: scoped.org.units.move.use(requires('hr.org.manage')).handler(async ({ input }) => {
          const rows = await db.withWorkspace(input.workspaceId, async (tx) => {
            const [unit] = await tx
              .select()
              .from(orgUnits)
              .where(and(eq(orgUnits.workspaceId, input.workspaceId), eq(orgUnits.id, input.unitId)))
              .limit(1)
            if (!unit) throw KernError.notFound('Department')

            const newParentPath = await parentPath(tx, input.workspaceId, input.parentId)
            if (input.parentId) {
              const [target] = await tx
                .select({ path: orgUnits.path })
                .from(orgUnits)
                .where(and(eq(orgUnits.workspaceId, input.workspaceId), eq(orgUnits.id, input.parentId)))
                .limit(1)
              if (!target) throw KernError.notFound('Department')
              if (target.path === unit.path || target.path.startsWith(`${unit.path}.`))
                throw KernError.badRequest('A department cannot be moved underneath itself.')
            }

            const label = unit.path.split('.').pop()!
            const nextPath = newParentPath ? `${newParentPath}.${label}` : label
            await tx.execute(sql`
              update ${orgUnits}
                 set path = ${nextPath}::ltree || subpath(path, nlevel(${unit.path}::ltree)),
                     updated_at = now()
               where workspace_id = ${input.workspaceId}
                 and path <@ ${unit.path}::ltree
            `)
            await tx
              .update(orgUnits)
              .set({ parentId: input.parentId })
              .where(and(eq(orgUnits.workspaceId, input.workspaceId), eq(orgUnits.id, input.unitId)))

            return tx
              .select()
              .from(orgUnits)
              .where(and(eq(orgUnits.workspaceId, input.workspaceId), sql`path <@ ${nextPath}::ltree`))
              .orderBy(asc(orgUnits.path))
          })
          await changed(input.workspaceId, 'org_unit', input.unitId, 'updated')
          return rows.map((r) => ({ ...r, archivedAt: r.archivedAt?.toISOString() ?? null }))
        }),

        archive: scoped.org.units.archive.use(requires('hr.org.manage')).handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const [held] = await tx
              .select({ n: count() })
              .from(employments)
              .where(
                and(
                  eq(employments.workspaceId, input.workspaceId),
                  eq(employments.orgUnitId, input.unitId),
                  isNull(employments.effectiveTo),
                ),
              )
            if ((held?.n ?? 0) > 0)
              throw KernError.conflict(
                `${held?.n} people still report into this department. Move them first.`,
              )
            await tx
              .update(orgUnits)
              .set({ archivedAt: new Date() })
              .where(and(eq(orgUnits.workspaceId, input.workspaceId), eq(orgUnits.id, input.unitId)))
          })
          await changed(input.workspaceId, 'org_unit', input.unitId, 'deleted')
          return { ok: true as const }
        }),
      },

      positions: {
        list: scoped.org.positions.list.use(requires('hr.org.view')).handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(positions.workspaceId, input.workspaceId)]
            if (!input.includeArchived) where.push(isNull(positions.archivedAt))
            const rows = await tx
              .select()
              .from(positions)
              .where(and(...where))
              .orderBy(asc(positions.title))
            return rows.map((r) => ({ ...r, archivedAt: r.archivedAt?.toISOString() ?? null }))
          }),
        ),
        create: scoped.org.positions.create.use(requires('hr.org.manage')).handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const [created] = await tx
              .insert(positions)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                title: input.title,
                code: input.code ?? null,
                jobFamily: input.jobFamily ?? null,
                level: input.level ?? null,
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'position', row.id, 'created')
          return { ...row, archivedAt: null }
        }),
        update: scoped.org.positions.update.use(requires('hr.org.manage')).handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const set: Record<string, unknown> = {}
            if (input.title !== undefined) set.title = input.title
            if (input.code !== undefined) set.code = input.code
            if (input.jobFamily !== undefined) set.jobFamily = input.jobFamily
            if (input.level !== undefined) set.level = input.level
            const [updated] = await tx
              .update(positions)
              .set(set)
              .where(and(eq(positions.workspaceId, input.workspaceId), eq(positions.id, input.positionId)))
              .returning()
            if (!updated) throw KernError.notFound('Position')
            return updated
          })
          await changed(input.workspaceId, 'position', row.id, 'updated')
          return { ...row, archivedAt: row.archivedAt?.toISOString() ?? null }
        }),
        archive: scoped.org.positions.archive.use(requires('hr.org.manage')).handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, (tx) =>
            tx
              .update(positions)
              .set({ archivedAt: new Date() })
              .where(and(eq(positions.workspaceId, input.workspaceId), eq(positions.id, input.positionId))),
          )
          await changed(input.workspaceId, 'position', input.positionId, 'deleted')
          return { ok: true as const }
        }),
      },
    },

    // ================================================================= offices
    offices: {
      list: scoped.offices.list
        .use(cap('offices'))
        .use(requires('hr.office.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(offices.workspaceId, input.workspaceId)]
            if (!input.includeArchived) where.push(isNull(offices.archivedAt))
            const rows = await tx
              .select()
              .from(offices)
              .where(and(...where))
              .orderBy(desc(offices.isDefault), asc(offices.name))
            const counts = await tx
              .select({ officeId: officeAssignments.officeId, n: count() })
              .from(officeAssignments)
              .where(
                and(
                  eq(officeAssignments.workspaceId, input.workspaceId),
                  eq(officeAssignments.isPrimary, true),
                  isNull(officeAssignments.effectiveTo),
                ),
              )
              .groupBy(officeAssignments.officeId)
            const byOffice = new Map(counts.map((c) => [c.officeId, c.n]))
            return rows.map((r) => ({ ...toOffice(r), headcount: byOffice.get(r.id) ?? 0 }))
          }),
        ),

      get: scoped.offices.get
        .use(cap('offices'))
        .use(requires('hr.office.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => toOffice(await loadOffice(tx, input))),
        ),

      create: scoped.offices.create
        .use(cap('offices'))
        .use(requires('hr.office.manage'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            let calendarId: string | null = null
            if (input.seedCalendarFromPack) {
              // The office's own calendar *extends* the country pack rather than copying it, so a
              // pack refresh reaches this office without reconciling a copy — and days HR add here
              // stay `custom` and survive that refresh untouched.
              const base = await packCalendar(tx, input.workspaceId, input.country)
              const [own] = await tx
                .insert(calendars)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  name: input.name,
                  extendsId: base?.id ?? null,
                  country: input.country,
                  region: input.region ?? null,
                  workingWeek: (base?.workingWeek as Record<string, number>) ?? DEFAULT_WORKING_WEEK,
                  source: 'custom',
                })
                .returning()
              calendarId = own!.id
            }
            const [created] = await tx
              .insert(offices)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                name: input.name,
                kind: input.kind,
                code: input.code ?? null,
                parentOfficeId: input.parentOfficeId ?? null,
                legalEntityId: input.legalEntityId ?? null,
                country: input.country,
                region: input.region ?? null,
                city: input.city ?? null,
                timezone: input.timezone,
                calendarId,
                isDefault: false,
              })
              .returning()
            return created!
          })
          await kernel.emit(
            hrEvents.officeCreated,
            { officeId: row.id, workspaceId: input.workspaceId, country: row.country },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'office', row.id, 'created')
          return toOffice(row)
        }),

      update: scoped.offices.update
        .use(cap('offices'))
        .use(requires('hr.office.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const { workspaceId, officeId, ...patch } = input
            const set: Record<string, unknown> = { updatedAt: new Date() }
            for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v
            const [updated] = await tx
              .update(offices)
              .set(set)
              .where(and(eq(offices.workspaceId, workspaceId), eq(offices.id, officeId)))
              .returning()
            if (!updated) throw KernError.notFound('Office')
            return updated
          })
          await changed(input.workspaceId, 'office', row.id, 'updated')
          return toOffice(row)
        }),

      archive: scoped.offices.archive
        .use(cap('offices'))
        .use(requires('hr.office.manage'))
        .handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const office = await loadOffice(tx, input)
            // The default office is where everyone without an assignment lands and where the
            // resolution ladder bottoms out. Archiving it would leave people with no calendar and no
            // timezone, so it has to be handed over first.
            if (office.isDefault)
              throw KernError.conflict(
                'This is the default office. Make another office the default before archiving it.',
              )
            const [held] = await tx
              .select({ n: count() })
              .from(officeAssignments)
              .where(
                and(
                  eq(officeAssignments.workspaceId, input.workspaceId),
                  eq(officeAssignments.officeId, input.officeId),
                  isNull(officeAssignments.effectiveTo),
                ),
              )
            if ((held?.n ?? 0) > 0)
              throw KernError.conflict(`${held?.n} people still work here. Move them first.`)
            await tx
              .update(offices)
              .set({ archivedAt: new Date() })
              .where(and(eq(offices.workspaceId, input.workspaceId), eq(offices.id, input.officeId)))
          })
          await changed(input.workspaceId, 'office', input.officeId, 'deleted')
          return { ok: true as const }
        }),

      setDefault: scoped.offices.setDefault
        .use(cap('offices'))
        .use(requires('hr.office.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            // Clear first, then set. A partial unique index enforces one default per workspace, so
            // the other order fails on the constraint rather than doing the obvious thing.
            await tx
              .update(offices)
              .set({ isDefault: false })
              .where(and(eq(offices.workspaceId, input.workspaceId), eq(offices.isDefault, true)))
            const [updated] = await tx
              .update(offices)
              .set({ isDefault: true, updatedAt: new Date() })
              .where(and(eq(offices.workspaceId, input.workspaceId), eq(offices.id, input.officeId)))
              .returning()
            if (!updated) throw KernError.notFound('Office')
            return updated
          })
          await changed(input.workspaceId, 'office', row.id, 'updated')
          return toOffice(row)
        }),

      /**
       * The office's people, and its headcount.
       *
       * One join rather than the two round trips this used to be. The old shape limited the
       * *assignments* and then sorted the people it had fetched, so a page was an arbitrary subset
       * put in alphabetical order — and it reported `rows.length` as `total`, which told an office
       * of forty that it had twenty as soon as one page stopped holding everybody. The headcount is
       * counted now, over the same predicate and without the cursor.
       */
      people: scoped.offices.people
        .use(cap('offices'))
        .use(requires('hr.office.view'))
        .handler(({ input, context }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            // An office roster is the directory filtered to one place, so it is read at the same
            // width — `hr.office.view` is a `member` default too, and returning whole records here
            // would be a way round `people.list` rather than a different question.
            const visible = visibleSet(
              await access.visiblePersonIds(tx, input.workspaceId, context.principal),
            )
            const here = and(
              eq(people.id, officeAssignments.personId),
              eq(people.workspaceId, officeAssignments.workspaceId),
            )
            // As of today, not "the row with no end date" — the same predicate `HrAccessService`
            // uses, and they have to agree because both answer this one screen. An office move and
            // an offboarding are both *dated*: `people.offboard` writes a last working day that is
            // normally in the future, so a null-end-date test drops somebody the moment their
            // leaving is recorded, while a future-dated transfer adds them weeks early. The roster
            // showed one set and the record scope another, on the same response.
            const where = [
              eq(officeAssignments.workspaceId, input.workspaceId),
              eq(officeAssignments.officeId, input.officeId),
              inForceOn(officeAssignments.effectiveFrom, officeAssignments.effectiveTo, todayIso()),
            ]
            if (input.primaryOnly) where.push(eq(officeAssignments.isPrimary, true))

            const [total] = await tx
              .select({ n: count() })
              .from(officeAssignments)
              .innerJoin(people, here)
              .where(and(...where))

            const cursor = decodeCursor(input.cursor)
            if (cursor) where.push(after(people.displayName, people.id, 'asc', cursor))
            const { items: rows, nextCursor } = paginate(
              await tx
                .select({ person: people, isPrimary: officeAssignments.isPrimary })
                .from(officeAssignments)
                .innerJoin(people, here)
                .where(and(...where))
                .orderBy(asc(people.displayName), asc(people.id))
                .limit(input.limit + 1),
              input.limit,
              (r) => [r.person.displayName, r.person.id],
            )

            return {
              items: rows.map((r) =>
                forViewer(
                  {
                    ...PeopleService.toPerson(r.person),
                    // Migration 0001 allows one open assignment per person per office, so the join
                    // cannot produce a person twice and this flag cannot disagree with itself.
                    isPrimaryHere: r.isPrimary,
                  },
                  visible,
                ),
              ),
              nextCursor,
              total: total?.n ?? 0,
            }
          }),
        ),

      assign: scoped.offices.assign
        .use(cap('offices'))
        .use(requires('hr.office.assign'))
        .handler(async ({ input, context }) => {
          const rows = await db.withWorkspace(input.workspaceId, async (tx) => {
            await loadOffice(tx, input)
            return svc.assignOffice(
              tx,
              input.workspaceId,
              input.personId,
              input.officeId,
              input.isPrimary,
              input.effectiveFrom,
              input.reason ?? null,
            )
          })
          await kernel.emit(
            hrEvents.officeAssignmentChanged,
            {
              personId: input.personId,
              workspaceId: input.workspaceId,
              officeId: input.officeId,
              isPrimary: input.isPrimary,
              effectiveFrom: input.effectiveFrom,
            },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return rows.map(PeopleService.toAssignment)
        }),

      unassign: scoped.offices.unassign
        .use(cap('offices'))
        .use(requires('hr.office.assign'))
        .handler(async ({ input, context }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const [row] = await tx
              .select()
              .from(officeAssignments)
              .where(
                and(
                  eq(officeAssignments.workspaceId, input.workspaceId),
                  eq(officeAssignments.officeId, input.officeId),
                  eq(officeAssignments.personId, input.personId),
                  isNull(officeAssignments.effectiveTo),
                ),
              )
              .limit(1)
            if (!row) throw KernError.notFound('Office assignment')
            // Removing somebody's *primary* office leaves them with no calendar, no timezone and no
            // policy — a person in that state is what the resolution ladder cannot answer for. Make
            // another office primary first.
            if (row.isPrimary)
              throw KernError.conflict(
                'This is their primary office. Assign another office as primary first.',
              )
            await tx
              .update(officeAssignments)
              .set({ effectiveTo: input.effectiveTo })
              .where(eq(officeAssignments.id, row.id))
          })
          await kernel.emit(
            hrEvents.officeAssignmentChanged,
            {
              personId: input.personId,
              workspaceId: input.workspaceId,
              officeId: input.officeId,
              isPrimary: false,
              effectiveFrom: input.effectiveTo,
            },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return { ok: true as const }
        }),

      /**
       * Not behind the `offices` capability, deliberately.
       *
       * A workspace with one office still has a ladder, and this is the first thing anybody reaches
       * for when a holiday or a timezone looks wrong. Gating it on the capability would mean the
       * support answer is only available to workspaces that already understand the model.
       */
      resolveFor: scoped.offices.resolveFor
        .use(requires('hr.person.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, (tx) =>
            resolve.forPerson(tx, input.workspaceId, input.personId, input.on),
          ),
        ),
    },

    // ================================================================= legal entities
    entities: {
      list: scoped.entities.list
        .use(cap('legal_entities'))
        .use(requires('hr.entity.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(legalEntities.workspaceId, input.workspaceId)]
            if (!input.includeArchived) where.push(isNull(legalEntities.archivedAt))
            const rows = await tx
              .select()
              .from(legalEntities)
              .where(and(...where))
              .orderBy(asc(legalEntities.name))
            return rows.map(toEntity)
          }),
        ),
      get: scoped.entities.get
        .use(cap('legal_entities'))
        .use(requires('hr.entity.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const [row] = await tx
              .select()
              .from(legalEntities)
              .where(
                and(eq(legalEntities.workspaceId, input.workspaceId), eq(legalEntities.id, input.entityId)),
              )
              .limit(1)
            if (!row) throw KernError.notFound('Legal entity')
            return toEntity(row)
          }),
        ),
      create: scoped.entities.create
        .use(cap('legal_entities'))
        .use(requires('hr.entity.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const [created] = await tx
              .insert(legalEntities)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                name: input.name,
                country: input.country,
                registrationNo: input.registrationNo ?? null,
                taxNo: input.taxNo ?? null,
                currency: input.currency ?? null,
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'legal_entity', row.id, 'created')
          return toEntity(row)
        }),
      update: scoped.entities.update
        .use(cap('legal_entities'))
        .use(requires('hr.entity.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const { workspaceId, entityId, ...patch } = input
            const set: Record<string, unknown> = { updatedAt: new Date() }
            for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v
            const [updated] = await tx
              .update(legalEntities)
              .set(set)
              .where(and(eq(legalEntities.workspaceId, workspaceId), eq(legalEntities.id, entityId)))
              .returning()
            if (!updated) throw KernError.notFound('Legal entity')
            return updated
          })
          await changed(input.workspaceId, 'legal_entity', row.id, 'updated')
          return toEntity(row)
        }),
      archive: scoped.entities.archive
        .use(cap('legal_entities'))
        .use(requires('hr.entity.manage'))
        .handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, (tx) =>
            tx
              .update(legalEntities)
              .set({ archivedAt: new Date() })
              .where(
                and(eq(legalEntities.workspaceId, input.workspaceId), eq(legalEntities.id, input.entityId)),
              ),
          )
          await changed(input.workspaceId, 'legal_entity', input.entityId, 'deleted')
          return { ok: true as const }
        }),

      costCenters: {
        list: scoped.entities.costCenters.list
          .use(cap('legal_entities'))
          .use(requires('hr.entity.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [eq(costCenters.workspaceId, input.workspaceId)]
              if (!input.includeArchived) where.push(isNull(costCenters.archivedAt))
              const rows = await tx
                .select()
                .from(costCenters)
                .where(and(...where))
                .orderBy(asc(costCenters.code))
              return rows.map((r) => ({ ...r, archivedAt: r.archivedAt?.toISOString() ?? null }))
            }),
          ),
        create: scoped.entities.costCenters.create
          .use(cap('legal_entities'))
          .use(requires('hr.entity.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              try {
                const [created] = await tx
                  .insert(costCenters)
                  .values({
                    id: uuidv7(),
                    workspaceId: input.workspaceId,
                    code: input.code,
                    name: input.name,
                    officeId: input.officeId ?? null,
                    orgUnitId: input.orgUnitId ?? null,
                    legalEntityId: input.legalEntityId ?? null,
                  })
                  .returning()
                return created!
              } catch (err) {
                // A code is how a cost centre is referred to everywhere outside this table, so the
                // index holds it unique per workspace — archived rows included, because the code of
                // an archived centre is still the one an old export names. Without this the driver's
                // duplicate key escapes as a 500 and the person typing the form is told nothing.
                if (!isUniqueViolation(err, 'hr_cost_centers_ws_code_uq')) throw err
                throw KernError.conflict('That code is already used by another cost centre.')
              }
            })
            await changed(input.workspaceId, 'cost_center', row.id, 'created')
            return { ...row, archivedAt: null }
          }),
        archive: scoped.entities.costCenters.archive
          .use(cap('legal_entities'))
          .use(requires('hr.entity.manage'))
          .handler(async ({ input }) => {
            await db.withWorkspace(input.workspaceId, (tx) =>
              tx
                .update(costCenters)
                .set({ archivedAt: new Date() })
                .where(
                  and(eq(costCenters.workspaceId, input.workspaceId), eq(costCenters.id, input.costCenterId)),
                ),
            )
            await changed(input.workspaceId, 'cost_center', input.costCenterId, 'deleted')
            return { ok: true as const }
          }),
      },
    },

    // ================================================================= calendars
    calendars: {
      list: scoped.calendars.list
        .use(cap('calendars'))
        .use(requires('hr.calendar.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(calendars.workspaceId, input.workspaceId)]
            if (!input.includeArchived) where.push(isNull(calendars.archivedAt))
            const rows = await tx
              .select()
              .from(calendars)
              .where(and(...where))
              .orderBy(asc(calendars.name))
            const used = await tx
              .select({ calendarId: offices.calendarId, officeId: offices.id })
              .from(offices)
              .where(eq(offices.workspaceId, input.workspaceId))
            return rows.map((r) => ({
              ...toCalendar(r),
              officeIds: used.filter((u) => u.calendarId === r.id).map((u) => u.officeId),
            }))
          }),
        ),

      get: scoped.calendars.get
        .use(cap('calendars'))
        .use(requires('hr.calendar.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) =>
            toCalendar(await loadCalendar(tx, input.workspaceId, input.calendarId)),
          ),
        ),

      create: scoped.calendars.create
        .use(cap('calendars'))
        .use(requires('hr.calendar.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            if (input.extendsId) await assertChainDepth(tx, input.workspaceId, input.extendsId)
            const [created] = await tx
              .insert(calendars)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                name: input.name,
                extendsId: input.extendsId ?? null,
                country: input.country ?? null,
                region: input.region ?? null,
                workingWeek: (input.workingWeek as Record<string, number>) ?? DEFAULT_WORKING_WEEK,
                source: 'custom',
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'calendar', row.id, 'created')
          return toCalendar(row)
        }),

      update: scoped.calendars.update
        .use(cap('calendars'))
        .use(requires('hr.calendar.manage'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            if (input.extendsId) {
              if (input.extendsId === input.calendarId)
                throw KernError.badRequest('A calendar cannot extend itself.')
              await assertChainDepth(tx, input.workspaceId, input.extendsId, input.calendarId)
            }
            const set: Record<string, unknown> = { updatedAt: new Date() }
            if (input.name !== undefined) set.name = input.name
            if (input.workingWeek !== undefined) set.workingWeek = input.workingWeek
            if (input.extendsId !== undefined) set.extendsId = input.extendsId
            const [updated] = await tx
              .update(calendars)
              .set(set)
              .where(and(eq(calendars.workspaceId, input.workspaceId), eq(calendars.id, input.calendarId)))
              .returning()
            if (!updated) throw KernError.notFound('Calendar')
            return updated
          })
          await emitCalendarChanged(input.workspaceId, input.calendarId, null, null, context.principal.userId)
          return toCalendar(row)
        }),

      archive: scoped.calendars.archive
        .use(cap('calendars'))
        .use(requires('hr.calendar.manage'))
        .handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const [used] = await tx
              .select({ n: count() })
              .from(offices)
              .where(
                and(eq(offices.workspaceId, input.workspaceId), eq(offices.calendarId, input.calendarId)),
              )
            if ((used?.n ?? 0) > 0)
              throw KernError.conflict(
                `${used?.n} offices use this calendar. Point them at another one first.`,
              )
            await tx
              .update(calendars)
              .set({ archivedAt: new Date() })
              .where(and(eq(calendars.workspaceId, input.workspaceId), eq(calendars.id, input.calendarId)))
          })
          await changed(input.workspaceId, 'calendar', input.calendarId, 'deleted')
          return { ok: true as const }
        }),

      days: {
        list: scoped.calendars.days.list
          .use(cap('calendars'))
          .use(requires('hr.calendar.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, (tx) =>
              composedDays(tx, input.workspaceId, input.calendarId, input.from, input.to),
            ),
          ),

        add: scoped.calendars.days.add
          .use(cap('calendars'))
          .use(requires('hr.calendar.manage'))
          .handler(async ({ input, context }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              await loadCalendar(tx, input.workspaceId, input.calendarId)
              const [created] = await tx
                .insert(calendarDays)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  calendarId: input.calendarId,
                  date: input.date,
                  kind: input.kind,
                  name: input.name,
                  workingFraction: String(input.workingFraction),
                  // Always `custom`. A day HR adds is theirs, and a pack upgrade must never
                  // overwrite or remove it — that is the whole point of tracking source per day.
                  source: 'custom',
                  paid: input.paid,
                  note: input.note ?? null,
                })
                .onConflictDoUpdate({
                  target: [calendarDays.calendarId, calendarDays.date, calendarDays.kind],
                  set: {
                    name: input.name,
                    workingFraction: String(input.workingFraction),
                    paid: input.paid,
                    note: input.note ?? null,
                    source: 'custom',
                  },
                })
                .returning()
              return created!
            })
            await emitCalendarChanged(
              input.workspaceId,
              input.calendarId,
              input.date,
              input.date,
              context.principal.userId,
            )
            return toResolvedDay(row, input.calendarId, '', false)
          }),

        update: scoped.calendars.days.update
          .use(cap('calendars'))
          .use(requires('hr.calendar.manage'))
          .handler(async ({ input, context }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const set: Record<string, unknown> = {}
              if (input.name !== undefined) set.name = input.name
              if (input.kind !== undefined) set.kind = input.kind
              if (input.workingFraction !== undefined) set.workingFraction = String(input.workingFraction)
              if (input.paid !== undefined) set.paid = input.paid
              if (input.note !== undefined) set.note = input.note
              // Editing a pack day makes it the workspace's own. Leaving it `pack` would mean the
              // next upgrade silently reverted the edit.
              set.source = 'custom'
              const [updated] = await tx
                .update(calendarDays)
                .set(set)
                .where(and(eq(calendarDays.workspaceId, input.workspaceId), eq(calendarDays.id, input.dayId)))
                .returning()
              if (!updated) throw KernError.notFound('Calendar day')
              return updated
            })
            await emitCalendarChanged(
              input.workspaceId,
              input.calendarId,
              row.date,
              row.date,
              context.principal.userId,
            )
            return toResolvedDay(row, input.calendarId, '', false)
          }),

        /**
         * A `custom` day is deleted. A `pack` day cannot be — it belongs to the pack and the next
         * upgrade would bring it straight back — so this writes a suppressing `working_override`
         * over it and says so, rather than appearing to work and silently undoing itself in January.
         */
        remove: scoped.calendars.days.remove
          .use(cap('calendars'))
          .use(requires('hr.calendar.manage'))
          .handler(async ({ input, context }) => {
            const result = await db.withWorkspace(input.workspaceId, async (tx) => {
              const [row] = await tx
                .select()
                .from(calendarDays)
                .where(and(eq(calendarDays.workspaceId, input.workspaceId), eq(calendarDays.id, input.dayId)))
                .limit(1)
              if (!row) throw KernError.notFound('Calendar day')

              if (row.source === 'custom' && row.calendarId === input.calendarId) {
                await tx.delete(calendarDays).where(eq(calendarDays.id, row.id))
                return { date: row.date, suppressed: false }
              }

              await tx
                .insert(calendarDays)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  calendarId: input.calendarId,
                  date: row.date,
                  kind: 'working_override',
                  name: row.name,
                  workingFraction: '1',
                  source: 'custom',
                  paid: false,
                  note: 'Worked despite the calendar it extends',
                })
                .onConflictDoNothing()
              return { date: row.date, suppressed: true }
            })
            await emitCalendarChanged(
              input.workspaceId,
              input.calendarId,
              result.date,
              result.date,
              context.principal.userId,
            )
            return { ok: true as const, suppressed: result.suppressed }
          }),
      },

      pack: {
        preview: scoped.calendars.pack.preview
          .use(cap('calendars'))
          .use(requires('hr.calendar.manage'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, (tx) =>
              diffPack(tx, input.workspaceId, input.calendarId, input.packKey, input.year),
            ),
          ),

        apply: scoped.calendars.pack.apply
          .use(cap('calendars'))
          .use(requires('hr.calendar.manage'))
          .handler(async ({ input, context }) => {
            const result = await db.withWorkspace(input.workspaceId, async (tx) => {
              const diff = await diffPack(tx, input.workspaceId, input.calendarId, input.packKey, input.year)
              const from = `${input.year}-01-01`
              const to = `${input.year}-12-31`
              // Only `pack` rows are touched. Everything HR added stays exactly as it is — which is
              // the promise the preview made, and the one thing this operation must never break.
              await tx
                .delete(calendarDays)
                .where(
                  and(
                    eq(calendarDays.workspaceId, input.workspaceId),
                    eq(calendarDays.calendarId, input.calendarId),
                    eq(calendarDays.source, 'pack'),
                    gte(calendarDays.date, from),
                    lte(calendarDays.date, to),
                  ),
                )
              const pack = packDays(input.packKey, input.year)
              if (pack.length)
                await tx
                  .insert(calendarDays)
                  .values(
                    pack.map((d) => ({
                      id: uuidv7(),
                      workspaceId: input.workspaceId,
                      calendarId: input.calendarId,
                      date: d.date,
                      kind: d.kind,
                      name: d.name,
                      workingFraction: String(d.workingFraction),
                      source: 'pack' as const,
                      paid: true,
                    })),
                  )
                  .onConflictDoNothing()
              await tx
                .update(calendars)
                .set({ packKey: input.packKey, packVersion: String(input.year), updatedAt: new Date() })
                .where(and(eq(calendars.workspaceId, input.workspaceId), eq(calendars.id, input.calendarId)))
              return diff
            })
            await emitCalendarChanged(
              input.workspaceId,
              input.calendarId,
              `${input.year}-01-01`,
              `${input.year}-12-31`,
              context.principal.userId,
            )
            return {
              ok: true as const,
              added: result.added.length,
              changed: result.changed.length,
              removed: result.removed.length,
            }
          }),
      },

      workingDays: scoped.calendars.workingDays
        .use(cap('calendars'))
        .use(requires('hr.calendar.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            let calendarId = input.calendarId ?? null
            let week: WorkingWeek = DEFAULT_WORKING_WEEK
            if (input.personId) {
              const r = await resolve.forPerson(tx, input.workspaceId, input.personId, input.from)
              calendarId = r.calendarId
              week = r.workingWeek
            } else if (calendarId) {
              week = (await loadCalendar(tx, input.workspaceId, calendarId))
                .workingWeek as unknown as WorkingWeek
            }
            const days = calendarId
              ? await composedDays(tx, input.workspaceId, calendarId, input.from, input.to)
              : []
            const results = workingDays(
              input.from,
              input.to,
              week,
              days.map((d) => ({ date: d.date, name: d.name, workingFraction: d.workingFraction })),
            )
            return { days: countWorkingDays(results), breakdown: results }
          }),
        ),
    },

    // ================================================================= documents
    documents: {
      list: scoped.documents.list
        .use(cap('documents'))
        .use(requires('hr.document.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const rows = await tx
              .select()
              .from(personDocuments)
              .where(
                and(
                  eq(personDocuments.workspaceId, input.workspaceId),
                  eq(personDocuments.personId, input.personId),
                ),
              )
              .orderBy(desc(personDocuments.createdAt))
            return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
          }),
        ),
      attach: scoped.documents.attach
        .use(cap('documents'))
        .use(requires('hr.document.manage'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const [created] = await tx
              .insert(personDocuments)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                personId: input.personId,
                fileId: input.fileId,
                name: input.name,
                kind: input.kind,
                issuedOn: input.issuedOn ?? null,
                expiresOn: input.expiresOn ?? null,
                uploadedBy: context.principal.userId ?? null,
              })
              .returning()
            // The document's *existence* is audited, never its contents.
            await svc.record(tx, input.workspaceId, input.personId, context.principal.userId ?? null, [
              { field: 'document.attached', from: null, to: input.name },
            ])
            return created!
          })
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return { ...row, createdAt: row.createdAt.toISOString() }
        }),
      remove: scoped.documents.remove
        .use(cap('documents'))
        .use(requires('hr.document.manage'))
        .handler(async ({ input, context }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const [row] = await tx
              .select()
              .from(personDocuments)
              .where(
                and(
                  eq(personDocuments.workspaceId, input.workspaceId),
                  eq(personDocuments.id, input.documentId),
                ),
              )
              .limit(1)
            if (!row) throw KernError.notFound('Document')
            await tx.delete(personDocuments).where(eq(personDocuments.id, row.id))
            await svc.record(tx, input.workspaceId, input.personId, context.principal.userId ?? null, [
              { field: 'document.removed', from: row.name, to: null },
            ])
          })
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return { ok: true as const }
        }),
    },

    // ================================================================= policies
    policies: {
      list: scoped.policies.list
        .use(cap('leave_accrual'))
        .use(requires('hr.policy.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(policies.workspaceId, input.workspaceId)]
            if (input.kind) where.push(eq(policies.kind, input.kind))
            if (!input.includeArchived) where.push(isNull(policies.archivedAt))
            const rows = await tx
              .select()
              .from(policies)
              .where(and(...where))
              .orderBy(asc(policies.kind), asc(policies.name))
            return withAssignments(tx, input.workspaceId, rows)
          }),
        ),

      get: scoped.policies.get
        .use(cap('leave_accrual'))
        .use(requires('hr.policy.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const row = await loadPolicy(tx, input.workspaceId, input.policyId)
            return (await withAssignments(tx, input.workspaceId, [row]))[0]!
          }),
        ),

      create: scoped.policies.create
        .use(cap('leave_accrual'))
        .use(requires('hr.policy.manage'))
        .handler(async ({ input }) => {
          const config = validatePolicyConfig(input.kind, input.config)
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const [created] = await tx
              .insert(policies)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                kind: input.kind,
                name: input.name,
                config,
                effectiveFrom: input.effectiveFrom,
                effectiveTo: input.effectiveTo ?? null,
                source: 'custom',
                configHash: hashConfig(config),
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'policy', row.id, 'created')
          return toPolicy(row)
        }),

      update: scoped.policies.update
        .use(cap('leave_accrual'))
        .use(requires('hr.policy.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const existing = await loadPolicy(tx, input.workspaceId, input.policyId)
            const set: Record<string, unknown> = { updatedAt: new Date() }
            if (input.name !== undefined) set.name = input.name
            if (input.effectiveTo !== undefined) set.effectiveTo = input.effectiveTo
            if (input.config !== undefined) {
              const config = validatePolicyConfig(existing.kind as never, input.config)
              set.config = config
              // The hash changes with the config, which is what marks every row derived from the
              // old one as stale rather than leaving them silently wrong.
              set.configHash = hashConfig(config)
            }
            const [updated] = await tx
              .update(policies)
              .set(set)
              .where(and(eq(policies.workspaceId, input.workspaceId), eq(policies.id, input.policyId)))
              .returning()
            return updated!
          })
          await changed(input.workspaceId, 'policy', row.id, 'updated')
          return toPolicy(row)
        }),

      archive: scoped.policies.archive
        .use(cap('leave_accrual'))
        .use(requires('hr.policy.manage'))
        .handler(async ({ input }) => {
          // Archived, never deleted: ledger entries name the policy that produced them, and a
          // movement whose policy has vanished is a number nobody can explain.
          await db.withWorkspace(input.workspaceId, (tx) =>
            tx
              .update(policies)
              .set({ archivedAt: new Date() })
              .where(and(eq(policies.workspaceId, input.workspaceId), eq(policies.id, input.policyId))),
          )
          await changed(input.workspaceId, 'policy', input.policyId, 'deleted')
          return { ok: true as const }
        }),

      assign: scoped.policies.assign
        .use(cap('leave_accrual'))
        .use(requires('hr.policy.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            await loadPolicy(tx, input.workspaceId, input.policyId)
            if (input.subjectKind !== 'workspace' && !input.subjectId)
              throw KernError.badRequest(`A ${input.subjectKind} assignment needs a subject.`)
            const [created] = await tx
              .insert(policyAssignments)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                policyId: input.policyId,
                subjectKind: input.subjectKind,
                subjectId: input.subjectKind === 'workspace' ? null : (input.subjectId ?? null),
                effectiveFrom: input.effectiveFrom,
                effectiveTo: input.effectiveTo ?? null,
                // The ladder, written once. Nothing else invents its own order.
                priority: PolicyService.priorityFor(input.subjectKind),
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'policy', input.policyId, 'updated')
          return toAssignment(row)
        }),

      unassign: scoped.policies.unassign
        .use(cap('leave_accrual'))
        .use(requires('hr.policy.manage'))
        .handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, (tx) =>
            tx
              .delete(policyAssignments)
              .where(
                and(
                  eq(policyAssignments.workspaceId, input.workspaceId),
                  eq(policyAssignments.id, input.assignmentId),
                ),
              ),
          )
          await changed(input.workspaceId, 'policy', input.assignmentId, 'deleted')
          return { ok: true as const }
        }),

      resolveFor: scoped.policies.resolveFor
        .use(cap('leave_accrual'))
        .use(requires('hr.policy.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const on = input.on ?? todayIso()
            const kinds = ['accrual', 'carry_forward', 'overtime', 'rounding', 'working_time'] as const
            const out = []
            for (const kind of kinds)
              out.push(await policySvc.forPerson(tx, input.workspaceId, input.personId, kind, on))
            return out
          }),
        ),
    },

    // ================================================================= accrual
    accrual: {
      preview: scoped.accrual.preview
        .use(cap('leave_accrual'))
        .use(requires('hr.policy.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, (tx) =>
            accrualPreview(tx, input.workspaceId, input.from, input.to, input.personId),
          ),
        ),

      run: scoped.accrual.run
        .use(cap('leave_accrual'))
        .use(requires('hr.policy.manage'))
        .handler(async ({ input, context }) => {
          const result = await db.withWorkspace(input.workspaceId, async (tx) => {
            const preview = await accrualPreview(tx, input.workspaceId, input.from, input.to, input.personId)
            let credited = 0
            let totalMinutes = 0
            for (const row of preview.rows) {
              // Idempotent per person, per type, per period: a job that double-credits when
              // somebody clicks twice is worse than one that never ran.
              if (row.alreadyAccrued || row.minutes <= 0) continue
              const year = yearOf(input.from)
              await ledger.lockAndRead(tx, input.workspaceId, row.personId, row.leaveTypeId, year)
              await ledger.append(tx, input.workspaceId, {
                personId: row.personId,
                leaveTypeId: row.leaveTypeId,
                kind: 'accrual',
                amountMinutes: row.minutes,
                effectiveOn: input.to,
                periodYear: year,
                reason: row.reason,
                createdBy: context.principal.userId ?? null,
              })
              credited++
              totalMinutes += row.minutes
            }
            return { credited, skipped: preview.rows.length - credited, totalMinutes }
          })
          await changed(input.workspaceId, 'leave_balance', input.workspaceId, 'updated')
          return result
        }),
    },

    // ================================================================= periods
    periods: {
      list: scoped.periods.list
        .use(cap('periods'))
        .use(requires('hr.period.manage'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(periods.workspaceId, input.workspaceId)]
            if (input.kind) where.push(eq(periods.kind, input.kind))
            const cursor = decodeCursor(input.cursor)
            if (cursor) where.push(after(periods.startsOn, periods.id, 'desc', cursor))
            const { items, nextCursor } = paginate(
              await tx
                .select()
                .from(periods)
                .where(and(...where))
                .orderBy(desc(periods.startsOn), desc(periods.id))
                .limit(input.limit + 1),
              input.limit,
              (r) => [r.startsOn, r.id],
            )
            return { items: items.map(toPeriod), nextCursor }
          }),
        ),

      create: scoped.periods.create
        .use(cap('periods'))
        .use(requires('hr.period.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            if (input.endsOn < input.startsOn)
              throw KernError.badRequest('A period cannot end before it starts.')
            const [created] = await tx
              .insert(periods)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                kind: input.kind,
                legalEntityId: input.legalEntityId ?? null,
                startsOn: input.startsOn,
                endsOn: input.endsOn,
                status: 'open',
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'period', row.id, 'created')
          return toPeriod(row)
        }),

      lock: scoped.periods.lock
        .use(cap('periods'))
        .use(requires('hr.period.manage'))
        .handler(async ({ input, context }) => {
          const result = await db.withWorkspace(input.workspaceId, async (tx) => {
            const period = await loadPeriod(tx, input.workspaceId, input.periodId)
            if (period.status === 'locked') throw KernError.conflict('That period is already locked.')

            const [row] = await tx
              .update(periods)
              .set({
                status: 'locked',
                lockedAt: new Date(),
                lockedBy: context.principal.userId ?? null,
                note: input.note ?? null,
              })
              .where(eq(periods.id, period.id))
              .returning()

            // The day sheet carries its own flag so a recomputation does not have to join periods
            // on every row — this is what actually stops a closed month moving. It is stamped
            // through `setPeriodLock`, which is also what keeps the flag scoped to the period's
            // legal entity: filtering on the date range alone closed January for every entity in
            // the workspace, while `isLocked` went on answering for one.
            const lockedDays = await attendance.setPeriodLock(tx, input.workspaceId, period, true)

            return { period: row!, lockedDays }
          })
          await changed(input.workspaceId, 'period', input.periodId, 'updated')
          return { ...toPeriod(result.period), lockedDays: result.lockedDays }
        }),

      unlock: scoped.periods.unlock
        .use(cap('periods'))
        .use(requires('hr.period.manage'))
        .handler(async ({ input, context }) => {
          const result = await db.withWorkspace(input.workspaceId, async (tx) => {
            const period = await loadPeriod(tx, input.workspaceId, input.periodId)
            const [row] = await tx
              .update(periods)
              .set({
                status: 'open',
                lockedAt: null,
                lockedBy: null,
                note: `Reopened: ${input.reason}`,
              })
              .where(eq(periods.id, period.id))
              .returning()

            const unlockedDays = await attendance.setPeriodLock(tx, input.workspaceId, period, false)

            kernel.log.warn(
              {
                module: MODULE_ID,
                workspaceId: input.workspaceId,
                periodId: period.id,
                days: unlockedDays,
                actorId: context.principal.userId,
                reason: input.reason,
              },
              'payroll period reopened',
            )
            return { period: row!, unlockedDays }
          })
          await changed(input.workspaceId, 'period', input.periodId, 'updated')
          return { ...toPeriod(result.period), unlockedDays: result.unlockedDays }
        }),
    },

    // ================================================================= attendance
    attendance: {
      state: scoped.attendance.state
        .use(cap('attendance'))
        .use(requires('hr.attendance.view'))
        .handler(({ input, context }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const personId = await personFor(tx, input.workspaceId, context, input.personId)
            // The same attribution the next punch will be judged against, so what a person is shown
            // and what they are then allowed to do cannot disagree. Somebody who forgot to clock out
            // last night is told they are still on last night's shift, which is both true and the
            // thing they need to know before pressing anything.
            const { timezone, at, attribution } = await clockNow(tx, input.workspaceId, personId)

            let open: Date | null = null
            let onBreak = false
            let workedMs = 0
            let breakOpen: Date | null = null
            for (const r of attribution.punches) {
              if (r.direction === 'in') open = r.at
              else if (r.direction === 'out' && open) {
                workedMs += r.at.getTime() - open.getTime()
                open = null
              } else if (r.direction === 'break_start') {
                breakOpen = r.at
                onBreak = true
              } else if (r.direction === 'break_end' && breakOpen) {
                workedMs -= r.at.getTime() - breakOpen.getTime()
                breakOpen = null
                onBreak = false
              }
            }
            // An open span counts up to now, so the widget shows time accruing rather than freezing
            // at the last completed pair. `at` rather than a fresh `Date.now()`: one instant per
            // request, the one the attribution was made from.
            if (open) workedMs += at.getTime() - open.getTime()
            if (breakOpen) workedMs -= at.getTime() - breakOpen.getTime()

            return {
              personId,
              businessDate: attribution.businessDate,
              clockedIn: open !== null,
              onBreak,
              since: (open ?? breakOpen)?.toISOString() ?? null,
              workedMinutesToday: Math.max(0, Math.round(workedMs / 60000)),
              timezone,
            }
          }),
        ),

      clockIn: scoped.attendance.clockIn
        .use(cap('attendance'))
        .use(requires('hr.attendance.punch'))
        .handler(({ input, context }) => punch(input, context, 'in')),
      clockOut: scoped.attendance.clockOut
        .use(cap('attendance'))
        .use(requires('hr.attendance.punch'))
        .handler(({ input, context }) => punch(input, context, 'out')),
      breakStart: scoped.attendance.breakStart
        .use(cap('attendance'))
        .use(requires('hr.attendance.punch'))
        .handler(({ input, context }) => punch(input, context, 'break_start')),
      breakEnd: scoped.attendance.breakEnd
        .use(cap('attendance'))
        .use(requires('hr.attendance.punch'))
        .handler(({ input, context }) => punch(input, context, 'break_end')),

      punches: {
        list: scoped.attendance.punches.list
          .use(cap('attendance'))
          .use(requires('hr.attendance.view'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              const where = [
                eq(punches.workspaceId, input.workspaceId),
                eq(punches.personId, personId),
                gte(punches.businessDate, input.from),
                lte(punches.businessDate, input.to),
              ]
              if (!input.includeVoided) where.push(isNull(punches.voidedByPunchId))
              const cursor = decodeCursor(input.cursor)
              if (cursor) where.push(after(punches.at, punches.id, 'asc', cursor))
              const { items, nextCursor } = paginate(
                // `atText`, for the reason in `paginate`. Every insert here supplies a JS `Date`, so
                // nothing sub-millisecond is stored today and the bug is latent rather than live —
                // but the column carries `.defaultNow()`, so one insert that omits `at` would start
                // dropping punches off the end of a page with nothing to show for it.
                await tx
                  .select({ ...getTableColumns(punches), atText: sql<string>`${punches.at}::text` })
                  .from(punches)
                  .where(and(...where))
                  .orderBy(asc(punches.at), asc(punches.id))
                  .limit(input.limit + 1),
                input.limit,
                (r) => [r.atText, r.id],
              )
              return { items: items.map(toPunch), nextCursor }
            }),
          ),

        void: scoped.attendance.punches.void
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input, context }) => {
            const affected = await db.withWorkspace(input.workspaceId, async (tx) => {
              const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
              const { original } = await attendance.voidPunch(
                tx,
                input.workspaceId,
                input.punchId,
                input.reason,
                me?.id ?? null,
              )
              // The day is derived, so voiding a punch means the sheet is stale until it is rebuilt.
              const { timezone, schedule } = await personContext(tx, input.workspaceId, original.personId)
              await attendance.recomputeDay(
                tx,
                input.workspaceId,
                original.personId,
                original.businessDate,
                timezone,
                schedule,
              )
              return original
            })
            await changed(input.workspaceId, 'attendance_day', affected.personId, 'updated')
            return { ok: true as const }
          }),
      },

      days: {
        list: scoped.attendance.days.list
          .use(cap('attendance'))
          .use(requires('hr.attendance.view'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [
                eq(attendanceDays.workspaceId, input.workspaceId),
                gte(attendanceDays.businessDate, input.from),
                lte(attendanceDays.businessDate, input.to),
              ]
              if (input.officeId) {
                const here = await tx
                  .select({ personId: officeAssignments.personId })
                  .from(officeAssignments)
                  .where(
                    and(
                      eq(officeAssignments.workspaceId, input.workspaceId),
                      eq(officeAssignments.officeId, input.officeId),
                      isNull(officeAssignments.effectiveTo),
                    ),
                  )
                // Reading a whole office needs the team permission; reading yourself does not.
                await kernel.authz.require(context.principal, 'hr.attendance.view_team', {
                  kind: 'workspace',
                  id: input.workspaceId,
                  workspaceId: input.workspaceId,
                })
                where.push(
                  here.length
                    ? inArray(
                        attendanceDays.personId,
                        here.map((h) => h.personId),
                      )
                    : sql`false`,
                )
              } else {
                const personId = await personFor(tx, input.workspaceId, context, input.personId)
                where.push(eq(attendanceDays.personId, personId))
              }
              const cursor = decodeCursor(input.cursor)
              if (cursor) where.push(after(attendanceDays.businessDate, attendanceDays.id, 'asc', cursor))
              const { items, nextCursor } = paginate(
                await tx
                  .select()
                  .from(attendanceDays)
                  .where(and(...where))
                  .orderBy(asc(attendanceDays.businessDate), asc(attendanceDays.id))
                  .limit(input.limit + 1),
                input.limit,
                (r) => [r.businessDate, r.id],
              )
              return { items: items.map(toAttendanceDay), nextCursor }
            }),
          ),

        recompute: scoped.attendance.days.recompute
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              const { timezone, schedule } = await personContext(tx, input.workspaceId, personId)
              const dates = await attendance.datesWithPunches(
                tx,
                input.workspaceId,
                personId,
                input.from,
                input.to,
              )
              let recomputed = 0
              const skippedLocked: string[] = []
              for (const date of dates) {
                const r = await attendance.recomputeDay(
                  tx,
                  input.workspaceId,
                  personId,
                  date,
                  timezone,
                  schedule,
                )
                // Named rather than silently skipped: a recomputation that quietly declines to touch
                // a closed month looks identical to one that had nothing to do.
                if (r.locked) skippedLocked.push(date)
                else recomputed++
              }
              return { recomputed, skippedLocked }
            }),
          ),
      },

      schedules: {
        list: scoped.attendance.schedules.list
          .use(cap('attendance'))
          .use(requires('hr.attendance.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [eq(schedules.workspaceId, input.workspaceId)]
              if (!input.includeArchived) where.push(isNull(schedules.archivedAt))
              const rows = await tx
                .select()
                .from(schedules)
                .where(and(...where))
                .orderBy(asc(schedules.name))
              return rows.map(toSchedule)
            }),
          ),
        create: scoped.attendance.schedules.create
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const [created] = await tx
                .insert(schedules)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  name: input.name,
                  kind: input.kind,
                  week: input.week as unknown as Record<string, unknown>,
                  tzMode: input.tzMode,
                  tz: input.tz ?? null,
                  graceInMinutes: input.graceInMinutes,
                  graceOutMinutes: input.graceOutMinutes,
                  roundingStepMinutes: input.roundingStepMinutes,
                  roundingDirection: input.roundingDirection,
                  autoClockOutAfterMinutes: input.autoClockOutAfterMinutes ?? null,
                })
                .returning()
              return created!
            })
            await changed(input.workspaceId, 'schedule', row.id, 'created')
            return toSchedule(row)
          }),
        update: scoped.attendance.schedules.update
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const { workspaceId, scheduleId, ...patch } = input
              const set: Record<string, unknown> = { updatedAt: new Date() }
              for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v
              const [updated] = await tx
                .update(schedules)
                .set(set)
                .where(and(eq(schedules.workspaceId, workspaceId), eq(schedules.id, scheduleId)))
                .returning()
              if (!updated) throw KernError.notFound('Schedule')
              return updated
            })
            await changed(input.workspaceId, 'schedule', row.id, 'updated')
            return toSchedule(row)
          }),
        archive: scoped.attendance.schedules.archive
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            await db.withWorkspace(input.workspaceId, (tx) =>
              tx
                .update(schedules)
                .set({ archivedAt: new Date() })
                .where(and(eq(schedules.workspaceId, input.workspaceId), eq(schedules.id, input.scheduleId))),
            )
            await changed(input.workspaceId, 'schedule', input.scheduleId, 'deleted')
            return { ok: true as const }
          }),
        assign: scoped.attendance.schedules.assign
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            const rows = await db.withWorkspace(input.workspaceId, async (tx) => {
              // Effective-dated like everything else here: the old assignment is closed the day
              // before, so "which schedule was she on in March" stays answerable.
              await tx
                .update(scheduleAssignments)
                .set({ effectiveTo: sql`${input.effectiveFrom}::date - 1` })
                .where(
                  and(
                    eq(scheduleAssignments.workspaceId, input.workspaceId),
                    eq(scheduleAssignments.personId, input.personId),
                    isNull(scheduleAssignments.effectiveTo),
                  ),
                )
              await tx.insert(scheduleAssignments).values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                personId: input.personId,
                scheduleId: input.scheduleId,
                effectiveFrom: input.effectiveFrom,
              })
              return tx
                .select()
                .from(scheduleAssignments)
                .where(
                  and(
                    eq(scheduleAssignments.workspaceId, input.workspaceId),
                    eq(scheduleAssignments.personId, input.personId),
                  ),
                )
                .orderBy(desc(scheduleAssignments.effectiveFrom))
            })
            await changed(input.workspaceId, 'schedule', input.scheduleId, 'updated')
            return rows.map(toScheduleAssignment)
          }),
      },

      regularizations: {
        list: scoped.attendance.regularizations.list
          .use(cap('attendance'))
          .use(requires('hr.attendance.view'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              const where = [
                eq(regularizations.workspaceId, input.workspaceId),
                eq(regularizations.personId, personId),
              ]
              if (input.status?.length) where.push(inArray(regularizations.status, input.status))
              const cursor = decodeCursor(input.cursor)
              if (cursor) where.push(after(regularizations.businessDate, regularizations.id, 'desc', cursor))
              const { items, nextCursor } = paginate(
                await tx
                  .select()
                  .from(regularizations)
                  .where(and(...where))
                  .orderBy(desc(regularizations.businessDate), desc(regularizations.id))
                  .limit(input.limit + 1),
                input.limit,
                (r) => [r.businessDate, r.id],
              )
              return { items: items.map(toRegularization), nextCursor }
            }),
          ),

        request: scoped.attendance.regularizations.request
          .use(cap('attendance'))
          .use(requires('hr.attendance.punch'))
          .handler(async ({ input, context }) => {
            const filed = await db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              const [created] = await tx
                .insert(regularizations)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  personId,
                  businessDate: input.businessDate,
                  punchId: input.punchId ?? null,
                  proposed: input.proposed as unknown as Array<Record<string, unknown>>,
                  reason: input.reason,
                  status: 'pending',
                })
                .returning()

              // The same engine leave uses. That reuse is the reason approvals were built keyed by
              // subject type rather than bolted onto leave_requests.
              const raised = await approvals.raise(tx, input.workspaceId, {
                subjectType: 'regularization',
                subjectId: created!.id,
                summary: `Correction for ${input.businessDate}`,
                summaryParams: { date: input.businessDate },
                requesterPersonId: personId,
                requestedBy: context.principal.userId ?? null,
                on: input.businessDate,
              })
              await tx
                .update(regularizations)
                .set({ approvalRequestId: raised.request.id })
                .where(eq(regularizations.id, created!.id))
              if (raised.autoApproved) await applyRegularization(tx, input.workspaceId, created!.id)

              const [fresh] = await tx
                .select()
                .from(regularizations)
                .where(eq(regularizations.id, created!.id))
              // Same reason as leave: the approvers are told after this commits, never inside it.
              return {
                row: fresh!,
                approval: {
                  requestId: raised.request.id,
                  approverIds: raised.firstStepApprovers,
                  userIds: await accountsOf(tx, input.workspaceId, raised.firstStepApprovers),
                  summary: raised.request.summary,
                  summaryParams: raised.request.summaryParams,
                  actorId: raised.request.requestedBy,
                },
              }
            })
            if (filed.approval.approverIds.length) {
              await kernel.emit(
                hrEvents.approvalRequested,
                {
                  requestId: filed.approval.requestId,
                  workspaceId: input.workspaceId,
                  subjectType: 'regularization',
                  subjectId: filed.row.id,
                  approverIds: filed.approval.approverIds,
                },
                { workspaceId: input.workspaceId, actorId: context.principal.userId },
              )
              await notifyApprovers({
                workspaceId: input.workspaceId,
                requestId: filed.approval.requestId,
                subjectType: 'regularization',
                summary: filed.approval.summary,
                summaryParams: filed.approval.summaryParams,
                userIds: filed.approval.userIds,
                actorId: filed.approval.actorId,
              })
            }
            await changed(input.workspaceId, 'regularization', filed.row.id, 'created')
            return toRegularization(filed.row)
          }),
      },
    },

    // ================================================================= rosters
    rosters: {
      shifts: {
        list: scoped.rosters.shifts.list
          .use(cap('rosters'))
          .use(requires('hr.attendance.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [eq(rosterShifts.workspaceId, input.workspaceId)]
              if (!input.includeArchived) where.push(isNull(rosterShifts.archivedAt))
              const rows = await tx
                .select()
                .from(rosterShifts)
                .where(and(...where))
                .orderBy(asc(rosterShifts.startTime), asc(rosterShifts.name))
              return rows.map(toRosterShift)
            }),
          ),
        create: scoped.rosters.shifts.create
          .use(cap('rosters'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const [created] = await tx
                .insert(rosterShifts)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  name: input.name,
                  code: input.code ?? null,
                  startTime: input.start,
                  endTime: input.end,
                  breakMinutes: input.breakMinutes,
                  graceInMinutes: input.graceInMinutes,
                  graceOutMinutes: input.graceOutMinutes,
                  color: input.color ?? null,
                })
                .returning()
              return created!
            })
            await changed(input.workspaceId, 'roster_shift', row.id, 'created')
            return toRosterShift(row)
          }),
        update: scoped.rosters.shifts.update
          .use(cap('rosters'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              // Written out rather than looped over the patch, because two of the fields are named
              // differently in the contract and in the table: `start`/`end` read well on a shift and
              // are `start_time`/`end_time` in SQL, where `end` is a keyword.
              const set: Record<string, unknown> = { updatedAt: new Date() }
              if (input.name !== undefined) set.name = input.name
              if (input.code !== undefined) set.code = input.code ?? null
              if (input.start !== undefined) set.startTime = input.start
              if (input.end !== undefined) set.endTime = input.end
              if (input.breakMinutes !== undefined) set.breakMinutes = input.breakMinutes
              if (input.graceInMinutes !== undefined) set.graceInMinutes = input.graceInMinutes
              if (input.graceOutMinutes !== undefined) set.graceOutMinutes = input.graceOutMinutes
              if (input.color !== undefined) set.color = input.color ?? null
              const [updated] = await tx
                .update(rosterShifts)
                .set(set)
                .where(
                  and(eq(rosterShifts.workspaceId, input.workspaceId), eq(rosterShifts.id, input.shiftId)),
                )
                .returning()
              if (!updated) throw KernError.notFound('Shift')
              return updated
            })
            await changed(input.workspaceId, 'roster_shift', row.id, 'updated')
            return toRosterShift(row)
          }),
        archive: scoped.rosters.shifts.archive
          .use(cap('rosters'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            // Archived, not deleted. Rotations and stored overrides point at a shift by id, and a
            // deleted one would empty out every day it has ever appeared on — history included.
            await db.withWorkspace(input.workspaceId, (tx) =>
              tx
                .update(rosterShifts)
                .set({ archivedAt: new Date(), updatedAt: new Date() })
                .where(
                  and(eq(rosterShifts.workspaceId, input.workspaceId), eq(rosterShifts.id, input.shiftId)),
                ),
            )
            await changed(input.workspaceId, 'roster_shift', input.shiftId, 'deleted')
            return { ok: true as const }
          }),
      },

      patterns: {
        list: scoped.rosters.patterns.list
          .use(cap('rosters'))
          .use(requires('hr.attendance.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [eq(rosterPatterns.workspaceId, input.workspaceId)]
              if (!input.includeArchived) where.push(isNull(rosterPatterns.archivedAt))
              const rows = await tx
                .select()
                .from(rosterPatterns)
                .where(and(...where))
                .orderBy(asc(rosterPatterns.name))
              return rows.map(toRosterPattern)
            }),
          ),
        create: scoped.rosters.patterns.create
          .use(cap('rosters'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              await rosters.assertShiftsExist(tx, input.workspaceId, input.days.flat())
              const [created] = await tx
                .insert(rosterPatterns)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  name: input.name,
                  anchorDate: input.anchorDate,
                  days: input.days.map((d) => [...d]),
                })
                .returning()
              return created!
            })
            await changed(input.workspaceId, 'roster_pattern', row.id, 'created')
            return toRosterPattern(row)
          }),
        update: scoped.rosters.patterns.update
          .use(cap('rosters'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              if (input.days) await rosters.assertShiftsExist(tx, input.workspaceId, input.days.flat())
              const set: Record<string, unknown> = { updatedAt: new Date() }
              if (input.name !== undefined) set.name = input.name
              if (input.anchorDate !== undefined) set.anchorDate = input.anchorDate
              if (input.days !== undefined) set.days = input.days.map((d) => [...d])
              const [updated] = await tx
                .update(rosterPatterns)
                .set(set)
                .where(
                  and(
                    eq(rosterPatterns.workspaceId, input.workspaceId),
                    eq(rosterPatterns.id, input.patternId),
                  ),
                )
                .returning()
              if (!updated) throw KernError.notFound('Rotation')
              return updated
            })
            await changed(input.workspaceId, 'roster_pattern', row.id, 'updated')
            return toRosterPattern(row)
          }),
        archive: scoped.rosters.patterns.archive
          .use(cap('rosters'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            // Hidden from the pickers, still read by everybody already on it. Archiving a rotation
            // people are working is not the same as taking them off it, and silently emptying their
            // roster would be a worse answer than leaving it visible until somebody unassigns them.
            await db.withWorkspace(input.workspaceId, (tx) =>
              tx
                .update(rosterPatterns)
                .set({ archivedAt: new Date(), updatedAt: new Date() })
                .where(
                  and(
                    eq(rosterPatterns.workspaceId, input.workspaceId),
                    eq(rosterPatterns.id, input.patternId),
                  ),
                ),
            )
            await changed(input.workspaceId, 'roster_pattern', input.patternId, 'deleted')
            return { ok: true as const }
          }),
      },

      assignments: scoped.rosters.assignments
        .use(cap('rosters'))
        .use(requires('hr.attendance.view_team'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(rosterAssignments.workspaceId, input.workspaceId)]
            if (input.personId) where.push(eq(rosterAssignments.personId, input.personId))
            if (input.patternId) where.push(eq(rosterAssignments.patternId, input.patternId))
            const rows = await tx
              .select()
              .from(rosterAssignments)
              .where(and(...where))
              .orderBy(desc(rosterAssignments.effectiveFrom), asc(rosterAssignments.id))
            return rows.map(toRosterAssignment)
          }),
        ),

      assign: scoped.rosters.assign
        .use(cap('rosters'))
        .use(requires('hr.attendance.manage'))
        .handler(async ({ input }) => {
          const rows = await db.withWorkspace(input.workspaceId, async (tx) => {
            const [pattern] = await tx
              .select()
              .from(rosterPatterns)
              .where(
                and(
                  eq(rosterPatterns.workspaceId, input.workspaceId),
                  eq(rosterPatterns.id, input.patternId),
                ),
              )
              .limit(1)
            if (!pattern) throw KernError.notFound('Rotation')

            const personIds = [...new Set(input.personIds)]
            const known = await tx
              .select({ id: people.id, displayName: people.displayName })
              .from(people)
              .where(and(eq(people.workspaceId, input.workspaceId), inArray(people.id, personIds)))
            if (known.length !== personIds.length)
              throw KernError.badRequest('This list names somebody who is not in this workspace.')
            const nameOf = new Map(known.map((p) => [p.id, p.displayName]))

            // An assignment already running when this one starts is closed the day before, which is
            // how "which rotation was she on in March" stays answerable.
            await tx
              .update(rosterAssignments)
              .set({ effectiveTo: sql`${input.effectiveFrom}::date - 1` })
              .where(
                and(
                  eq(rosterAssignments.workspaceId, input.workspaceId),
                  inArray(rosterAssignments.personId, personIds),
                  lte(rosterAssignments.effectiveFrom, sql`${input.effectiveFrom}::date - 1`),
                  or(
                    isNull(rosterAssignments.effectiveTo),
                    gte(rosterAssignments.effectiveTo, input.effectiveFrom),
                  ),
                ),
              )

            // One that starts *later* cannot be trimmed backwards without deleting somebody's plan,
            // so it is refused by name instead. The exclusion constraint would refuse it too, as
            // `23P01` — a Postgres error code is not something the person at the screen can act on.
            const clashWhere = [
              eq(rosterAssignments.workspaceId, input.workspaceId),
              inArray(rosterAssignments.personId, personIds),
              gte(rosterAssignments.effectiveFrom, input.effectiveFrom),
            ]
            if (input.effectiveTo) clashWhere.push(lte(rosterAssignments.effectiveFrom, input.effectiveTo))
            const clashes = await tx
              .select()
              .from(rosterAssignments)
              .where(and(...clashWhere))
              .orderBy(asc(rosterAssignments.effectiveFrom))
              .limit(3)
            if (clashes.length) {
              const first = clashes[0]!
              const who = nameOf.get(first.personId) ?? 'Somebody in this list'
              throw KernError.badRequest(
                `${who} already starts a rotation on ${first.effectiveFrom}. End that one first, or give this assignment an end date before it.`,
              )
            }

            await tx.insert(rosterAssignments).values(
              personIds.map((personId) => ({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                personId,
                patternId: input.patternId,
                effectiveFrom: input.effectiveFrom,
                effectiveTo: input.effectiveTo ?? null,
                cycleOffset: input.cycleOffset,
              })),
            )
            return tx
              .select()
              .from(rosterAssignments)
              .where(
                and(
                  eq(rosterAssignments.workspaceId, input.workspaceId),
                  inArray(rosterAssignments.personId, personIds),
                ),
              )
              .orderBy(desc(rosterAssignments.effectiveFrom), asc(rosterAssignments.id))
          })
          await changed(input.workspaceId, 'roster_assignment', input.patternId, 'updated')
          return rows.map(toRosterAssignment)
        }),

      unassign: scoped.rosters.unassign
        .use(cap('rosters'))
        .use(requires('hr.attendance.manage'))
        .handler(async ({ input }) => {
          const closed = await db.withWorkspace(input.workspaceId, async (tx) => {
            // Only assignments that have actually started by that date. Ending one before it begins
            // is a deletion wearing an end date, and this procedure never deletes: an assignment
            // somebody set up for next month is left for them to remove deliberately.
            const rows = await tx
              .update(rosterAssignments)
              .set({ effectiveTo: input.effectiveTo })
              .where(
                and(
                  eq(rosterAssignments.workspaceId, input.workspaceId),
                  inArray(rosterAssignments.personId, [...new Set(input.personIds)]),
                  isNull(rosterAssignments.effectiveTo),
                  lte(rosterAssignments.effectiveFrom, input.effectiveTo),
                ),
              )
              .returning({ id: rosterAssignments.id })
            return rows.length
          })
          for (const personId of new Set(input.personIds))
            await changed(input.workspaceId, 'roster_assignment', personId, 'updated')
          return { closed }
        }),

      days: scoped.rosters.days
        .use(cap('rosters'))
        .use(requires('hr.attendance.view'))
        .handler(({ input, context }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const personId = await rosterPersonFor(tx, input.workspaceId, context, input.personId)
            const refusal = rosterRefusal({ from: input.from, to: input.to, coverage: false })
            if (refusal) throw KernError.badRequest(refusal)
            const days = await rosters.forPerson(tx, input.workspaceId, personId, input.from, input.to)
            return days.map((day) => toRosterDay(personId, day))
          }),
        ),

      set: scoped.rosters.set
        .use(cap('rosters'))
        .use(requires('hr.attendance.manage'))
        .handler(async ({ input, context }) => {
          const day = await db.withWorkspace(input.workspaceId, async (tx) => {
            const [person] = await tx
              .select({ id: people.id })
              .from(people)
              .where(and(eq(people.workspaceId, input.workspaceId), eq(people.id, input.personId)))
              .limit(1)
            if (!person) throw KernError.notFound('Employee')
            await rosters.assertShiftsExist(tx, input.workspaceId, input.shiftIds)
            const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
            await tx
              .insert(rosterOverrides)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                personId: input.personId,
                businessDate: input.businessDate,
                shiftIds: [...input.shiftIds],
                note: input.note ?? null,
                createdBy: me?.id ?? null,
              })
              // One override per person-day, so a second edit of the same Tuesday replaces the
              // first rather than adding a row nothing would ever choose between.
              .onConflictDoUpdate({
                target: [rosterOverrides.workspaceId, rosterOverrides.personId, rosterOverrides.businessDate],
                set: {
                  shiftIds: [...input.shiftIds],
                  note: input.note ?? null,
                  createdBy: me?.id ?? null,
                  updatedAt: new Date(),
                },
              })
            const [resolved] = await rosters.forPerson(
              tx,
              input.workspaceId,
              input.personId,
              input.businessDate,
              input.businessDate,
            )
            return resolved!
          })
          await changed(input.workspaceId, 'roster_day', input.personId, 'updated')
          return toRosterDay(input.personId, day)
        }),

      clear: scoped.rosters.clear
        .use(cap('rosters'))
        .use(requires('hr.attendance.manage'))
        .handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, (tx) =>
            tx
              .delete(rosterOverrides)
              .where(
                and(
                  eq(rosterOverrides.workspaceId, input.workspaceId),
                  eq(rosterOverrides.personId, input.personId),
                  eq(rosterOverrides.businessDate, input.businessDate),
                ),
              ),
          )
          await changed(input.workspaceId, 'roster_day', input.personId, 'updated')
          return { ok: true as const }
        }),

      coverage: scoped.rosters.coverage
        .use(cap('rosters'))
        .use(requires('hr.attendance.view_team'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const shape = rosterRefusal({ from: input.from, to: input.to, coverage: true })
            if (shape) throw KernError.badRequest(shape)

            // The population is whoever a rotation covers — narrowed to one office when asked. A
            // grid over people no rotation touches is a page of empty rows.
            const rostered = await tx
              .selectDistinct({ personId: rosterAssignments.personId })
              .from(rosterAssignments)
              .where(
                and(
                  eq(rosterAssignments.workspaceId, input.workspaceId),
                  lte(rosterAssignments.effectiveFrom, input.to),
                  or(isNull(rosterAssignments.effectiveTo), gte(rosterAssignments.effectiveTo, input.from)),
                ),
              )
            let personIds = rostered.map((r) => r.personId)
            if (input.officeId) {
              const here = await tx
                .select({ personId: officeAssignments.personId })
                .from(officeAssignments)
                .where(
                  and(
                    eq(officeAssignments.workspaceId, input.workspaceId),
                    eq(officeAssignments.officeId, input.officeId),
                    isNull(officeAssignments.effectiveTo),
                  ),
                )
              const inOffice = new Set(here.map((h) => h.personId))
              personIds = personIds.filter((id) => inOffice.has(id))
            }

            const dates = datesBetween(input.from, input.to)
            if (!personIds.length) return dates.map((businessDate) => ({ businessDate, slots: [], off: [] }))

            const tooWide = rosterRefusal({
              from: input.from,
              to: input.to,
              coverage: true,
              population: personIds.length,
            })
            if (tooWide) throw KernError.badRequest(tooWide)

            const plan = await rosters.plan(tx, input.workspaceId, personIds, dates)
            const named = await tx
              .select({ personId: people.id, displayName: people.displayName })
              .from(people)
              .where(and(eq(people.workspaceId, input.workspaceId), inArray(people.id, personIds)))
            const nameOf = new Map(named.map((p) => [p.personId, p.displayName]))
            const person = (personId: string) => ({
              personId,
              displayName: nameOf.get(personId) ?? '',
            })

            return dates.map((businessDate, index) => {
              const slots = new Map<string, { shift: ReturnType<typeof toRosterShift>; people: string[] }>()
              const off: string[] = []
              for (const personId of personIds) {
                const day = plan.get(personId)?.[index]
                // `none` means nothing rosters this person on this date, which is not the same as a
                // planned day off and does not belong in either column.
                if (!day || day.source === 'none') continue
                if (!day.shifts.length) {
                  off.push(personId)
                  continue
                }
                for (const shift of day.shifts) {
                  const slot = slots.get(shift.id) ?? { shift: toRosterShift(shift), people: [] }
                  slot.people.push(personId)
                  slots.set(shift.id, slot)
                }
              }
              return {
                businessDate,
                slots: [...slots.values()]
                  .sort(
                    (a, b) =>
                      a.shift.start.localeCompare(b.shift.start) || a.shift.name.localeCompare(b.shift.name),
                  )
                  .map((slot) => ({ shift: slot.shift, people: slot.people.map(person) })),
                off: off.map(person),
              }
            })
          }),
        ),
    },

    // ================================================================= leave
    leave: {
      types: {
        list: scoped.leave.types.list
          .use(cap('leave'))
          .use(requires('hr.leave.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [eq(leaveTypes.workspaceId, input.workspaceId)]
              if (!input.includeArchived) where.push(isNull(leaveTypes.archivedAt))
              const rows = await tx
                .select()
                .from(leaveTypes)
                .where(and(...where))
                .orderBy(asc(leaveTypes.order), asc(leaveTypes.name))
              return rows.map(toLeaveType)
            }),
          ),
        create: scoped.leave.types.create
          .use(cap('leave'))
          .use(requires('hr.leave.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const [created] = await tx
                .insert(leaveTypes)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  key: input.key,
                  name: input.name,
                  paid: input.paid,
                  unit: input.unit,
                  color: input.color ?? null,
                  icon: input.icon ?? null,
                  requiresDocumentAfterDays: input.requiresDocumentAfterDays ?? null,
                  countsWorkingDaysOnly: input.countsWorkingDaysOnly,
                  allowNegative: input.allowNegative,
                  maxNegativeMinutes: input.maxNegativeMinutes,
                })
                .returning()
              return created!
            })
            await changed(input.workspaceId, 'leave_type', row.id, 'created')
            return toLeaveType(row)
          }),
        update: scoped.leave.types.update
          .use(cap('leave'))
          .use(requires('hr.leave.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const { workspaceId, leaveTypeId, ...patch } = input
              const set: Record<string, unknown> = { updatedAt: new Date() }
              for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v
              const [updated] = await tx
                .update(leaveTypes)
                .set(set)
                .where(and(eq(leaveTypes.workspaceId, workspaceId), eq(leaveTypes.id, leaveTypeId)))
                .returning()
              if (!updated) throw KernError.notFound('Leave type')
              return updated
            })
            await changed(input.workspaceId, 'leave_type', row.id, 'updated')
            return toLeaveType(row)
          }),
        archive: scoped.leave.types.archive
          .use(cap('leave'))
          .use(requires('hr.leave.manage'))
          .handler(async ({ input }) => {
            // Archived, never deleted: the ledger points at it, and a balance whose type has
            // vanished is a number nobody can explain.
            await db.withWorkspace(input.workspaceId, (tx) =>
              tx
                .update(leaveTypes)
                .set({ archivedAt: new Date() })
                .where(
                  and(eq(leaveTypes.workspaceId, input.workspaceId), eq(leaveTypes.id, input.leaveTypeId)),
                ),
            )
            await changed(input.workspaceId, 'leave_type', input.leaveTypeId, 'deleted')
            return { ok: true as const }
          }),
      },

      balance: {
        get: scoped.leave.balance.get
          .use(cap('leave'))
          .use(requires('hr.leave.view'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              const year = input.periodYear ?? new Date().getUTCFullYear()
              return ledger.balances(tx, input.workspaceId, personId, year)
            }),
          ),
      },

      ledger: {
        list: scoped.leave.ledger.list
          .use(cap('leave'))
          .use(requires('hr.leave.view_ledger'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [
                eq(leaveLedger.workspaceId, input.workspaceId),
                eq(leaveLedger.personId, input.personId),
              ]
              if (input.leaveTypeId) where.push(eq(leaveLedger.leaveTypeId, input.leaveTypeId))
              if (input.periodYear) where.push(eq(leaveLedger.periodYear, input.periodYear))
              const cursor = decodeCursor(input.cursor)
              if (cursor) where.push(after(leaveLedger.effectiveOn, leaveLedger.id, 'desc', cursor))
              // The second sort key is the id rather than `created_at`, and means the same thing:
              // ids here are uuidv7, so they already run in creation order — and unlike `created_at`
              // no two rows can share one, which is what makes the cursor land in exactly one place.
              const { items, nextCursor } = paginate(
                await tx
                  .select()
                  .from(leaveLedger)
                  .where(and(...where))
                  .orderBy(desc(leaveLedger.effectiveOn), desc(leaveLedger.id))
                  .limit(input.limit + 1),
                input.limit,
                (r) => [r.effectiveOn, r.id],
              )
              return { items: items.map(toLedgerEntry), nextCursor }
            }),
          ),
      },

      adjust: scoped.leave.adjust
        .use(cap('leave'))
        .use(requires('hr.leave.adjust'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const year = yearOf(input.effectiveOn)
            await ledger.lockAndRead(tx, input.workspaceId, input.personId, input.leaveTypeId, year)
            return ledger.append(tx, input.workspaceId, {
              personId: input.personId,
              leaveTypeId: input.leaveTypeId,
              kind: input.kind,
              amountMinutes: input.amountMinutes,
              effectiveOn: input.effectiveOn,
              periodYear: year,
              reason: input.reason,
              createdBy: context.principal.userId ?? null,
            })
          })
          await kernel.emit(
            hrEvents.leaveBalanceChanged,
            {
              workspaceId: input.workspaceId,
              personId: input.personId,
              leaveTypeId: input.leaveTypeId,
              deltaMinutes: input.amountMinutes,
            },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'leave_balance', input.personId, 'updated')
          return toLedgerEntry(row)
        }),

      requests: {
        list: scoped.leave.requests.list
          .use(cap('leave'))
          .use(requires('hr.leave.view'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [eq(leaveRequests.workspaceId, input.workspaceId)]

              // An office is other people's absences, so asking for one costs the same permission
              // the team calendar costs. `hr.leave.view` alone must not become a way of reading the
              // whole company — which is exactly what a filter the server ignores had made of it.
              if (input.officeId) {
                await kernel.authz.require(context.principal, 'hr.leave.view_team', {
                  kind: 'workspace',
                  id: input.workspaceId,
                  workspaceId: input.workspaceId,
                })
                const here = await tx
                  .select({ personId: officeAssignments.personId })
                  .from(officeAssignments)
                  .where(
                    and(
                      eq(officeAssignments.workspaceId, input.workspaceId),
                      eq(officeAssignments.officeId, input.officeId),
                      isNull(officeAssignments.effectiveTo),
                    ),
                  )
                // An empty office matches nobody, not everybody.
                where.push(
                  here.length
                    ? inArray(
                        leaveRequests.personId,
                        here.map((h) => h.personId),
                      )
                    : sql`false`,
                )
              }

              if (input.personId) {
                // Naming somebody else is the same act as naming their office, and was the one way
                // through this handler that cost nothing: `hr.leave.view` and a person id read
                // anybody's absences. `personFor` is the rule everywhere else in this module.
                await personFor(tx, input.workspaceId, context, input.personId)
                where.push(eq(leaveRequests.personId, input.personId))
              } else if (!input.officeId && !context.principal.instanceAdmin) {
                // Without an explicit person or office, this is "my requests". Seeing everybody's by
                // default would leak the whole company's absences to any member with hr.leave.view.
                const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
                where.push(me ? eq(leaveRequests.personId, me.id) : sql`false`)
              }

              if (input.status?.length) where.push(inArray(leaveRequests.status, input.status))
              if (input.from) where.push(gte(leaveRequests.endsOn, input.from))
              if (input.to) where.push(lte(leaveRequests.startsOn, input.to))
              const cursor = decodeCursor(input.cursor)
              if (cursor) where.push(after(leaveRequests.startsOn, leaveRequests.id, 'desc', cursor))
              const { items, nextCursor } = paginate(
                await tx
                  .select()
                  .from(leaveRequests)
                  .where(and(...where))
                  .orderBy(desc(leaveRequests.startsOn), desc(leaveRequests.id))
                  .limit(input.limit + 1),
                input.limit,
                (r) => [r.startsOn, r.id],
              )
              return { items: items.map(toLeaveRequest), nextCursor }
            }),
          ),

        get: scoped.leave.requests.get
          .use(cap('leave'))
          .use(requires('hr.leave.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) =>
              toLeaveRequest(await loadRequest(tx, input.workspaceId, input.requestId)),
            ),
          ),

        simulate: scoped.leave.requests.simulate
          .use(cap('leave'))
          .use(requires('hr.leave.request'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              return simulate(tx, input.workspaceId, personId, input)
            }),
          ),

        /**
         * File a request.
         *
         * `idempotencyKey` is the contract's promise that a retried submission is safe, and the
         * server used to store the key without ever reading it. So a retry filed a second request,
         * or died on whichever unique index it reached first — the exploded days for a counted
         * absence, the key itself otherwise. Neither is what the caller was promised.
         *
         * `hr_leave_requests_idem_uq` is what there is to lean on: it already refuses a second row
         * for a key, so honouring the promise is a read before the insert and an answer for the
         * loser of the race.
         */
        create: scoped.leave.requests.create
          .use(cap('leave'))
          .use(requires('hr.leave.request'))
          .handler(async ({ input, context }) => {
            const key = input.idempotencyKey
            // Held as a promise rather than awaited here, so that the duplicate recovery below is
            // one step at the end instead of ninety lines wrapped in a `try`.
            const filing = db.withWorkspace(input.workspaceId, async (tx) => {
              // Before anything is locked or simulated: the same key is the same submission, and
              // answering it with the request it already filed is what "safe to retry" means.
              const already = key ? await byIdempotencyKey(tx, input.workspaceId, key) : undefined
              if (already) return { request: already, personId: already.personId, replay: true as const }

              const personId = await personFor(tx, input.workspaceId, context, input.personId)

              // Everything that spends balance takes the cursor lock first, inside this
              // transaction. Two overlapping requests for the last day cannot both read "enough".
              const year = yearOf(input.startsOn)
              await ledger.lockAndRead(tx, input.workspaceId, personId, input.leaveTypeId, year)

              const sim = await simulate(tx, input.workspaceId, personId, input)
              if (sim.blockers.length)
                // `details`, for the reason `refusePunch` gives: `KernError.conflict`'s second
                // argument is kept on the error object and never serialised, so the blocker code
                // this line has always meant to send was reaching nobody.
                throw new KernError('CONFLICT', sim.blockers[0]!.message, {
                  reason: `hr.leave.${sim.blockers[0]!.code}`,
                })

              const [request] = await tx
                .insert(leaveRequests)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  personId,
                  leaveTypeId: input.leaveTypeId,
                  startsOn: input.startsOn,
                  endsOn: input.endsOn,
                  startPart: input.startPart,
                  endPart: input.endPart,
                  hours: input.hours === null || input.hours === undefined ? null : String(input.hours),
                  workingDays: String(sim.workingDays),
                  minutes: sim.minutes,
                  status: 'pending',
                  reason: input.reason ?? null,
                  documentFileId: input.documentFileId ?? null,
                  idempotencyKey: input.idempotencyKey ?? null,
                })
                .returning()

              // The exploded days are what the partial unique index guards, so this insert is what
              // actually refuses a double booking — before any approval happens.
              await tx.insert(leaveRequestDays).values(
                sim.days.map((d) => ({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  requestId: request!.id,
                  personId,
                  date: d.date,
                  fraction: String(d.fraction),
                  counted: d.counted,
                  status: 'pending',
                })),
              )

              const raised = await approvals.raise(tx, input.workspaceId, {
                subjectType: 'leave',
                subjectId: request!.id,
                summary: `${sim.workingDays} day(s) from ${input.startsOn}`,
                summaryParams: { days: sim.workingDays, from: input.startsOn, to: input.endsOn },
                requesterPersonId: personId,
                requestedBy: context.principal.userId ?? null,
                on: input.startsOn,
              })

              await tx
                .update(leaveRequests)
                .set({ approvalRequestId: raised.request.id })
                .where(eq(leaveRequests.id, request!.id))

              // A chain that resolves to nobody approves immediately — a one-person company has no
              // manager and still has to be able to book time off.
              if (raised.autoApproved)
                await applyApproval(tx, input.workspaceId, request!.id, context.principal.userId ?? null)

              const [fresh] = await tx.select().from(leaveRequests).where(eq(leaveRequests.id, request!.id))
              // Carried out of the transaction rather than emitted here: an approver must not be
              // handed a card for a request a rollback is about to erase. `firstStepApprovers` is
              // empty exactly when the chain resolved to nobody — the auto-approval above.
              return {
                request: fresh!,
                personId,
                replay: false as const,
                approval: {
                  requestId: raised.request.id,
                  approverIds: raised.firstStepApprovers,
                  // Resolved here because it needs `tx`, delivered outside because a notification
                  // cannot be rolled back. Person ids are HR's identity and accounts are core's, so
                  // the translation happens once, on the way out.
                  userIds: await accountsOf(tx, input.workspaceId, raised.firstStepApprovers),
                  summary: raised.request.summary,
                  summaryParams: raised.request.summaryParams,
                  actorId: raised.request.requestedBy,
                },
              }
            })

            const result = await filing.catch(async (err: unknown) => {
              // The other half of a double submit: two clicks a browser sends before the first has
              // answered both pass the read above, both reach the insert, and the unique index
              // refuses one. The loser lost a race it was never meant to enter, so it is answered
              // with the request that won rather than with a constraint error. The re-read needs a
              // new transaction — the failed one is aborted and will not answer another query.
              if (!key || !isUniqueViolation(err, 'hr_leave_requests_idem_uq')) throw err
              const won = await db.withWorkspace(input.workspaceId, (tx) =>
                byIdempotencyKey(tx, input.workspaceId, key),
              )
              if (!won) throw err
              return { request: won, personId: won.personId, replay: true as const }
            })

            // A replay files nothing, so it announces nothing. Emitting `leaveRequested` again would
            // put a second card in an approver's inbox for one request — the outcome the key exists
            // to prevent, arriving by a different route.
            if (result.replay) return toLeaveRequest(result.request)

            await kernel.emit(
              hrEvents.leaveRequested,
              {
                requestId: result.request.id,
                workspaceId: input.workspaceId,
                personId: result.personId,
                startsOn: input.startsOn,
                endsOn: input.endsOn,
              },
              { workspaceId: input.workspaceId, actorId: context.principal.userId },
            )
            // Second, and only when somebody is actually waiting: the request exists, and these are
            // the people the *first* step is on. Nothing for a chain that resolved to nobody — that
            // was approved on the way in and is not waiting on anyone. The ids are person ids, the
            // same identity the rest of `hr.*` carries.
            if (result.approval.approverIds.length) {
              await kernel.emit(
                hrEvents.approvalRequested,
                {
                  requestId: result.approval.requestId,
                  workspaceId: input.workspaceId,
                  subjectType: 'leave',
                  subjectId: result.request.id,
                  approverIds: result.approval.approverIds,
                },
                { workspaceId: input.workspaceId, actorId: context.principal.userId },
              )
              // And then the approvers themselves. The event is for other modules; this is for the
              // people whose signature the request is now waiting on.
              await notifyApprovers({
                workspaceId: input.workspaceId,
                requestId: result.approval.requestId,
                subjectType: 'leave',
                summary: result.approval.summary,
                summaryParams: result.approval.summaryParams,
                userIds: result.approval.userIds,
                actorId: result.approval.actorId,
              })
            }
            await changed(input.workspaceId, 'leave_request', result.request.id, 'created')
            return toLeaveRequest(result.request)
          }),

        cancel: scoped.leave.requests.cancel
          .use(cap('leave'))
          .use(requires('hr.leave.request'))
          .handler(async ({ input, context }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const request = await loadRequest(tx, input.workspaceId, input.requestId)
              // A reason beside the sentence, because the sentence is English and the reason is what
              // a client can translate. Two states, not one: "withdrawn" is the requester taking it
              // back and "cancelled" is somebody else doing so, and telling a person their own
              // withdrawal was "already cancelled" is a small lie about who did what.
              if (request.status === 'cancelled')
                throw KernError.conflict('That request is already cancelled.', 'hr.leave.already_cancelled')
              if (request.status === 'withdrawn')
                throw KernError.conflict('That request was already withdrawn.', 'hr.leave.already_withdrawn')

              const year = yearOf(request.startsOn)
              await ledger.lockAndRead(tx, input.workspaceId, request.personId, request.leaveTypeId, year)

              // Approved leave is *reversed*, not deleted. "She booked it and cancelled" and "she
              // never booked it" are different facts, and only one of them is true.
              if (request.status === 'approved')
                for (const entry of await ledger.entriesFor(tx, input.workspaceId, request.id))
                  if (entry.kind === 'consumption')
                    await ledger.reverse(
                      tx,
                      input.workspaceId,
                      entry.id,
                      input.reason ?? 'Leave cancelled',
                      context.principal.userId ?? null,
                      todayIso(),
                    )

              await approvals.cancel(tx, input.workspaceId, 'leave', request.id)
              const next = request.status === 'approved' ? 'withdrawn' : 'cancelled'
              await tx
                .update(leaveRequestDays)
                .set({ status: next })
                .where(eq(leaveRequestDays.requestId, request.id))
              const [updated] = await tx
                .update(leaveRequests)
                .set({ status: next, decidedAt: new Date(), updatedAt: new Date() })
                .where(eq(leaveRequests.id, request.id))
                .returning()
              return updated!
            })
            await kernel.emit(
              hrEvents.leaveDecided,
              {
                requestId: row.id,
                workspaceId: input.workspaceId,
                personId: row.personId,
                status: row.status,
                startsOn: row.startsOn,
                endsOn: row.endsOn,
              },
              { workspaceId: input.workspaceId, actorId: context.principal.userId },
            )
            await changed(input.workspaceId, 'leave_request', row.id, 'updated')
            return toLeaveRequest(row)
          }),
      },

      team: {
        calendar: scoped.leave.team.calendar
          .use(cap('leave'))
          .use(requires('hr.leave.view_team'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const rows = await tx
                .select()
                .from(leaveRequests)
                .where(
                  and(
                    eq(leaveRequests.workspaceId, input.workspaceId),
                    inArray(leaveRequests.status, ['pending', 'approved']),
                    lte(leaveRequests.startsOn, input.to),
                    gte(leaveRequests.endsOn, input.from),
                  ),
                )
              if (!rows.length) return []

              const personIds = [...new Set(rows.map((r) => r.personId))]
              const persons = await tx
                .select({ id: people.id, displayName: people.displayName })
                .from(people)
                .where(and(eq(people.workspaceId, input.workspaceId), inArray(people.id, personIds)))
              const nameById = new Map(persons.map((p) => [p.id, p.displayName]))
              const types = await tx
                .select()
                .from(leaveTypes)
                .where(eq(leaveTypes.workspaceId, input.workspaceId))
              const typeById = new Map(types.map((t) => [t.id, t]))

              // Most companies want the team to know somebody is away without knowing it is sick
              // leave, so the type is named only for somebody who may read the ledger.
              const maySeeType = await kernel.authz.can(context.principal, 'hr.leave.view_ledger', {
                kind: 'workspace',
                id: input.workspaceId,
                workspaceId: input.workspaceId,
              })

              let filtered = rows
              if (input.officeId) {
                const here = await tx
                  .select({ personId: officeAssignments.personId })
                  .from(officeAssignments)
                  .where(
                    and(
                      eq(officeAssignments.workspaceId, input.workspaceId),
                      eq(officeAssignments.officeId, input.officeId),
                      isNull(officeAssignments.effectiveTo),
                    ),
                  )
                const ids = new Set(here.map((h) => h.personId))
                filtered = filtered.filter((r) => ids.has(r.personId))
              }
              if (input.orgUnitId) {
                const ids = new Set(await unitMemberIds(tx, input.workspaceId, input.orgUnitId, true))
                filtered = filtered.filter((r) => ids.has(r.personId))
              }

              return filtered.map((r) => {
                const type = typeById.get(r.leaveTypeId)
                return {
                  personId: r.personId,
                  displayName: nameById.get(r.personId) ?? 'Unknown',
                  requestId: r.id,
                  startsOn: r.startsOn,
                  endsOn: r.endsOn,
                  status: r.status as never,
                  leaveTypeName: maySeeType ? (type?.name ?? null) : null,
                  color: type?.color ?? null,
                }
              })
            }),
          ),
      },
    },

    // ================================================================= approvals
    approvals: {
      /**
       * Everything waiting on the caller. No permission: an inbox of what *you* must decide is
       * yours by definition, and the engine only lists steps you are named on.
       *
       * The one paged list here that still answers `nextCursor: null`, and the only one that cannot
       * be fixed from this file: the page is cut inside `ApprovalService.inboxFor`, which takes a
       * limit and no cursor. Honouring one means widening that signature and pushing
       * `after(approvalRequests.requestedAt, approvalRequests.id, 'desc', …)` into its final query —
       * ordering it by `(requested_at, id)` on the way, so the cursor has something unique to land
       * on. Filtering the rows it returns would not do: it has already truncated them.
       */
      inbox: scoped.approvals.inbox.handler(({ input, context }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
          if (!me) return { items: [], nextCursor: null }
          const rows = await approvals.inboxFor(tx, input.workspaceId, me.id, input.status, input.limit)
          const items = []
          for (const r of rows) items.push(await hydrateApproval(tx, r))
          return { items, nextCursor: null }
        }),
      ),

      get: scoped.approvals.get.handler(({ input }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const [row] = await tx
            .select()
            .from(approvalRequests)
            .where(
              and(
                eq(approvalRequests.workspaceId, input.workspaceId),
                eq(approvalRequests.id, input.requestId),
              ),
            )
            .limit(1)
          if (!row) throw KernError.notFound('Approval request')
          return hydrateApproval(tx, row)
        }),
      ),

      decide: scoped.approvals.decide.handler(async ({ input, context }) => {
        const outcome = await db.withWorkspace(input.workspaceId, async (tx) => {
          const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
          if (!me) throw KernError.forbidden('You have no employee record in this workspace')

          const result = await approvals.decide(
            tx,
            input.workspaceId,
            input.requestId,
            me.id,
            input.decision,
            input.comment ?? null,
            input.onBehalfOfId ?? null,
          )

          // The approval engine knows nothing about leave. Applying the decision to the subject is
          // the caller's job, which is what keeps the engine reusable for regularization and
          // overtime later.
          //
          // Through the same appliers the timeout sweep is given, rather than a branch of its own:
          // this used to be a `switch` on `subjectType` here and nothing at all in the job, which is
          // how a deadline could approve a request and leave its leave unbooked. One table of
          // subject types, and adding overtime means adding a line to it and nothing here.
          const request = result.request
          if (result.status !== 'pending') {
            const apply = subjects.appliersFor(context.principal.userId ?? null)[request.subjectType]
            await apply?.(tx, input.workspaceId, request, result.status)
          }

          const [fresh] = await tx
            .select()
            .from(approvalRequests)
            .where(
              and(
                eq(approvalRequests.workspaceId, input.workspaceId),
                eq(approvalRequests.id, input.requestId),
              ),
            )
          return { hydrated: await hydrateApproval(tx, fresh!), request: fresh! }
        })

        await kernel.emit(
          hrEvents.approvalDecided,
          {
            requestId: outcome.request.id,
            workspaceId: input.workspaceId,
            subjectType: outcome.request.subjectType,
            subjectId: outcome.request.subjectId,
            status: outcome.request.status,
          },
          { workspaceId: input.workspaceId, actorId: context.principal.userId },
        )
        await changed(input.workspaceId, 'approval', outcome.request.id, 'updated')
        return outcome.hydrated
      }),

      chains: {
        list: scoped.approvals.chains.list
          .use(cap('approvals'))
          .use(requires('hr.approval.manage'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [
                eq(approvalChains.workspaceId, input.workspaceId),
                isNull(approvalChains.archivedAt),
              ]
              if (input.subjectType) where.push(eq(approvalChains.subjectType, input.subjectType))
              const rows = await tx
                .select()
                .from(approvalChains)
                .where(and(...where))
                .orderBy(asc(approvalChains.name))
              return rows.map(toChain)
            }),
          ),
        create: scoped.approvals.chains.create
          .use(cap('approvals'))
          .use(requires('hr.approval.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              if (input.isDefault) await clearDefaultChain(tx, input.workspaceId, input.subjectType)
              const [created] = await tx
                .insert(approvalChains)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  name: input.name,
                  subjectType: input.subjectType,
                  spec: input.spec as unknown as Record<string, unknown>,
                  isDefault: input.isDefault,
                })
                .returning()
              return created!
            })
            await changed(input.workspaceId, 'approval_chain', row.id, 'created')
            return toChain(row)
          }),
        update: scoped.approvals.chains.update
          .use(cap('approvals'))
          .use(requires('hr.approval.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const [existing] = await tx
                .select()
                .from(approvalChains)
                .where(
                  and(
                    eq(approvalChains.workspaceId, input.workspaceId),
                    eq(approvalChains.id, input.chainId),
                  ),
                )
                .limit(1)
              if (!existing) throw KernError.notFound('Approval chain')
              if (input.isDefault) await clearDefaultChain(tx, input.workspaceId, existing.subjectType)
              const set: Record<string, unknown> = { updatedAt: new Date() }
              if (input.name !== undefined) set.name = input.name
              if (input.spec !== undefined) set.spec = input.spec
              if (input.isDefault !== undefined) set.isDefault = input.isDefault
              const [updated] = await tx
                .update(approvalChains)
                .set(set)
                .where(
                  and(
                    eq(approvalChains.workspaceId, input.workspaceId),
                    eq(approvalChains.id, input.chainId),
                  ),
                )
                .returning()
              return updated!
            })
            await changed(input.workspaceId, 'approval_chain', row.id, 'updated')
            return toChain(row)
          }),
        archive: scoped.approvals.chains.archive
          .use(cap('approvals'))
          .use(requires('hr.approval.manage'))
          .handler(async ({ input }) => {
            // In-flight requests carry their own snapshot of the chain, so archiving one cannot
            // strand an approval half-signed.
            await db.withWorkspace(input.workspaceId, (tx) =>
              tx
                .update(approvalChains)
                .set({ archivedAt: new Date(), isDefault: false })
                .where(
                  and(
                    eq(approvalChains.workspaceId, input.workspaceId),
                    eq(approvalChains.id, input.chainId),
                  ),
                ),
            )
            await changed(input.workspaceId, 'approval_chain', input.chainId, 'deleted')
            return { ok: true as const }
          }),
      },

      delegations: scoped.approvals.delegations
        .use(cap('approvals'))
        .use(requires('hr.approval.delegate'))
        .handler(({ input, context }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const personId = await personFor(tx, input.workspaceId, context, input.personId)
            const rows = await tx
              .select()
              .from(delegations)
              .where(
                and(
                  eq(delegations.workspaceId, input.workspaceId),
                  or(eq(delegations.fromPersonId, personId), eq(delegations.toPersonId, personId)),
                ),
              )
              .orderBy(desc(delegations.startsOn))
            return rows.map(toDelegation)
          }),
        ),

      delegate: scoped.approvals.delegate
        .use(cap('approvals'))
        .use(requires('hr.approval.delegate'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
            if (!me) throw KernError.forbidden('You have no employee record in this workspace')
            if (me.id === input.toPersonId)
              throw KernError.badRequest('You cannot delegate your approvals to yourself.')
            if (input.endsOn < input.startsOn)
              throw KernError.badRequest('A delegation cannot end before it starts.')
            const [created] = await tx
              .insert(delegations)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                fromPersonId: me.id,
                toPersonId: input.toPersonId,
                subjectType: input.subjectType ?? null,
                startsOn: input.startsOn,
                endsOn: input.endsOn,
                reason: input.reason ?? null,
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'delegation', row.id, 'created')
          return toDelegation(row)
        }),

      revokeDelegation: scoped.approvals.revokeDelegation
        .use(cap('approvals'))
        .use(requires('hr.approval.delegate'))
        .handler(async ({ input, context }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
            const [row] = await tx
              .select()
              .from(delegations)
              .where(
                and(eq(delegations.workspaceId, input.workspaceId), eq(delegations.id, input.delegationId)),
              )
              .limit(1)
            if (!row) throw KernError.notFound('Delegation')
            // Only the person who gave it away may take it back — otherwise a delegate could quietly
            // extend their own authority by revoking the competition.
            if (row.fromPersonId !== me?.id)
              throw KernError.forbidden('Only the person who delegated may revoke it')
            await tx.delete(delegations).where(eq(delegations.id, row.id))
          })
          await changed(input.workspaceId, 'delegation', input.delegationId, 'deleted')
          return { ok: true as const }
        }),
    },

    // ================================================================= custom fields
    fields: {
      /**
       * Deliberately not narrowed by the record scope, unlike everything else on `hr.person.view`.
       *
       * These are field *definitions* — a workspace's shape, not anybody's data. Every screen that
       * renders a person has to know what "hire_buddy" is called and whether it is a date before it
       * can draw a single row, and a reader who may see one person's record needs the whole schema
       * to read that one person. There is nothing here to scope to a person.
       */
      list: scoped.fields.list.use(requires('hr.person.view')).handler(({ input }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const where = [eq(customFieldDefs.workspaceId, input.workspaceId)]
          if (!input.includeArchived) where.push(isNull(customFieldDefs.archivedAt))
          const rows = await tx
            .select()
            .from(customFieldDefs)
            .where(and(...where))
            .orderBy(asc(customFieldDefs.order), asc(customFieldDefs.name))
          return rows.map(toField)
        }),
      ),
      create: scoped.fields.create.use(requires('hr.field.manage')).handler(async ({ input }) => {
        const row = await db.withWorkspace(input.workspaceId, async (tx) => {
          const [created] = await tx
            .insert(customFieldDefs)
            .values({
              id: uuidv7(),
              workspaceId: input.workspaceId,
              key: input.key,
              name: input.name,
              type: input.type,
              options: input.options ?? null,
              required: input.required,
              sensitive: input.sensitive,
              section: input.section,
            })
            .returning()
          return created!
        })
        await changed(input.workspaceId, 'field', row.id, 'created')
        return toField(row)
      }),
      update: scoped.fields.update.use(requires('hr.field.manage')).handler(async ({ input }) => {
        const row = await db.withWorkspace(input.workspaceId, async (tx) => {
          const { workspaceId, fieldId, ...patch } = input
          const set: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v
          const [updated] = await tx
            .update(customFieldDefs)
            .set(set)
            .where(and(eq(customFieldDefs.workspaceId, workspaceId), eq(customFieldDefs.id, fieldId)))
            .returning()
          if (!updated) throw KernError.notFound('Field')
          return updated
        })
        await changed(input.workspaceId, 'field', row.id, 'updated')
        return toField(row)
      }),
      archive: scoped.fields.archive.use(requires('hr.field.manage')).handler(async ({ input }) => {
        // Archived, never dropped: the values stay in `people.custom`, so re-enabling the field
        // brings back what everybody had rather than a column of blanks.
        await db.withWorkspace(input.workspaceId, (tx) =>
          tx
            .update(customFieldDefs)
            .set({ archivedAt: new Date() })
            .where(
              and(eq(customFieldDefs.workspaceId, input.workspaceId), eq(customFieldDefs.id, input.fieldId)),
            ),
        )
        await changed(input.workspaceId, 'field', input.fieldId, 'deleted')
        return { ok: true as const }
      }),
    },

    // ================================================================= reports
    /**
     * Four aggregates, and the two rules that decide every line of them.
     *
     * **A report is a separate grant, and it says which one produced it.** Each of these costs
     * `hr.report.view` *and* the key that already guards the rows it sums — `hr.attendance.view_team`
     * is what reading a whole office's day sheets costs on `attendance.days.list`, and
     * `hr.leave.view_team` is what reading somebody else's balance costs through `personFor`. So a
     * report reaches no further than the rows a reader could already page through, and it does not
     * narrow below them either: the population is never intersected with
     * `HrAccessService.visiblePersonIds`, which withholds *fields* nothing here reads and would
     * otherwise leave two managers reading different totals under one title. A reader holding
     * neither key gets nothing at all rather than a one-row self-report.
     *
     * Both `view_team` keys are declared `scope: 'object'` and are asked here at **workspace** scope,
     * which is what `requires()` does and what every existing caller does explicitly. Binding one to
     * an office id narrows nothing today — `Authz.can(object, id)` falls through to the
     * workspace-level effective set — so the response says `askedAt: 'workspace'` rather than
     * letting a reader infer a scoping that is not happening.
     *
     * **Nothing here writes.** No recompute, no refresh: `recomputeDay` is the only thing entitled to
     * decide whether a day may move, and a report over a filed month must not be able to move it.
     */
    reports: {
      /**
       * Scheduled against worked, per person.
       *
       * `workedRatio` is null wherever nothing was scheduled. That is not a rare edge: somebody with
       * no schedule assignment resolves to `NO_SCHEDULE`, owes no hours, and is written down as
       * `present` with `scheduledMinutes: 0` — so a percentage would be a division by zero dressed
       * up as 0% or 100%. `noScheduleDays` counts them from the policy stamp, which is the only
       * positive evidence; `scheduledMinutes === 0` is also true of a scheduled rest day.
       */
      attendance: scoped.reports.attendance
        .use(cap('attendance'))
        .use(requires('hr.report.view'))
        .use(requires('hr.attendance.view_team'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const { slice, population, rows } = await dayReport(tx, input)
            const totals = {
              days: sum(rows, (r) => r.days),
              scheduledMinutes: sum(rows, (r) => r.scheduledMinutes),
              workedMinutes: sum(rows, (r) => r.workedMinutes),
              scheduledWorkedMinutes: sum(rows, (r) => r.scheduledWorkedMinutes),
              breakMinutes: sum(rows, (r) => r.breakMinutes),
              lateMinutes: sum(rows, (r) => r.lateMinutes),
              earlyLeaveMinutes: sum(rows, (r) => r.earlyLeaveMinutes),
              noScheduleDays: sum(rows, (r) => r.noScheduleDays),
              unknownScheduleDays: sum(rows, (r) => r.unknownScheduleDays),
            }
            const shown = [...rows]
              .sort((a, b) => b.workedMinutes - a.workedMinutes || a.personId.localeCompare(b.personId))
              .slice(0, input.limit)
            const names = await reports.namesOf(
              tx,
              input.workspaceId,
              shown.map((r) => r.personId),
            )
            return {
              header: reportHeader({
                input,
                slice,
                population,
                counted: rows.length,
                shown: shown.length,
                permissions: ['hr.report.view', 'hr.attendance.view_team'],
              }),
              finality: mergeFinality(rows),
              totals: {
                ...totals,
                workedRatio: ratio(totals.scheduledWorkedMinutes, totals.scheduledMinutes),
              },
              rows: shown.map((r) => ({
                personId: r.personId,
                displayName: names.get(r.personId) ?? '',
                days: r.days,
                scheduledMinutes: r.scheduledMinutes,
                workedMinutes: r.workedMinutes,
                scheduledWorkedMinutes: r.scheduledWorkedMinutes,
                breakMinutes: r.breakMinutes,
                lateMinutes: r.lateMinutes,
                earlyLeaveMinutes: r.earlyLeaveMinutes,
                workedRatio: ratio(r.scheduledWorkedMinutes, r.scheduledMinutes),
                noScheduleDays: r.noScheduleDays,
                unknownScheduleDays: r.unknownScheduleDays,
              })),
            }
          }),
        ),

      /**
       * Overtime, and how much of it an annual ceiling would not take.
       *
       * `beyondCapMinutes` is summed as a nullable column and never coalesced: Postgres answers NULL
       * when every day in the group is null, which is exactly "no ceiling was in force on any of
       * these days" — a different fact from "one applied and nothing passed it". `cappedDays` is
       * beside it so a reader can see which of the two they are looking at.
       */
      overtime: scoped.reports.overtime
        .use(cap('attendance'))
        .use(requires('hr.report.view'))
        .use(requires('hr.attendance.view_team'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const { slice, population, rows } = await dayReport(tx, input)
            const shown = [...rows]
              .sort((a, b) => b.overtimeMinutes - a.overtimeMinutes || a.personId.localeCompare(b.personId))
              .slice(0, input.limit)
            const names = await reports.namesOf(
              tx,
              input.workspaceId,
              shown.map((r) => r.personId),
            )
            return {
              header: reportHeader({
                input,
                slice,
                population,
                counted: rows.length,
                shown: shown.length,
                permissions: ['hr.report.view', 'hr.attendance.view_team'],
              }),
              finality: mergeFinality(rows),
              totals: {
                days: sum(rows, (r) => r.days),
                overtimeMinutes: sum(rows, (r) => r.overtimeMinutes),
                // The days are added up; the minutes are not, unless at least one day had a ceiling.
                beyondCapMinutes: capTotal(rows.map((r) => r.beyondCapMinutes)).beyondCapMinutes,
                cappedDays: sum(rows, (r) => r.cappedDays),
                uncappedDays: sum(rows, (r) => r.uncappedDays),
              },
              rows: shown.map((r) => ({
                personId: r.personId,
                displayName: names.get(r.personId) ?? '',
                days: r.days,
                overtimeMinutes: r.overtimeMinutes,
                beyondCapMinutes: r.beyondCapMinutes,
                cappedDays: r.cappedDays,
                uncappedDays: r.uncappedDays,
              })),
            }
          }),
        ),

      /**
       * Expected working days, minus days worked, minus approved leave.
       *
       * **Never `status = 'absent'`.** `attendance_days` holds a row only where somebody punched —
       * the punch path, a regularization, auto-clock-out and the two recompute jobs are the only
       * writers, and not one of them creates a row for a day nobody clocked in on. Counting absent
       * rows therefore reports near-zero absence in every workspace and looks entirely healthy while
       * doing it. The denominator is built from the calendar instead, and the two populations it
       * cannot answer for are named rather than dropped: somebody with no schedule assignment owes
       * no hours, and an office with no calendar attached would only be measured against an assumed
       * Monday–Friday week.
       */
      absence: scoped.reports.absence
        .use(cap('attendance'))
        .use(requires('hr.report.view'))
        .use(requires('hr.attendance.view_team'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const slice = sliceOf(input)
            // Always a per-day report, sliced or not: every person's expectation is their own
            // office's calendar on each day, which is a ladder walk per day either way.
            const refusal = rangeRefusal({ from: input.from, to: input.to, perDay: true })
            if (refusal) throw KernError.badRequest(refusal)

            const population = await reports.population(tx, input.workspaceId, slice, input.from, input.to)
            const dates = datesBetween(input.from, input.to)
            const resolutions =
              population.resolutions ??
              (await reports.resolveByDate(tx, input.workspaceId, population.personIds, dates))

            const calendarIds = new Set<string>()
            for (const perDate of resolutions.values())
              for (const resolution of perDate.values())
                if (resolution.calendarId) calendarIds.add(resolution.calendarId)
            // Composed once per calendar rather than once per person: the holidays are a property
            // of the office, and a workspace has a handful of calendars behind however many people.
            const calendarDaysById = new Map<
              string,
              Array<{ date: string; name: string; workingFraction: number }>
            >()
            for (const calendarId of calendarIds)
              calendarDaysById.set(
                calendarId,
                (await composedDays(tx, input.workspaceId, calendarId, input.from, input.to)).map((d) => ({
                  date: d.date,
                  name: d.name,
                  workingFraction: d.workingFraction,
                })),
              )

            const scheduled = await reports.scheduledPeople(
              tx,
              input.workspaceId,
              population.personIds,
              input.from,
              input.to,
            )
            // `leave` is a capability of its own, and a workspace that has it off holds no approved
            // leave to subtract. The column is then absent rather than zero, and `leaveCounted` says
            // so — a zero would read as "nobody was away", which is a claim rather than a silence.
            const leaveCounted = (await kernel.capabilities(input.workspaceId, MODULE_ID)).has('leave')

            const basisByPerson = new Map<string, AbsenceBasis>()
            const groups = new Map<
              string,
              { personIds: string[]; expected: Array<{ date: string; fraction: number }> }
            >()
            for (const personId of population.personIds) {
              const mine = population.datesByPerson?.get(personId) ?? dates
              const { expected, hasCalendar } = expectedDaysFor(
                mine,
                (date) => resolutions.get(date)?.get(personId),
                (calendarId) => calendarDaysById.get(calendarId) ?? [],
              )
              const basis = absenceBasis({ hasSchedule: scheduled.has(personId), hasCalendar })
              basisByPerson.set(personId, basis)
              if (basis !== 'calendar') continue
              const signature = expected.map((e) => `${e.date}:${e.fraction}`).join(',')
              const existing = groups.get(signature)
              if (existing) existing.personIds.push(personId)
              else groups.set(signature, { personIds: [personId], expected })
            }

            const measured: AbsenceAggregateRow[] = []
            for (const group of groups.values())
              measured.push(
                ...(await reports.absenceAggregate(
                  tx,
                  input.workspaceId,
                  group.personIds,
                  group.expected,
                  leaveCounted,
                )),
              )
            const byPerson = new Map(measured.map((r) => [r.personId, r]))

            const rows = [...basisByPerson].map(([personId, basis]) => {
              const found = byPerson.get(personId)
              if (basis !== 'calendar' || !found)
                return {
                  personId,
                  basis,
                  expectedDays: null,
                  workedDays: null,
                  leaveDays: null,
                  absentDays: null,
                  absenceRate: null,
                }
              const split = absenceSplit(found)
              return {
                personId,
                basis,
                expectedDays: found.expectedDays,
                workedDays: found.workedDays,
                leaveDays: found.leaveDays,
                absentDays: split.absentDays,
                absenceRate: split.absenceRate,
              }
            })

            const totalExpected = sum(measured, (r) => r.expectedDays)
            const totalWorked = sum(measured, (r) => r.workedDays)
            const totalLeave = leaveCounted ? sum(measured, (r) => r.leaveDays ?? 0) : null
            const totalSplit = absenceSplit({
              expectedDays: totalExpected,
              workedDays: totalWorked,
              leaveDays: totalLeave,
            })

            // Measured people first, ordered by what a reader came for; the two named buckets after
            // them, so they are visible rather than truncated away by the row limit.
            const shown = rows
              .sort(
                (a, b) =>
                  (a.basis === 'calendar' ? 0 : 1) - (b.basis === 'calendar' ? 0 : 1) ||
                  (b.absentDays ?? -1) - (a.absentDays ?? -1) ||
                  a.personId.localeCompare(b.personId),
              )
              .slice(0, input.limit)
            const names = await reports.namesOf(
              tx,
              input.workspaceId,
              shown.map((r) => r.personId),
            )

            return {
              header: reportHeader({
                input,
                slice: { ...slice, name: population.sliceName },
                population: population.personIds.length,
                counted: measured.length,
                shown: shown.length,
                permissions: ['hr.report.view', 'hr.attendance.view_team'],
                attribution: 'each_day' as const,
              }),
              finality: mergeFinality(measured),
              leaveCounted,
              totals: {
                measured: measured.length,
                expectedDays: round2(totalExpected),
                workedDays: round2(totalWorked),
                leaveDays: totalLeave === null ? null : round2(totalLeave),
                absentDays: totalSplit.absentDays,
                absenceRate: totalSplit.absenceRate,
              },
              excluded: {
                noSchedule: rows.filter((r) => r.basis === 'no_schedule').length,
                noCalendar: rows.filter((r) => r.basis === 'no_calendar').length,
              },
              rows: shown.map((r) => ({ ...r, displayName: names.get(r.personId) ?? '' })),
            }
          }),
        ),

      /**
       * Every balance in the population, per leave type, for one entitlement year.
       *
       * Summed from `leave_ledger` and nothing else — the cursor exists to be locked, and a cache
       * that is also the source of truth eventually disagrees with it. There is no entitlement, no
       * allowance remaining and no year-end projection: all three need an accrual policy, the
       * `leave_accrual` capability ships off, and a company that grants a fixed allowance on 1
       * January has a perfectly real balance and no policy at all. `dayLengthMinutes` is published
       * because `toUnit` renders a `day` at a constant eight hours, and a report that prints days
       * without saying which day is the quiet way this goes wrong.
       */
      leaveBalance: scoped.reports.leaveBalance
        .use(cap('leave'))
        .use(requires('hr.report.view'))
        .use(requires('hr.leave.view_team'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const asOf = input.asOf ?? todayIso()
            const periodYear = input.periodYear ?? yearOf(asOf)
            const slice = sliceOf(input)
            // A balance is a position rather than a per-day quantity, so it is attributed as of one
            // date and the header says which. Resolving it per day would be arithmetic nobody asked
            // for on a figure that does not vary by day.
            const population = await reports.population(tx, input.workspaceId, slice, asOf, asOf)
            const all = await reports.leaveBalances(tx, input.workspaceId, population.personIds, periodYear)

            const counted = [...new Set(all.map((r) => r.personId))]
            const names = await reports.namesOf(tx, input.workspaceId, counted)
            const shownPeople = counted
              .sort((a, b) => (names.get(a) ?? '').localeCompare(names.get(b) ?? '') || a.localeCompare(b))
              .slice(0, input.limit)
            const keep = new Set(shownPeople)

            const totals = new Map<string, (typeof all)[number] & { people: number }>()
            for (const row of all) {
              const found = totals.get(row.leaveTypeId)
              if (found) {
                found.balanceMinutes += row.balanceMinutes
                found.bookedMinutes += row.bookedMinutes
                found.pendingMinutes += row.pendingMinutes
                found.availableMinutes += row.availableMinutes
                found.people += 1
              } else totals.set(row.leaveTypeId, { ...row, people: 1 })
            }

            return {
              header: reportHeader({
                input: { from: asOf, to: asOf, by: input.by },
                slice: { ...slice, name: population.sliceName },
                population: population.personIds.length,
                counted: counted.length,
                shown: shownPeople.length,
                permissions: ['hr.report.view', 'hr.leave.view_team'],
                attribution: 'as_of_date' as const,
                attributionOn: asOf,
              }),
              periodYear,
              dayLengthMinutes: MINUTES_PER_DAY,
              totals: [...totals.values()]
                .sort((a, b) => a.order - b.order || a.leaveTypeName.localeCompare(b.leaveTypeName))
                .map((t) => ({
                  leaveTypeId: t.leaveTypeId,
                  leaveTypeName: t.leaveTypeName,
                  unit: t.unit,
                  people: t.people,
                  balanceMinutes: t.balanceMinutes,
                  bookedMinutes: t.bookedMinutes,
                  pendingMinutes: t.pendingMinutes,
                  availableMinutes: t.availableMinutes,
                })),
              rows: all
                .filter((r) => keep.has(r.personId))
                .sort(
                  (a, b) =>
                    (names.get(a.personId) ?? '').localeCompare(names.get(b.personId) ?? '') ||
                    a.order - b.order ||
                    a.leaveTypeName.localeCompare(b.leaveTypeName),
                )
                .map((r) => ({
                  personId: r.personId,
                  displayName: names.get(r.personId) ?? '',
                  leaveTypeId: r.leaveTypeId,
                  leaveTypeName: r.leaveTypeName,
                  unit: r.unit,
                  balanceMinutes: r.balanceMinutes,
                  bookedMinutes: r.bookedMinutes,
                  pendingMinutes: r.pendingMinutes,
                  availableMinutes: r.availableMinutes,
                  balance: r.balance,
                  available: r.available,
                })),
            }
          }),
        ),
    },

    // ================================================================= payroll export
    /**
     * The monthly handover to whoever runs payroll, for one legal entity, frozen at v1.
     *
     * **Three keys, and the middle one is new.** `hr.payroll.export` ships in this change because
     * this is the change that makes a writer exist — it is granted to nobody by default, like
     * `hr.person.view_sensitive` and `hr.privacy.manage`, so on a fresh workspace only an owner can
     * reach it. On top of it, the same second-check rule the reports follow:
     * `hr.attendance.view_team` for the hours file and `hr.leave.view_team` for the leave file,
     * because an export must not answer what the row-level procedure would refuse.
     *
     * **One capability gate, and it carries two more inside it.** `payroll_export` declares
     * `dependsOn: ['core', 'periods', 'attendance']`, and `kernel.capabilities` prunes a capability
     * whose dependencies are off — so a workspace with attendance off has no day sheet to hand over
     * and this answers 404, and a workspace with periods off would have every day open, the refusal
     * below would fire on every call, and a switch that only ever produces an error is worse than no
     * switch. Gating on the three separately would say the same thing three times and let them drift;
     * the dependency list is where that belongs.
     *
     * That pruning is measured rather than assumed, because the whole gate rests on it: against a real
     * kernel, `payroll.export.v1` answers `NOT_FOUND` with `attendance` off, with `periods` off, and
     * with `payroll_export` itself off, and reaches the handler only when all three are on. Worth
     * knowing when reading a support ticket: all three refusals say *`hr.payroll_export` is not
     * enabled*, so an administrator looking at a switch that is plainly on is looking at a dependency
     * that is off.
     *
     * **Nothing here writes**, including no `sensitive_access_log` row: this export reads no
     * sensitive field. Adding `iban` would make it a bulk decrypt of every employee's bank account
     * and would owe one audit row per person with `via: 'export'` — a different procedure with its
     * own key, not a column on this one.
     */
    payroll: {
      export: {
        /**
         * One entity, one period, two CSVs and a manifest.
         *
         * Synchronous, and that is checked rather than preferred: `core.files.createUpload` needs a
         * user principal and returns a presigned PUT for a browser, so a background job cannot mint a
         * `FileObject` at all, and writing bytes straight into `kernel.storage` would orphan an
         * object `core.files.*` cannot see and nothing will ever delete.
         *
         * It throws the first refusal `collect` found rather than emitting a row of zeros — an open
         * period without `draft`, an entity with nobody in it, or somebody with no employment record
         * covering their days here. The preview below returns all of them instead, so a screen can
         * show the reader every reason at once before anybody downloads anything.
         */
        v1: scoped.payroll.export.v1
          .use(cap('payroll_export'))
          .use(requires('hr.payroll.export'))
          .use(requires('hr.attendance.view_team'))
          .use(requires('hr.leave.view_team'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const data = await payroll.collect(tx, input)
              const [first] = data.refusals
              // `conflict` rather than `badRequest`: the request is well formed and the state is not
              // ready. `hr.period.not_locked` mirrors the spelling of `hr.period.locked`, which
              // `PolicyService.assertOpen` throws pointed the other way.
              if (first) throw KernError.conflict(first.message, first.code)
              return assembleExport(payrollAssembly(data, input.draft))
            }),
          ),

        /**
         * The same rows as JSON, with no file and no refusal thrown.
         *
         * The manifest it carries is the manifest the export *would* write, filenames included, so a
         * screen can name the files before they exist and a reader can see `DRAFT` in the name before
         * choosing to send it.
         */
        preview: scoped.payroll.export.preview
          .use(cap('payroll_export'))
          .use(requires('hr.payroll.export'))
          .use(requires('hr.attendance.view_team'))
          .use(requires('hr.leave.view_team'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const data = await payroll.collect(tx, input)
              return {
                manifest: exportManifest(payrollAssembly(data, input.draft)),
                refusals: data.refusals,
                exportable: data.refusals.length === 0,
                totals: data.totals,
                hours: data.hours,
                leave: data.leave,
              }
            }),
          ),
      },
    },

    // ================================================================= privacy
    /**
     * Subject access, erasure and retention.
     *
     * `hr.privacy.manage` gates all of it except reading your own access log, and it is granted to
     * nobody by default — so on a fresh workspace only an owner, who passes every check, can reach
     * any of this. That is the intended starting position: whether anybody below an owner may export
     * or erase a colleague is a decision the workspace makes deliberately, in the role editor.
     */
    privacy: {
      /**
       * Everything HR holds about one person.
       *
       * Two transactions rather than one, and on purpose. `PeopleService.readSensitive` opens its
       * own so the decrypt and the `sensitive_access_log` row it writes are atomic with each other —
       * that atomicity is the point of the log and it must not be widened into a transaction that
       * also holds several thousand rows of punches open. The bundle's own reads then run in a
       * second transaction. The consequence is that the two halves are a moment apart, which for a
       * subject-access snapshot is not a property anybody depends on.
       *
       * The access log is read **after** the export's own row is written, so a subject's bundle
       * always contains the read that produced it. A bundle that could not account for its own
       * existence is the first hole somebody would find in it.
       */
      subjectAccess: scoped.privacy.subjectAccess
        .use(requires('hr.privacy.manage'))
        .handler(async ({ input, context }) => {
          const { workspaceId, personId } = input
          // Before anything else: this both proves the person exists and records the disclosure.
          // Refusing here means nothing was decrypted and nothing was assembled.
          const sensitive = await svc.readSensitive({
            workspaceId,
            personId,
            principal: context.principal,
            via: 'export',
            purpose: input.purpose ?? null,
          })

          return db.withWorkspace(workspaceId, async (tx) => {
            const person = await svc.load(tx, workspaceId, personId)
            const data = await privacy.subjectAccess(tx, workspaceId, personId)

            // Resolved here rather than left to the client, and included whatever the
            // `leave_accrual` capability says: "why is my balance this number" is the commonest
            // follow-up to a subject-access request, and it is the subject's own data either way.
            const kinds = ['accrual', 'carry_forward', 'overtime', 'rounding', 'working_time'] as const
            const policiesInForce = []
            for (const kind of kinds)
              policiesInForce.push(await policySvc.forPerson(tx, workspaceId, personId, kind, todayIso()))

            const decisionsOf = (stepId: string) =>
              data.approvals.stepDecisions
                .filter((d) => d.stepId === stepId)
                .map((d) => ({ ...d, decision: d.decision as 'approve' | 'reject', at: d.at.toISOString() }))
            const toStep = (s: (typeof data.approvals.raisedSteps)[number]) => ({
              ...s,
              mode: s.mode as never,
              status: s.status as never,
              dueAt: s.dueAt?.toISOString() ?? null,
              escalatedAt: s.escalatedAt?.toISOString() ?? null,
              decisions: decisionsOf(s.id),
            })

            return {
              manifest: {
                workspaceId,
                personId,
                generatedAt: new Date().toISOString(),
                generatedBy: context.principal.userId ?? null,
                moduleVersion: packageVersion(import.meta.url),
                truncated: data.truncated,
                // Stated rather than left to be noticed. HR holds the metadata and the file id for
                // every document; the bytes live in core's storage and `core.files.get` signs one
                // download at a time, so a module cannot put them in a bundle. Naming the omission
                // is the difference between an incomplete export and a dishonest one.
                excluded: [{ section: 'documents.contents', reason: 'fileContentsNotExportable' as const }],
              },
              // The whole row, never `forViewer`: the four personnel fields it withholds from a
              // reader are the subject's own.
              person: PeopleService.toPerson(person),
              sensitive,
              employment: data.employment.map(PeopleService.toEmployment),
              offices: data.offices.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
              history: data.history.map((r) => ({
                id: r.id,
                field: r.field,
                from: r.from ?? null,
                to: r.to ?? null,
                at: r.at.toISOString(),
                actorId: r.actorId,
                source: r.source,
              })),
              documents: data.documents.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
              leave: {
                types: data.leave.types.map(toLeaveType),
                requests: data.leave.requests.map(toLeaveRequest),
                days: data.leave.days.map((r) => ({
                  id: r.id,
                  requestId: r.requestId,
                  date: r.date,
                  fraction: Number.parseFloat(r.fraction),
                  counted: r.counted,
                  status: r.status,
                })),
                ledger: data.leave.ledger.map(toLedgerEntry),
                closingBalanceMinutes: closingBalance(data.leave.ledger),
              },
              attendance: {
                punches: data.attendance.punches.map(toPunch),
                days: data.attendance.days.map(toAttendanceDay),
              },
              regularizations: data.regularizations.map(toRegularization),
              approvals: {
                raised: data.approvals.raised.map((r) => ({
                  ...r,
                  subjectType: r.subjectType as never,
                  status: r.status as never,
                  // The requester is the subject of this bundle, so the name is already loaded —
                  // and after an erasure it is the tombstone token, which is the right answer.
                  requesterName: person.displayName,
                  requestedAt: r.requestedAt.toISOString(),
                  decidedAt: r.decidedAt?.toISOString() ?? null,
                  steps: data.approvals.raisedSteps.filter((s) => s.requestId === r.id).map(toStep),
                })),
                approverOn: data.approvals.approverOn.map(toStep),
                decisions: data.approvals.decisions.map((d) => ({
                  ...d,
                  decision: d.decision as 'approve' | 'reject',
                  at: d.at.toISOString(),
                })),
              },
              delegations: {
                given: data.delegations.given.map(toDelegation),
                received: data.delegations.received.map(toDelegation),
              },
              policiesInForce,
              accessLog: data.accessLog.map(HrAuditService.toEntry),
            }
          })
        }),

      /**
       * Redact a person, or say what redacting them would do.
       *
       * One transaction for the whole erasure: a half-run erasure is worse than a refused one, and a
       * partial one is not something anybody could tell had happened. It is replayable as well as
       * atomic — every step matches only rows that still have something to clear — so the recovery
       * from any failure is to run it again.
       *
       * The dry run takes the same transaction and rolls nothing back because it writes nothing; it
       * runs the identical predicates, which is what stops a preview drifting from the act.
       */
      erase: scoped.privacy.erase.use(requires('hr.privacy.manage')).handler(async ({ input, context }) => {
        const result = await db.withWorkspace(input.workspaceId, (tx) =>
          privacy.erase(tx, {
            workspaceId: input.workspaceId,
            personId: input.personId,
            dryRun: input.dryRun,
            reason: input.reason ?? null,
            keepNationalIdForAudit: input.keepNationalIdForAudit,
            actorUserId: context.principal.userId ?? null,
          }),
        )
        // Only a real run moved anything. A dry run that pushed a realtime change would blank the
        // person's card on every open screen in the workspace for a preview nobody committed.
        if (!input.dryRun) await changed(input.workspaceId, 'person', input.personId, 'updated')
        return {
          workspaceId: input.workspaceId,
          personId: input.personId,
          dryRun: input.dryRun,
          erasedAt: result.erasedAt?.toISOString() ?? null,
          displayName: result.displayName,
          redacted: result.redacted,
          kept: result.kept,
          caveats: result.caveats,
          filesRemaining: result.filesRemaining,
        }
      }),

      accessLog: {
        /**
         * Who read this person's sensitive fields.
         *
         * **No `requires()`, and that is the whole design of this procedure.** Reading your own
         * access log is a thing nobody may lack — a grantable key here could only ever be one
         * somebody could be *denied*, and "you may not see who has been looking at your bank
         * details" is not a state this product should be able to express. It is in
         * `module.test.ts`'s `SELF_SERVICE` allowlist for that reason, beside `people.me`.
         *
         * The permission check is in the handler because it depends on the arguments: any
         * `personId` that is not the caller's own, and any `actorUserId` at all. The second is not
         * the smaller case — "what has this account been looking at" is an investigation into a
         * colleague, and it is the query that makes this log a thing to be careful with rather than
         * only a thing to be reassured by.
         */
        list: scoped.privacy.accessLog.list.handler(({ input, context }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const own = await access.personIdOf(tx, input.workspaceId, context.principal)
            const aboutSomebodyElse = input.personId !== undefined && input.personId !== own
            const isInvestigation = input.actorUserId !== undefined
            if (aboutSomebodyElse || isInvestigation)
              await kernel.authz.require(context.principal, 'hr.privacy.manage', {
                kind: 'workspace',
                workspaceId: input.workspaceId,
              })
            // A member who was never made a person has no log of their own and no permission to
            // read anybody's. Refusing beats returning an empty page, which reads as "nobody has
            // ever looked at your record" — an answer, and the wrong one.
            if (!aboutSomebodyElse && !isInvestigation && !own) throw KernError.notFound('Person')

            const cursor = decodeCursor(input.cursor)
            const rows = await audit.list(tx, {
              workspaceId: input.workspaceId,
              personId: input.personId ?? own ?? undefined,
              actorUserId: input.actorUserId,
              limit: input.limit,
              after: cursor ? after(accessLogSort.at, accessLogSort.id, 'desc', cursor) : undefined,
            })
            // `atText`, never the `Date`: one export writes its rows in a single insert, so they
            // share `now()` to the microsecond, and a millisecond-truncated cursor drops every row
            // that ties with the last one on the page.
            const { items, nextCursor } = paginate(rows, input.limit, (r) => [r.atText, r.id])
            // No `total`. Counting an append-only log a subject scrolls through costs a second scan
            // of the same rows to answer a question nobody asked, and `page()` makes it optional
            // precisely so a list can decline.
            return { items: items.map(HrAuditService.toEntry), nextCursor }
          }),
        ),
      },

      retention: {
        /**
         * The horizons, and what is already past them.
         *
         * `sweepEnabled` is a literal `false` in the contract, and it says the thing this feature
         * must not imply: nothing in HR deletes on a timer. The horizons are read here, to count
         * what has passed one, and by `privacy.erase`, to say under which horizon each surviving
         * class was kept. An unattended job that prunes personnel records is the one act in this
         * module that cannot be undone by re-running anything, so it ships off, with a dry run and
         * a per-run report naming every person it touched — and until it exists, saying so in the
         * response is what keeps this screen from promising it.
         */
        get: scoped.privacy.retention.get.use(requires('hr.privacy.manage')).handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const { retention, updatedAt, updatedBy } = await privacy.retention(tx, input.workspaceId)
            const counts = input.withCounts
              ? await privacy.retentionCounts(tx, input.workspaceId, retention)
              : null
            return {
              workspaceId: input.workspaceId,
              classes: RETENTION_CLASSES.map((cls) => ({
                class: cls,
                days: retention[cls],
                dueNow: counts?.[cls] ?? null,
              })),
              updatedAt: updatedAt?.toISOString() ?? null,
              updatedBy,
              sweepEnabled: false as const,
            }
          }),
        ),

        set: scoped.privacy.retention.set.use(requires('hr.privacy.manage')).handler(({ input, context }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const { retention, updatedAt, updatedBy } = await privacy.setRetention(
              tx,
              input.workspaceId,
              input.retention,
              context.principal.userId ?? null,
            )
            // The counts are not recomputed on a write: a screen that has just changed a horizon
            // asks for them again, and doing eight counts inside the write transaction would hold
            // it open across the most expensive queries in this file.
            return {
              workspaceId: input.workspaceId,
              classes: RETENTION_CLASSES.map((cls) => ({
                class: cls,
                days: retention[cls],
                dueNow: null,
              })),
              updatedAt: updatedAt?.toISOString() ?? null,
              updatedBy,
              sweepEnabled: false as const,
            }
          }),
        ),
      },
    },
  })

  // ------------------------------------------------------------------ helpers
  // Closures over `kernel` and `db`, kept at the bottom so the router above reads as a list of
  // procedures rather than a list of procedures interrupted by plumbing.

  /**
   * The `people.custom` keys this reader may not be shown.
   *
   * `custom_field_defs.sensitive` has been declared, stored, editable and documented as "needs
   * `hr.person.view_sensitive`, like a national identity number" since the day custom fields
   * shipped — and until now **nothing read it**. `toPerson` returns `custom` whole and `forViewer`
   * narrows only the four personnel fields, so a field an administrator deliberately marked
   * sensitive went to every holder of `hr.person.view`, which is a `member` default. That is the
   * same defect as a permission key nothing asks about, one level down, and it is why the fix lands
   * here rather than waiting for a screen.
   *
   * Empty for a reader who holds the permission, and empty for a workspace with no sensitive fields
   * — which is the ordinary case and the one that must not pay for this. Archived definitions are
   * still counted: `fields.archive` deliberately leaves the values in `people.custom`, so an
   * archived sensitive field is a sensitive value with its guard removed.
   *
   * A person always sees their own, which is the same rule `people.me` follows: a permission you
   * would need to read your own record is one nobody may lack.
   */
  async function sensitiveCustomKeys(
    tx: Tx,
    workspaceId: string,
    principal: Principal,
  ): Promise<ReadonlySet<string>> {
    if (await kernel.authz.can(principal, 'hr.person.view_sensitive', { kind: 'workspace', workspaceId }))
      return NO_HIDDEN_FIELDS
    const rows = await tx
      .select({ key: customFieldDefs.key })
      .from(customFieldDefs)
      .where(and(eq(customFieldDefs.workspaceId, workspaceId), eq(customFieldDefs.sensitive, true)))
    return rows.length ? new Set(rows.map((r) => r.key)) : NO_HIDDEN_FIELDS
  }

  async function loadOffice(tx: Tx, input: { workspaceId: string; officeId: string }) {
    const [row] = await tx
      .select()
      .from(offices)
      .where(and(eq(offices.workspaceId, input.workspaceId), eq(offices.id, input.officeId)))
      .limit(1)
    if (!row) throw KernError.notFound('Office')
    return row
  }

  /** The workspace's calendar for a country pack, created on first use so offices can share one. */
  async function packCalendar(tx: Tx, workspaceId: string, country: string) {
    const [existing] = await tx
      .select()
      .from(calendars)
      .where(
        and(
          eq(calendars.workspaceId, workspaceId),
          eq(calendars.source, 'pack'),
          eq(calendars.packKey, country),
        ),
      )
      .limit(1)
    if (existing) return existing
    const pack = COUNTRY_PACKS[country]
    if (!pack) return undefined
    const [created] = await tx
      .insert(calendars)
      .values({
        id: uuidv7(),
        workspaceId,
        name: pack.name,
        country,
        workingWeek: pack.workingWeek,
        source: 'pack',
        packKey: country,
      })
      .returning()
    const year = new Date().getUTCFullYear()
    const days = packDays(country, year)
    if (days.length)
      await tx.insert(calendarDays).values(
        days.map((d) => ({
          id: uuidv7(),
          workspaceId,
          calendarId: created!.id,
          date: d.date,
          kind: d.kind,
          name: d.name,
          workingFraction: String(d.workingFraction),
          source: 'pack' as const,
          paid: true,
        })),
      )
    return created
  }

  /**
   * Walk `extends` and refuse a chain deeper than three, or one that would close a cycle.
   *
   * A cycle here does not throw anywhere obvious — it makes every calendar read spin, so the first
   * symptom is a report that never returns. Checked on write, where it is cheap and the person who
   * caused it is still looking at the screen.
   */
  async function assertChainDepth(tx: Tx, workspaceId: string, startId: string, selfId?: string) {
    let cursor: string | null = startId
    for (let depth = 0; depth < 4; depth++) {
      if (!cursor) return
      if (selfId && cursor === selfId)
        throw KernError.badRequest('That would make the calendars extend each other in a circle.')
      const row: { extendsId: string | null } | undefined = (
        await tx
          .select({ extendsId: calendars.extendsId })
          .from(calendars)
          .where(and(eq(calendars.workspaceId, workspaceId), eq(calendars.id, cursor)))
          .limit(1)
      )[0]
      cursor = row?.extendsId ?? null
    }
    throw KernError.badRequest('Calendars may only be built on three levels.')
  }

  /**
   * What applying a pack would do — and, just as importantly, what it would leave alone.
   *
   * The "kept" list is not decoration. The single most damaging thing this module could do is eat a
   * company's own holidays during a routine yearly refresh, silently, months before anyone notices.
   * Showing exactly which days survive is how an administrator can believe the operation.
   */
  /**
   * The days a pack would add, change and drop — and the days it must never touch.
   *
   * A pack key nobody publishes is refused rather than treated as a pack with no days in it.
   * `packDays` answers `[]` for an unknown key, which made the diff for a typo "add nothing, change
   * nothing, **remove every national holiday**" — with Apply live beside it, and `keptCustom` still
   * promising the company's own days were safe, which was true and beside the point. The screen
   * could reach that state on its own: `COUNTRY_PACKS` is keyed `TR`, the editor prefilled the
   * calendar's country lowercased, and so a calendar made by hand offered to empty itself.
   *
   * This is the one operation in the module that deletes rows a customer did not ask it to, so it
   * fails closed: an unknown key is a mistake, never an instruction.
   */
  function requirePack(packKey: string) {
    // `packFor` states the rule and is tested beside the packs; this turns its refusal into the
    // error shape a client can render.
    try {
      packFor(packKey)
    } catch (error) {
      throw KernError.badRequest((error as Error).message)
    }
  }

  async function diffPack(tx: Tx, workspaceId: string, calendarId: string, packKey: string, year: number) {
    requirePack(packKey)
    // The calendar id is the caller's. Proving it belongs to this workspace is what stops `apply`
    // stamping a pack onto another tenant's calendar, and stops `preview` answering with the empty
    // diff a calendar nobody can see produces.
    await loadCalendar(tx, workspaceId, calendarId)
    const from = `${year}-01-01`
    const to = `${year}-12-31`
    const existing = await tx
      .select()
      .from(calendarDays)
      .where(
        and(
          eq(calendarDays.workspaceId, workspaceId),
          eq(calendarDays.calendarId, calendarId),
          gte(calendarDays.date, from),
          lte(calendarDays.date, to),
        ),
      )
    const currentPack = new Map(existing.filter((d) => d.source === 'pack').map((d) => [d.date, d]))
    const custom = existing.filter((d) => d.source === 'custom')
    const incoming = packDays(packKey, year)
    const incomingByDate = new Map(incoming.map((d) => [d.date, d]))

    return {
      packKey,
      packVersion: String(year),
      added: incoming.filter((d) => !currentPack.has(d.date)).map((d) => ({ date: d.date, name: d.name })),
      changed: incoming
        .filter((d) => currentPack.has(d.date) && currentPack.get(d.date)!.name !== d.name)
        .map((d) => ({ date: d.date, name: d.name, was: currentPack.get(d.date)!.name })),
      removed: [...currentPack.values()]
        .filter((d) => !incomingByDate.has(d.date))
        .map((d) => ({ date: d.date, name: d.name })),
      keptCustom: custom.map((d) => ({ date: d.date, name: d.name })),
    }
  }

  /** People in a department, optionally including everything beneath it. */
  async function unitMemberIds(
    tx: Tx,
    workspaceId: string,
    unitId: string,
    includeDescendants: boolean,
  ): Promise<string[]> {
    let unitIds = [unitId]
    if (includeDescendants) {
      const [unit] = await tx
        .select({ path: orgUnits.path })
        .from(orgUnits)
        .where(and(eq(orgUnits.workspaceId, workspaceId), eq(orgUnits.id, unitId)))
        .limit(1)
      if (!unit) return []
      // One GiST index lookup for the whole subtree, rather than a recursive walk.
      const subtree = await tx
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(and(eq(orgUnits.workspaceId, workspaceId), sql`path <@ ${unit.path}::ltree`))
      unitIds = subtree.map((u) => u.id)
    }
    if (!unitIds.length) return []
    const rows = await tx
      .select({ personId: employments.personId })
      .from(employments)
      .where(
        and(
          eq(employments.workspaceId, workspaceId),
          inArray(employments.orgUnitId, unitIds),
          isNull(employments.effectiveTo),
        ),
      )
    return rows.map((r) => r.personId)
  }

  async function parentPath(tx: Tx, workspaceId: string, parentId: string | null) {
    if (!parentId) return null
    const [row] = await tx
      .select({ path: orgUnits.path })
      .from(orgUnits)
      .where(and(eq(orgUnits.workspaceId, workspaceId), eq(orgUnits.id, parentId)))
      .limit(1)
    return row?.path ?? null
  }

  /**
   * An ltree label for a new unit.
   *
   * The id with dashes stripped, not the name: ltree labels allow only letters, digits and
   * underscores, and a department called "R&D — Europe" would otherwise be unrepresentable. Names
   * change too, and a path built from one would have to be rewritten on every rename.
   */
  async function childPath(tx: Tx, workspaceId: string, parentId: string | null, id: string) {
    const label = `u${id.replace(/-/g, '')}`
    const parent = await parentPath(tx, workspaceId, parentId)
    return parent ? `${parent}.${label}` : label
  }

  /**
   * The person a call is about: the one named, or the caller.
   *
   * Reading somebody else's balance needs `hr.leave.view_team`; reading your own needs nothing
   * beyond being an employee. Collapsing those into one permission would either hide your own
   * balance from you or show you everybody's.
   */
  async function personFor(
    tx: Tx,
    workspaceId: string,
    context: RequestContext,
    personId: string | undefined,
  ): Promise<string> {
    const me = await svc.byUserId(tx, workspaceId, context.principal.userId ?? '')
    if (!personId) {
      if (!me) throw KernError.notFound('Your employee record')
      return me.id
    }
    if (me && me.id === personId) return personId
    await kernel.authz.require(context.principal, 'hr.leave.view_team', {
      kind: 'workspace',
      id: workspaceId,
      workspaceId,
    })
    return personId
  }

  /**
   * The same rule as `personFor`, asking for the attendance key rather than the leave one.
   *
   * A roster is what somebody is expected to turn up for, which is an attendance fact — reusing
   * `personFor` here would mean a manager needed permission to read a colleague's *leave balance*
   * before they could see who is on Tuesday's late shift. Reading your own needs nothing beyond
   * being an employee, exactly as `attendance.days.list` already decides it.
   */
  async function rosterPersonFor(
    tx: Tx,
    workspaceId: string,
    context: RequestContext,
    personId: string | undefined,
  ): Promise<string> {
    const me = await svc.byUserId(tx, workspaceId, context.principal.userId ?? '')
    if (!personId) {
      if (!me) throw KernError.notFound('Your employee record')
      return me.id
    }
    if (me && me.id === personId) return personId
    await kernel.authz.require(context.principal, 'hr.attendance.view_team', {
      kind: 'workspace',
      id: workspaceId,
      workspaceId,
    })
    return personId
  }

  // ------------------------------------------------------------------ reports

  /** What the caller asked to narrow to, refusing a slice with nothing to narrow *to*. */
  function sliceOf(input: { by: ReportSliceBy; sliceId?: string }): {
    by: ReportSliceBy
    id: string | null
    name: string | null
  } {
    if (input.by === 'workspace') return { by: 'workspace', id: null, name: null }
    if (!input.sliceId)
      throw KernError.badRequest('A report sliced by an office or a legal entity needs the id of one.')
    return { by: input.by, id: input.sliceId, name: null }
  }

  /**
   * A declaration rather than a `const`, like every other helper down here.
   *
   * This whole block sits *after* `return os.router(…)`, so a `const` is never evaluated and every
   * handler that reached for it would throw a `ReferenceError` the first time somebody opened a
   * report — at runtime only, with a clean type-check and a clean test run behind it. Function
   * declarations hoist; that is the only reason the helpers below one already-returned statement
   * work at all.
   */
  function sum<T>(rows: readonly T[], of: (row: T) => number): number {
    return rows.reduce((total, row) => total + of(row), 0)
  }

  /**
   * The header every report carries, and the reason it is not optional.
   *
   * A total with no denominator beside it is the defect, not the scoping: "47 hours of overtime"
   * means one thing to somebody reading a whole company and another to somebody reading a team, and
   * neither of them is told which they have. So the population, the range, the slice, the
   * attribution rule and the keys that produced it all travel with the figures.
   */
  function reportHeader(args: {
    input: { from: string; to: string; by: ReportSliceBy }
    slice: ReportSlice
    population: number
    counted: number
    shown: number
    permissions: string[]
    attribution?: ReportAttribution
    attributionOn?: string
  }) {
    return {
      from: args.input.from,
      to: args.input.to,
      slice: args.slice,
      scope: { permissions: args.permissions, askedAt: 'workspace' as const },
      population: args.population,
      counted: args.counted,
      attribution:
        args.attribution ??
        (args.input.by === 'workspace' ? ('not_applicable' as const) : ('each_day' as const)),
      attributionOn: args.attributionOn ?? null,
      truncated: args.shown < args.counted,
    }
  }

  /**
   * The population and the per-person day-sheet aggregate the attendance and overtime reports share.
   *
   * One grouped aggregate per set of people who belonged to the slice on the same days — which for a
   * range nobody transferred through is one query over the whole range. The rows are one per person,
   * never one per person-day: a year of five hundred people is a hundred and thirty thousand day
   * sheets, and adding them up in this process is the shape that works in a demo and falls over on
   * the first real customer.
   */
  async function dayReport(
    tx: Tx,
    input: { workspaceId: string; from: string; to: string; by: ReportSliceBy; sliceId?: string },
  ): Promise<{ slice: ReportSlice; population: number; rows: DayAggregateRow[] }> {
    const slice = sliceOf(input)
    const refusal = rangeRefusal({ from: input.from, to: input.to, perDay: slice.by !== 'workspace' })
    if (refusal) throw KernError.badRequest(refusal)

    const population = await reports.population(tx, input.workspaceId, slice, input.from, input.to)
    const rows: DayAggregateRow[] = []
    for (const group of reports.groupsFor(population, input.from, input.to))
      rows.push(...(await reports.dayAggregate(tx, input.workspaceId, group, input.from, input.to)))
    return {
      slice: { ...slice, name: population.sliceName },
      population: population.personIds.length,
      rows,
    }
  }

  /**
   * The provenance half of a payroll export's manifest — the part that is the router's to supply.
   *
   * `kernVersion` is the platform version this image was built as, recorded so a file can be traced
   * back to what wrote it. It is **not** the contract identity: `PAYROLL_EXPORT_CONTRACT` is a
   * literal that moves only when the column set does, and reading the module version into that field
   * would rename the format on every patch release.
   *
   * The three permissions are the ones the middlewares above actually asked for, written out rather
   * than inferred, for the reason `ReportScope` exists: two readers must never hold one file's
   * figures under one title without being told which grants produced them.
   */
  function payrollAssembly(data: PayrollExportData, draft: boolean): PayrollExportAssembly {
    return {
      entity: data.entity,
      period: data.period,
      draft,
      generatedAt: new Date().toISOString(),
      kernVersion: kernel.version,
      permissions: ['hr.payroll.export', 'hr.attendance.view_team', 'hr.leave.view_team'],
      dayLengthMinutes: MINUTES_PER_DAY,
      population: data.population,
      counted: data.counted,
      attendance: data.attendance,
      hours: data.hours,
      leave: data.leave,
    }
  }

  /** The request a retry is a retry *of*, or undefined the first time a key is seen. */
  async function byIdempotencyKey(tx: Tx, workspaceId: string, key: string) {
    const [row] = await tx
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.workspaceId, workspaceId), eq(leaveRequests.idempotencyKey, key)))
      .limit(1)
    return row
  }

  /**
   * The Kern accounts behind a set of people.
   *
   * An employee need not have an account, and one removed from the workspace has had the link
   * cleared on purpose by the `core.member.removed` subscription. Both are "nothing to deliver",
   * not an error — the same rule `sweepTimeouts` applies to the people it has to reach.
   */
  async function accountsOf(tx: Tx, workspaceId: string, personIds: string[]): Promise<string[]> {
    if (!personIds.length) return []
    const rows = await tx
      .select({ userId: people.userId })
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, personIds)))
    return [...new Set(rows.map((r) => r.userId).filter((id): id is string => !!id))]
  }

  /**
   * Tell the people a newly raised request is waiting on.
   *
   * `hr.approval.requested` has always been *emitted*, and an event is not a notification: nothing
   * subscribes to it, so the first thing an approver ever heard about a request was the timeout
   * sweep reminding them about something they had never been told about in the first place.
   *
   * The route is the sweep's own, deliberately and to the letter: `core.notifications.create`, the
   * same `groupKey` so one request stays one card however often it is later reminded about, the
   * same `url`, and a catch per notification — by the time this runs the request is committed, so a
   * notification that fails must not become an error for the person who filed it. What they would
   * lose is a card; what a throw would cost them is the request.
   *
   * **After the transaction, never inside it.** Core writes on its own connection, so a
   * notification sent inside a transaction that then rolls back has already been delivered, and an
   * approver is holding a card for a request that does not exist.
   *
   * No sentence is composed here beyond the English fallback, for the reason the sweep gives: a
   * title built on the server is built before anyone knows who will read it, so it can only ever be
   * English on a Persian screen. `data` carries the subject type and the request's own
   * `summaryParams`, which is what a localised renderer needs to write the sentence itself.
   */
  async function notifyApprovers(notice: {
    workspaceId: string
    requestId: string
    subjectType: string
    summary: string
    summaryParams: Record<string, string | number> | null
    userIds: string[]
    actorId: string | null
  }) {
    for (const userId of notice.userIds)
      try {
        await kernel.call(
          'core.notifications.create',
          {
            userId,
            workspaceId: notice.workspaceId,
            module: MODULE_ID,
            type: 'hr.approval.requested',
            title: 'Your approval is requested',
            body: notice.summary || null,
            object: null,
            url: '/hr/approvals',
            data: {
              subjectType: notice.subjectType,
              requestId: notice.requestId,
              params: notice.summaryParams ?? {},
            },
            groupKey: `hr.approval:${notice.requestId}`,
            // Whoever filed it, which is not always the person it is about — HR files leave for
            // somebody often enough that `requestedBy` exists as its own column.
            actorId: notice.actorId,
          },
          kernel.system,
        )
      } catch (err) {
        kernel.log.warn(
          {
            module: 'hr',
            workspaceId: notice.workspaceId,
            requestId: notice.requestId,
            err: (err as Error).message,
          },
          'approval notification not delivered',
        )
      }
  }

  async function clearDefaultChain(tx: Tx, workspaceId: string, subjectType: string) {
    await tx
      .update(approvalChains)
      .set({ isDefault: false })
      .where(
        and(
          eq(approvalChains.workspaceId, workspaceId),
          eq(approvalChains.subjectType, subjectType),
          eq(approvalChains.isDefault, true),
        ),
      )
  }

  /** An approval request with its steps and decisions, which is the only useful shape. */
  /**
   * One request, with its steps, its decisions and the requester's name.
   *
   * The name is resolved here rather than left to the client: an inbox is one call, and a client
   * that has to fetch the directory to read it will show ids for the moment the directory is in
   * flight — which is the moment somebody clicks approve.
   */
  async function hydrateApproval(tx: Tx, row: typeof approvalRequests.$inferSelect) {
    const steps = await tx
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.requestId, row.id))
      .orderBy(asc(approvalSteps.stepIndex))
    const stepIds = steps.map((s) => s.id)
    const decisions = stepIds.length
      ? await tx.select().from(approvalDecisions).where(inArray(approvalDecisions.stepId, stepIds))
      : []
    const [requester] = row.requesterPersonId
      ? await tx
          .select({ displayName: people.displayName })
          .from(people)
          .where(and(eq(people.workspaceId, row.workspaceId), eq(people.id, row.requesterPersonId)))
          .limit(1)
      : []

    return {
      ...row,
      subjectType: row.subjectType as never,
      status: row.status as never,
      requesterName: requester?.displayName ?? null,
      requestedAt: row.requestedAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      steps: steps.map((s) => ({
        ...s,
        mode: s.mode as never,
        status: s.status as never,
        dueAt: s.dueAt?.toISOString() ?? null,
        escalatedAt: s.escalatedAt?.toISOString() ?? null,
        decisions: decisions
          .filter((d) => d.stepId === s.id)
          .map((d) => ({
            ...d,
            decision: d.decision as 'approve' | 'reject',
            at: d.at.toISOString(),
          })),
      })),
    }
  }

  /**
   * The same, plus the one decision every clock procedure has to agree about: which shift *this
   * instant* belongs to, and what is already filed on it.
   *
   * The instant is taken once, here, and travels with its answer — so the guard, the row that is
   * written and the figures the widget shows all come out of a single attribution. They used to be
   * three: `clockContext` attributed `Date.now()`, the guard re-read the punches of whatever date
   * that produced, and `record` attributed its own `new Date()` again on the way to the insert.
   * Every version of the night-shift bug is those answers disagreeing, and a person being told they
   * are not clocked in at the end of a shift they have just worked.
   */
  async function clockNow(tx: Tx, workspaceId: string, personId: string) {
    const context = await personContext(tx, workspaceId, personId)
    const at = new Date()
    const attribution = await attendance.attribute(
      tx,
      workspaceId,
      personId,
      at.getTime(),
      context.timezone,
      context.schedule,
    )
    return { ...context, at, attribution }
  }

  /**
   * A refused punch: the sentence for the reader, and a stable reason for the screen.
   *
   * The reason travels in `details`, not in `KernError.conflict`'s `reason` argument. Only
   * `details` is on the wire — `kernErrorToORPC` maps it to the oRPC error's `data` and drops
   * everything else — so a reason passed as `conflict(message, reason)` never leaves this process.
   * Reasons are dotted and namespaced like `hr.leave.*` above, and are API: renaming one silently
   * puts the English sentence back in front of every non-English reader.
   *
   * A `function`, like every other helper down here: these sit after the router's `return`, so a
   * `const` is never initialised and the first refusal throws a ReferenceError instead of a
   * conflict. `noUnreachable` is what catches that — nothing else does until a person punches.
   */
  function refusePunch(reason: string, message: string) {
    return new KernError('CONFLICT', message, { reason })
  }

  /**
   * One punch, and the day rebuilt straight afterwards.
   *
   * Recomputing inline rather than in a background job: the clock widget shows a total, and a person
   * who clocks out wants to see it immediately. The day sheet is a projection, so doing it twice
   * costs nothing.
   */
  async function punch(
    input: {
      workspaceId: string
      personId?: string
      method?: string
      clientReportedAt?: string | null
      geo?: { lat: number; lng: number; accuracyM?: number } | null
      note?: string | null
      idempotencyKey?: string
    },
    context: RequestContext,
    direction: 'in' | 'out' | 'break_start' | 'break_end',
  ) {
    const row = await db.withWorkspace(input.workspaceId, async (tx) => {
      const personId = await personFor(tx, input.workspaceId, context, input.personId)
      const { timezone, schedule, resolution, at, attribution } = await clockNow(
        tx,
        input.workspaceId,
        personId,
      )

      // Refuse the transitions that make no sense, with a sentence rather than a constraint error:
      // clocking in twice, or out when never in, is somebody double-tapping a button.
      //
      // The sentence is written for a person, and it is written in English — a router has no locale.
      // So every refusal also carries a *reason*, which is what the clock widget translates; the
      // sentence is what it falls back to for a reason it has no string for, so a sixth refusal
      // added here reaches the reader in English rather than not at all.
      //
      // What it is judged against comes out of the attribution rather than being fetched again.
      // Re-reading `punchesOn(businessDate)` here is what made the guard circular: it could only
      // ever confirm the date the attribution had already chosen, so a wrong choice arrived as
      // "You are not clocked in." at the end of a shift somebody had just worked.
      const open = attribution.open
      if (direction === 'in' && open.clockedIn)
        throw refusePunch('hr.clock.already_clocked_in', 'You are already clocked in.')
      if (direction === 'out' && !open.clockedIn)
        throw refusePunch('hr.clock.not_clocked_in', 'You are not clocked in.')
      if (direction === 'break_start' && !open.clockedIn)
        throw refusePunch('hr.clock.break_before_clock_in', 'Clock in before starting a break.')
      if (direction === 'break_start' && open.onBreak)
        throw refusePunch('hr.clock.already_on_break', 'You are already on a break.')
      if (direction === 'break_end' && !open.onBreak)
        throw refusePunch('hr.clock.not_on_break', 'You are not on a break.')

      const punchRow = await attendance.record(tx, input.workspaceId, {
        personId,
        direction,
        at,
        businessDate: attribution.businessDate,
        timezone,
        method: input.method ?? 'web',
        clientReportedAt: input.clientReportedAt ?? null,
        officeId: resolution.primaryOfficeId,
        geo: input.geo ?? null,
        note: input.note ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      })

      // A punch inside a closed month is still recorded — it is a fact about somebody's day, and
      // refusing it because payroll has been filed loses the fact to protect the report. What must
      // not move is the derived sheet, and `recomputeDay` is where that is decided.
      await attendance.recomputeDay(
        tx,
        input.workspaceId,
        personId,
        punchRow.businessDate,
        timezone,
        schedule,
      )
      return punchRow
    })

    await kernel.emit(
      hrEvents.punchRecorded,
      {
        punchId: row.id,
        workspaceId: input.workspaceId as never,
        personId: row.personId,
        direction: row.direction,
        businessDate: row.businessDate,
      },
      { workspaceId: input.workspaceId, actorId: context.principal.userId },
    )
    await changed(input.workspaceId, 'attendance_day', row.personId, 'updated')
    return toPunch(row)
  }

  async function loadPolicy(tx: Tx, workspaceId: string, policyId: string) {
    const [row] = await tx
      .select()
      .from(policies)
      .where(and(eq(policies.workspaceId, workspaceId), eq(policies.id, policyId)))
      .limit(1)
    if (!row) throw KernError.notFound('Policy')
    return row
  }

  async function loadPeriod(tx: Tx, workspaceId: string, periodId: string) {
    const [row] = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.workspaceId, workspaceId), eq(periods.id, periodId)))
      .limit(1)
    if (!row) throw KernError.notFound('Period')
    return row
  }

  /** Policies with the assignments that decide who they reach — one query for the whole list. */
  async function withAssignments(tx: Tx, workspaceId: string, rows: Array<typeof policies.$inferSelect>) {
    if (!rows.length) return []
    const assignments = await tx
      .select()
      .from(policyAssignments)
      .where(
        and(
          eq(policyAssignments.workspaceId, workspaceId),
          inArray(
            policyAssignments.policyId,
            rows.map((r) => r.id),
          ),
        ),
      )
    return rows.map((r) => ({
      ...toPolicy(r),
      assignments: assignments.filter((a) => a.policyId === r.id).map(toAssignment),
    }))
  }

  /**
   * What an accrual run would credit, per person.
   *
   * **`run` calls this and credits what it returns**, so the preview and the thing it previews are
   * the same computation. A preview written separately is a preview that eventually disagrees with
   * the number that lands in somebody's balance.
   *
   * Everybody active is considered; the reason a person was skipped is returned rather than the
   * person being silently absent, because "why did she not accrue" is the question that follows.
   */
  async function accrualPreview(
    tx: Tx,
    workspaceId: string,
    from: string,
    to: string,
    onlyPersonId?: string,
  ) {
    const staff = await tx
      .select()
      .from(people)
      .where(
        and(
          eq(people.workspaceId, workspaceId),
          onlyPersonId ? eq(people.id, onlyPersonId) : inArray(people.status, ['active', 'on_leave']),
        ),
      )

    const rows: Array<{
      personId: string
      displayName: string
      leaveTypeId: string
      leaveTypeName: string
      minutes: number
      days: number
      reason: string
      alreadyAccrued: boolean
    }> = []
    const skipped: Array<{ personId: string; displayName: string; reason: string }> = []

    if (!staff.length) return { periodFrom: from, periodTo: to, rows, totalMinutes: 0, skipped }

    const ids = staff.map((p) => p.id)
    const resolved = await policySvc.forPeople(tx, workspaceId, ids, 'accrual', to)
    const employmentRows = await tx
      .select()
      .from(employments)
      .where(
        and(
          eq(employments.workspaceId, workspaceId),
          inArray(employments.personId, ids),
          inForceOn(employments.effectiveFrom, employments.effectiveTo, to),
        ),
      )
    const employmentBy = new Map(employmentRows.map((e) => [e.personId, e]))

    /**
     * Hours worked in the window, for the frequency that accrues against them.
     *
     * The preview has to answer with the same numbers the job will credit, so it reads the same
     * inputs. `per_hour_worked` was fed by neither for as long as it existed, which made the
     * preview quietly agree with a job that granted nothing. Only queried where a policy asks.
     */
    const hoursBy = new Map<string, { workedMinutes: number; scheduledMinutes: number }>()
    if (
      [...resolved.values()].some(
        (p) => (p?.config as AccrualConfig | undefined)?.frequency === 'per_hour_worked',
      )
    ) {
      const rows = await tx
        .select({
          personId: attendanceDays.personId,
          worked: sql<string>`coalesce(sum(${attendanceDays.workedMinutes}), 0)`,
          scheduled: sql<string>`coalesce(sum(${attendanceDays.scheduledMinutes}), 0)`,
        })
        .from(attendanceDays)
        .where(
          and(
            eq(attendanceDays.workspaceId, workspaceId),
            inArray(attendanceDays.personId, ids),
            gte(attendanceDays.businessDate, from),
            lte(attendanceDays.businessDate, to),
          ),
        )
        .groupBy(attendanceDays.personId)
      for (const r of rows)
        hoursBy.set(r.personId, {
          workedMinutes: Number(r.worked),
          scheduledMinutes: Number(r.scheduled),
        })
    }

    const types = await tx
      .select()
      .from(leaveTypes)
      .where(and(eq(leaveTypes.workspaceId, workspaceId), isNull(leaveTypes.archivedAt)))
    const typeByKey = new Map(types.map((t) => [t.key, t]))

    // Everything already credited for this window, so a re-run credits nothing.
    const existing = await tx
      .select({ personId: leaveLedger.personId, leaveTypeId: leaveLedger.leaveTypeId })
      .from(leaveLedger)
      .where(
        and(
          eq(leaveLedger.workspaceId, workspaceId),
          eq(leaveLedger.kind, 'accrual'),
          eq(leaveLedger.effectiveOn, to),
          inArray(leaveLedger.personId, ids),
        ),
      )
    const already = new Set(existing.map((e) => `${e.personId}:${e.leaveTypeId}`))

    let totalMinutes = 0
    for (const person of staff) {
      const policy = resolved.get(person.id)
      if (!policy?.config) {
        skipped.push({
          personId: person.id,
          displayName: person.displayName,
          reason: 'no accrual policy applies',
        })
        continue
      }
      const config = policy.config as unknown as AccrualConfig
      const type = typeByKey.get(config.leaveTypeKey)
      if (!type) {
        skipped.push({
          personId: person.id,
          displayName: person.displayName,
          reason: `no leave type "${config.leaveTypeKey}"`,
        })
        continue
      }
      if (!person.hiredOn) {
        skipped.push({
          personId: person.id,
          displayName: person.displayName,
          reason: 'no hire date',
        })
        continue
      }

      const employment = employmentBy.get(person.id)
      const result = accrueForPeriod({
        policy: {
          frequency: config.frequency,
          daysPerYear: config.daysPerYear,
          minutesPerDay: config.minutesPerDay,
          seniorityTiers: config.seniorityTiers,
          waitingPeriodMonths: config.waitingPeriodMonths,
          roundToMinutes: config.roundToMinutes,
        },
        period: { from, to },
        hiredOn: person.hiredOn,
        terminatedOn: person.terminatedOn,
        fte: employment ? Number.parseFloat(employment.fte ?? '1') : 1,
        ...hoursBy.get(person.id),
      })

      const alreadyAccrued = already.has(`${person.id}:${type.id}`)
      rows.push({
        personId: person.id,
        displayName: person.displayName,
        leaveTypeId: type.id,
        leaveTypeName: type.name,
        minutes: result.minutes,
        days: Math.round((result.minutes / config.minutesPerDay) * 100) / 100,
        reason: result.reason,
        alreadyAccrued,
      })
      if (!alreadyAccrued) totalMinutes += result.minutes
    }

    return { periodFrom: from, periodTo: to, rows, totalMinutes, skipped }
  }

  /**
   * Validate a config against the schema for its kind.
   *
   * A policy is data, and data from an API is not trusted because it arrived in the right-shaped
   * field. Each kind validates its own shape, which is what makes "policies as data" safe rather
   * than a jsonb column nobody checks.
   */
  function validatePolicyConfig(kind: PolicyKind, config: Record<string, unknown>) {
    const schema =
      kind === 'accrual'
        ? AccrualConfig
        : kind === 'carry_forward'
          ? CarryForwardConfig
          : kind === 'overtime'
            ? OvertimeConfig
            : kind === 'rounding'
              ? RoundingConfig
              : WorkingTimeConfig
    const parsed = schema.safeParse(config)
    if (!parsed.success)
      throw KernError.badRequest(`Invalid ${kind} policy`, {
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      })
    return parsed.data as unknown as Record<string, unknown>
  }

  async function emitCalendarChanged(
    workspaceId: WorkspaceId,
    calendarId: string,
    from: string | null,
    to: string | null,
    actorId: string | null | undefined,
  ) {
    await kernel.emit(
      hrEvents.calendarChanged,
      { calendarId, workspaceId, from, to },
      { workspaceId, actorId },
    )
    await changed(workspaceId, 'calendar', calendarId, 'updated')
  }
}

// ---------------------------------------------------------------------- serialisers

const toOffice = (r: typeof offices.$inferSelect) => ({
  ...r,
  kind: r.kind as never,
  address: (r.address as Record<string, string> | null) ?? null,
  archivedAt: r.archivedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
})

const toEntity = (r: typeof legalEntities.$inferSelect) => ({
  ...r,
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toCalendar = (r: typeof calendars.$inferSelect) => ({
  ...r,
  workingWeek: r.workingWeek as unknown as WorkingWeek,
  source: r.source as 'pack' | 'custom',
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toField = (r: typeof customFieldDefs.$inferSelect) => ({
  ...r,
  type: r.type as never,
  section: r.section as never,
  options: r.options ?? null,
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toResolvedDay = (
  r: typeof calendarDays.$inferSelect,
  fromCalendarId: string,
  fromCalendarName: string,
  overrides: boolean,
) => ({
  ...r,
  kind: r.kind as never,
  source: r.source as 'pack' | 'custom',
  workingFraction: Number.parseFloat(r.workingFraction),
  fromCalendarId,
  fromCalendarName,
  overrides,
})

const toLeaveType = (r: typeof leaveTypes.$inferSelect) => ({
  ...r,
  unit: r.unit as never,
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toLedgerEntry = (r: typeof leaveLedger.$inferSelect) => ({
  ...r,
  kind: r.kind as never,
  createdAt: r.createdAt.toISOString(),
})

const toLeaveRequest = (r: typeof leaveRequests.$inferSelect) => ({
  ...r,
  startPart: r.startPart as never,
  endPart: r.endPart as never,
  status: r.status as never,
  hours: r.hours === null ? null : Number.parseFloat(r.hours),
  workingDays: Number.parseFloat(r.workingDays),
  decidedAt: r.decidedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
})

const toChain = (r: typeof approvalChains.$inferSelect) => ({
  ...r,
  subjectType: r.subjectType as never,
  spec: r.spec as never,
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toDelegation = (r: typeof delegations.$inferSelect) => ({
  ...r,
  subjectType: (r.subjectType ?? null) as never,
  createdAt: r.createdAt.toISOString(),
})

const toPunch = (r: typeof punches.$inferSelect) => ({
  ...r,
  direction: r.direction as never,
  method: r.method as never,
  trust: r.trust as never,
  geo: (r.geo as { lat: number; lng: number } | null) ?? null,
  at: r.at.toISOString(),
  clientReportedAt: r.clientReportedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
})

const toAttendanceDay = (r: typeof attendanceDays.$inferSelect) => ({
  ...r,
  status: r.status as never,
  firstIn: r.firstIn?.toISOString() ?? null,
  lastOut: r.lastOut?.toISOString() ?? null,
  computedAt: r.computedAt.toISOString(),
})

const toSchedule = (r: typeof schedules.$inferSelect) => ({
  ...r,
  kind: r.kind as never,
  week: r.week as never,
  tzMode: r.tzMode as never,
  roundingDirection: r.roundingDirection as never,
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toScheduleAssignment = (r: typeof scheduleAssignments.$inferSelect) => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
})

/**
 * `start_time` / `end_time` in the table, `start` / `end` on the wire.
 *
 * The column names carry the suffix because `end` is a SQL keyword and a quoted keyword in every
 * hand-written query is a trap for whoever writes the next one; the contract does not, because a
 * shift reads as "start 06:00, end 14:00". The spread leaves both spellings on the object and zod
 * strips the ones the schema does not name.
 */
const toRosterShift = (r: typeof rosterShifts.$inferSelect) => ({
  ...r,
  start: r.startTime,
  end: r.endTime,
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toRosterPattern = (r: typeof rosterPatterns.$inferSelect) => ({
  ...r,
  days: r.days ?? [],
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toRosterAssignment = (r: typeof rosterAssignments.$inferSelect) => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
})

const toRosterDay = (personId: string, day: ResolvedRosterDay) => ({
  personId,
  businessDate: day.businessDate,
  shifts: day.shifts.map(toRosterShift),
  source: day.source,
  note: day.note,
})

const toRegularization = (r: typeof regularizations.$inferSelect) => ({
  ...r,
  status: r.status as never,
  proposed: r.proposed as never,
  appliedAt: r.appliedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
})

const toPolicy = (r: typeof policies.$inferSelect) => ({
  ...r,
  kind: r.kind as never,
  source: r.source as 'pack' | 'custom',
  config: r.config ?? {},
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toAssignment = (r: typeof policyAssignments.$inferSelect) => ({
  ...r,
  subjectKind: r.subjectKind as never,
})

const toPeriod = (r: typeof periods.$inferSelect) => ({
  ...r,
  kind: r.kind as never,
  status: r.status as 'open' | 'locked',
  lockedAt: r.lockedAt?.toISOString() ?? null,
})
