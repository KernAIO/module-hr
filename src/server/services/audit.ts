import type { Principal } from '@kernhq/contracts'
import type { Kernel, Tx } from '@kernhq/kernel'
import { KernError, uuidv7 } from '@kernhq/kernel'
import { and, desc, eq, getTableColumns, type SQL, sql } from 'drizzle-orm'
import { MODULE_ID } from '../../contract/index.js'
import { sensitiveAccessLog } from '../schema.js'
import type { HrAccessService } from './access.js'

/**
 * Who read a national identity number, a birth date or a bank account, and when.
 *
 * `hr.person.view_sensitive` decides who *may* read those three; until this existed nothing recorded
 * that anybody had. That is the one gap a subject-access request cannot be answered around: "who has
 * looked at my data" is the question the log exists for, and a module that can only answer "somebody
 * with the permission, possibly" is answering it with a shrug.
 *
 * **Why the evidence lives here and not only in `mod_core.activity_events`.** Core does offer a
 * write — `core.activity.record`, `requireService`-gated, core/src/modules/core/index.ts:349 — and
 * the mirror below uses it. It cannot be the source of truth, for three reasons that were checked
 * against core rather than assumed:
 *
 * 1. **The permissions do not line up.** `activity_events` is read through `core.workspaces.audit`,
 *    gated by `core.audit.view` — an owner/admin default. `hr.person.view_sensitive` is held by
 *    *nobody* by default (src/contract/permissions.ts:62-70). Storing the read only there would
 *    publish "an admin read Ayşe's bank details" to a wider audience than the data itself has,
 *    which inverts the reason the sensitive fields sit in their own table at all.
 * 2. **It is a cross-service call that is allowed to fail, and cannot be made atomic.**
 *    `activity.record` opens its own `kernel.database.withWorkspace` on *core's* connection
 *    (core/src/modules/core/services/activity.ts:13) — there is no way to enlist it in the
 *    transaction that performed the read, whatever we do at this end. A notification that goes
 *    missing costs a card; an access record that goes missing costs the only evidence there is.
 * 3. **A subject-access request has to read it back per subject, from here.** `activity.list` can
 *    express the query, but it is not a broker — the brokers core registers are listed at
 *    core/src/modules/core/index.ts:205-380 and `activity.record` is the only activity one. Reading
 *    a subject's own history out of core would mean a new core procedure, in another repository, in
 *    the same release. `list` below answers it from this module's own tables instead.
 *
 * So: the row in `mod_hr.sensitive_access_log` is the evidence, written inside the transaction that
 * did the reading and never caught; the `core.activity.record` echo is best-effort, caught exactly
 * like the approval notifications, and carries field *names* only.
 *
 * **The write is not gated.** No permission suppresses it, no capability switches it off, there is
 * no skip path and no flag. An audit somebody can turn off is not an audit.
 */
export class HrAuditService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: HrAccessService,
  ) {}

  /**
   * Describe the caller once, so every row about one request agrees about who made it.
   *
   * `actorPersonId` is resolved here rather than left to the caller because it is the half a subject
   * actually recognises: a user id means nothing on a subject-access bundle, and "read by Ayşe Demir
   * in People Operations" means everything. It stays nullable — plenty of members with a permission
   * are not employees, and a member who was never made a person must not cost the read.
   *
   * **`userId` is not nullable, and an unattributable reader is refused here.** `actor_user_id` is
   * `not null` in the schema, so a principal with no user behind it cannot be recorded at all: left
   * to the insert it arrives as a bare 23502 from inside the read's own transaction, which fails the
   * read with a Postgres error string instead of a sentence. It is worth being explicit about which
   * principals those are — `systemPrincipal` spreads `ANONYMOUS`, so **every** `kind: 'service'`
   * carries `userId: null` (kernel/src/auth.ts:50-56), while an `api_key` is built by `fromUserId`
   * and always has one (core/src/auth/principal.ts). Refusing is the right direction rather than a
   * regrettable one: a log that says "somebody read her bank details" is not an answer to give a
   * subject, so a read nobody can be named for does not happen. If an unattended reader is ever
   * genuinely wanted — a payroll export on a schedule — it earns a column for the service name, not
   * a null actor.
   */
  async readerFor(
    tx: Tx,
    workspaceId: string,
    principal: Principal,
    via: SensitiveReadVia,
    purpose: string | null = null,
  ): Promise<SensitiveReader> {
    if (!principal.userId)
      throw new KernError(
        'FORBIDDEN',
        'These fields are released only to a signed-in account, because every release of them is recorded against one.',
        { kind: principal.kind },
        'sensitive_read_unattributable',
      )
    return {
      userId: principal.userId,
      personId: await this.access.personIdOf(tx, workspaceId, principal),
      via,
      purpose,
    }
  }

  /**
   * Record that these people's sensitive fields were disclosed to this reader.
   *
   * **In the caller's transaction, and deliberately not caught.** If this insert fails the read
   * fails with it and the plaintext never reaches the wire — which is the right way round, and the
   * choice is smaller than it sounds: the insert goes into the same database, on the same
   * connection, inside a transaction that is already open, so the only ways it can fail are the ways
   * the surrounding `select` would have failed too. There is almost no state where the read succeeds
   * and the log does not, so "keep the read working" buys nothing and costs the single property the
   * log exists to have. The cross-service echo in `mirror` is the opposite case — a genuinely
   * independent failure — and is caught.
   *
   * **One row per person, never one per field.** Four fields would quadruple a table that only ever
   * grows, and `fields` answers the same question in one row. What that costs: one insert and two
   * index entries per `people.sensitive.get`, which is a per-person endpoint
   * (`GET /people/{personId}/sensitive`) with no list form — a directory page that shows fifty
   * people writes nothing, because none of those fifty rows carries a sensitive field. An HR team
   * opening fifty records a day writes about eighteen thousand rows a year. The one path that reads
   * many people at once is a privacy export, which is why this takes an array and emits a single
   * multi-row insert rather than making the caller loop.
   *
   * `fields` lists only what was actually non-null in the response. An empty array is meaningful and
   * still written: it says somebody opened the record and nothing was there, which is a different
   * fact from nobody having looked, and a subject asking who accessed their data wants both.
   */
  async record(
    tx: Tx,
    workspaceId: string,
    reader: SensitiveReader,
    reads: readonly SensitiveAccess[],
  ): Promise<void> {
    if (!reads.length) return
    await tx.insert(sensitiveAccessLog).values(
      reads.map((r) => ({
        id: uuidv7(),
        workspaceId,
        personId: r.personId,
        actorUserId: reader.userId,
        actorPersonId: reader.personId,
        fields: [...r.fields],
        purpose: reader.purpose,
        via: reader.via,
      })),
    )
  }

  /**
   * Echo the read into the workspace's one audit console, best-effort.
   *
   * Call it **after** the transaction has committed, never inside it: `activity.record` is an HTTP
   * hop to core, and holding an HR transaction open across it is how a slow core turns into an HR
   * connection-pool outage. It is also why a failure here is caught and logged rather than raised —
   * same shape, and the same reasoning, as the approval notifications in `approvals.ts`. Losing this
   * loses a console line; the evidence is already committed by `record`.
   *
   * `data` carries the field **names** and never a value, which is the discipline `sensitive.update`
   * already follows when it writes its history row: an audit trail that quotes a national identity
   * number defeats the reason that column is encrypted.
   *
   * One event per subject, in sequence. Every path today reads one subject, so that is one call; a
   * caller that reads many at once is choosing to write that many console entries and should decide
   * whether the console wants them.
   */
  async mirror(
    workspaceId: string,
    reader: SensitiveReader,
    reads: readonly SensitiveAccess[],
  ): Promise<void> {
    for (const read of reads)
      try {
        await this.kernel.call(
          'core.activity.record',
          {
            workspaceId,
            module: MODULE_ID,
            object: { module: MODULE_ID, type: 'person', id: read.personId },
            action: 'sensitive_read',
            actorId: reader.userId,
            changes: [],
            data: { fields: [...read.fields], via: reader.via },
          },
          this.kernel.system,
        )
      } catch (err) {
        this.kernel.log.warn(
          {
            module: MODULE_ID,
            workspaceId,
            personId: read.personId,
            err: (err as Error).message,
          },
          'sensitive read not mirrored to the activity log',
        )
      }
  }

  /**
   * The log back out: one subject's readers, or one reader's subjects.
   *
   * Returns `limit + 1` rows and leaves the page to the caller, because the cursor helpers live in
   * the router and both halves of a keyset cursor have to agree about encoding. `atText` is selected
   * as `::text` on purpose — node-postgres rounds a `timestamptz` to milliseconds on the way into a
   * JS `Date`, so a cursor built from the row object sorts *before* the row it came from and drops
   * every row that ties with it. Rows written by one multi-row insert all share `now()`, so a bulk
   * export is exactly the case that ties.
   */
  async list(
    tx: Tx,
    input: {
      workspaceId: string
      personId?: string
      actorUserId?: string
      limit: number
      /** Keyset predicate from the caller's cursor, over `accessLogSort`. */
      after?: SQL
    },
  ) {
    const where = [eq(sensitiveAccessLog.workspaceId, input.workspaceId)]
    if (input.personId) where.push(eq(sensitiveAccessLog.personId, input.personId))
    if (input.actorUserId) where.push(eq(sensitiveAccessLog.actorUserId, input.actorUserId))
    if (input.after) where.push(input.after)
    return tx
      .select({
        ...getTableColumns(sensitiveAccessLog),
        atText: sql<string>`${sensitiveAccessLog.at}::text`,
      })
      .from(sensitiveAccessLog)
      .where(and(...where))
      .orderBy(desc(sensitiveAccessLog.at), desc(sensitiveAccessLog.id))
      .limit(input.limit + 1)
  }

  /** Serialise a row for the wire. `fields` and `via` are text in Postgres and unions here. */
  static toEntry(row: typeof sensitiveAccessLog.$inferSelect) {
    return {
      id: row.id,
      personId: row.personId,
      actorUserId: row.actorUserId,
      actorPersonId: row.actorPersonId,
      fields: row.fields as SensitiveField[],
      purpose: row.purpose,
      via: row.via as SensitiveReadVia,
      at: row.at.toISOString(),
    }
  }
}

/** The sort key `list` orders by, so a caller can build the matching cursor predicate. */
export const accessLogSort = { at: sensitiveAccessLog.at, id: sensitiveAccessLog.id }

/**
 * The fields behind `hr.person.view_sensitive`, in the order `PersonSensitive` declares them.
 *
 * These are the names a subject is shown, so they are the contract's names rather than the column
 * names — `nationalId`, not `national_id_enc`. Adding a field to `PersonSensitive` without adding it
 * here means a disclosure the log does not mention.
 */
export const SENSITIVE_FIELDS = ['nationalId', 'birthDate', 'iban', 'emergencyContact'] as const
export type SensitiveField = (typeof SENSITIVE_FIELDS)[number]

/**
 * How the read arrived. Stored as `text`, so a surface added later needs no migration.
 *
 * There is no `'mcp'`, and that is not an oversight: core's MCP proxy forwards a plain bearer token
 * to the module route (core/src/mcp/server.ts:448-458), so an MCP-driven read reaches HR as an
 * ordinary `kind: 'user'` principal and nothing here can honestly tell it from a browser. A value
 * nothing can ever write is the same lie as a permission key nothing asks about. Distinguishing it
 * needs core's proxy to stamp a surface header that `RequestContext.headers` would then carry —
 * a change in core, and worth making, but not something to pretend about from this side.
 *
 * There is no `'service'` either, and it is the same rule applied a second time rather than a
 * different decision. `systemPrincipal` spreads `ANONYMOUS` (kernel/src/auth.ts:50-56), so a
 * `kind: 'service'` principal always has `userId: null` and `readerFor` refuses it before a row is
 * ever built — leaving `'service'` as a label no row could carry. An `api_key` is the case that
 * looks similar and is not: `fromApiKey` resolves it through `fromUserId`, so it has a real account
 * behind it and `'api'` is genuinely written.
 */
export type SensitiveReadVia = 'ui' | 'api' | 'export'

/** Who is reading, resolved once per request by `readerFor`. */
export interface SensitiveReader {
  /** The account the disclosure is recorded against. Never null — see `readerFor`. */
  userId: string
  /** The reader's own HR record, when they have one. Null for a member who is not an employee. */
  personId: string | null
  via: SensitiveReadVia
  /** Why, when the path knows — a privacy export names the request it is answering. */
  purpose: string | null
}

/** One person's record, and what of it was actually disclosed. */
export interface SensitiveAccess {
  personId: string
  fields: SensitiveField[]
}

/**
 * How a request-borne read arrived, from the principal alone.
 *
 * Derived, never taken from the caller: a client-supplied `via` is a field the reader controls, and
 * the point of the log is that it says what happened rather than what the reader claimed. `'export'`
 * is not reachable from here — it is passed explicitly by the path that takes a bulk copy of a
 * record, which is a server-side decision, not a request header.
 */
export function viaFor(principal: Principal): SensitiveReadVia {
  // `service` and `anonymous` both reach `readerFor` with no `userId` and are refused there, so
  // `user` and `api_key` are the only kinds that ever reach a stored row.
  return principal.kind === 'api_key' ? 'api' : 'ui'
}

/**
 * Which of the four fields actually came back with a value.
 *
 * Non-null rather than "was asked for": a record holding only a birth date has not had its bank
 * details read, and filing it as though it had overstates what happened in the one document where
 * overstatement is expensive. An empty array is a real answer and still written — somebody opened a
 * record and nothing was in it, which is a different fact from nobody having looked.
 */
export const fieldsPresent = (v: Record<SensitiveField, unknown>): SensitiveField[] =>
  SENSITIVE_FIELDS.filter((f) => v[f] !== null && v[f] !== undefined)
