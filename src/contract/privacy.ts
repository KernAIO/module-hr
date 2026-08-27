import { Timestamp, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import { ApprovalDecision, ApprovalRequest, ApprovalStep, Delegation } from './approvals.js'
import { AttendanceDay, Punch, Regularization } from './attendance.js'
import { LeaveLedgerEntry, LeaveRequest, LeaveType } from './leave.js'
import { Employment, IsoDate, OfficeAssignment, Person, PersonDocument, PersonSensitive } from './models.js'
import { ResolvedPolicy } from './policies.js'

/**
 * Subject access, erasure and retention — the three things a data-protection law asks a personnel
 * system for, and the one part of HR whose whole job is to say what it did.
 *
 * Three positions hold this file together, and each of them is a decision the rest of the module
 * already made somewhere else:
 *
 * - **Erasure is redaction, never deletion.** `leave_ledger` is append-only because a balance is the
 *   sum of it and nothing else; `punches` is append-only because an attendance record somebody can
 *   quietly rewrite is worth nothing in the dispute it exists for; `employments` is effective-dated
 *   so March is still answerable in June. Deleting an erased person's rows would break all three and
 *   would answer a payroll audit with "she left, so we deleted her file". So erasure clears the
 *   columns that identify a person and leaves every record that a wage, an entitlement or an
 *   authorisation was computed from. Afterwards the ledger still has somebody to attribute a day
 *   to, and nobody has a name.
 * - **It says what it kept, per class, and why.** The `kept` half of the report is not a courtesy:
 *   an erasure that silently retains is the same failure as an export that silently omits, and the
 *   only difference is which of the two the subject finds out about later.
 * - **Nothing here is a capability.** A workspace that could switch privacy off would be a workspace
 *   that stopped honouring subject requests, which fails the capability registry's own second rule —
 *   a switch must be reversible without destroying data, and this one would not even be a switch
 *   anybody should be offered. One permission key, `hr.privacy.manage`, gates all four procedures,
 *   and it ships in the same change as them.
 */

const ws = { workspaceId: WorkspaceId }

// =====================================================================================
// retention
// =====================================================================================

/**
 * A horizon in days, or null.
 *
 * **Null is the shipped value for every class and it means "keep indefinitely".** "Seven years" is a
 * fact about one country and one document class, not about the world, so no number here is a
 * default: the suggested figures live in the help text on the settings screen, beside the sentence
 * saying Kern gives no legal advice. The workspace owner sets them, and where their legal entities
 * differ they set them per entity — which this shape cannot yet express, and says so below.
 */
const RetentionDays = z.number().int().min(1).max(36_500).nullable().default(null)

/**
 * The classes retention is expressed in.
 *
 * They follow the redact/retain split rather than the table list, because that is the split a
 * retention decision is actually made in: "how long do we keep the evidence behind a day sheet" is
 * one question whatever tables it lands in.
 */
export const RetentionClass = z.enum([
  /** Where a punch happened, on what device, and what was typed on it. */
  'punchDetail',
  /** The punch rows themselves — the evidence behind a day sheet. */
  'punches',
  /** The derived day sheet: hours, overtime, lateness. This is pay. */
  'attendanceDays',
  /** Ledger movements and the requests behind them. Also pay. */
  'leave',
  /** The audit trail. At the horizon the values go and the rows stay — see `privacy.erase`. */
  'personHistory',
  /** Contracts, payslips, identity scans. */
  'personDocuments',
  /** People who have left, and have not been erased. */
  'terminatedPeople',
  /** Who read somebody's identity, birth date or bank details. Itself personal data. */
  'sensitiveAccessLog',
])
export type RetentionClass = z.infer<typeof RetentionClass>

/**
 * How long HR keeps each class, per workspace.
 *
 * A table rather than module settings, and the reason is mechanical: `core.settings.setModule`
 * validates the merged blob against the module's declared zod schema and a zod object strips what it
 * does not declare — so a retention key stored beside `country` and `employeeNumberPrefix` would be
 * deleted by the next unrelated settings write, silently, from a screen that never mentions
 * retention. Extending `HrSettings` instead is the other honest route and is a change to a shared
 * shape; this one keeps the numbers where nothing can quietly drop them.
 *
 * Workspace-wide for now. The honest end state is per legal entity — a Dutch entity and a Turkish
 * one have different obligations, which is exactly why `periods` is already per legal entity — and
 * the row carries a jsonb config so that move is an added column rather than a new table.
 */
export const HrRetention = z.object({
  punchDetail: RetentionDays,
  punches: RetentionDays,
  attendanceDays: RetentionDays,
  leave: RetentionDays,
  personHistory: RetentionDays,
  personDocuments: RetentionDays,
  terminatedPeople: RetentionDays,
  sensitiveAccessLog: RetentionDays,
})
export type HrRetention = z.infer<typeof HrRetention>

/** One class, its horizon, and what has already passed it. */
export const RetentionClassState = z.object({
  class: RetentionClass,
  /** Null means "kept indefinitely", which is what every class ships as. */
  days: z.number().int().nullable(),
  /**
   * How many rows are already older than the horizon — the dry run, asked for with `withCounts`.
   *
   * Null when no horizon is set (nothing to be past) or when the caller did not ask for counts. A
   * retention screen that cannot say what a sweep would touch before it runs is a data-loss button
   * with no confirmation, so this is the number that belongs beside every horizon on it.
   */
  dueNow: z.number().int().nullable(),
})
export type RetentionClassState = z.infer<typeof RetentionClassState>

export const RetentionSettings = z.object({
  ...ws,
  classes: z.array(RetentionClassState),
  updatedAt: Timestamp.nullable(),
  updatedBy: z.uuid().nullable(),
  /**
   * Whether anything in HR deletes on these horizons yet. **It is false, and saying so is the
   * point.**
   *
   * The horizons are read in two places today: here, to count what has passed one, and by
   * `privacy.erase`, to say under which horizon each surviving class was kept. No timed sweep acts
   * on them. An unattended job that prunes personnel records is the one act in this module that
   * cannot be undone by re-running anything, so it ships off, with a dry run and a per-run report
   * naming every person it touched — and until it exists this field must not claim otherwise.
   */
  sweepEnabled: z.literal(false),
})
export type RetentionSettings = z.infer<typeof RetentionSettings>

// =====================================================================================
// erasure
// =====================================================================================

/** The units erasure reports in. One per group of columns that survive or go together. */
export const ErasureClass = z.enum([
  'identity',
  'sensitive',
  'history',
  'documents',
  'punches',
  'attendance',
  'leaveRequests',
  'leaveLedger',
  'employment',
  'officeAssignments',
  'approvals',
  'approvalDecisions',
  'regularizations',
  'delegations',
  'headship',
])
export type ErasureClass = z.infer<typeof ErasureClass>

/** A class the erasure cleared, and exactly which columns it cleared. */
export const ErasureRedaction = z.object({
  class: ErasureClass,
  table: z.string(),
  /** Rows that still had something to clear. Zero on a replay, which is what makes it replayable. */
  rows: z.number().int(),
  columns: z.array(z.string()),
})
export type ErasureRedaction = z.infer<typeof ErasureRedaction>

/**
 * Why a record survived an erasure.
 *
 * An enum rather than a sentence: a reason composed on the server is English for every reader, and
 * this one is read by the person who asked to be forgotten. The client renders it.
 */
export const RetentionBasis = z.enum([
  /** A wage, an entitlement or the hours behind one. Statutory wherever Kern ships a country pack. */
  'payRecord',
  /** What changed, when, and who authorised it. Erasing the trail and erasing the data differ. */
  'auditTrail',
  /** The workspace set a horizon for this class and it has not passed. */
  'retentionHorizon',
  /** HR cannot remove it: the bytes belong to another module. See `caveats`. */
  'notRemovable',
  /** It is somebody else's record. Erasing A is not authority to rewrite what A did to B's row. */
  'anotherPersonsRecord',
])
export type RetentionBasis = z.infer<typeof RetentionBasis>

export const ErasureRetained = z.object({
  class: ErasureClass,
  table: z.string(),
  rows: z.number().int(),
  basis: RetentionBasis,
  /** The horizon in force for the retention class covering this, when the workspace set one. */
  retentionDays: z.number().int().nullable(),
})
export type ErasureRetained = z.infer<typeof ErasureRetained>

/**
 * Things the response has to state in words, as keys the client renders.
 *
 * Each one is a promise this module would otherwise be making and not keeping.
 */
export const ErasureCaveat = z.enum([
  /**
   * `person_documents` rows and their files both survive. `core.files.get` is the only file
   * procedure a module can reach — there is no `files.delete` — so an erasure claiming to remove
   * employee documents would null a row and leave the passport scan in the bucket. The rows stay
   * because they are also the only remaining record of which files those are.
   */
  'documentFilesRemain',
  /** The profile photo pointer was cleared; the object behind it is in `filesRemaining`. */
  'photoFileOrphaned',
  /** Sick notes attached to leave requests, same reason and same list. */
  'leaveDocumentFilesRemain',
  /** The national identity number was kept, because the caller asked for it to be. */
  'nationalIdKeptForAudit',
  /**
   * History rows where this person was the **actor** on somebody else's record keep their values.
   * Erasing A is not authority to rewrite the trail of what A did to B.
   */
  'actorHistoryKept',
  /** At least one attendance day or punch sits in a locked period and was left exactly as it is. */
  'lockedPeriodUntouched',
])
export type ErasureCaveat = z.infer<typeof ErasureCaveat>

/**
 * What an erasure did, or would do.
 *
 * The same shape either way, because a preview computed differently from the thing it previews is a
 * preview that eventually lies — the rule `accrual.preview` is written under.
 */
export const ErasureReport = z.object({
  ...ws,
  personId: z.uuid(),
  /** True when nothing was written. See `privacy.erase` for why this is what the default gives you. */
  dryRun: z.boolean(),
  /**
   * When this person was erased. Null on a dry run of a person who has not been.
   *
   * On a replay it carries the **first** erasure's timestamp: the second run finds nothing left to
   * clear, reports zero rows everywhere, and does not restamp the tombstone.
   */
  erasedAt: Timestamp.nullable(),
  /** The pseudonym the directory shows now. Never a name, never empty — `displayName` is not null. */
  displayName: z.string(),
  redacted: z.array(ErasureRedaction),
  kept: z.array(ErasureRetained),
  caveats: z.array(ErasureCaveat),
  /**
   * File objects in core's storage that this erasure could not delete, and which are recorded on the
   * person row so a later release can finish the job rather than losing them.
   */
  filesRemaining: z.array(z.uuid()),
})
export type ErasureReport = z.infer<typeof ErasureReport>

// =====================================================================================
// the sensitive read log
// =====================================================================================

/**
 * How a sensitive record was reached.
 *
 * Derived from the principal, never taken from the caller — a client-supplied value is one the
 * reader controls, and this log exists to say what happened rather than what the reader claimed.
 * `export` is the exception and is not reachable from a request: it is passed by the one server-side
 * path that takes a bulk copy of a record, which is `privacy.subjectAccess`.
 *
 * There is no `mcp` and no `service`, and both omissions are the same rule rather than an oversight.
 * Core's MCP proxy forwards a plain bearer token, so an assistant's read arrives as an ordinary
 * `kind: 'user'` principal that nothing here can honestly tell from a browser; and a service
 * principal carries no user id at all, so the read is refused before a row is built. A value nothing
 * can ever write is the same lie as a permission key nothing asks about. See `services/audit.ts`.
 */
export const SensitiveAccessVia = z.enum(['ui', 'api', 'export'])
export type SensitiveAccessVia = z.infer<typeof SensitiveAccessVia>

/**
 * One read of somebody's identity, birth date or bank details.
 *
 * Written in the same transaction as the read, in HR's own schema. `mod_core.activity_events` also
 * gets a best-effort copy so the workspace's single audit console shows that HR sensitive data was
 * touched — but it cannot be the record, for two reasons: it is read behind `core.audit.view`,
 * which owners and admins hold by default and `hr.person.view_sensitive` deliberately nobody does,
 * so publishing the read there inverts the model the sensitive split exists to create; and the
 * cross-service call is allowed to fail, which is right for a notification and wrong for evidence.
 * A subject-access response that answers "who looked at my data" out of a log with silent holes is
 * worse than one that says it cannot answer.
 */
export const SensitiveAccess = z.object({
  id: z.uuid(),
  /** Whose record was read. */
  personId: z.uuid(),
  /**
   * The account the disclosure is recorded against. Never null: a reader nobody can be named for is
   * refused before the record is loaded, because "somebody read your bank details" is not an answer
   * to give a subject.
   */
  actorUserId: z.uuid(),
  /** The reader's own HR record, when they have one. Plenty of accounts are not employees. */
  actorPersonId: z.uuid().nullable(),
  /**
   * Only the fields that actually came back with a value.
   *
   * Logging "read the record" when three of the four were empty overstates what happened, and this
   * log is itself read by the subject.
   */
  fields: z.array(z.string()),
  /** Why, when the caller said. Shown to the subject in their own bundle — nowhere else. */
  purpose: z.string().max(500).nullable(),
  via: SensitiveAccessVia,
  at: Timestamp,
})
export type SensitiveAccess = z.infer<typeof SensitiveAccess>

// =====================================================================================
// the subject-access bundle
// =====================================================================================

/** `person_history`, with the values. Redacting it in a subject's own bundle defeats the purpose. */
export const PersonHistoryEntry = z.object({
  id: z.uuid(),
  field: z.string(),
  from: z.unknown(),
  to: z.unknown(),
  at: Timestamp,
  actorId: z.uuid().nullable(),
  source: z.string(),
})
export type PersonHistoryEntry = z.infer<typeof PersonHistoryEntry>

/** A request exploded into days — what the balance was actually charged for. */
export const LeaveRequestDay = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  date: IsoDate,
  fraction: z.number(),
  counted: z.boolean(),
  status: z.string(),
})
export type LeaveRequestDay = z.infer<typeof LeaveRequestDay>

/** A section that hit the row cap. Named, with its numbers, so nothing is short by surprise. */
export const BundleTruncation = z.object({
  section: z.string(),
  returned: z.number().int(),
  cap: z.number().int(),
})

/** Something this bundle does not contain, and why. */
export const BundleExclusion = z.object({
  section: z.string(),
  reason: z.enum([
    /**
     * The bytes of a file. HR holds the metadata and the id; the object lives in core's storage and
     * a module can only ask for a download URL for one file at a time.
     */
    'fileContentsNotExportable',
    /** The caller asked for the fast path. */
    'notRequested',
  ]),
})

export const SubjectAccessManifest = z.object({
  ...ws,
  personId: z.uuid(),
  generatedAt: Timestamp,
  generatedBy: z.uuid().nullable(),
  /** From `packageVersion(import.meta.url)`, never a literal — the literals drifted for months. */
  moduleVersion: z.string(),
  truncated: z.array(BundleTruncation),
  excluded: z.array(BundleExclusion),
})
export type SubjectAccessManifest = z.infer<typeof SubjectAccessManifest>

/**
 * Everything HR holds about one person, including the parts they cannot reach through the product.
 *
 * Structured JSON rather than a zip of files, and one person at a time. Both are deliberate:
 *
 * - **The rows are not the problem; documents are.** Five years of four punches a day is about nine
 *   thousand rows and two to three megabytes — large for a response and bounded. A contract PDF,
 *   three payslips a year and an identity scan has no upper bound at all, which is why the file
 *   bytes are named in `manifest.excluded` instead of being streamed through a request handler.
 *   Every section is capped and every cap that bites is named in `manifest.truncated`.
 * - **There is no workspace-wide variant, and there will not be.** Five hundred people is two and a
 *   half million rows with decrypted bank details in flight. `personId` is required and there is no
 *   filter.
 *
 * `sensitive` is decrypted here, which makes this the most dangerous object the module produces —
 * so producing it writes a `sensitive_access_log` row with `via: 'export'` before it is returned. An
 * export is a bulk read of that record, not a smaller one.
 */
export const SubjectAccessBundle = z.object({
  manifest: SubjectAccessManifest,
  /**
   * The whole row, not the directory card.
   *
   * `forViewer` narrows `personalEmail`, `phone`, `hiredOn` and `terminatedOn` for a reader who may
   * not see somebody's personnel record. Those four are the subject's own; they are not narrowed
   * here.
   */
  person: Person,
  sensitive: PersonSensitive,
  employment: z.array(Employment),
  offices: z.array(OfficeAssignment),
  history: z.array(PersonHistoryEntry),
  /** Metadata and file ids. The bytes are named in `manifest.excluded`. */
  documents: z.array(PersonDocument),
  leave: z.object({
    types: z.array(LeaveType),
    requests: z.array(LeaveRequest),
    days: z.array(LeaveRequestDay),
    ledger: z.array(LeaveLedgerEntry),
    /** The running balance down the ledger, so "why is my balance this number" is answered here. */
    closingBalanceMinutes: z.number().int(),
  }),
  attendance: z.object({
    punches: z.array(Punch),
    days: z.array(AttendanceDay),
  }),
  regularizations: z.array(Regularization),
  approvals: z.object({
    /** Requests this person raised. */
    raised: z.array(ApprovalRequest),
    /** Steps they were named on as an approver, with the decisions filed against them. */
    approverOn: z.array(ApprovalStep),
    /** Their own decisions, wherever they were filed. */
    decisions: z.array(ApprovalDecision),
  }),
  /** Both directions: what they handed over, and what was handed to them. */
  delegations: z.object({
    given: z.array(Delegation),
    received: z.array(Delegation),
  }),
  /**
   * The accrual, overtime and rounding policy resolved for this person today, with the rung that
   * answered. Included whatever the `leave_accrual` capability is set to: it is the subject's own
   * data, and "why does she accrue differently from her team" is the commonest follow-up a subject
   * access request produces.
   */
  policiesInForce: z.array(ResolvedPolicy),
  /** Who read their identity, birth date or bank details. A bundle without it is incomplete. */
  accessLog: z.array(SensitiveAccess),
})
export type SubjectAccessBundle = z.infer<typeof SubjectAccessBundle>
