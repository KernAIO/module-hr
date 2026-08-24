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
] as const
