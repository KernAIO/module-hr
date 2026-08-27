import { KernError, type Tx } from '@kernhq/kernel'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type {
  ErasureCaveat,
  ErasureRedaction,
  ErasureRetained,
  HrRetention,
  RetentionClass,
} from '../../contract/index.js'
import {
  approvalDecisions,
  approvalRequests,
  approvalSteps,
  attendanceDays,
  delegations,
  employments,
  leaveLedger,
  leaveRequestDays,
  leaveRequests,
  leaveTypes,
  officeAssignments,
  offices,
  orgUnits,
  people,
  peopleSensitive,
  personDocuments,
  personHistory,
  punches,
  regularizations,
  retentionSettings,
  sensitiveAccessLog,
} from '../schema.js'
import { todayIso } from './db.js'

/**
 * Subject access, erasure and retention.
 *
 * The whole file rests on one decision, and the rest follows from it: **erasure here is redaction,
 * never deletion.** Three of this module's tables say why in their own comments — the ledger is
 * append-only because a balance is the sum of it and nothing else, punches are append-only because
 * an attendance record somebody can quietly rewrite is worth nothing in the dispute it exists for,
 * and `employments` is effective-dated so that March is still answerable in June. Deleting an erased
 * person's rows breaks all three at once, and answers a payroll audit with "she left, so we deleted
 * her file". So every step below clears columns and leaves rows, and the report says which rows
 * survived and on what basis.
 *
 * Two properties are load-bearing and both come out of how the predicates are written:
 *
 * - **Replayable.** Every step matches only rows that still have something to clear, so a second run
 *   updates nothing and reports zero. A half-finished erasure is therefore finished by running it
 *   again, which matters because the only alternative to a resumable erasure is a refused one.
 * - **Previewable.** A step is a predicate plus a `set`; the dry run counts the predicate and the
 *   real run counts it and then applies the set. The preview cannot drift from the thing it previews
 *   because there is only one predicate, in one place — the same reason `accrual.preview` runs the
 *   code the run runs.
 */

// =====================================================================================
// pure helpers — the redaction rules, testable without a database
// =====================================================================================

/**
 * The pseudonym an erased person is shown under.
 *
 * `display_name` is `not null` and the contract's `Person.displayName` is `min(1)`, so there is no
 * "no name" to write: something has to go in the column and it must not be a name. The employee
 * number is the right thing when there is one — it is already a pseudonym, it is the join key a
 * payslip carries, and it survives erasure for exactly that reason. Otherwise the front of the row's
 * own uuid, which identifies the record without identifying the person.
 *
 * Not a localised label like "Erased employee": the database is not the place for a language, and a
 * client that knows the row is a tombstone can render one. Knowing that needs `erasedAt` on the
 * `Person` contract, which is a change to `models.ts`, `toPerson` and the client mock together.
 */
export const erasureDisplayName = (person: { id: string; employeeNo: string | null }): string =>
  person.employeeNo?.trim() || `person-${person.id.slice(0, 8)}`

/**
 * `person_history` fields whose recorded values are personal data.
 *
 * The trap this list exists for: `person_history` stores `from_value`/`to_value` as jsonb for every
 * field, so a redacted `people` row sits beside a history row saying `personalEmail: null → "…"`.
 * Redacting the record and leaving the trail is theatre.
 *
 * What is *not* here is as deliberate. `hiredOn`, `terminatedOn`, `status` and every employment
 * field stay with their values, because those are the employment facts the erasure keeps on `people`
 * and `employments` anyway — clearing their history while keeping the current value would leave the
 * record self-contradictory for no gain. And `sensitive` rows already store only key names, never
 * values (`sensitive.update` has always written it that way), so there is nothing in them to clear.
 */
export const REDACTED_HISTORY_FIELDS = [
  'displayName',
  'workEmail',
  'personalEmail',
  'phone',
  'photoFileId',
  'timezone',
  'custom',
] as const

/** `custom.dietary` is as personal as `custom` itself; the writer records either spelling. */
export const isRedactableHistoryField = (field: string): boolean =>
  (REDACTED_HISTORY_FIELDS as readonly string[]).includes(field) || field.startsWith('custom.')

/**
 * Replace every occurrence of a person's name inside a JSON value.
 *
 * `approval_requests.chain` is a snapshot of the workflow as it stood when the request was raised,
 * and a step in it can be named after the person it is about. Nulling the column is not an option —
 * it is `not null` and it is the record of who had to sign — so the names come out and the structure
 * stays.
 *
 * Substring rather than equality: a step called "Approval for Ayşe Demir" carries the name as much
 * as one called "Ayşe Demir" does. Case-insensitive, and needles shorter than three characters are
 * ignored, because a one-letter name would blank every string in the document.
 *
 * Reports whether anything changed, so the caller can skip the write — which is what makes an
 * erasure replay report zero rows for this class rather than rewriting identical jsonb.
 */
export function scrubNames(
  value: unknown,
  needles: readonly string[],
  token: string,
): { value: unknown; changed: boolean } {
  const usable = needles.map((n) => n.trim()).filter((n) => n.length >= 3)
  if (!usable.length) return { value, changed: false }
  let changed = false

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      let out = node
      for (const needle of usable) {
        // Escape the needle: a name is user input and may contain regex metacharacters.
        const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
        out = out.replace(pattern, token)
      }
      if (out !== node) changed = true
      return out
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object')
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)]))
    return node
  }

  const next = walk(value)
  return { value: changed ? next : value, changed }
}

/**
 * Drop the `custom` values whose field definition is marked sensitive.
 *
 * A defect that predates this feature and lands in the middle of it: `custom_field_defs.sensitive`
 * is declared, stored, editable and documented as "needs `hr.person.view_sensitive`, like a national
 * identity number" — and nothing has ever read it. `toPerson` returns `custom` whole and `forViewer`
 * nulls only the four personnel fields, so a field an administrator marked sensitive went to every
 * holder of `hr.person.view`, which is a `member` default. That is the same failure as a permission
 * key nothing asks about, one level down.
 *
 * Returns the object it was given when there is nothing to strip, so the common path — no sensitive
 * fields defined, or a reader who holds the permission — allocates nothing.
 */
export function stripSensitiveCustom(
  custom: Record<string, unknown>,
  sensitiveKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!sensitiveKeys.size) return custom
  const present = Object.keys(custom).filter((k) => sensitiveKeys.has(k))
  if (!present.length) return custom
  const out = { ...custom }
  for (const k of present) delete out[k]
  return out
}

/** `YYYY-MM-DD`, `days` before `today`. The boundary a retention horizon is measured from. */
export function retentionCutoff(days: number, today: string = todayIso()): string {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

/** Every retention class, in the order a settings screen should show them. */
export const RETENTION_CLASSES = [
  'punchDetail',
  'punches',
  'attendanceDays',
  'leave',
  'personHistory',
  'personDocuments',
  'terminatedPeople',
  'sensitiveAccessLog',
] as const

/** Null everywhere: the shipped state, and the one this module refuses to guess a number for. */
export const EMPTY_RETENTION: HrRetention = {
  punchDetail: null,
  punches: null,
  attendanceDays: null,
  leave: null,
  personHistory: null,
  personDocuments: null,
  terminatedPeople: null,
  sensitiveAccessLog: null,
}

/**
 * How many rows a subject-access section returns before it is cut.
 *
 * A cut is always named in `manifest.truncated` with its numbers — an export that silently omits is
 * the same failure as an erasure that silently retains. The figures are sized off a five-year
 * employee punching four times a day: about five thousand punches, eighteen hundred day sheets, two
 * hundred and fifty ledger movements. Each cap is a few multiples of that, so a normal record is
 * never cut and a pathological one does not take the process down with it.
 */
export const SECTION_CAPS = {
  employment: 500,
  offices: 500,
  history: 20_000,
  documents: 1_000,
  leaveRequests: 5_000,
  leaveRequestDays: 20_000,
  leaveLedger: 20_000,
  punches: 40_000,
  attendanceDays: 10_000,
  regularizations: 2_000,
  approvalsRaised: 2_000,
  approverOn: 2_000,
  decisions: 5_000,
  delegations: 1_000,
  accessLog: 5_000,
} as const
export type BundleSection = keyof typeof SECTION_CAPS

export interface Truncation {
  section: string
  returned: number
  cap: number
}

// =====================================================================================
// the service
// =====================================================================================

/** One redaction: which rows still have something to clear, and what clearing them means. */
interface Step {
  class: ErasureRedaction['class']
  table: string
  columns: string[]
  count(tx: Tx): Promise<number>
  apply(tx: Tx): Promise<void>
}

export interface EraseOptions {
  workspaceId: string
  personId: string
  dryRun: boolean
  reason: string | null
  keepNationalIdForAudit: boolean
  actorUserId: string | null
}

export interface EraseResult {
  erasedAt: Date | null
  displayName: string
  redacted: ErasureRedaction[]
  kept: ErasureRetained[]
  caveats: ErasureCaveat[]
  filesRemaining: string[]
}

/** `select count(*)` reduced to the number, which is the only thing any caller here wants. */
const total = async (query: Promise<Array<{ n: number }>>): Promise<number> => (await query)[0]?.n ?? 0

export class PrivacyService {
  // ------------------------------------------------------------------ retention

  /** The stored horizons, defaulted. A workspace that has never set one gets nulls, not numbers. */
  async retention(
    tx: Tx,
    workspaceId: string,
  ): Promise<{ retention: HrRetention; updatedAt: Date | null; updatedBy: string | null }> {
    const [row] = await tx
      .select()
      .from(retentionSettings)
      .where(eq(retentionSettings.workspaceId, workspaceId))
      .limit(1)
    return {
      retention: { ...EMPTY_RETENTION, ...(row?.config ?? {}) },
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    }
  }

  /**
   * Patch the horizons.
   *
   * A field left out is unchanged and a field sent as `null` goes back to "keep indefinitely", which
   * is the same reading `core.settings.setModule` gives a partial write — a caller that has nothing
   * to say about a class must not silently reset it.
   */
  async setRetention(
    tx: Tx,
    workspaceId: string,
    patch: Partial<HrRetention>,
    actorUserId: string | null,
  ): Promise<{ retention: HrRetention; updatedAt: Date | null; updatedBy: string | null }> {
    const current = await this.retention(tx, workspaceId)
    const config: Record<string, number | null> = { ...current.retention }
    for (const [key, value] of Object.entries(patch)) config[key] = value ?? null
    const updatedAt = new Date()
    await tx
      .insert(retentionSettings)
      .values({ workspaceId, config, updatedAt, updatedBy: actorUserId })
      .onConflictDoUpdate({
        target: retentionSettings.workspaceId,
        set: { config, updatedAt, updatedBy: actorUserId },
      })
    return { retention: { ...EMPTY_RETENTION, ...config }, updatedAt, updatedBy: actorUserId }
  }

  /**
   * How much is already past each horizon — the dry run a retention screen shows before anything
   * runs, and the only thing that reads these numbers today.
   *
   * Null for a class with no horizon set: there is nothing to be past. One query per class that has
   * one, which is why the caller asks for this rather than getting it on every read.
   *
   * `attendanceDays` deliberately excludes locked days and `terminatedPeople` excludes anybody
   * already erased, so the number is what a sweep *could* act on rather than what merely matches a
   * date. A count that overstates is a count nobody trusts the second time they check it.
   */
  async retentionCounts(
    tx: Tx,
    workspaceId: string,
    retention: HrRetention,
    today: string = todayIso(),
  ): Promise<Record<RetentionClass, number | null>> {
    const out = {} as Record<RetentionClass, number | null>
    for (const cls of RETENTION_CLASSES) out[cls] = null

    const one = async (cls: RetentionClass, run: (cutoff: string) => Promise<number>) => {
      const days = retention[cls]
      if (days === null) return
      out[cls] = await run(retentionCutoff(days, today))
    }

    await one('punchDetail', (cutoff) =>
      total(
        tx
          .select({ n: count() })
          .from(punches)
          .where(
            and(
              eq(punches.workspaceId, workspaceId),
              lt(punches.businessDate, cutoff),
              or(isNotNull(punches.geo), isNotNull(punches.deviceId), isNotNull(punches.note)),
            ),
          ),
      ),
    )
    await one('punches', (cutoff) =>
      total(
        tx
          .select({ n: count() })
          .from(punches)
          .where(and(eq(punches.workspaceId, workspaceId), lt(punches.businessDate, cutoff))),
      ),
    )
    await one('attendanceDays', (cutoff) =>
      total(
        tx
          .select({ n: count() })
          .from(attendanceDays)
          .where(
            and(
              eq(attendanceDays.workspaceId, workspaceId),
              lt(attendanceDays.businessDate, cutoff),
              eq(attendanceDays.locked, false),
            ),
          ),
      ),
    )
    await one('leave', (cutoff) =>
      total(
        tx
          .select({ n: count() })
          .from(leaveLedger)
          .where(and(eq(leaveLedger.workspaceId, workspaceId), lt(leaveLedger.effectiveOn, cutoff))),
      ),
    )
    await one('personHistory', (cutoff) =>
      total(
        tx
          .select({ n: count() })
          .from(personHistory)
          .where(
            and(
              eq(personHistory.workspaceId, workspaceId),
              lt(personHistory.at, new Date(`${cutoff}T00:00:00Z`)),
              or(isNotNull(personHistory.from), isNotNull(personHistory.to)),
            ),
          ),
      ),
    )
    await one('personDocuments', (cutoff) =>
      total(
        tx
          .select({ n: count() })
          .from(personDocuments)
          .where(
            and(
              eq(personDocuments.workspaceId, workspaceId),
              lt(personDocuments.createdAt, new Date(`${cutoff}T00:00:00Z`)),
            ),
          ),
      ),
    )
    await one('terminatedPeople', (cutoff) =>
      total(
        tx
          .select({ n: count() })
          .from(people)
          .where(
            and(
              eq(people.workspaceId, workspaceId),
              isNotNull(people.terminatedOn),
              lt(people.terminatedOn, cutoff),
              isNull(people.erasedAt),
            ),
          ),
      ),
    )
    await one('sensitiveAccessLog', (cutoff) =>
      total(
        tx
          .select({ n: count() })
          .from(sensitiveAccessLog)
          .where(
            and(
              eq(sensitiveAccessLog.workspaceId, workspaceId),
              lt(sensitiveAccessLog.at, new Date(`${cutoff}T00:00:00Z`)),
            ),
          ),
      ),
    )
    return out
  }

  // ------------------------------------------------------------------ erasure

  /**
   * Redact one person, or say what redacting them would do.
   *
   * Runs inside the caller's transaction, so the whole erasure commits or none of it does — a
   * half-run erasure is worse than a refused one, and this is the only way to be sure there is no
   * such state to be in.
   */
  async erase(tx: Tx, opts: EraseOptions): Promise<EraseResult> {
    const { workspaceId, personId, dryRun } = opts
    const [person] = await tx
      .select()
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), eq(people.id, personId)))
      .limit(1)
    if (!person) throw KernError.notFound('Person')

    const caveats = new Set<ErasureCaveat>()
    const token = erasureDisplayName(person)
    const names = [person.displayName].filter((n) => n !== token)

    // ---- files this erasure orphans, gathered before the pointers are cleared -------------
    const leaveDocs = await tx
      .select({ fileId: leaveRequests.documentFileId })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.workspaceId, workspaceId),
          eq(leaveRequests.personId, personId),
          isNotNull(leaveRequests.documentFileId),
        ),
      )
    const orphaned = [
      ...(person.photoFileId ? [person.photoFileId] : []),
      ...leaveDocs.map((r) => r.fileId).filter((id): id is string => id !== null),
    ]
    const filesRemaining = [...new Set([...(person.erasedFileIds ?? []), ...orphaned])]
    if (person.photoFileId) caveats.add('photoFileOrphaned')
    if (leaveDocs.length) caveats.add('leaveDocumentFilesRemain')

    /**
     * Punches inside a closed month are left exactly as they are.
     *
     * The module's standing rule is that a locked period does not move, and `hr.period.manage` — an
     * owner's key — is what unlocks one. Clearing a note or a location does not change a figure, but
     * it is still a write into a month a payroll has been filed against, and quietly making an
     * exception for erasure is how "locked" stops meaning anything. So these rows are skipped, the
     * report says so, and because erasure is replayable the owner unlocks and runs it again to
     * finish the job. Surfacing the decision rather than encoding it.
     */
    const notLocked = sql`not exists (select 1 from ${attendanceDays} ad
      where ad.workspace_id = ${punches.workspaceId}
        and ad.person_id = ${punches.personId}
        and ad.business_date = ${punches.businessDate}
        and ad.locked)`
    const punchesDirty = or(
      isNotNull(punches.geo),
      isNotNull(punches.deviceId),
      isNotNull(punches.note),
      isNotNull(punches.clientReportedAt),
    )
    const lockedPunches = await total(
      tx
        .select({ n: count() })
        .from(punches)
        .where(
          and(
            eq(punches.workspaceId, workspaceId),
            eq(punches.personId, personId),
            punchesDirty,
            sql`not (${notLocked})`,
          ),
        ),
    )
    if (lockedPunches > 0) caveats.add('lockedPeriodUntouched')

    // ---- the steps -----------------------------------------------------------------------
    const now = new Date()
    const sensitiveDirty = [
      isNotNull(peopleSensitive.birthDate),
      isNotNull(peopleSensitive.ibanEnc),
      isNotNull(peopleSensitive.emergencyContact),
    ]
    if (!opts.keepNationalIdForAudit) sensitiveDirty.push(isNotNull(peopleSensitive.nationalIdEnc))
    if (opts.keepNationalIdForAudit) caveats.add('nationalIdKeptForAudit')

    const steps: Step[] = [
      {
        class: 'identity',
        table: 'people',
        columns: [
          'userId',
          'displayName',
          'workEmail',
          'personalEmail',
          'phone',
          'photoFileId',
          'timezone',
          'custom',
        ],
        count: (t) =>
          total(
            t
              .select({ n: count() })
              .from(people)
              .where(
                and(eq(people.workspaceId, workspaceId), eq(people.id, personId), isNull(people.erasedAt)),
              ),
          ),
        apply: async (t) => {
          await t
            .update(people)
            .set({
              userId: null,
              displayName: token,
              workEmail: null,
              personalEmail: null,
              phone: null,
              photoFileId: null,
              timezone: null,
              custom: {},
              erasedAt: now,
              erasedBy: opts.actorUserId,
              erasureReason: opts.reason,
              erasedFileIds: filesRemaining.length ? filesRemaining : null,
              updatedAt: now,
            })
            .where(and(eq(people.workspaceId, workspaceId), eq(people.id, personId), isNull(people.erasedAt)))
        },
      },
      {
        class: 'sensitive',
        table: 'people_sensitive',
        columns: opts.keepNationalIdForAudit
          ? ['birthDate', 'iban', 'emergencyContact']
          : ['nationalId', 'birthDate', 'iban', 'emergencyContact'],
        count: (t) =>
          total(
            t
              .select({ n: count() })
              .from(peopleSensitive)
              .where(
                and(
                  eq(peopleSensitive.workspaceId, workspaceId),
                  eq(peopleSensitive.personId, personId),
                  or(...sensitiveDirty),
                ),
              ),
          ),
        apply: async (t) => {
          // The row survives rather than being deleted: "sensitive data was held here and cleared on
          // this date" is exactly what the erasure response has to be able to say afterwards.
          await t
            .update(peopleSensitive)
            .set({
              ...(opts.keepNationalIdForAudit ? {} : { nationalIdEnc: null }),
              birthDate: null,
              ibanEnc: null,
              emergencyContact: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(peopleSensitive.workspaceId, workspaceId),
                eq(peopleSensitive.personId, personId),
                or(...sensitiveDirty),
              ),
            )
        },
      },
      {
        // A pointer, not a record. An erased person heading a department renders as a tombstone at
        // the top of the org chart, which is the one place the redaction is loudest.
        class: 'headship',
        table: 'offices',
        columns: ['headPersonId'],
        count: (t) =>
          total(
            t
              .select({ n: count() })
              .from(offices)
              .where(and(eq(offices.workspaceId, workspaceId), eq(offices.headPersonId, personId))),
          ),
        apply: async (t) => {
          await t
            .update(offices)
            .set({ headPersonId: null })
            .where(and(eq(offices.workspaceId, workspaceId), eq(offices.headPersonId, personId)))
        },
      },
      {
        class: 'headship',
        table: 'org_units',
        columns: ['headPersonId'],
        count: (t) =>
          total(
            t
              .select({ n: count() })
              .from(orgUnits)
              .where(and(eq(orgUnits.workspaceId, workspaceId), eq(orgUnits.headPersonId, personId))),
          ),
        apply: async (t) => {
          await t
            .update(orgUnits)
            .set({ headPersonId: null })
            .where(and(eq(orgUnits.workspaceId, workspaceId), eq(orgUnits.headPersonId, personId)))
        },
      },
      {
        // The values go, the rows stay: "personalEmail changed on 3 March, by X" survives and the
        // address does not. Erasing the trail and erasing the data are different acts.
        class: 'history',
        table: 'person_history',
        columns: ['from', 'to'],
        count: (t) =>
          total(t.select({ n: count() }).from(personHistory).where(this.historyWhere(workspaceId, personId))),
        apply: async (t) => {
          await t
            .update(personHistory)
            .set({ from: null, to: null })
            .where(this.historyWhere(workspaceId, personId))
        },
      },
      {
        // Where somebody was, on what device, and what they typed. Far beyond what an attendance
        // dispute needs; the direction, the instant and the business date are what it does need.
        class: 'punches',
        table: 'punches',
        columns: ['geo', 'deviceId', 'note', 'clientReportedAt'],
        count: (t) =>
          total(
            t
              .select({ n: count() })
              .from(punches)
              .where(
                and(
                  eq(punches.workspaceId, workspaceId),
                  eq(punches.personId, personId),
                  punchesDirty,
                  notLocked,
                ),
              ),
          ),
        apply: async (t) => {
          await t
            .update(punches)
            .set({ geo: null, deviceId: null, note: null, clientReportedAt: null })
            .where(
              and(
                eq(punches.workspaceId, workspaceId),
                eq(punches.personId, personId),
                punchesDirty,
                notLocked,
              ),
            )
        },
      },
      {
        // `reason` on a leave request is routinely health data — "chemotherapy", "funeral". The
        // dates, the working days and the status are the pay record and stay.
        class: 'leaveRequests',
        table: 'leave_requests',
        columns: ['reason', 'documentFileId'],
        count: (t) =>
          total(
            t
              .select({ n: count() })
              .from(leaveRequests)
              .where(
                and(
                  eq(leaveRequests.workspaceId, workspaceId),
                  eq(leaveRequests.personId, personId),
                  or(isNotNull(leaveRequests.reason), isNotNull(leaveRequests.documentFileId)),
                ),
              ),
          ),
        apply: async (t) => {
          await t
            .update(leaveRequests)
            .set({ reason: null, documentFileId: null, updatedAt: now })
            .where(
              and(
                eq(leaveRequests.workspaceId, workspaceId),
                eq(leaveRequests.personId, personId),
                or(isNotNull(leaveRequests.reason), isNotNull(leaveRequests.documentFileId)),
              ),
            )
        },
      },
      {
        class: 'leaveLedger',
        table: 'leave_ledger',
        columns: ['reason'],
        count: (t) =>
          total(
            t
              .select({ n: count() })
              .from(leaveLedger)
              .where(
                and(
                  eq(leaveLedger.workspaceId, workspaceId),
                  eq(leaveLedger.personId, personId),
                  isNotNull(leaveLedger.reason),
                ),
              ),
          ),
        apply: async (t) => {
          await t
            .update(leaveLedger)
            .set({ reason: null })
            .where(
              and(
                eq(leaveLedger.workspaceId, workspaceId),
                eq(leaveLedger.personId, personId),
                isNotNull(leaveLedger.reason),
              ),
            )
        },
      },
      {
        // "performance", "returning from maternity leave" — free text about a person, on a row whose
        // dates and hours are the statutory record.
        class: 'employment',
        table: 'employments',
        columns: ['reason'],
        count: (t) =>
          total(
            t
              .select({ n: count() })
              .from(employments)
              .where(
                and(
                  eq(employments.workspaceId, workspaceId),
                  eq(employments.personId, personId),
                  isNotNull(employments.reason),
                ),
              ),
          ),
        apply: async (t) => {
          await t
            .update(employments)
            .set({ reason: null })
            .where(
              and(
                eq(employments.workspaceId, workspaceId),
                eq(employments.personId, personId),
                isNotNull(employments.reason),
              ),
            )
        },
      },
      {
        class: 'officeAssignments',
        table: 'office_assignments',
        columns: ['reason'],
        count: (t) =>
          total(
            t
              .select({ n: count() })
              .from(officeAssignments)
              .where(
                and(
                  eq(officeAssignments.workspaceId, workspaceId),
                  eq(officeAssignments.personId, personId),
                  isNotNull(officeAssignments.reason),
                ),
              ),
          ),
        apply: async (t) => {
          await t
            .update(officeAssignments)
            .set({ reason: null })
            .where(
              and(
                eq(officeAssignments.workspaceId, workspaceId),
                eq(officeAssignments.personId, personId),
                isNotNull(officeAssignments.reason),
              ),
            )
        },
      },
      {
        // `reason` is `not null` here, so it is emptied rather than nulled. `proposed` and `status`
        // stay: they justify a corrected day sheet that payroll relies on.
        class: 'regularizations',
        table: 'regularizations',
        columns: ['reason'],
        count: (t) =>
          total(
            t
              .select({ n: count() })
              .from(regularizations)
              .where(
                and(
                  eq(regularizations.workspaceId, workspaceId),
                  eq(regularizations.personId, personId),
                  ne(regularizations.reason, ''),
                ),
              ),
          ),
        apply: async (t) => {
          await t
            .update(regularizations)
            .set({ reason: '' })
            .where(
              and(
                eq(regularizations.workspaceId, workspaceId),
                eq(regularizations.personId, personId),
                ne(regularizations.reason, ''),
              ),
            )
        },
      },
      {
        class: 'delegations',
        table: 'delegations',
        columns: ['reason'],
        count: (t) =>
          total(
            t.select({ n: count() }).from(delegations).where(this.delegationWhere(workspaceId, personId)),
          ),
        apply: async (t) => {
          await t.update(delegations).set({ reason: null }).where(this.delegationWhere(workspaceId, personId))
        },
      },
    ]

    const redacted: ErasureRedaction[] = []
    for (const step of steps) {
      const rows = await step.count(tx)
      if (rows > 0 && !dryRun) await step.apply(tx)
      redacted.push({ class: step.class, table: step.table, rows, columns: step.columns })
    }

    // ---- the two that cannot be one predicate ---------------------------------------------
    redacted.push(await this.redactApprovals(tx, workspaceId, personId, names, token, dryRun))
    redacted.push(await this.redactDecisions(tx, workspaceId, personId, dryRun))

    // ---- what survived, and on what basis --------------------------------------------------
    const { retention } = await this.retention(tx, workspaceId)
    const kept = await this.keptClasses(tx, workspaceId, personId, retention)
    if (kept.some((k) => k.class === 'documents' && k.rows > 0)) caveats.add('documentFilesRemain')
    if (kept.some((k) => k.class === 'history' && k.basis === 'anotherPersonsRecord' && k.rows > 0))
      caveats.add('actorHistoryKept')

    return {
      // A replay keeps the first erasure's date rather than restamping it: the second run finds
      // nothing left to clear, and moving the timestamp would misdate the act for the one field
      // somebody would later be asked to produce.
      erasedAt: person.erasedAt ?? (dryRun ? null : now),
      // The token on both paths, never the name being replaced. A dry run is what a confirmation
      // dialog reads before somebody presses through, so "this is the name the directory will show"
      // is the useful answer — and echoing the real name back would put it in a response whose whole
      // subject is removing it. Already-erased rows recompute to the same token, because it is
      // derived from `employee_no` and the row id, neither of which an erasure changes.
      displayName: token,
      redacted,
      kept,
      caveats: [...caveats],
      filesRemaining,
    }
  }

  private historyWhere(workspaceId: string, personId: string) {
    return and(
      eq(personHistory.workspaceId, workspaceId),
      eq(personHistory.personId, personId),
      inArray(personHistory.field, [...REDACTED_HISTORY_FIELDS]),
      or(isNotNull(personHistory.from), isNotNull(personHistory.to)),
    )
  }

  private delegationWhere(workspaceId: string, personId: string) {
    return and(
      eq(delegations.workspaceId, workspaceId),
      or(eq(delegations.fromPersonId, personId), eq(delegations.toPersonId, personId)),
      isNotNull(delegations.reason),
    )
  }

  /**
   * The approval requests this person raised: the English summary, the same sentence as data, and
   * any name embedded in the snapshotted chain.
   *
   * Row by row rather than one `update`, because the chain is jsonb that has to be read to be
   * scrubbed. The set is small — an approval request per leave request — and skipping rows that
   * scrub to themselves is what keeps a replay at zero.
   */
  private async redactApprovals(
    tx: Tx,
    workspaceId: string,
    personId: string,
    names: string[],
    token: string,
    dryRun: boolean,
  ): Promise<ErasureRedaction> {
    const rows = await tx
      .select({
        id: approvalRequests.id,
        summary: approvalRequests.summary,
        chain: approvalRequests.chain,
        params: approvalRequests.summaryParams,
      })
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.requesterPersonId, personId)),
      )

    let touched = 0
    for (const row of rows) {
      const scrubbed = scrubNames(row.chain, names, token)
      const dirty = row.summary !== '' || row.params !== null || scrubbed.changed
      if (!dirty) continue
      touched += 1
      if (dryRun) continue
      await tx
        .update(approvalRequests)
        .set({
          summary: '',
          summaryParams: null,
          chain: scrubbed.value as Record<string, unknown>,
        })
        .where(eq(approvalRequests.id, row.id))
    }
    return {
      class: 'approvals',
      table: 'approval_requests',
      rows: touched,
      columns: ['summary', 'summaryParams', 'chain'],
    }
  }

  /**
   * Approver comments, on both paths.
   *
   * A comment is free text an approver wrote. On the subject's erasure it is somebody talking about
   * the subject; on the approver's own erasure it is the approver's own speech. Both are personal
   * data about the person being erased, so both are cleared — the decision itself, who made it and
   * when, are the authorisation record and stay.
   */
  private async redactDecisions(
    tx: Tx,
    workspaceId: string,
    personId: string,
    dryRun: boolean,
  ): Promise<ErasureRedaction> {
    const requestIds = (
      await tx
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.workspaceId, workspaceId),
            eq(approvalRequests.requesterPersonId, personId),
          ),
        )
    ).map((r) => r.id)
    const stepIds = requestIds.length
      ? (
          await tx
            .select({ id: approvalSteps.id })
            .from(approvalSteps)
            .where(
              and(eq(approvalSteps.workspaceId, workspaceId), inArray(approvalSteps.requestId, requestIds)),
            )
        ).map((r) => r.id)
      : []

    const target = stepIds.length
      ? or(eq(approvalDecisions.approverId, personId), inArray(approvalDecisions.stepId, stepIds))
      : eq(approvalDecisions.approverId, personId)
    const where = and(
      eq(approvalDecisions.workspaceId, workspaceId),
      target,
      isNotNull(approvalDecisions.comment),
    )

    const [row] = await tx.select({ n: count() }).from(approvalDecisions).where(where)
    const rows = row?.n ?? 0
    if (rows > 0 && !dryRun) await tx.update(approvalDecisions).set({ comment: null }).where(where)
    return { class: 'approvalDecisions', table: 'approval_decisions', rows, columns: ['comment'] }
  }

  /**
   * The records that survive, counted, with the basis each survives under.
   *
   * `retentionHorizon` wins over the statutory reason wherever the workspace has actually set one:
   * with a horizon in force, the horizon is the operative answer to "why is this still here", and
   * the number the administrator typed is the thing they will recognise. Without one it falls back
   * to what the record is — a wage, an entitlement, or an authorisation.
   */
  private async keptClasses(
    tx: Tx,
    workspaceId: string,
    personId: string,
    retention: HrRetention,
  ): Promise<ErasureRetained[]> {
    const basis = (days: number | null, fallback: ErasureRetained['basis']): ErasureRetained['basis'] =>
      days === null ? fallback : 'retentionHorizon'

    const out: ErasureRetained[] = [
      {
        class: 'employment',
        table: 'employments',
        rows: await total(
          tx
            .select({ n: count() })
            .from(employments)
            .where(and(eq(employments.workspaceId, workspaceId), eq(employments.personId, personId))),
        ),
        basis: 'payRecord',
        retentionDays: null,
      },
      {
        class: 'officeAssignments',
        table: 'office_assignments',
        rows: await total(
          tx
            .select({ n: count() })
            .from(officeAssignments)
            .where(
              and(eq(officeAssignments.workspaceId, workspaceId), eq(officeAssignments.personId, personId)),
            ),
        ),
        basis: 'payRecord',
        retentionDays: null,
      },
      {
        class: 'leaveLedger',
        table: 'leave_ledger',
        rows: await total(
          tx
            .select({ n: count() })
            .from(leaveLedger)
            .where(and(eq(leaveLedger.workspaceId, workspaceId), eq(leaveLedger.personId, personId))),
        ),
        basis: basis(retention.leave, 'payRecord'),
        retentionDays: retention.leave,
      },
      {
        class: 'leaveRequests',
        table: 'leave_requests',
        rows: await total(
          tx
            .select({ n: count() })
            .from(leaveRequests)
            .where(and(eq(leaveRequests.workspaceId, workspaceId), eq(leaveRequests.personId, personId))),
        ),
        basis: basis(retention.leave, 'payRecord'),
        retentionDays: retention.leave,
      },
      {
        class: 'attendance',
        table: 'attendance_days',
        rows: await total(
          tx
            .select({ n: count() })
            .from(attendanceDays)
            .where(and(eq(attendanceDays.workspaceId, workspaceId), eq(attendanceDays.personId, personId))),
        ),
        basis: basis(retention.attendanceDays, 'payRecord'),
        retentionDays: retention.attendanceDays,
      },
      {
        class: 'punches',
        table: 'punches',
        rows: await total(
          tx
            .select({ n: count() })
            .from(punches)
            .where(and(eq(punches.workspaceId, workspaceId), eq(punches.personId, personId))),
        ),
        basis: basis(retention.punches, 'payRecord'),
        retentionDays: retention.punches,
      },
      {
        class: 'history',
        table: 'person_history',
        rows: await total(
          tx
            .select({ n: count() })
            .from(personHistory)
            .where(and(eq(personHistory.workspaceId, workspaceId), eq(personHistory.personId, personId))),
        ),
        basis: basis(retention.personHistory, 'auditTrail'),
        retentionDays: retention.personHistory,
      },
      {
        /**
         * Rows where this person was the **actor** on somebody else's record.
         *
         * Left alone, values and all. Erasing A is not authority to rewrite the trail of what A did
         * to B's record — that trail is B's, and B did not ask for anything.
         */
        class: 'history',
        table: 'person_history',
        rows: await total(
          tx
            .select({ n: count() })
            .from(personHistory)
            .where(
              and(
                eq(personHistory.workspaceId, workspaceId),
                eq(personHistory.actorId, personId),
                ne(personHistory.personId, personId),
              ),
            ),
        ),
        basis: 'anotherPersonsRecord',
        retentionDays: null,
      },
      {
        /**
         * The rows stay and so do the files, because HR cannot delete a core object: `core.files.get`
         * is the only file procedure a module can reach. Nulling the row would remove the last record
         * of which files those were and leave the passport scan in the bucket regardless — a promise
         * with nothing behind it, and the worst kind, because the response would say the document was
         * erased.
         */
        class: 'documents',
        table: 'person_documents',
        rows: await total(
          tx
            .select({ n: count() })
            .from(personDocuments)
            .where(and(eq(personDocuments.workspaceId, workspaceId), eq(personDocuments.personId, personId))),
        ),
        basis: 'notRemovable',
        retentionDays: retention.personDocuments,
      },
      {
        class: 'approvals',
        table: 'approval_requests',
        rows: await total(
          tx
            .select({ n: count() })
            .from(approvalRequests)
            .where(
              and(
                eq(approvalRequests.workspaceId, workspaceId),
                eq(approvalRequests.requesterPersonId, personId),
              ),
            ),
        ),
        basis: 'auditTrail',
        retentionDays: null,
      },
    ]
    return out
  }

  // ------------------------------------------------------------------ subject access

  /**
   * Every row HR holds about one person.
   *
   * Reads only — the sensitive decrypt and its access-log row are the caller's job, because that
   * pairing lives in `PeopleService.readSensitive` and there must go on being exactly one place in
   * this module that decrypts these columns.
   *
   * Each section fetches `cap + 1` rows so a cut is detectable without a second `count`, and every
   * cut is reported. Nothing is dropped in silence.
   */
  async subjectAccess(tx: Tx, workspaceId: string, personId: string) {
    const truncated: Truncation[] = []
    const cut = <T>(section: BundleSection, rows: T[]): T[] => {
      const cap = SECTION_CAPS[section]
      if (rows.length <= cap) return rows
      truncated.push({ section, returned: cap, cap })
      return rows.slice(0, cap)
    }
    const limitOf = (section: BundleSection) => SECTION_CAPS[section] + 1

    const employment = cut(
      'employment',
      await tx
        .select()
        .from(employments)
        .where(and(eq(employments.workspaceId, workspaceId), eq(employments.personId, personId)))
        .orderBy(desc(employments.effectiveFrom))
        .limit(limitOf('employment')),
    )

    const officeRows = cut(
      'offices',
      await tx
        .select()
        .from(officeAssignments)
        .where(and(eq(officeAssignments.workspaceId, workspaceId), eq(officeAssignments.personId, personId)))
        .orderBy(desc(officeAssignments.effectiveFrom))
        .limit(limitOf('offices')),
    )

    const history = cut(
      'history',
      await tx
        .select()
        .from(personHistory)
        .where(and(eq(personHistory.workspaceId, workspaceId), eq(personHistory.personId, personId)))
        .orderBy(desc(personHistory.at), desc(personHistory.id))
        .limit(limitOf('history')),
    )

    const documents = cut(
      'documents',
      await tx
        .select()
        .from(personDocuments)
        .where(and(eq(personDocuments.workspaceId, workspaceId), eq(personDocuments.personId, personId)))
        .orderBy(desc(personDocuments.createdAt))
        .limit(limitOf('documents')),
    )

    const requests = cut(
      'leaveRequests',
      await tx
        .select()
        .from(leaveRequests)
        .where(and(eq(leaveRequests.workspaceId, workspaceId), eq(leaveRequests.personId, personId)))
        .orderBy(desc(leaveRequests.startsOn))
        .limit(limitOf('leaveRequests')),
    )

    const days = cut(
      'leaveRequestDays',
      await tx
        .select()
        .from(leaveRequestDays)
        .where(and(eq(leaveRequestDays.workspaceId, workspaceId), eq(leaveRequestDays.personId, personId)))
        .orderBy(asc(leaveRequestDays.date))
        .limit(limitOf('leaveRequestDays')),
    )

    // Oldest first: the ledger is only meaningful read in order, and the running balance in the
    // bundle is the reason it is sent that way rather than newest-first like everything else.
    const ledger = cut(
      'leaveLedger',
      await tx
        .select()
        .from(leaveLedger)
        .where(and(eq(leaveLedger.workspaceId, workspaceId), eq(leaveLedger.personId, personId)))
        .orderBy(asc(leaveLedger.effectiveOn), asc(leaveLedger.id))
        .limit(limitOf('leaveLedger')),
    )

    const typeIds = [...new Set(ledger.map((r) => r.leaveTypeId).concat(requests.map((r) => r.leaveTypeId)))]
    const types = typeIds.length
      ? await tx
          .select()
          .from(leaveTypes)
          .where(and(eq(leaveTypes.workspaceId, workspaceId), inArray(leaveTypes.id, typeIds)))
      : []

    const punchRows = cut(
      'punches',
      await tx
        .select()
        .from(punches)
        .where(and(eq(punches.workspaceId, workspaceId), eq(punches.personId, personId)))
        .orderBy(desc(punches.businessDate), desc(punches.at))
        .limit(limitOf('punches')),
    )

    const dayRows = cut(
      'attendanceDays',
      await tx
        .select()
        .from(attendanceDays)
        .where(and(eq(attendanceDays.workspaceId, workspaceId), eq(attendanceDays.personId, personId)))
        .orderBy(desc(attendanceDays.businessDate))
        .limit(limitOf('attendanceDays')),
    )

    const regs = cut(
      'regularizations',
      await tx
        .select()
        .from(regularizations)
        .where(and(eq(regularizations.workspaceId, workspaceId), eq(regularizations.personId, personId)))
        .orderBy(desc(regularizations.businessDate))
        .limit(limitOf('regularizations')),
    )

    const raised = cut(
      'approvalsRaised',
      await tx
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.workspaceId, workspaceId),
            eq(approvalRequests.requesterPersonId, personId),
          ),
        )
        .orderBy(desc(approvalRequests.requestedAt))
        .limit(limitOf('approvalsRaised')),
    )

    // `approver_ids` is a uuid[] of **person** ids, and the gin index on it is what makes this an
    // overlap lookup rather than a scan of every step the workspace has ever raised.
    const approverOn = cut(
      'approverOn',
      await tx
        .select()
        .from(approvalSteps)
        .where(
          and(
            eq(approvalSteps.workspaceId, workspaceId),
            sql`${approvalSteps.approverIds} && array[${personId}]::uuid[]`,
          ),
        )
        .orderBy(desc(approvalSteps.id))
        .limit(limitOf('approverOn')),
    )

    const ownDecisions = cut(
      'decisions',
      await tx
        .select()
        .from(approvalDecisions)
        .where(
          and(eq(approvalDecisions.workspaceId, workspaceId), eq(approvalDecisions.approverId, personId)),
        )
        .orderBy(desc(approvalDecisions.at))
        .limit(limitOf('decisions')),
    )

    // Steps of their own requests, plus the steps they were named on, so `approverOn` can carry its
    // decisions rather than being a list of steps with no outcome.
    const raisedStepIds = raised.length
      ? (
          await tx
            .select({ id: approvalSteps.id })
            .from(approvalSteps)
            .where(
              and(
                eq(approvalSteps.workspaceId, workspaceId),
                inArray(
                  approvalSteps.requestId,
                  raised.map((r) => r.id),
                ),
              ),
            )
        ).map((r) => r.id)
      : []
    const stepIds = [...new Set([...raisedStepIds, ...approverOn.map((s) => s.id)])]
    const stepDecisions = stepIds.length
      ? await tx
          .select()
          .from(approvalDecisions)
          .where(
            and(eq(approvalDecisions.workspaceId, workspaceId), inArray(approvalDecisions.stepId, stepIds)),
          )
      : []
    const raisedSteps = raisedStepIds.length
      ? await tx
          .select()
          .from(approvalSteps)
          .where(and(eq(approvalSteps.workspaceId, workspaceId), inArray(approvalSteps.id, raisedStepIds)))
          .orderBy(asc(approvalSteps.stepIndex))
      : []

    const given = cut(
      'delegations',
      await tx
        .select()
        .from(delegations)
        .where(and(eq(delegations.workspaceId, workspaceId), eq(delegations.fromPersonId, personId)))
        .orderBy(desc(delegations.startsOn))
        .limit(limitOf('delegations')),
    )
    const received = cut(
      'delegations',
      await tx
        .select()
        .from(delegations)
        .where(and(eq(delegations.workspaceId, workspaceId), eq(delegations.toPersonId, personId)))
        .orderBy(desc(delegations.startsOn))
        .limit(limitOf('delegations')),
    )

    const accessLog = cut(
      'accessLog',
      await tx
        .select()
        .from(sensitiveAccessLog)
        .where(
          and(eq(sensitiveAccessLog.workspaceId, workspaceId), eq(sensitiveAccessLog.personId, personId)),
        )
        .orderBy(desc(sensitiveAccessLog.at), desc(sensitiveAccessLog.id))
        .limit(limitOf('accessLog')),
    )

    return {
      employment,
      offices: officeRows,
      history,
      documents,
      leave: { types, requests, days, ledger },
      attendance: { punches: punchRows, days: dayRows },
      regularizations: regs,
      approvals: { raised, raisedSteps, approverOn, stepDecisions, decisions: ownDecisions },
      delegations: { given, received },
      accessLog,
      truncated,
    }
  }
}

/** The running total down an ordered ledger. "Why is my balance this number", answered in the file. */
export const closingBalance = (ledger: ReadonlyArray<{ amountMinutes: number }>): number =>
  ledger.reduce((sum, entry) => sum + entry.amountMinutes, 0)
