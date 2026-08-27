import { moduleSchema } from '@kernhq/kernel'
import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * HR's tables, in `mod_hr`.
 *
 * Two rules apply to every tenant table here, neither optional: `workspace_id` with an index that
 * starts with it, and a row-level security policy hand-written in the migration. Three more apply to
 * this module in particular, and they are what most of the design is about:
 *
 * - **Effective-dated tables are never updated in place.** `employments` and `office_assignments`
 *   record what was true over a period. A change closes the open row and inserts a new one, so
 *   "who did she report to in March" stays answerable — which a leave approval from March needs.
 * - **History is append-only.** `person_history` records what changed, when and by whom, and nothing
 *   rewrites it. It is what a KVKK or GDPR subject-access request is built from.
 * - **Constraints, not application code, enforce the invariants that matter.** One primary office
 *   per person per day, and no two overlapping employment rows, are guaranteed by exclusion
 *   constraints in migration 0001. Two concurrent requests cannot both win.
 */
export const schema = moduleSchema('hr')

const ltree = customType<{ data: string }>({ dataType: () => 'ltree' })

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`)
const ws = () => uuid('workspace_id').notNull()
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const created = () => ts('created_at').notNull().defaultNow()
const updated = () => ts('updated_at').notNull().defaultNow()

// =====================================================================================
// offices, entities — the unit of inheritance
// =====================================================================================

export const legalEntities = schema.table(
  'legal_entities',
  {
    id: id(),
    workspaceId: ws(),
    name: text('name').notNull(),
    registrationNo: text('registration_no'),
    taxNo: text('tax_no'),
    country: text('country').notNull(),
    currency: text('currency'),
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('hr_entities_ws_idx').on(t.workspaceId, t.archivedAt)],
)

export const offices = schema.table(
  'offices',
  {
    id: id(),
    workspaceId: ws(),
    name: text('name').notNull(),
    code: text('code'),
    kind: text('kind').notNull().default('branch'),
    /** A campus with buildings. Geography, not the org chart. */
    parentOfficeId: uuid('parent_office_id'),
    legalEntityId: uuid('legal_entity_id'),
    country: text('country').notNull(),
    region: text('region'),
    city: text('city'),
    /** IANA, never an offset — an offset cannot survive a daylight-saving transition. */
    timezone: text('timezone').notNull().default('UTC'),
    calendarId: uuid('calendar_id'),
    address: jsonb('address').$type<Record<string, string>>(),
    /**
     * Exactly one per workspace, enforced by a partial unique index in 0001.
     *
     * Always present, even when the `offices` capability is off: HR creates it from the workspace
     * country and nobody sees the word. That is what makes enabling the capability a reveal rather
     * than a migration, and why nothing in this module has a "no office" branch.
     */
    isDefault: boolean('is_default').notNull().default(false),
    headPersonId: uuid('head_person_id'),
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('hr_offices_ws_idx').on(t.workspaceId, t.archivedAt),
    index('hr_offices_ws_country_idx').on(t.workspaceId, t.country),
    /**
     * One default office per workspace — the invariant `isDefault` above describes, created by
     * 0001. Declared here rather than left to the migration alone because a snapshot that does not
     * know about an index is what lets a later `db:generate` propose creating it a second time.
     */
    uniqueIndex('hr_offices_one_default_per_ws').on(t.workspaceId).where(sql`is_default`),
  ],
)

export const costCenters = schema.table(
  'cost_centers',
  {
    id: id(),
    workspaceId: ws(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    officeId: uuid('office_id'),
    orgUnitId: uuid('org_unit_id'),
    legalEntityId: uuid('legal_entity_id'),
    archivedAt: ts('archived_at'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('hr_cost_centers_ws_code_uq').on(t.workspaceId, t.code)],
)

// =====================================================================================
// org structure
// =====================================================================================

export const orgUnits = schema.table(
  'org_units',
  {
    id: id(),
    workspaceId: ws(),
    parentId: uuid('parent_id'),
    /**
     * Materialised ltree path. A subtree is `path <@ 'root.eng'`, which is one GiST index lookup —
     * and the same query answers both "who is in this department" and the office/team permission
     * scope, so it is on a hot path twice.
     */
    path: ltree('path').notNull(),
    name: text('name').notNull(),
    code: text('code'),
    headPersonId: uuid('head_person_id'),
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('hr_org_units_ws_idx').on(t.workspaceId, t.archivedAt),
    /** Two departments at one path would make a subtree query return one of them arbitrarily. */
    uniqueIndex('hr_org_units_ws_path_uq').on(t.workspaceId, t.path),
    /** The `<@` lookup the comment on `path` is about. A btree cannot answer it. */
    index('hr_org_units_path_gist').using('gist', t.path),
  ],
)

export const positions = schema.table(
  'positions',
  {
    id: id(),
    workspaceId: ws(),
    title: text('title').notNull(),
    code: text('code'),
    jobFamily: text('job_family'),
    level: text('level'),
    archivedAt: ts('archived_at'),
    createdAt: created(),
  },
  (t) => [index('hr_positions_ws_idx').on(t.workspaceId, t.archivedAt)],
)

// =====================================================================================
// people
// =====================================================================================

export const people = schema.table(
  'people',
  {
    id: id(),
    workspaceId: ws(),
    /** Nullable: plenty of employees never sign in, and HR is populated before anyone is invited. */
    userId: uuid('user_id'),
    employeeNo: text('employee_no'),
    displayName: text('display_name').notNull(),
    workEmail: text('work_email'),
    personalEmail: text('personal_email'),
    phone: text('phone'),
    photoFileId: uuid('photo_file_id'),
    status: text('status').notNull().default('active'),
    hiredOn: date('hired_on'),
    terminatedOn: date('terminated_on'),
    /** Overrides the primary office's zone for somebody who genuinely works elsewhere. */
    timezone: text('timezone'),
    custom: jsonb('custom').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /**
     * The erasure tombstone.
     *
     * Deliberately **not** a member of `status`. `status` carries the employment lifecycle —
     * onboarding, active, on leave, offboarding, terminated — and overloading it with `erased` makes
     * "was she still employed when this was approved" unanswerable, which is the question a payroll
     * audit asks. It would also be a *constructing* break on a shared contract: adding a member to
     * `PersonStatus` keeps every stored row parsing and stops every site that builds one compiling.
     * A separate nullable timestamp says the same thing and costs nothing.
     */
    erasedAt: ts('erased_at'),
    erasedBy: uuid('erased_by'),
    erasureReason: text('erasure_reason'),
    /**
     * File objects an erasure had to leave in core's storage.
     *
     * `core.files.get` is the only file procedure a module can reach — there is no `files.delete` —
     * so clearing `photo_file_id` and `leave_requests.document_file_id` removes the *pointer* and
     * orphans the object. Recording the ids here is what keeps that finishable: without them the
     * bytes stay in the bucket with nothing left that knows they were hers. `person_documents` rows
     * are kept instead of being nulled, so their files need no entry here.
     */
    erasedFileIds: uuid('erased_file_ids').array(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('hr_people_ws_status_idx').on(t.workspaceId, t.status, t.displayName),
    uniqueIndex('hr_people_ws_user_uq').on(t.workspaceId, t.userId),
    uniqueIndex('hr_people_ws_empno_uq').on(t.workspaceId, t.employeeNo),
  ],
)

/**
 * The fields that need a second permission, in their own table.
 *
 * Not optional columns on `people`: an optional column gets returned by a `select *` that somebody
 * wrote in a hurry, and this is the data a KVKK or GDPR breach is measured in. A separate table
 * means reading it is a deliberate join, and `hr.person.view_sensitive` guards the one procedure
 * that performs it.
 */
export const peopleSensitive = schema.table(
  'people_sensitive',
  {
    personId: uuid('person_id').primaryKey(),
    workspaceId: ws(),
    /** Encrypted through `kernel.secrets`; the column holds ciphertext, never the number. */
    nationalIdEnc: text('national_id_enc'),
    birthDate: date('birth_date'),
    ibanEnc: text('iban_enc'),
    emergencyContact: jsonb('emergency_contact').$type<Record<string, string>>(),
    updatedAt: updated(),
  },
  (t) => [index('hr_people_sensitive_ws_idx').on(t.workspaceId)],
)

/**
 * Effective-dated employment. One row per period the job was a given shape.
 *
 * `effective_to IS NULL` is the present. Migration 0001 adds an exclusion constraint so two rows for
 * one person can never overlap — which is what stops "what was her FTE in March" having two answers
 * after a backdated correction races a forward-dated one.
 */
export const employments = schema.table(
  'employments',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    orgUnitId: uuid('org_unit_id'),
    positionId: uuid('position_id'),
    legalEntityId: uuid('legal_entity_id'),
    costCenterId: uuid('cost_center_id'),
    managerPersonId: uuid('manager_person_id'),
    employmentType: text('employment_type').notNull().default('full_time'),
    fte: numeric('fte', { precision: 4, scale: 3 }).notNull().default('1.000'),
    contractHoursWeek: numeric('contract_hours_week', { precision: 5, scale: 2 }),
    reason: text('reason'),
    createdAt: created(),
  },
  (t) => [
    index('hr_employments_person_idx').on(t.workspaceId, t.personId, t.effectiveFrom),
    index('hr_employments_ws_manager_idx').on(t.workspaceId, t.managerPersonId),
    index('hr_employments_ws_unit_idx').on(t.workspaceId, t.orgUnitId),
  ],
)

/**
 * Who works where, over time. Several concurrent rows allowed; exactly one primary.
 *
 * The primary decides holidays, timezone and policy. The others grant presence — appearing in that
 * office's directory, being visible to its local HR — and decide nothing. Migration 0001 enforces
 * both halves: no duplicate assignment over a period, and no two primaries on one day.
 */
export const officeAssignments = schema.table(
  'office_assignments',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    officeId: uuid('office_id').notNull(),
    isPrimary: boolean('is_primary').notNull().default(true),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    reason: text('reason'),
    createdAt: created(),
  },
  (t) => [
    index('hr_office_assign_person_idx').on(t.workspaceId, t.personId, t.effectiveFrom),
    index('hr_office_assign_office_idx').on(t.workspaceId, t.officeId, t.effectiveFrom),
  ],
)

/** Append-only. What changed, when, by whom — and what a subject-access request is built from. */
export const personHistory = schema.table(
  'person_history',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    field: text('field').notNull(),
    from: jsonb('from_value'),
    to: jsonb('to_value'),
    at: created(),
    actorId: uuid('actor_id'),
    source: text('source').notNull().default('app'),
  },
  (t) => [index('hr_person_history_idx').on(t.workspaceId, t.personId, t.at)],
)

/**
 * Who looked at somebody's identity number, birth date or bank details.
 *
 * `people_sensitive` is the one table in this module where the *read* is the event worth recording:
 * `hr.person.view_sensitive` is granted to nobody by default, and a subject-access request that
 * cannot answer "who has seen my data" is not a complete answer. Every other table is audited by
 * `person_history`, which records changes — a change to a national identity number is interesting,
 * and so is a colleague opening it and changing nothing.
 *
 * Append-only, like `person_history` and the ledger: a row here is evidence, and evidence that can
 * be edited is not evidence. One row per read of one person's record rather than per field — a
 * screen that opens twenty people writes twenty rows, not eighty, and `fields` says what was on
 * screen so a narrower read is still distinguishable from a full one.
 *
 * `actor_user_id` is the account, not the person: the reader may be an administrator with no
 * employee record at all, and the question a subject asks is about accounts. `actor_person_id` is
 * kept beside it when there is one, so the log reads as names without a join through core.
 */
export const sensitiveAccessLog = schema.table(
  'sensitive_access_log',
  {
    id: id(),
    workspaceId: ws(),
    /** Whose record was read. */
    personId: uuid('person_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    actorPersonId: uuid('actor_person_id'),
    /** Which fields the read returned, so a narrow read is not filed as a full one. */
    fields: text('fields').array().notNull(),
    /** Why, where a caller offered a reason. Never invented on the caller's behalf. */
    purpose: text('purpose'),
    /**
     * How it was reached: `ui`, `api` or `export`, and nothing else that is producible today.
     *
     * Not `mcp`: core's MCP proxy forwards a plain bearer token, so an assistant's read arrives here
     * as an ordinary `kind: 'user'` principal and is indistinguishable from a person at a keyboard.
     * Recording it as its own channel would be a claim the code cannot support. Not `service`
     * either: a service principal always has a null `userId`, and a reader nobody can be named for
     * is refused before a row is written — an audit row whose actor is "the system" answers the
     * subject's question with a shrug.
     */
    via: text('via').notNull(),
    at: created(),
  },
  (t) => [
    // Both reads this table exists to answer: what was seen of one person (a subject-access
    // request), and what one account has been looking at (an investigation). Newest first in both,
    // because nobody asks these questions oldest-first.
    // `t.at.desc()`, never `desc(t.at)`. The second is the *query* helper: drizzle records it in the
    // snapshot as a SQL expression — `("created_at" desc)` — rather than as a column with a sort
    // direction, and Postgres will not build an index on that. `check-snapshot-drift` catches it by
    // asking Postgres to build what the snapshot describes, which is the only reason it is visible
    // at all: the emitted `CREATE INDEX` is valid either way, so the migration applies and only the
    // snapshot is wrong. `hr_approval_requests_requester_idx` below is the spelling to copy.
    index('hr_sens_access_subject_idx').on(t.workspaceId, t.personId, t.at.desc()),
    index('hr_sens_access_actor_idx').on(t.workspaceId, t.actorUserId, t.at.desc()),
  ],
)

export const personDocuments = schema.table(
  'person_documents',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    fileId: uuid('file_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('other'),
    issuedOn: date('issued_on'),
    expiresOn: date('expires_on'),
    uploadedBy: uuid('uploaded_by'),
    createdAt: created(),
  },
  (t) => [
    index('hr_person_docs_idx').on(t.workspaceId, t.personId, t.createdAt),
    index('hr_person_docs_expiry_idx').on(t.workspaceId, t.expiresOn),
  ],
)

export const customFieldDefs = schema.table(
  'custom_field_defs',
  {
    id: id(),
    workspaceId: ws(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    options: jsonb('options').$type<Array<{ value: string; label: string }>>(),
    required: boolean('required').notNull().default(false),
    sensitive: boolean('sensitive').notNull().default(false),
    section: text('section').notNull().default('profile'),
    order: integer('order').notNull().default(0),
    archivedAt: ts('archived_at'),
    createdAt: created(),
  },
  (t) => [
    // The key *is* the `people.custom` key, so two definitions sharing one would share a value.
    uniqueIndex('hr_fields_ws_key_uq').on(t.workspaceId, t.key),
  ],
)

// =====================================================================================
// calendars
// =====================================================================================

export const calendars = schema.table(
  'calendars',
  {
    id: id(),
    workspaceId: ws(),
    name: text('name').notNull(),
    /** Composition, not copying: this calendar's days sit on top of the one it extends. */
    extendsId: uuid('extends_id'),
    country: text('country'),
    region: text('region'),
    workingWeek: jsonb('working_week')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{"mon":1,"tue":1,"wed":1,"thu":1,"fri":1,"sat":0,"sun":0}'::jsonb`),
    source: text('source').notNull().default('custom'),
    packKey: text('pack_key'),
    packVersion: text('pack_version'),
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('hr_calendars_ws_idx').on(t.workspaceId, t.archivedAt)],
)

export const calendarDays = schema.table(
  'calendar_days',
  {
    id: id(),
    workspaceId: ws(),
    calendarId: uuid('calendar_id').notNull(),
    date: date('date').notNull(),
    kind: text('kind').notNull().default('public_holiday'),
    name: text('name').notNull(),
    /** 0 is off, 0.5 a half day, 1 a day worked despite the pack saying otherwise. */
    workingFraction: numeric('working_fraction', { precision: 3, scale: 2 }).notNull().default('0'),
    /**
     * Per **day**, not per calendar. This one column is what lets HR add their own holidays to a
     * country pack safely: an upgrade rewrites `pack` rows and never touches `custom` ones.
     */
    source: text('source').notNull().default('custom'),
    paid: boolean('paid').notNull().default(true),
    note: text('note'),
    createdAt: created(),
  },
  (t) => [
    index('hr_calendar_days_idx').on(t.workspaceId, t.calendarId, t.date),
    uniqueIndex('hr_calendar_days_uq').on(t.calendarId, t.date, t.kind),
  ],
)

// =====================================================================================
// leave
// =====================================================================================

export const leaveTypes = schema.table(
  'leave_types',
  {
    id: id(),
    workspaceId: ws(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    paid: boolean('paid').notNull().default(true),
    unit: text('unit').notNull().default('day'),
    color: text('color'),
    icon: text('icon'),
    requiresDocumentAfterDays: integer('requires_document_after_days'),
    countsWorkingDaysOnly: boolean('counts_working_days_only').notNull().default(true),
    allowNegative: boolean('allow_negative').notNull().default(false),
    maxNegativeMinutes: integer('max_negative_minutes').notNull().default(0),
    order: integer('order').notNull().default(0),
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('hr_leave_types_ws_key_uq').on(t.workspaceId, t.key)],
)

/**
 * Append-only. **A balance is the sum of this table and nothing else.**
 *
 * No row is ever updated or deleted. Cancelling approved leave inserts a `reversal` pointing at the
 * `consumption` it undoes; a retroactive correction inserts an `adjustment`. That costs a little
 * arithmetic and buys the only thing that matters when an employee and HR disagree about a number:
 * a list of what happened, in order, that nobody edited.
 *
 * Minutes rather than days because half-days, hourly leave and part-time fractions all divide a day,
 * and a decimal day accumulates rounding error across a year of them.
 */
export const leaveLedger = schema.table(
  'leave_ledger',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    leaveTypeId: uuid('leave_type_id').notNull(),
    kind: text('kind').notNull(),
    amountMinutes: integer('amount_minutes').notNull(),
    effectiveOn: date('effective_on').notNull(),
    periodYear: integer('period_year').notNull(),
    requestId: uuid('request_id'),
    reversesEntryId: uuid('reverses_entry_id'),
    policyHash: text('policy_hash'),
    reason: text('reason'),
    createdBy: uuid('created_by'),
    createdAt: created(),
  },
  (t) => [
    index('hr_ledger_person_idx').on(t.workspaceId, t.personId, t.leaveTypeId, t.effectiveOn),
    index('hr_ledger_request_idx').on(t.workspaceId, t.requestId),
    index('hr_ledger_year_idx').on(t.workspaceId, t.periodYear),
  ],
)

/**
 * A cached balance **and** the lock two concurrent requests contend on.
 *
 * `SELECT … FOR UPDATE` on this row is what serialises "spend the last day": without it, two
 * overlapping requests both read the same balance, both see enough, and both succeed. Rebuildable
 * from the ledger at any time, so it is a cache in the sense that losing it costs a re-sum, not
 * data.
 */
export const leaveBalanceCursor = schema.table(
  'leave_balance_cursor',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    leaveTypeId: uuid('leave_type_id').notNull(),
    periodYear: integer('period_year').notNull(),
    cachedBalanceMinutes: integer('cached_balance_minutes').notNull().default(0),
    asOfEntryId: uuid('as_of_entry_id'),
    version: integer('version').notNull().default(0),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('hr_balance_cursor_uq').on(t.workspaceId, t.personId, t.leaveTypeId, t.periodYear)],
)

export const leaveRequests = schema.table(
  'leave_requests',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    leaveTypeId: uuid('leave_type_id').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    startPart: text('start_part').notNull().default('full'),
    endPart: text('end_part').notNull().default('full'),
    hours: numeric('hours', { precision: 5, scale: 2 }),
    workingDays: numeric('working_days', { precision: 6, scale: 2 }).notNull().default('0'),
    minutes: integer('minutes').notNull().default(0),
    status: text('status').notNull().default('pending'),
    reason: text('reason'),
    documentFileId: uuid('document_file_id'),
    approvalRequestId: uuid('approval_request_id'),
    /** Makes a retried submission safe: two clicks must not book the week twice. */
    idempotencyKey: text('idempotency_key'),
    decidedAt: ts('decided_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('hr_leave_requests_person_idx').on(t.workspaceId, t.personId, t.startsOn),
    index('hr_leave_requests_status_idx').on(t.workspaceId, t.status, t.startsOn),
    uniqueIndex('hr_leave_requests_idem_uq').on(t.workspaceId, t.idempotencyKey),
  ],
)

/**
 * A request exploded into days.
 *
 * Overlap detection is then an index lookup rather than a range comparison, and — more importantly —
 * migration 0002 puts a partial unique index across `(person, date)` for counted days in a live
 * status, so **the database refuses to double-book somebody**. Two concurrent requests for the same
 * Tuesday cannot both win, whatever the application layer believes.
 */
export const leaveRequestDays = schema.table(
  'leave_request_days',
  {
    id: id(),
    workspaceId: ws(),
    requestId: uuid('request_id').notNull(),
    personId: uuid('person_id').notNull(),
    date: date('date').notNull(),
    fraction: numeric('fraction', { precision: 3, scale: 2 }).notNull().default('1'),
    /** False for a weekend or holiday inside the range: part of the request, costs nothing. */
    counted: boolean('counted').notNull().default(true),
    /** Denormalised from the request so the partial unique index can be built on this table alone. */
    status: text('status').notNull().default('pending'),
  },
  (t) => [
    index('hr_leave_days_person_idx').on(t.workspaceId, t.personId, t.date),
    index('hr_leave_days_request_idx').on(t.requestId),
    /**
     * No person holds two live requests covering one date. The balance cursor serialises the
     * spend; this refuses the overlap, whatever the application layer believes.
     *
     * Partial on purpose: a cancelled or rejected request must not block rebooking the same day,
     * and an uncounted weekend inside a range conflicts with nothing.
     */
    uniqueIndex('hr_leave_days_no_double_booking')
      .on(t.workspaceId, t.personId, t.date)
      .where(sql`counted and status in ('pending', 'approved')`),
  ],
)

// =====================================================================================
// approvals — one engine, keyed by subject
// =====================================================================================

export const approvalChains = schema.table(
  'approval_chains',
  {
    id: id(),
    workspaceId: ws(),
    name: text('name').notNull(),
    subjectType: text('subject_type').notNull(),
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('hr_approval_chains_idx').on(t.workspaceId, t.subjectType, t.archivedAt)],
)

export const approvalRequests = schema.table(
  'approval_requests',
  {
    id: id(),
    workspaceId: ws(),
    /** The seam: regularization, overtime and timesheets attach here without a schema change. */
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    /**
     * The English one-liner the request was raised with.
     *
     * Kept for rows raised before `summaryParams` existed, and as the fallback when a subject type
     * has no localised rendering. New code fills both and the client prefers the params.
     */
    summary: text('summary').notNull().default(''),
    /**
     * The same sentence as data, so the inbox can be read in the reader's language.
     *
     * A server-composed string is English for a Persian approver whatever the shell's locale says,
     * which is how an inbox ends up half-translated. The client renders `subjectType` + these.
     */
    summaryParams: jsonb('summary_params').$type<Record<string, string | number>>(),
    /**
     * Who is asking, as a person — not the user id in `requestedBy`.
     *
     * An inbox that cannot say whose leave this is cannot be acted on, and the two ids genuinely
     * differ: an employee need not have a Kern account, and a request can be raised on their behalf.
     */
    requesterPersonId: uuid('requester_person_id'),
    /**
     * The chain as it was when the request was raised.
     *
     * Snapshotted on purpose: editing the workflow afterwards must not change who has to sign
     * something already in flight. The version of that mistake where approved leave silently needs
     * another signature is very hard to explain to the person who took the week off.
     */
    chain: jsonb('chain').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('pending'),
    currentStep: integer('current_step').notNull().default(0),
    requestedBy: uuid('requested_by'),
    requestedAt: created(),
    decidedAt: ts('decided_at'),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    index('hr_approval_requests_subject_idx').on(t.workspaceId, t.subjectType, t.subjectId),
    index('hr_approval_requests_status_idx').on(t.workspaceId, t.status),
    /**
     * "Everything Ayşe has asked for", which the person page reads. The inbox itself lists by
     * approver and only then names the requester, so that query does not use this.
     */
    index('hr_approval_requests_requester_idx').on(t.workspaceId, t.requesterPersonId, t.requestedAt.desc()),
  ],
)

export const approvalSteps = schema.table(
  'approval_steps',
  {
    id: id(),
    workspaceId: ws(),
    requestId: uuid('request_id').notNull(),
    stepIndex: integer('step_index').notNull(),
    name: text('name').notNull().default(''),
    mode: text('mode').notNull().default('any'),
    minApprovals: integer('min_approvals').notNull().default(1),
    /** Expanded at request time; a later reorganisation does not move an in-flight approval. */
    approverIds: uuid('approver_ids').array().notNull().default(sql`'{}'::uuid[]`),
    status: text('status').notNull().default('pending'),
    dueAt: ts('due_at'),
    escalatedAt: ts('escalated_at'),
    /**
     * What the chain said to do when `dueAt` passes, copied onto the row when the request is raised.
     *
     * It cannot be read back out of the snapshot in `approval_requests.chain`: a step whose
     * approvers resolve to nobody is dropped rather than stored, so `step_index` counts the steps
     * that survived and the spec's array counts the steps that were written — the two drift apart
     * the moment one is dropped, and matching them up again would mean re-resolving "who is the
     * manager" as of a date that has passed. The step carries its own deadline policy instead.
     */
    onTimeout: text('on_timeout').notNull().default('remind'),
    /** The window in hours, kept for the same reason: a step's deadline is set when it *starts*. */
    slaHours: integer('sla_hours'),
    /**
     * When the deadline was acted on, and what was done.
     *
     * The sweep runs hourly against a deadline that stays passed, so this is what stops one step
     * being reminded every hour for ever. Reading the pair beside `on_timeout` is also how a
     * degraded outcome is visible without a log: `on_timeout = 'escalate'` with
     * `timeout_action = 'remind'` is an escalation that had nobody to go to.
     */
    timeoutHandledAt: ts('timeout_handled_at'),
    timeoutAction: text('timeout_action'),
  },
  (t) => [
    uniqueIndex('hr_approval_steps_uq').on(t.requestId, t.stepIndex),
    index('hr_approval_steps_due_idx').on(t.workspaceId, t.status, t.dueAt),
    /**
     * The inbox asks `approver_ids && ARRAY[…]::uuid[]`, and no btree can answer an array overlap —
     * so the query every manager triggers on every page load was a sequential scan over a table
     * that only ever grows. Plain GIN indexes the array's elements, which is the operator's own
     * shape; `btree_gin` would only be needed to fold `workspace_id` in beside it, and the
     * workspace filter is cheap once the overlap has cut the table down to a handful of rows.
     */
    index('hr_approval_steps_approvers_idx').using('gin', t.approverIds),
  ],
)

/** Append-only, and unique per approver per step — a double click is one decision, not two. */
export const approvalDecisions = schema.table(
  'approval_decisions',
  {
    id: id(),
    workspaceId: ws(),
    stepId: uuid('step_id').notNull(),
    approverId: uuid('approver_id').notNull(),
    onBehalfOfId: uuid('on_behalf_of_id'),
    decision: text('decision').notNull(),
    comment: text('comment'),
    /**
     * What decided this — `human`, or `timeout` for a step the deadline decided.
     *
     * An auto-approval is a decision and has to be recorded as one, but it is not a person's, and a
     * row that cannot say so is one somebody eventually reads as "her manager approved it". The
     * column carries that; `approver_id` carries the nil UUID, which no `uuidv7()` can ever be. It
     * is deliberately not nullable: the contract types `approverId` as a uuid, so a null would fail
     * the inbox's own output schema on every request that had ever timed out.
     */
    source: text('source').notNull().default('human'),
    at: created(),
  },
  (t) => [uniqueIndex('hr_approval_decisions_uq').on(t.stepId, t.approverId)],
)

export const delegations = schema.table(
  'delegations',
  {
    id: id(),
    workspaceId: ws(),
    fromPersonId: uuid('from_person_id').notNull(),
    toPersonId: uuid('to_person_id').notNull(),
    /** Null delegates every subject type. */
    subjectType: text('subject_type'),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    reason: text('reason'),
    createdAt: created(),
  },
  (t) => [index('hr_delegations_idx').on(t.workspaceId, t.toPersonId, t.startsOn)],
)

// =====================================================================================
// attendance
// =====================================================================================

export const schedules = schema.table(
  'schedules',
  {
    id: id(),
    workspaceId: ws(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('fixed'),
    /** Wall-clock readings per weekday. Never instants — a schedule is a rule, not a set of moments. */
    week: jsonb('week').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    tzMode: text('tz_mode').notNull().default('office'),
    tz: text('tz'),
    graceInMinutes: integer('grace_in_minutes').notNull().default(0),
    graceOutMinutes: integer('grace_out_minutes').notNull().default(0),
    roundingStepMinutes: integer('rounding_step_minutes').notNull().default(0),
    roundingDirection: text('rounding_direction').notNull().default('nearest'),
    autoClockOutAfterMinutes: integer('auto_clock_out_after_minutes'),
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('hr_schedules_ws_idx').on(t.workspaceId, t.archivedAt)],
)

export const scheduleAssignments = schema.table(
  'schedule_assignments',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    scheduleId: uuid('schedule_id').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    createdAt: created(),
  },
  (t) => [index('hr_schedule_assign_idx').on(t.workspaceId, t.personId, t.effectiveFrom)],
)

/**
 * Raw punches. **Append-only, and partitioned.**
 *
 * Never updated, never deleted: a wrong punch is voided by a correcting row, so both survive. An
 * attendance record somebody can quietly rewrite is worth nothing in the dispute it exists for.
 *
 * Partitioned monthly by `business_date` — see migration 0003, which creates the table by hand
 * because drizzle-kit cannot express `PARTITION BY`. Five hundred people punching four times a day
 * is half a million rows a year, and retrofitting partitioning onto a live table of those is a
 * migration nobody wants. A partitioned table's primary key must contain the partition column,
 * which is why it is `(id, business_date)` rather than `id`.
 */
export const punches = schema.table(
  'punches',
  {
    id: uuid('id').notNull().default(sql`uuidv7()`),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    direction: text('direction').notNull(),
    /** The instant. Server-stamped unless the punch was made offline and is a claim. */
    at: ts('at').notNull().defaultNow(),
    /** What the client believed. Kept even when it disagrees — a device an hour out is worth knowing. */
    clientReportedAt: ts('client_reported_at'),
    skewMs: integer('skew_ms'),
    /** The partition key, and the day this punch counts towards. A night shift lands on its start date. */
    businessDate: date('business_date').notNull(),
    /** The zone it happened in — audit only. Attribution follows the person's primary office. */
    timezone: text('timezone').notNull().default('UTC'),
    method: text('method').notNull().default('web'),
    officeId: uuid('office_id'),
    deviceId: uuid('device_id'),
    geo: jsonb('geo').$type<Record<string, number>>(),
    trust: text('trust').notNull().default('trusted'),
    voidedByPunchId: uuid('voided_by_punch_id'),
    idempotencyKey: text('idempotency_key'),
    note: text('note'),
    createdAt: created(),
  },
  (t) => [
    index('hr_punches_person_idx').on(t.workspaceId, t.personId, t.businessDate),
    /**
     * A retried punch is the same punch. `business_date` is in the key because it is the partition
     * column, and a partitioned table refuses a unique index that does not contain one.
     */
    uniqueIndex('hr_punches_idem_uq')
      .on(t.workspaceId, t.idempotencyKey, t.businessDate)
      .where(sql`"idempotency_key" is not null`),
    /**
     * The hourly auto-clock-out sweep. It asks for open `in` punches older than a cutoff, and until
     * this index not one of the four columns it filters on was indexed — half a million rows a
     * year, scanned once an hour per workspace.
     *
     * `voided_by_punch_id is null` is the partial predicate rather than a fourth column because
     * drizzle emits `is null` as literal SQL, so the planner can always prove the query implies it.
     * `direction` stays an indexed column for the opposite reason: it arrives as a bind parameter,
     * and a generic plan cannot match a parameter against a predicate's constant.
     *
     * Declared on the partitioned parent, which is what gives every partition its own copy —
     * including the ones `ensure_punch_partition` has not created yet.
     *
     * It only pays if the sweep bounds `at` from below and gives `business_date` a lower bound as
     * well. `at <= cutoff` on its own matches every `in` punch the instance has ever recorded, and
     * no index makes an unbounded result set cheap — measured, 16 partitions scanned end to end.
     */
    index('hr_punches_open_idx')
      .on(t.workspaceId, t.direction, t.at)
      .where(sql`"voided_by_punch_id" is null`),
  ],
)

/**
 * The derived day sheet. **A projection, never a source of truth.**
 *
 * Recomputable from punches + schedule + calendar + leave at any moment, which is what makes a bad
 * computation a bug to fix and re-run rather than data to repair by hand. `policyHash` records what
 * produced a row so a recomputation can tell whether it is stale; `locked` mirrors the period, so a
 * closed month cannot move underneath a payroll that has already been filed.
 */
export const attendanceDays = schema.table(
  'attendance_days',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    businessDate: date('business_date').notNull(),
    scheduledMinutes: integer('scheduled_minutes').notNull().default(0),
    workedMinutes: integer('worked_minutes').notNull().default(0),
    breakMinutes: integer('break_minutes').notNull().default(0),
    overtimeMinutes: integer('overtime_minutes').notNull().default(0),
    /**
     * Overtime the policy's cap will not take — null where no cap was in force.
     *
     * Nullable rather than zero-by-default, because the two mean different things and a report has
     * to tell them apart: null is "no cap applied to this day", zero is "a cap applied and nothing
     * exceeded it". `computeDay` draws that distinction itself and this stores its answer — it is
     * not re-derived here, or the two would eventually disagree.
     *
     * A statutory ceiling like Türkiye's 270 annual hours is a number somebody has to sum over a
     * year, which is why it is a column and not only the `overtime_beyond_cap` anomaly beside it:
     * text cannot be summed. The anomaly stays, and cannot drift from this — both come out of the
     * same value one line apart in a pure function, and both are rebuilt on every recompute. The
     * column is what a report sums; the anomaly is what puts the day in front of a person.
     */
    beyondCapMinutes: integer('beyond_cap_minutes'),
    lateMinutes: integer('late_minutes').notNull().default(0),
    earlyLeaveMinutes: integer('early_leave_minutes').notNull().default(0),
    status: text('status').notNull().default('absent'),
    leaveRequestId: uuid('leave_request_id'),
    anomalies: text('anomalies').array().notNull().default(sql`'{}'::text[]`),
    firstIn: ts('first_in'),
    lastOut: ts('last_out'),
    policyHash: text('policy_hash'),
    locked: boolean('locked').notNull().default(false),
    computedAt: ts('computed_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hr_attendance_days_uq').on(t.workspaceId, t.personId, t.businessDate),
    index('hr_attendance_days_date_idx').on(t.workspaceId, t.businessDate, t.status),
  ],
)

export const regularizations = schema.table(
  'regularizations',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    businessDate: date('business_date').notNull(),
    /** Null when nothing was punched at all and the whole day is being asked for. */
    punchId: uuid('punch_id'),
    proposed: jsonb('proposed').$type<Array<Record<string, unknown>>>().notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    approvalRequestId: uuid('approval_request_id'),
    appliedAt: ts('applied_at'),
    createdAt: created(),
  },
  (t) => [index('hr_regularizations_idx').on(t.workspaceId, t.personId, t.businessDate)],
)

// =====================================================================================
// rosters — a shift on a date, where a schedule is a week that repeats
// =====================================================================================

/**
 * A named shift. Early, Late, Night.
 *
 * Named rather than inlined into every rotation because coverage groups by it: "Early" in two
 * patterns has to be one column of one grid, which a wall-clock pair repeated in two jsonb blobs
 * cannot promise. Archived, never deleted — a pattern and a stored override both point at one by
 * id, and a deleted shift would leave a roster row referring to nothing.
 */
export const rosterShifts = schema.table(
  'roster_shifts',
  {
    id: id(),
    workspaceId: ws(),
    name: text('name').notNull(),
    /** One or two letters, for a grid too dense to carry a name. */
    code: text('code'),
    /** Wall clocks, never instants — a shift is a rule, exactly as a schedule's week is. */
    startTime: text('start_time').notNull(),
    /** Earlier than `start_time` for a shift that ends the next morning. */
    endTime: text('end_time').notNull(),
    breakMinutes: integer('break_minutes').notNull().default(0),
    graceInMinutes: integer('grace_in_minutes').notNull().default(0),
    graceOutMinutes: integer('grace_out_minutes').notNull().default(0),
    color: text('color'),
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('hr_roster_shifts_ws_idx').on(t.workspaceId, t.archivedAt)],
)

/**
 * A rotation: a cycle of days, and the date the cycle starts from.
 *
 * `days` is an array of arrays of `roster_shifts.id` — one entry per day of the cycle, each holding
 * the shifts worked that day. An empty entry is a planned rest day. The cycle length is
 * `jsonb_array_length(days)` and is deliberately not a second column: two numbers that have to
 * agree is one number and a bug waiting for somebody to edit one of them.
 *
 * **Nothing here is expanded into rows.** A year of generated shifts per person is what makes a
 * roster impossible to change: moving a crew forward one day becomes a bulk rewrite with no way to
 * tell which rows a human had already corrected. What somebody works on a date is arithmetic from
 * `anchor_date`, the assignment's `cycle_offset` and this array.
 */
export const rosterPatterns = schema.table(
  'roster_patterns',
  {
    id: id(),
    workspaceId: ws(),
    name: text('name').notNull(),
    /** The date `days[0]` applies to. Moving it rotates every crew on this pattern at once. */
    anchorDate: date('anchor_date').notNull(),
    days: jsonb('days').$type<string[][]>().notNull().default(sql`'[]'::jsonb`),
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('hr_roster_patterns_ws_idx').on(t.workspaceId, t.archivedAt)],
)

/**
 * A person on a rotation, over a period.
 *
 * Effective-dated like `schedule_assignments`, and with the same exclusion constraint from the day
 * the table exists rather than five migrations later: the resolver picks the assignment in force
 * with `limit 1`, so two in force is a roster that answers differently depending on which row the
 * executor hands back first.
 *
 * `cycle_offset` is what puts two crews on one pattern out of phase — crew B at offset 4 on a
 * 4-on-4-off cycle works exactly the days crew A is off. Without it each crew needs its own copy of
 * the rotation, and a change to the rotation has to be made once per copy.
 */
export const rosterAssignments = schema.table(
  'roster_assignments',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    patternId: uuid('pattern_id').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    cycleOffset: integer('cycle_offset').notNull().default(0),
    createdAt: created(),
  },
  (t) => [index('hr_roster_assign_idx').on(t.workspaceId, t.personId, t.effectiveFrom)],
)

/**
 * One day that differs from the rotation, and nothing else.
 *
 * The whole reason a roster is not a schedule: a schedule change is effective-dated and rewrites
 * every day after it, while somebody covering one Tuesday needs one Tuesday changed.
 *
 * `shift_ids` is an array for the same reason a cycle day is — a split shift is two entries, not
 * something the model forbids. An empty array is "this person is off that day", which is why the
 * row exists at all: without it, "off" and "no override" would be the same absence of a row.
 *
 * The unique index is on the *record*, one per person-day, not on the shift. That distinction is
 * the whole of the split-shift question: a unique index on `(workspace, person, business_date,
 * shift)` would allow two shifts and forbid two overrides, and one on the person-day with a scalar
 * shift column would do the reverse. Neither is what an override means.
 */
export const rosterOverrides = schema.table(
  'roster_overrides',
  {
    id: id(),
    workspaceId: ws(),
    personId: uuid('person_id').notNull(),
    businessDate: date('business_date').notNull(),
    shiftIds: jsonb('shift_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    note: text('note'),
    createdBy: uuid('created_by'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('hr_roster_override_uq').on(t.workspaceId, t.personId, t.businessDate)],
)

// =====================================================================================
// policies and periods
// =====================================================================================

/**
 * A policy is a row, not a branch.
 *
 * Leave entitlement, overtime rules and rounding differ per company and per country. Encoding that
 * as `if (country === 'TR')` is how a product acquires a branch per customer and a release cycle
 * per rule change. A policy carries a kind, a config validated by that kind's schema, and an
 * effective range — so a rule that changed in July is still answerable for June.
 *
 * `configHash` is what a derived row records, so a recomputation can tell a stale figure from a
 * current one without re-deriving it.
 */
export const policies = schema.table(
  'policies',
  {
    id: id(),
    workspaceId: ws(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    source: text('source').notNull().default('custom'),
    packKey: text('pack_key'),
    configHash: text('config_hash').notNull().default(''),
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('hr_policies_ws_kind_idx').on(t.workspaceId, t.kind, t.effectiveFrom)],
)

/**
 * Who a policy applies to, and how strongly.
 *
 * `priority` is the resolution ladder made explicit — person 100, office 80, legal entity 60, org
 * unit 40, position 30, workspace 0 — so a query orders by it rather than a service knowing the
 * sequence by heart. The same order resolves a calendar.
 */
export const policyAssignments = schema.table(
  'policy_assignments',
  {
    id: id(),
    workspaceId: ws(),
    policyId: uuid('policy_id').notNull(),
    subjectKind: text('subject_kind').notNull(),
    /** Null for `workspace`, which needs no id. */
    subjectId: uuid('subject_id'),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    priority: integer('priority').notNull().default(0),
    createdAt: created(),
  },
  (t) => [
    index('hr_policy_assign_idx').on(t.workspaceId, t.subjectKind, t.subjectId),
    index('hr_policy_assign_policy_idx').on(t.workspaceId, t.policyId),
  ],
)

/**
 * A closed month, and the boundary every recomputation respects.
 *
 * Locking is what makes a filed payroll safe: `attendance_days.locked` mirrors this, so a policy
 * changed with a retroactive `effectiveFrom` produces an adjustment in the open period rather than
 * rewriting a month somebody has already been paid for.
 *
 * Per legal entity, because a Dutch entity closes on a different day from a Turkish one.
 */
export const periods = schema.table(
  'periods',
  {
    id: id(),
    workspaceId: ws(),
    kind: text('kind').notNull().default('payroll'),
    legalEntityId: uuid('legal_entity_id'),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: text('status').notNull().default('open'),
    lockedAt: ts('locked_at'),
    lockedBy: uuid('locked_by'),
    note: text('note'),
    createdAt: created(),
  },
  (t) => [index('hr_periods_idx').on(t.workspaceId, t.kind, t.startsOn)],
)

// =====================================================================================
// privacy
// =====================================================================================

/**
 * How long this workspace keeps each class of personal data. One row per workspace.
 *
 * **A table rather than a key in module settings, and the reason is mechanical rather than
 * aesthetic.** `core.settings.setModule` merges a write over what is stored and then parses the
 * result against the module's declared zod schema — and a zod object strips what it does not
 * declare. A retention key living beside `country` and `employeeNumberPrefix` in `HrSettings` would
 * therefore be deleted by the next unrelated settings write, silently, from a screen that never
 * mentions retention. That is the same trap `$capabilities` needed a reserved key to escape.
 * Extending `HrSettings` itself is the other honest route; it is a change to a shape shared with the
 * client, and this keeps the numbers somewhere nothing else can drop them.
 *
 * `workspace_id` is the primary key, so "one row per workspace" is the database's promise and not a
 * convention a second code path can break. The horizons are a jsonb `config` validated by
 * `HrRetention` on both sides: the honest end state is per legal entity — a Dutch entity and a
 * Turkish one have different obligations, which is why `periods` is already per entity — and that
 * move is then an added nullable column rather than a new table.
 *
 * Every horizon is null until somebody sets one, and null means "keep indefinitely". No number in
 * here ships with a value: "seven years" is a fact about one country and one document class.
 */
export const retentionSettings = schema.table('retention_settings', {
  workspaceId: uuid('workspace_id').primaryKey(),
  config: jsonb('config').$type<Record<string, number | null>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: updated(),
  updatedBy: uuid('updated_by'),
})

/** Every tenant table, so the RLS migration is checked against one list rather than memory. */
export const TENANT_TABLES = [
  'legal_entities',
  'offices',
  'cost_centers',
  'org_units',
  'positions',
  'people',
  'people_sensitive',
  'employments',
  'office_assignments',
  'person_history',
  'sensitive_access_log',
  'person_documents',
  'custom_field_defs',
  'calendars',
  'calendar_days',
  'leave_types',
  'leave_ledger',
  'leave_balance_cursor',
  'leave_requests',
  'leave_request_days',
  'approval_chains',
  'approval_requests',
  'approval_steps',
  'approval_decisions',
  'delegations',
  'schedules',
  'schedule_assignments',
  'punches',
  'attendance_days',
  'regularizations',
  'roster_shifts',
  'roster_patterns',
  'roster_assignments',
  'roster_overrides',
  'policies',
  'policy_assignments',
  'periods',
  'retention_settings',
] as const
