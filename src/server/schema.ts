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
  (t) => [index('hr_org_units_ws_idx').on(t.workspaceId, t.archivedAt)],
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
    summary: text('summary').notNull().default(''),
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
  },
  (t) => [
    uniqueIndex('hr_approval_steps_uq').on(t.requestId, t.stepIndex),
    index('hr_approval_steps_due_idx').on(t.workspaceId, t.status, t.dueAt),
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
  (t) => [index('hr_punches_person_idx').on(t.workspaceId, t.personId, t.businessDate)],
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
  'policies',
  'policy_assignments',
  'periods',
] as const
