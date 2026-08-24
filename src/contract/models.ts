import { Timestamp, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'

/** Lowercase, 2-32 characters. Names the API prefix, the Postgres schema `mod_hr` and every event. */
export const MODULE_ID = 'hr'

/** A calendar date with no time and no zone: `2026-08-24`. */
export const IsoDate = z.iso.date()
export type IsoDate = z.infer<typeof IsoDate>

/**
 * An IANA zone name, never an offset.
 *
 * `+03:00` is a fact about one instant; `Europe/Istanbul` is a fact about a place, and only the
 * second survives a daylight-saving transition. Everything in this module that has to turn a wall
 * clock into an instant reads one of these.
 */
export const TimeZone = z.string().min(1).max(64)

/** ISO 3166-1 alpha-2, upper case: `TR`, `NL`, `DE`. */
export const CountryCode = z.string().length(2).regex(/^[A-Z]{2}$/)
/** ISO 3166-2 subdivision, without the country prefix: `34` for Istanbul, `BY` for Bavaria. */
export const RegionCode = z.string().min(1).max(8)

/** `09:00` — a wall clock reading, meaningless until a date and a zone are supplied. */
export const WallClock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const ws = { workspaceId: WorkspaceId }

// =====================================================================================
// people
// =====================================================================================

export const PersonStatus = z.enum([
  'onboarding',
  'active',
  'on_leave',
  'offboarding',
  'terminated',
])
export type PersonStatus = z.infer<typeof PersonStatus>

export const Person = z.object({
  id: z.uuid(),
  ...ws,
  /**
   * The Kern account, when there is one.
   *
   * Nullable on purpose. Plenty of employees never sign in — factory floor, drivers, seasonal staff
   * — and a directory that can only hold people with logins is not a directory. It also means HR can
   * be populated before anyone is invited.
   */
  userId: z.uuid().nullable(),
  employeeNo: z.string().min(1).max(32).nullable(),
  displayName: z.string().min(1).max(160),
  workEmail: z.email().max(254).nullable(),
  personalEmail: z.email().max(254).nullable(),
  phone: z.string().max(32).nullable(),
  photoFileId: z.uuid().nullable(),
  status: PersonStatus,
  hiredOn: IsoDate.nullable(),
  terminatedOn: IsoDate.nullable(),
  /** Overrides the primary office's zone for somebody who genuinely works elsewhere. */
  timezone: TimeZone.nullable(),
  custom: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Person = z.infer<typeof Person>

/**
 * The fields that need a second permission.
 *
 * A separate shape, not optional fields on `Person`, because optional fields get returned by
 * accident. Somebody with `hr.person.view` can read the directory; reading a national identity
 * number takes `hr.person.view_sensitive`, and the two never travel in the same object.
 */
export const PersonSensitive = z.object({
  personId: z.uuid(),
  ...ws,
  nationalId: z.string().max(64).nullable(),
  birthDate: IsoDate.nullable(),
  iban: z.string().max(48).nullable(),
  emergencyContact: z
    .object({
      name: z.string().max(160),
      relationship: z.string().max(64).optional(),
      phone: z.string().max(32),
    })
    .nullable(),
})
export type PersonSensitive = z.infer<typeof PersonSensitive>

// =====================================================================================
// employment — effective-dated
// =====================================================================================

export const EmploymentType = z.enum([
  'full_time',
  'part_time',
  'contract',
  'intern',
  'temporary',
  'freelance',
])
export type EmploymentType = z.infer<typeof EmploymentType>

/**
 * One row per period a person's job was a given shape. Never updated in place.
 *
 * Titles, managers, departments and hours all change, and a system that overwrites them cannot
 * answer "who did she report to in March", which is the question a leave approval from March needs.
 * A change closes the current row (`effectiveTo`) and opens a new one; `effectiveTo === null` is the
 * present. The database refuses overlaps.
 *
 * **Office is deliberately not here.** People change desks and change jobs on different days, and
 * folding the two together forces a fake promotion every time somebody relocates. See
 * `OfficeAssignment`.
 */
export const Employment = z.object({
  id: z.uuid(),
  ...ws,
  personId: z.uuid(),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable(),
  orgUnitId: z.uuid().nullable(),
  positionId: z.uuid().nullable(),
  legalEntityId: z.uuid().nullable(),
  costCenterId: z.uuid().nullable(),
  managerPersonId: z.uuid().nullable(),
  employmentType: EmploymentType,
  /** 1.0 is full time; 0.5 is a half-time contract. Drives proration everywhere. */
  fte: z.number().min(0).max(1),
  contractHoursWeek: z.number().min(0).max(168).nullable(),
  reason: z.string().max(200).nullable(),
  createdAt: Timestamp,
})
export type Employment = z.infer<typeof Employment>

// =====================================================================================
// org structure
// =====================================================================================

export const OrgUnit = z.object({
  id: z.uuid(),
  ...ws,
  parentId: z.uuid().nullable(),
  /** Materialised ltree path, e.g. `root.engineering.platform`. Read-only: `org.units.move` sets it. */
  path: z.string().max(512),
  name: z.string().min(1).max(160),
  code: z.string().max(32).nullable(),
  headPersonId: z.uuid().nullable(),
  archivedAt: Timestamp.nullable(),
})
export type OrgUnit = z.infer<typeof OrgUnit>

export const Position = z.object({
  id: z.uuid(),
  ...ws,
  title: z.string().min(1).max(160),
  code: z.string().max(32).nullable(),
  jobFamily: z.string().max(64).nullable(),
  level: z.string().max(32).nullable(),
  archivedAt: Timestamp.nullable(),
})
export type Position = z.infer<typeof Position>

// =====================================================================================
// offices — the unit of inheritance
// =====================================================================================

export const OfficeKind = z.enum([
  'head_office',
  'branch',
  'site',
  'warehouse',
  'store',
  /** Where remote people belong. Carries a country, a zone and a calendar like anywhere else. */
  'remote',
])
export type OfficeKind = z.infer<typeof OfficeKind>

/**
 * A place the company operates, and the thing a person inherits from.
 *
 * One workspace, many offices: a head office in Istanbul, a branch in Amsterdam, two sites in the
 * same city, and the remote people. Each carries what differs by geography — country, timezone,
 * working week, holidays — so "which days am I off" has a local answer without a workspace per
 * country.
 *
 * A workspace always has exactly one office even when the `offices` capability is off; it is created
 * from the workspace country and never shown. That is what lets the capability be a *reveal* rather
 * than a migration, and it is why nothing in this module has a "no office" branch.
 */
export const Office = z.object({
  id: z.uuid(),
  ...ws,
  name: z.string().min(1).max(160),
  code: z.string().max(32).nullable(),
  kind: OfficeKind,
  /** A campus with buildings. This is geography, *not* the org chart — see `OrgUnit`. */
  parentOfficeId: z.uuid().nullable(),
  legalEntityId: z.uuid().nullable(),
  country: CountryCode,
  region: RegionCode.nullable(),
  city: z.string().max(120).nullable(),
  timezone: TimeZone,
  calendarId: z.uuid().nullable(),
  address: z
    .object({
      line1: z.string().max(200).optional(),
      line2: z.string().max(200).optional(),
      postalCode: z.string().max(32).optional(),
    })
    .nullable(),
  /** Exactly one office per workspace carries this. Where a new person lands with no assignment. */
  isDefault: z.boolean(),
  headPersonId: z.uuid().nullable(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type Office = z.infer<typeof Office>

/**
 * Who works where, over time.
 *
 * A person may hold several of these at once — somebody splitting the week between two sites — but
 * **exactly one is primary at any date, and only the primary decides.** Non-primary offices grant
 * presence: the person appears in that office's directory, its local HR can see them, and later its
 * geofence will accept their punch. They never decide which holidays apply, which policy applies, or
 * which timezone the person's day is attributed in.
 *
 * Any other rule turns "how many days off do I have" into a question with two answers, which is not
 * a thing an employee or an auditor will accept.
 */
export const OfficeAssignment = z.object({
  id: z.uuid(),
  ...ws,
  personId: z.uuid(),
  officeId: z.uuid(),
  isPrimary: z.boolean(),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable(),
  reason: z.string().max(200).nullable(),
  createdAt: Timestamp,
})
export type OfficeAssignment = z.infer<typeof OfficeAssignment>

/**
 * Who actually employs somebody.
 *
 * Distinct from the office: two Turkish offices can share one entity, and one office can host two.
 * It exists because payroll is filed per legal employer, never per workspace — so a group with a
 * Dutch B.V. and a Turkish A.Ş. closes two different payrolls out of one Kern workspace.
 */
export const LegalEntity = z.object({
  id: z.uuid(),
  ...ws,
  name: z.string().min(1).max(200),
  registrationNo: z.string().max(64).nullable(),
  taxNo: z.string().max(64).nullable(),
  country: CountryCode,
  /** ISO 4217. */
  currency: z.string().length(3).nullable(),
  archivedAt: Timestamp.nullable(),
})
export type LegalEntity = z.infer<typeof LegalEntity>

export const CostCenter = z.object({
  id: z.uuid(),
  ...ws,
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(160),
  officeId: z.uuid().nullable(),
  orgUnitId: z.uuid().nullable(),
  legalEntityId: z.uuid().nullable(),
  archivedAt: Timestamp.nullable(),
})
export type CostCenter = z.infer<typeof CostCenter>

// =====================================================================================
// custom fields and documents
// =====================================================================================

export const FieldType = z.enum(['text', 'number', 'date', 'select', 'multi_select', 'boolean', 'url'])

export const CustomFieldDef = z.object({
  id: z.uuid(),
  ...ws,
  key: z.string().min(1).max(48).regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1).max(120),
  type: FieldType,
  options: z.array(z.object({ value: z.string(), label: z.string() })).nullable(),
  required: z.boolean(),
  /** Needs `hr.person.view_sensitive`, like a national identity number. */
  sensitive: z.boolean(),
  section: z.enum(['profile', 'employment', 'other']),
  order: z.number().int(),
  archivedAt: Timestamp.nullable(),
})
export type CustomFieldDef = z.infer<typeof CustomFieldDef>

export const PersonDocument = z.object({
  id: z.uuid(),
  ...ws,
  personId: z.uuid(),
  fileId: z.uuid(),
  name: z.string().min(1).max(200),
  kind: z.string().max(48),
  issuedOn: IsoDate.nullable(),
  expiresOn: IsoDate.nullable(),
  uploadedBy: z.uuid().nullable(),
  createdAt: Timestamp,
})
export type PersonDocument = z.infer<typeof PersonDocument>

// =====================================================================================
// calendars
// =====================================================================================

export const CalendarDayKind = z.enum([
  'public_holiday',
  'religious',
  'company_closure',
  'half_day',
  /** The country has a holiday and this company works it. `workingFraction` is 1. */
  'working_override',
  /** The Friday between a Thursday holiday and the weekend. */
  'bridge',
])
export type CalendarDayKind = z.infer<typeof CalendarDayKind>

/** Which weekdays are worked, and how much of each. Iran is `{fri: 0}` with a half Thursday. */
export const WorkingWeek = z.object({
  mon: z.number().min(0).max(1).default(1),
  tue: z.number().min(0).max(1).default(1),
  wed: z.number().min(0).max(1).default(1),
  thu: z.number().min(0).max(1).default(1),
  fri: z.number().min(0).max(1).default(1),
  sat: z.number().min(0).max(1).default(0),
  sun: z.number().min(0).max(1).default(0),
})
export type WorkingWeek = z.infer<typeof WorkingWeek>

/**
 * A set of non-working days, composed rather than copied.
 *
 * `extendsId` points at a country pack, and this calendar's own days sit on top: *"Amsterdam = the
 * NL pack, plus our two company closures, minus the one we work through"*. Copying the pack into
 * every office instead would mean a yearly pack refresh reconciling N copies against N sets of local
 * edits, which is exactly the problem per-day `source` exists to avoid.
 */
export const Calendar = z.object({
  id: z.uuid(),
  ...ws,
  name: z.string().min(1).max(160),
  extendsId: z.uuid().nullable(),
  country: CountryCode.nullable(),
  region: RegionCode.nullable(),
  workingWeek: WorkingWeek,
  source: z.enum(['pack', 'custom']),
  packKey: z.string().max(32).nullable(),
  packVersion: z.string().max(32).nullable(),
  archivedAt: Timestamp.nullable(),
})
export type Calendar = z.infer<typeof Calendar>

export const CalendarDay = z.object({
  id: z.uuid(),
  ...ws,
  calendarId: z.uuid(),
  date: IsoDate,
  kind: CalendarDayKind,
  name: z.string().min(1).max(160),
  /** 0 is a full day off, 0.5 a half day, 1 a day worked despite the pack saying otherwise. */
  workingFraction: z.number().min(0).max(1),
  /**
   * Per **day**, not per calendar. A pack upgrade replaces `pack` rows and never touches `custom`
   * ones — which is the entire reason HR can safely add their own holidays to a pack calendar.
   */
  source: z.enum(['pack', 'custom']),
  paid: z.boolean(),
  note: z.string().max(500).nullable(),
})
export type CalendarDay = z.infer<typeof CalendarDay>

/** A day as the composed calendar sees it, with where it came from. */
export const ResolvedCalendarDay = CalendarDay.extend({
  /** The calendar in the `extends` chain that contributed this day. */
  fromCalendarId: z.uuid(),
  fromCalendarName: z.string(),
  /** True when a nearer calendar overrode a day the base calendar had. */
  overrides: z.boolean(),
})
export type ResolvedCalendarDay = z.infer<typeof ResolvedCalendarDay>

// =====================================================================================
// resolution — the ladder, made inspectable
// =====================================================================================

export const ResolutionRung = z.enum(['person', 'office', 'legal_entity', 'org_unit', 'position', 'workspace'])
export type ResolutionRung = z.infer<typeof ResolutionRung>

/**
 * What actually applies to one person on one date, and which rung answered.
 *
 * The ladder is `person → primary office → org unit → workspace`, nearest wins, and it decides both
 * the calendar and every policy. Exposing *which rung answered* is not a nicety: "why does Ayşe have
 * different holidays from her team" is the support question this module will be asked most, and
 * without this it is answered with a database session.
 */
export const PersonResolution = z.object({
  personId: z.uuid(),
  on: IsoDate,
  primaryOfficeId: z.uuid().nullable(),
  primaryOfficeName: z.string().nullable(),
  otherOfficeIds: z.array(z.uuid()),
  country: CountryCode.nullable(),
  timezone: TimeZone,
  timezoneFrom: ResolutionRung,
  calendarId: z.uuid().nullable(),
  calendarFrom: ResolutionRung.nullable(),
  workingWeek: WorkingWeek,
  legalEntityId: z.uuid().nullable(),
  orgUnitId: z.uuid().nullable(),
  orgUnitPath: z.string().nullable(),
  managerPersonId: z.uuid().nullable(),
})
export type PersonResolution = z.infer<typeof PersonResolution>
