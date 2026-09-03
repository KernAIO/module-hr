import { baseContract, PageInput, page, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import {
  ApprovalChain,
  ApprovalChainSpec,
  ApprovalRequest,
  ApprovalSubjectType,
  Delegation,
} from './approvals.js'
import {
  AttendanceDay,
  ClientPunchMethod,
  ClockState,
  Punch,
  PunchDirection,
  Regularization,
  Schedule,
  ScheduleAssignment,
  ScheduleWeek,
} from './attendance.js'
import {
  Checklist,
  ChecklistItemInput,
  ChecklistKind,
  ChecklistStatus,
  ChecklistSummary,
  ChecklistTemplate,
  ChecklistTemplateInput,
} from './checklists.js'
import { PayrollExport, PayrollExportPreview } from './exports.js'
import {
  DayPart,
  LeaveBalance,
  LeaveLedgerEntry,
  LeaveRequest,
  LeaveSimulation,
  LeaveType,
  LeaveUnit,
  LedgerKind,
} from './leave.js'
import {
  Calendar,
  CalendarDayKind,
  CostCenter,
  CountryCode,
  CustomFieldDef,
  Employment,
  EmploymentType,
  IsoDate,
  LegalEntity,
  Office,
  OfficeAssignment,
  OfficeKind,
  OrgUnit,
  Person,
  PersonDocument,
  PersonResolution,
  PersonSensitive,
  PersonStatus,
  Position,
  RegionCode,
  ResolvedCalendarDay,
  TimeZone,
  WallClock,
  WorkingWeek,
} from './models.js'
import {
  AccrualPreview,
  Period,
  Policy,
  PolicyAssignment,
  PolicyKind,
  PolicySubjectKind,
  ResolvedPolicy,
} from './policies.js'
import {
  ErasureReport,
  RetentionPatch,
  RetentionRun,
  RetentionSettings,
  SensitiveAccess,
  SubjectAccessBundle,
} from './privacy.js'
import {
  AbsenceReport,
  AttendanceSummaryReport,
  LeaveBalanceReport,
  OvertimeReport,
  ReportSliceBy,
} from './reports.js'
import {
  RosterAssignment,
  RosterCoverageDay,
  RosterCycleDay,
  RosterDay,
  RosterPattern,
  RosterShift,
} from './rosters.js'

const ws = z.object({ workspaceId: WorkspaceId })
const t = ['hr'] as const
const ok = z.object({ ok: z.literal(true) })

/**
 * What every report takes: a range, a slice and how many rows to draw.
 *
 * `limit` bounds the rows, never the figures — `totals` and `population` are computed over everyone
 * the slice covers and `truncated` says when the rows are the top of a longer list. A headline that
 * silently described only the first page would be the exact defect these reports exist to avoid.
 */
const reportInput = ws.extend({
  from: IsoDate,
  to: IsoDate,
  by: ReportSliceBy.default('workspace'),
  /** Required by `office` and `legal_entity`, ignored by `workspace`. */
  sliceId: z.uuid().optional(),
  limit: z.number().int().min(1).max(1000).default(100),
})

export const hrContract = {
  // ---------------------------------------------------------------- people
  people: {
    list: baseContract
      .route({ method: 'GET', path: '/people', tags: t })
      .input(
        ws.extend({
          ...PageInput.shape,
          q: z.string().max(120).optional(),
          officeId: z.uuid().optional(),
          orgUnitId: z.uuid().optional(),
          /** Include the whole subtree below `orgUnitId`, not just its direct members. */
          includeDescendants: z.boolean().default(true),
          positionId: z.uuid().optional(),
          status: z.array(PersonStatus).optional(),
        }),
      )
      /**
       * Rows carry their office, which `Person` itself does not: office lives in
       * `office_assignments` because people change desks and change jobs on different days. A
       * directory that cannot say which office somebody is in misses the point of having offices,
       * so the list resolves it once for the whole page rather than making the client ask per row.
       */
      .output(page(Person.extend({ officeId: z.uuid().nullable(), officeName: z.string().nullable() }))),
    get: baseContract
      .route({ method: 'GET', path: '/people/{personId}', tags: t })
      .input(ws.extend({ personId: z.uuid() }))
      .output(Person),
    /**
     * The caller's own record.
     *
     * No permission: everybody has one and everybody may read it. Returns null rather than erroring
     * when the signed-in user has no HR record — plenty of members are not employees, and that is
     * an ordinary answer rather than a failure.
     */
    me: baseContract
      .route({ method: 'GET', path: '/people/me', tags: t })
      .input(ws)
      .output(Person.nullable()),
    create: baseContract
      .route({ method: 'POST', path: '/people', tags: t })
      .input(
        ws.extend({
          displayName: z.string().min(1).max(160),
          userId: z.uuid().nullish(),
          employeeNo: z.string().max(32).nullish(),
          workEmail: z.email().max(254).nullish(),
          hiredOn: IsoDate.nullish(),
          officeId: z.uuid().nullish(),
          orgUnitId: z.uuid().nullish(),
          positionId: z.uuid().nullish(),
          managerPersonId: z.uuid().nullish(),
          employmentType: EmploymentType.default('full_time'),
        }),
      )
      .output(Person),
    update: baseContract
      .route({ method: 'PATCH', path: '/people/{personId}', tags: t })
      .input(
        ws.extend({
          personId: z.uuid(),
          displayName: z.string().min(1).max(160).optional(),
          workEmail: z.email().max(254).nullish(),
          personalEmail: z.email().max(254).nullish(),
          phone: z.string().max(32).nullish(),
          photoFileId: z.uuid().nullish(),
          timezone: TimeZone.nullish(),
          custom: z.record(z.string(), z.unknown()).optional(),
          /**
           * The lifecycle, short of the end of it: `onboarding`, `active`, `on_leave` and
           * `offboarding` are states somebody moves a person between by hand. `terminated` is not
           * here — ending employment closes the open employment and office rows as well, and that
           * is `offboard` below. Moving somebody to `offboarding` starts the default offboarding
           * checklist, anchored on `terminatedOn` when it is known; until this field existed no
           * API call could reach that state at all.
           */
          status: PersonStatus.exclude(['terminated']).optional(),
          hiredOn: IsoDate.nullish(),
          /** The planned last day, which a leaver's checklist counts from. */
          terminatedOn: IsoDate.nullish(),
        }),
      )
      .output(Person),
    /** Ends employment. Keeps the record — a terminated person is history, not a deletion. */
    offboard: baseContract
      .route({ method: 'POST', path: '/people/{personId}/offboard', tags: t })
      .input(ws.extend({ personId: z.uuid(), on: IsoDate, reason: z.string().max(200).optional() }))
      .output(Person),
    history: baseContract
      .route({ method: 'GET', path: '/people/{personId}/history', tags: t })
      .input(ws.extend({ personId: z.uuid(), ...PageInput.shape }))
      .output(
        page(
          z.object({
            id: z.uuid(),
            field: z.string(),
            from: z.unknown().nullable(),
            to: z.unknown().nullable(),
            at: z.string(),
            actorId: z.uuid().nullable(),
            source: z.string(),
          }),
        ),
      ),
    sensitive: {
      get: baseContract
        .route({ method: 'GET', path: '/people/{personId}/sensitive', tags: t })
        .input(ws.extend({ personId: z.uuid() }))
        .output(PersonSensitive),
      update: baseContract
        .route({ method: 'PATCH', path: '/people/{personId}/sensitive', tags: t })
        .input(
          ws.extend({
            personId: z.uuid(),
            nationalId: z.string().max(64).nullish(),
            birthDate: IsoDate.nullish(),
            iban: z.string().max(48).nullish(),
            emergencyContact: z
              .object({
                name: z.string().max(160),
                relationship: z.string().max(64).optional(),
                phone: z.string().max(32),
              })
              .nullish(),
          }),
        )
        .output(PersonSensitive),
    },
  },

  // ---------------------------------------------------------------- employment
  employment: {
    current: baseContract
      .route({ method: 'GET', path: '/people/{personId}/employment', tags: t })
      .input(ws.extend({ personId: z.uuid(), on: IsoDate.optional() }))
      .output(Employment.nullable()),
    history: baseContract
      .route({ method: 'GET', path: '/people/{personId}/employment/history', tags: t })
      .input(ws.extend({ personId: z.uuid() }))
      .output(z.array(Employment)),
    /**
     * Records a change from a date. Closes the current row and opens a new one — never an update.
     *
     * `effectiveFrom` may be in the past: a promotion agreed in March and entered in May is normal,
     * and the record has to say March.
     */
    change: baseContract
      .route({ method: 'POST', path: '/people/{personId}/employment', tags: t })
      .input(
        ws.extend({
          personId: z.uuid(),
          effectiveFrom: IsoDate,
          orgUnitId: z.uuid().nullish(),
          positionId: z.uuid().nullish(),
          legalEntityId: z.uuid().nullish(),
          costCenterId: z.uuid().nullish(),
          managerPersonId: z.uuid().nullish(),
          employmentType: EmploymentType.optional(),
          fte: z.number().min(0).max(1).optional(),
          contractHoursWeek: z.number().min(0).max(168).nullish(),
          reason: z.string().max(200).nullish(),
        }),
      )
      .output(Employment),
  },

  // ---------------------------------------------------------------- org
  org: {
    units: {
      tree: baseContract
        .route({ method: 'GET', path: '/org/units', tags: t })
        .input(ws.extend({ includeArchived: z.boolean().default(false) }))
        .output(z.array(OrgUnit.extend({ headcount: z.number().int().nonnegative() }))),
      create: baseContract
        .route({ method: 'POST', path: '/org/units', tags: t })
        .input(
          ws.extend({
            name: z.string().min(1).max(160),
            parentId: z.uuid().nullish(),
            code: z.string().max(32).nullish(),
            headPersonId: z.uuid().nullish(),
          }),
        )
        .output(OrgUnit),
      update: baseContract
        .route({ method: 'PATCH', path: '/org/units/{unitId}', tags: t })
        .input(
          ws.extend({
            unitId: z.uuid(),
            name: z.string().min(1).max(160).optional(),
            code: z.string().max(32).nullish(),
            headPersonId: z.uuid().nullish(),
          }),
        )
        .output(OrgUnit),
      /** Reparents a unit and rewrites the ltree path of everything beneath it. */
      move: baseContract
        .route({ method: 'POST', path: '/org/units/{unitId}/move', tags: t })
        .input(ws.extend({ unitId: z.uuid(), parentId: z.uuid().nullable() }))
        .output(z.array(OrgUnit)),
      archive: baseContract
        .route({ method: 'DELETE', path: '/org/units/{unitId}', tags: t })
        .input(ws.extend({ unitId: z.uuid() }))
        .output(ok),
    },
    positions: {
      list: baseContract
        .route({ method: 'GET', path: '/org/positions', tags: t })
        .input(ws.extend({ includeArchived: z.boolean().default(false) }))
        .output(z.array(Position)),
      create: baseContract
        .route({ method: 'POST', path: '/org/positions', tags: t })
        .input(
          ws.extend({
            title: z.string().min(1).max(160),
            code: z.string().max(32).nullish(),
            jobFamily: z.string().max(64).nullish(),
            level: z.string().max(32).nullish(),
          }),
        )
        .output(Position),
      update: baseContract
        .route({ method: 'PATCH', path: '/org/positions/{positionId}', tags: t })
        .input(
          ws.extend({
            positionId: z.uuid(),
            title: z.string().min(1).max(160).optional(),
            code: z.string().max(32).nullish(),
            jobFamily: z.string().max(64).nullish(),
            level: z.string().max(32).nullish(),
          }),
        )
        .output(Position),
      archive: baseContract
        .route({ method: 'DELETE', path: '/org/positions/{positionId}', tags: t })
        .input(ws.extend({ positionId: z.uuid() }))
        .output(ok),
    },
  },

  // ---------------------------------------------------------------- offices
  offices: {
    list: baseContract
      .route({ method: 'GET', path: '/offices', tags: t })
      .input(ws.extend({ includeArchived: z.boolean().default(false) }))
      .output(z.array(Office.extend({ headcount: z.number().int().nonnegative() }))),
    get: baseContract
      .route({ method: 'GET', path: '/offices/{officeId}', tags: t })
      .input(ws.extend({ officeId: z.uuid() }))
      .output(Office),
    create: baseContract
      .route({ method: 'POST', path: '/offices', tags: t })
      .input(
        ws.extend({
          name: z.string().min(1).max(160),
          kind: OfficeKind.default('branch'),
          country: CountryCode,
          region: RegionCode.nullish(),
          city: z.string().max(120).nullish(),
          timezone: TimeZone,
          code: z.string().max(32).nullish(),
          parentOfficeId: z.uuid().nullish(),
          legalEntityId: z.uuid().nullish(),
          /**
           * Seed the office's calendar from a country pack. Omit to share the workspace default.
           * The pack is copied as a *base* the office's calendar extends, never inlined.
           */
          seedCalendarFromPack: z.boolean().default(true),
        }),
      )
      .output(Office),
    update: baseContract
      .route({ method: 'PATCH', path: '/offices/{officeId}', tags: t })
      .input(
        ws.extend({
          officeId: z.uuid(),
          name: z.string().min(1).max(160).optional(),
          kind: OfficeKind.optional(),
          country: CountryCode.optional(),
          region: RegionCode.nullish(),
          city: z.string().max(120).nullish(),
          timezone: TimeZone.optional(),
          calendarId: z.uuid().nullish(),
          legalEntityId: z.uuid().nullish(),
          headPersonId: z.uuid().nullish(),
          code: z.string().max(32).nullish(),
        }),
      )
      .output(Office),
    archive: baseContract
      .route({ method: 'DELETE', path: '/offices/{officeId}', tags: t })
      .input(ws.extend({ officeId: z.uuid() }))
      .output(ok),
    /** Moves the default flag. The old default keeps its people; only new arrivals change. */
    setDefault: baseContract
      .route({ method: 'POST', path: '/offices/{officeId}/default', tags: t })
      .input(ws.extend({ officeId: z.uuid() }))
      .output(Office),
    people: baseContract
      .route({ method: 'GET', path: '/offices/{officeId}/people', tags: t })
      .input(ws.extend({ officeId: z.uuid(), ...PageInput.shape, primaryOnly: z.boolean().default(false) }))
      .output(page(Person.extend({ isPrimaryHere: z.boolean() }))),
    assign: baseContract
      .route({ method: 'POST', path: '/offices/{officeId}/people', tags: t })
      .input(
        ws.extend({
          officeId: z.uuid(),
          personId: z.uuid(),
          isPrimary: z.boolean().default(true),
          effectiveFrom: IsoDate,
          reason: z.string().max(200).nullish(),
        }),
      )
      .output(z.array(OfficeAssignment)),
    unassign: baseContract
      .route({ method: 'DELETE', path: '/offices/{officeId}/people/{personId}', tags: t })
      .input(ws.extend({ officeId: z.uuid(), personId: z.uuid(), effectiveTo: IsoDate }))
      .output(ok),
    /**
     * What actually applies to this person on this date, and which rung of the ladder answered.
     *
     * Not behind the `offices` capability: a workspace with one office still has a ladder, and this
     * is the first thing anybody reaches for when a holiday or a policy looks wrong. It is the
     * difference between answering a support question and opening a database session.
     */
    resolveFor: baseContract
      .route({ method: 'GET', path: '/people/{personId}/resolution', tags: t })
      .input(ws.extend({ personId: z.uuid(), on: IsoDate.optional() }))
      .output(PersonResolution),
  },

  // ---------------------------------------------------------------- legal entities
  entities: {
    list: baseContract
      .route({ method: 'GET', path: '/entities', tags: t })
      .input(ws.extend({ includeArchived: z.boolean().default(false) }))
      .output(z.array(LegalEntity)),
    get: baseContract
      .route({ method: 'GET', path: '/entities/{entityId}', tags: t })
      .input(ws.extend({ entityId: z.uuid() }))
      .output(LegalEntity),
    create: baseContract
      .route({ method: 'POST', path: '/entities', tags: t })
      .input(
        ws.extend({
          name: z.string().min(1).max(200),
          country: CountryCode,
          registrationNo: z.string().max(64).nullish(),
          taxNo: z.string().max(64).nullish(),
          currency: z.string().length(3).nullish(),
        }),
      )
      .output(LegalEntity),
    update: baseContract
      .route({ method: 'PATCH', path: '/entities/{entityId}', tags: t })
      .input(
        ws.extend({
          entityId: z.uuid(),
          name: z.string().min(1).max(200).optional(),
          country: CountryCode.optional(),
          registrationNo: z.string().max(64).nullish(),
          taxNo: z.string().max(64).nullish(),
          currency: z.string().length(3).nullish(),
        }),
      )
      .output(LegalEntity),
    archive: baseContract
      .route({ method: 'DELETE', path: '/entities/{entityId}', tags: t })
      .input(ws.extend({ entityId: z.uuid() }))
      .output(ok),
    costCenters: {
      list: baseContract
        .route({ method: 'GET', path: '/cost-centers', tags: t })
        .input(ws.extend({ includeArchived: z.boolean().default(false) }))
        .output(z.array(CostCenter)),
      create: baseContract
        .route({ method: 'POST', path: '/cost-centers', tags: t })
        .input(
          ws.extend({
            code: z.string().min(1).max(32),
            name: z.string().min(1).max(160),
            officeId: z.uuid().nullish(),
            orgUnitId: z.uuid().nullish(),
            legalEntityId: z.uuid().nullish(),
          }),
        )
        .output(CostCenter),
      archive: baseContract
        .route({ method: 'DELETE', path: '/cost-centers/{costCenterId}', tags: t })
        .input(ws.extend({ costCenterId: z.uuid() }))
        .output(ok),
    },
  },

  // ---------------------------------------------------------------- calendars
  calendars: {
    list: baseContract
      .route({ method: 'GET', path: '/calendars', tags: t })
      .input(ws.extend({ includeArchived: z.boolean().default(false) }))
      .output(z.array(Calendar.extend({ officeIds: z.array(z.uuid()) }))),
    get: baseContract
      .route({ method: 'GET', path: '/calendars/{calendarId}', tags: t })
      .input(ws.extend({ calendarId: z.uuid() }))
      .output(Calendar),
    create: baseContract
      .route({ method: 'POST', path: '/calendars', tags: t })
      .input(
        ws.extend({
          name: z.string().min(1).max(160),
          /** Build on a country pack. Its days stay `pack` and upgrade cleanly. */
          extendsId: z.uuid().nullish(),
          country: CountryCode.nullish(),
          region: RegionCode.nullish(),
          workingWeek: WorkingWeek.optional(),
        }),
      )
      .output(Calendar),
    update: baseContract
      .route({ method: 'PATCH', path: '/calendars/{calendarId}', tags: t })
      .input(
        ws.extend({
          calendarId: z.uuid(),
          name: z.string().min(1).max(160).optional(),
          workingWeek: WorkingWeek.optional(),
          extendsId: z.uuid().nullish(),
        }),
      )
      .output(Calendar),
    archive: baseContract
      .route({ method: 'DELETE', path: '/calendars/{calendarId}', tags: t })
      .input(ws.extend({ calendarId: z.uuid() }))
      .output(ok),
    days: {
      /**
       * The composed calendar: the pack's days and this calendar's own, each labelled with where it
       * came from and whether it overrides something below it.
       */
      list: baseContract
        .route({ method: 'GET', path: '/calendars/{calendarId}/days', tags: t })
        .input(ws.extend({ calendarId: z.uuid(), from: IsoDate, to: IsoDate }))
        .output(z.array(ResolvedCalendarDay)),
      add: baseContract
        .route({ method: 'POST', path: '/calendars/{calendarId}/days', tags: t })
        .input(
          ws.extend({
            calendarId: z.uuid(),
            date: IsoDate,
            name: z.string().min(1).max(160),
            kind: CalendarDayKind.default('company_closure'),
            workingFraction: z.number().min(0).max(1).default(0),
            paid: z.boolean().default(true),
            note: z.string().max(500).nullish(),
          }),
        )
        .output(ResolvedCalendarDay),
      update: baseContract
        .route({ method: 'PATCH', path: '/calendars/{calendarId}/days/{dayId}', tags: t })
        .input(
          ws.extend({
            calendarId: z.uuid(),
            dayId: z.uuid(),
            name: z.string().min(1).max(160).optional(),
            kind: CalendarDayKind.optional(),
            workingFraction: z.number().min(0).max(1).optional(),
            paid: z.boolean().optional(),
            note: z.string().max(500).nullish(),
          }),
        )
        .output(ResolvedCalendarDay),
      /**
       * Removes a day.
       *
       * A `custom` day is deleted. A `pack` day cannot be — it belongs to the pack, and deleting it
       * would only bring it back on the next upgrade — so this writes a suppressing `custom` row
       * over it instead, and says so in `suppressed`.
       */
      remove: baseContract
        .route({ method: 'DELETE', path: '/calendars/{calendarId}/days/{dayId}', tags: t })
        .input(ws.extend({ calendarId: z.uuid(), dayId: z.uuid() }))
        .output(z.object({ ok: z.literal(true), suppressed: z.boolean() })),
    },
    pack: {
      /** What applying this pack would add, change and remove — and what it would leave alone. */
      preview: baseContract
        .route({ method: 'POST', path: '/calendars/{calendarId}/pack/preview', tags: t })
        .input(ws.extend({ calendarId: z.uuid(), packKey: z.string().max(32), year: z.number().int() }))
        .output(
          z.object({
            packKey: z.string(),
            packVersion: z.string(),
            added: z.array(z.object({ date: IsoDate, name: z.string() })),
            changed: z.array(z.object({ date: IsoDate, name: z.string(), was: z.string() })),
            removed: z.array(z.object({ date: IsoDate, name: z.string() })),
            /** Days HR added themselves. Always untouched; listed so the dialog can say so. */
            keptCustom: z.array(z.object({ date: IsoDate, name: z.string() })),
          }),
        ),
      apply: baseContract
        .route({ method: 'POST', path: '/calendars/{calendarId}/pack/apply', tags: t })
        .input(ws.extend({ calendarId: z.uuid(), packKey: z.string().max(32), year: z.number().int() }))
        .output(
          z.object({ ok: z.literal(true), added: z.number(), changed: z.number(), removed: z.number() }),
        ),
    },
    /**
     * How many working days a range holds for a given person, honouring their office's calendar,
     * working week, half-days and closures.
     *
     * The one computation leave, attendance and reporting all need. Exposed on the API as well as
     * through `kernel.call` so a screen can show the number before anything is submitted.
     */
    workingDays: baseContract
      .route({ method: 'GET', path: '/calendars/working-days', tags: t })
      .input(
        ws.extend({
          personId: z.uuid().optional(),
          calendarId: z.uuid().optional(),
          from: IsoDate,
          to: IsoDate,
        }),
      )
      .output(
        z.object({
          days: z.number(),
          breakdown: z.array(
            z.object({ date: IsoDate, fraction: z.number(), reason: z.string().nullable() }),
          ),
        }),
      ),
  },

  // ---------------------------------------------------------------- documents
  documents: {
    list: baseContract
      .route({ method: 'GET', path: '/people/{personId}/documents', tags: t })
      .input(ws.extend({ personId: z.uuid() }))
      .output(z.array(PersonDocument)),
    attach: baseContract
      .route({ method: 'POST', path: '/people/{personId}/documents', tags: t })
      .input(
        ws.extend({
          personId: z.uuid(),
          fileId: z.uuid(),
          name: z.string().min(1).max(200),
          kind: z.string().max(48).default('other'),
          issuedOn: IsoDate.nullish(),
          expiresOn: IsoDate.nullish(),
        }),
      )
      .output(PersonDocument),
    remove: baseContract
      .route({ method: 'DELETE', path: '/people/{personId}/documents/{documentId}', tags: t })
      .input(ws.extend({ personId: z.uuid(), documentId: z.uuid() }))
      .output(ok),
  },

  // ---------------------------------------------------------------- policies
  policies: {
    list: baseContract
      .route({ method: 'GET', path: '/policies', tags: t })
      .input(ws.extend({ kind: PolicyKind.optional(), includeArchived: z.boolean().default(false) }))
      .output(z.array(Policy.extend({ assignments: z.array(PolicyAssignment) }))),
    get: baseContract
      .route({ method: 'GET', path: '/policies/{policyId}', tags: t })
      .input(ws.extend({ policyId: z.uuid() }))
      .output(Policy.extend({ assignments: z.array(PolicyAssignment) })),
    create: baseContract
      .route({ method: 'POST', path: '/policies', tags: t })
      .input(
        ws.extend({
          kind: PolicyKind,
          name: z.string().min(1).max(120),
          /** Validated against the schema for `kind` — a config for the wrong kind is refused. */
          config: z.record(z.string(), z.unknown()),
          effectiveFrom: IsoDate,
          effectiveTo: IsoDate.nullish(),
        }),
      )
      .output(Policy),
    /**
     * Edits a policy in place.
     *
     * A change that should apply from a date rather than retroactively is a **new** policy with a
     * later `effectiveFrom`, not an edit — editing rewrites what was true in the past, and anything
     * already derived from it becomes unexplainable.
     */
    update: baseContract
      .route({ method: 'PATCH', path: '/policies/{policyId}', tags: t })
      .input(
        ws.extend({
          policyId: z.uuid(),
          name: z.string().min(1).max(120).optional(),
          config: z.record(z.string(), z.unknown()).optional(),
          effectiveTo: IsoDate.nullish(),
        }),
      )
      .output(Policy),
    archive: baseContract
      .route({ method: 'DELETE', path: '/policies/{policyId}', tags: t })
      .input(ws.extend({ policyId: z.uuid() }))
      .output(ok),
    assign: baseContract
      .route({ method: 'POST', path: '/policies/{policyId}/assign', tags: t })
      .input(
        ws.extend({
          policyId: z.uuid(),
          subjectKind: PolicySubjectKind,
          /** Null for `workspace`, which needs no id. */
          subjectId: z.uuid().nullish(),
          effectiveFrom: IsoDate,
          effectiveTo: IsoDate.nullish(),
        }),
      )
      .output(PolicyAssignment),
    unassign: baseContract
      .route({ method: 'DELETE', path: '/policies/assignments/{assignmentId}', tags: t })
      .input(ws.extend({ assignmentId: z.uuid() }))
      .output(ok),
    /**
     * Which policy of each kind applies to this person on this date, and which rung answered.
     *
     * "Why does she accrue differently from her team" is the question this module gets asked, and
     * this is what answers it without a database session.
     */
    resolveFor: baseContract
      .route({ method: 'GET', path: '/people/{personId}/policies', tags: t })
      .input(ws.extend({ personId: z.uuid(), on: IsoDate.optional() }))
      .output(z.array(ResolvedPolicy)),
  },

  // ---------------------------------------------------------------- accrual
  accrual: {
    /**
     * What a run would credit, per person, before it writes anything.
     *
     * Runs the same code the run does. A preview computed differently from the thing it previews is
     * a preview that eventually lies.
     */
    preview: baseContract
      .route({ method: 'POST', path: '/accrual/preview', tags: t })
      .input(ws.extend({ from: IsoDate, to: IsoDate, personId: z.uuid().optional() }))
      .output(AccrualPreview),
    /**
     * Credits the ledger.
     *
     * Idempotent per person, per leave type, per period: a second run for the same window credits
     * nothing, because an accrual job that double-credits when somebody clicks twice is worse than
     * one that never ran.
     */
    run: baseContract
      .route({ method: 'POST', path: '/accrual/run', tags: t })
      .input(ws.extend({ from: IsoDate, to: IsoDate, personId: z.uuid().optional() }))
      .output(
        z.object({
          credited: z.number().int(),
          skipped: z.number().int(),
          totalMinutes: z.number().int(),
        }),
      ),
  },

  // ---------------------------------------------------------------- periods
  periods: {
    list: baseContract
      .route({ method: 'GET', path: '/periods', tags: t })
      .input(ws.extend({ kind: Period.shape.kind.optional(), ...PageInput.shape }))
      .output(page(Period)),
    create: baseContract
      .route({ method: 'POST', path: '/periods', tags: t })
      .input(
        ws.extend({
          kind: Period.shape.kind.default('payroll'),
          legalEntityId: z.uuid().nullish(),
          startsOn: IsoDate,
          endsOn: IsoDate,
        }),
      )
      .output(Period),
    /** Freezes the month. Every derived day inside it stops being recomputable. */
    lock: baseContract
      .route({ method: 'POST', path: '/periods/{periodId}/lock', tags: t })
      .input(ws.extend({ periodId: z.uuid(), note: z.string().max(500).nullish() }))
      .output(Period.extend({ lockedDays: z.number().int() })),
    /**
     * Reopens it.
     *
     * Dangerous on purpose: a payroll has usually been filed against a locked month, and reopening
     * lets figures move underneath it. The response says how many days became recomputable again.
     */
    unlock: baseContract
      .route({ method: 'POST', path: '/periods/{periodId}/unlock', tags: t })
      .input(ws.extend({ periodId: z.uuid(), reason: z.string().min(1).max(500) }))
      .output(Period.extend({ unlockedDays: z.number().int() })),
  },

  // ---------------------------------------------------------------- attendance
  attendance: {
    /** Am I clocked in? The one call a clock widget makes. */
    state: baseContract
      .route({ method: 'GET', path: '/attendance/state', tags: t })
      .input(ws.extend({ personId: z.uuid().optional() }))
      .output(ClockState),

    /**
     * Clock in. The instant is **stamped by the server**, never taken from the caller.
     *
     * `clientReportedAt` is recorded alongside it for audit — a device whose clock is an hour out is
     * worth knowing about — but it never decides anything.
     */
    clockIn: baseContract
      .route({ method: 'POST', path: '/attendance/clock-in', tags: t })
      .input(
        ws.extend({
          personId: z.uuid().optional(),
          // `ClientPunchMethod`, which is `PunchMethod` minus `auto`: `auto` means "the nightly
          // sweep closed a shift nobody clocked out of", and it is the one value a caller must not
          // be able to claim for itself. The employee's timeline labels it "Closed automatically",
          // so accepting it here would let a punch dressed as the machine's disown a person's own.
          method: ClientPunchMethod.default('web'),
          clientReportedAt: z.iso.datetime({ offset: true }).nullish(),
          geo: z.object({ lat: z.number(), lng: z.number(), accuracyM: z.number().optional() }).nullish(),
          note: z.string().max(500).nullish(),
          idempotencyKey: z.string().min(8).max(128).optional(),
        }),
      )
      .output(Punch),
    clockOut: baseContract
      .route({ method: 'POST', path: '/attendance/clock-out', tags: t })
      .input(
        ws.extend({
          personId: z.uuid().optional(),
          // `ClientPunchMethod`, which is `PunchMethod` minus `auto`: `auto` means "the nightly
          // sweep closed a shift nobody clocked out of", and it is the one value a caller must not
          // be able to claim for itself. The employee's timeline labels it "Closed automatically",
          // so accepting it here would let a punch dressed as the machine's disown a person's own.
          method: ClientPunchMethod.default('web'),
          clientReportedAt: z.iso.datetime({ offset: true }).nullish(),
          geo: z.object({ lat: z.number(), lng: z.number(), accuracyM: z.number().optional() }).nullish(),
          note: z.string().max(500).nullish(),
          idempotencyKey: z.string().min(8).max(128).optional(),
        }),
      )
      .output(Punch),
    breakStart: baseContract
      .route({ method: 'POST', path: '/attendance/break-start', tags: t })
      .input(
        ws.extend({ personId: z.uuid().optional(), idempotencyKey: z.string().min(8).max(128).optional() }),
      )
      .output(Punch),
    breakEnd: baseContract
      .route({ method: 'POST', path: '/attendance/break-end', tags: t })
      .input(
        ws.extend({ personId: z.uuid().optional(), idempotencyKey: z.string().min(8).max(128).optional() }),
      )
      .output(Punch),

    punches: {
      list: baseContract
        .route({ method: 'GET', path: '/attendance/punches', tags: t })
        .input(
          ws.extend({
            personId: z.uuid().optional(),
            from: IsoDate,
            to: IsoDate,
            includeVoided: z.boolean().default(false),
            ...PageInput.shape,
          }),
        )
        .output(page(Punch)),
      /**
       * Void a punch by writing a correcting row.
       *
       * The original is never edited or deleted — an attendance record somebody can quietly rewrite
       * is worth nothing in the dispute it exists for.
       */
      void: baseContract
        .route({ method: 'POST', path: '/attendance/punches/{punchId}/void', tags: t })
        .input(ws.extend({ punchId: z.uuid(), reason: z.string().min(1).max(500) }))
        .output(ok),
    },

    days: {
      list: baseContract
        .route({ method: 'GET', path: '/attendance/days', tags: t })
        .input(
          ws.extend({
            personId: z.uuid().optional(),
            officeId: z.uuid().optional(),
            from: IsoDate,
            to: IsoDate,
            ...PageInput.shape,
          }),
        )
        .output(page(AttendanceDay)),
      /**
       * Recompute a range from the punches.
       *
       * Safe to call at any time — the day sheet is a projection, so this is idempotent by
       * construction. Locked days are skipped and named in the response rather than silently
       * ignored.
       */
      recompute: baseContract
        .route({ method: 'POST', path: '/attendance/days/recompute', tags: t })
        .input(ws.extend({ personId: z.uuid().optional(), from: IsoDate, to: IsoDate }))
        .output(z.object({ recomputed: z.number().int(), skippedLocked: z.array(IsoDate) })),
    },

    schedules: {
      list: baseContract
        .route({ method: 'GET', path: '/attendance/schedules', tags: t })
        .input(ws.extend({ includeArchived: z.boolean().default(false) }))
        .output(z.array(Schedule)),
      create: baseContract
        .route({ method: 'POST', path: '/attendance/schedules', tags: t })
        .input(
          ws.extend({
            name: z.string().min(1).max(120),
            kind: Schedule.shape.kind.default('fixed'),
            week: ScheduleWeek,
            tzMode: Schedule.shape.tzMode.default('office'),
            tz: Schedule.shape.tz.optional(),
            graceInMinutes: z.number().int().min(0).max(240).default(0),
            graceOutMinutes: z.number().int().min(0).max(240).default(0),
            roundingStepMinutes: z.number().int().min(0).max(60).default(0),
            roundingDirection: Schedule.shape.roundingDirection.default('nearest'),
            autoClockOutAfterMinutes: z.number().int().min(60).nullish(),
          }),
        )
        .output(Schedule),
      update: baseContract
        .route({ method: 'PATCH', path: '/attendance/schedules/{scheduleId}', tags: t })
        .input(
          ws.extend({
            scheduleId: z.uuid(),
            name: z.string().min(1).max(120).optional(),
            week: ScheduleWeek.optional(),
            graceInMinutes: z.number().int().min(0).max(240).optional(),
            graceOutMinutes: z.number().int().min(0).max(240).optional(),
            roundingStepMinutes: z.number().int().min(0).max(60).optional(),
            roundingDirection: Schedule.shape.roundingDirection.optional(),
            autoClockOutAfterMinutes: z.number().int().min(60).nullish(),
          }),
        )
        .output(Schedule),
      archive: baseContract
        .route({ method: 'DELETE', path: '/attendance/schedules/{scheduleId}', tags: t })
        .input(ws.extend({ scheduleId: z.uuid() }))
        .output(ok),
      assign: baseContract
        .route({ method: 'POST', path: '/attendance/schedules/{scheduleId}/assign', tags: t })
        .input(ws.extend({ scheduleId: z.uuid(), personId: z.uuid(), effectiveFrom: IsoDate }))
        .output(z.array(ScheduleAssignment)),
    },

    regularizations: {
      list: baseContract
        .route({ method: 'GET', path: '/attendance/regularizations', tags: t })
        .input(
          ws.extend({
            personId: z.uuid().optional(),
            status: z.array(Regularization.shape.status).optional(),
            ...PageInput.shape,
          }),
        )
        .output(page(Regularization)),
      /** Ask for a wrong or missing punch to be fixed. Goes through the same approval engine. */
      request: baseContract
        .route({ method: 'POST', path: '/attendance/regularizations', tags: t })
        .input(
          ws.extend({
            personId: z.uuid().optional(),
            businessDate: IsoDate,
            punchId: z.uuid().nullish(),
            proposed: z
              .array(
                z.object({
                  direction: PunchDirection,
                  at: z.iso.datetime({ offset: true }),
                }),
              )
              .min(1),
            reason: z.string().min(1).max(1000),
          }),
        )
        .output(Regularization),
    },
  },

  // ---------------------------------------------------------------- rosters
  /**
   * Who works which shift on which **date**.
   *
   * Separate from `attendance.schedules` rather than folded into it, because the two answer
   * different questions and only one of them has a weekly period. A schedule is a week that repeats
   * for ever; a rotation is a cycle of any length anchored to a date, which is the only shape
   * 4-on-4-off has. Nothing here recomputes hours — grace, rounding, overnight attribution and the
   * auto-close sweep all stay in attendance, and a roster only decides what the day was meant to be.
   */
  rosters: {
    shifts: {
      list: baseContract
        .route({ method: 'GET', path: '/rosters/shifts', tags: t })
        .input(ws.extend({ includeArchived: z.boolean().default(false) }))
        .output(z.array(RosterShift)),
      create: baseContract
        .route({ method: 'POST', path: '/rosters/shifts', tags: t })
        .input(
          ws.extend({
            name: z.string().min(1).max(80),
            code: z.string().max(8).nullish(),
            start: WallClock,
            end: WallClock,
            breakMinutes: z.number().int().min(0).max(480).default(0),
            graceInMinutes: z.number().int().min(0).max(240).default(0),
            graceOutMinutes: z.number().int().min(0).max(240).default(0),
            color: z.string().max(32).nullish(),
          }),
        )
        .output(RosterShift),
      update: baseContract
        .route({ method: 'PATCH', path: '/rosters/shifts/{shiftId}', tags: t })
        .input(
          ws.extend({
            shiftId: z.uuid(),
            name: z.string().min(1).max(80).optional(),
            code: z.string().max(8).nullish(),
            start: WallClock.optional(),
            end: WallClock.optional(),
            breakMinutes: z.number().int().min(0).max(480).optional(),
            graceInMinutes: z.number().int().min(0).max(240).optional(),
            graceOutMinutes: z.number().int().min(0).max(240).optional(),
            color: z.string().max(32).nullish(),
          }),
        )
        .output(RosterShift),
      /**
       * Archive, never delete. Patterns and stored overrides point at a shift by id, so deleting
       * one would empty out every day it appears on — past days included.
       */
      archive: baseContract
        .route({ method: 'DELETE', path: '/rosters/shifts/{shiftId}', tags: t })
        .input(ws.extend({ shiftId: z.uuid() }))
        .output(ok),
    },

    patterns: {
      list: baseContract
        .route({ method: 'GET', path: '/rosters/patterns', tags: t })
        .input(ws.extend({ includeArchived: z.boolean().default(false) }))
        .output(z.array(RosterPattern)),
      create: baseContract
        .route({ method: 'POST', path: '/rosters/patterns', tags: t })
        .input(
          ws.extend({
            name: z.string().min(1).max(120),
            anchorDate: IsoDate,
            days: z.array(RosterCycleDay).min(1).max(56),
          }),
        )
        .output(RosterPattern),
      /**
       * Editing a rotation moves every crew on it, on every date, at once — which is the point of a
       * rotation being computed rather than generated, and worth saying out loud on the screen that
       * does it.
       */
      update: baseContract
        .route({ method: 'PATCH', path: '/rosters/patterns/{patternId}', tags: t })
        .input(
          ws.extend({
            patternId: z.uuid(),
            name: z.string().min(1).max(120).optional(),
            anchorDate: IsoDate.optional(),
            days: z.array(RosterCycleDay).min(1).max(56).optional(),
          }),
        )
        .output(RosterPattern),
      archive: baseContract
        .route({ method: 'DELETE', path: '/rosters/patterns/{patternId}', tags: t })
        .input(ws.extend({ patternId: z.uuid() }))
        .output(ok),
    },

    /** Who is on which rotation, and when. `attendance.schedules` has no equivalent and should. */
    assignments: baseContract
      .route({ method: 'GET', path: '/rosters/assignments', tags: t })
      .input(ws.extend({ personId: z.uuid().optional(), patternId: z.uuid().optional() }))
      .output(z.array(RosterAssignment)),

    /**
     * Put a crew on a rotation.
     *
     * Takes a list of people because a rotation is a crew's, not a person's — assigning eleven
     * people one at a time is eleven chances to get the offset wrong. The previous assignment is
     * closed the day before, so "which rotation was she on in March" stays answerable.
     */
    assign: baseContract
      .route({ method: 'POST', path: '/rosters/assign', tags: t })
      .input(
        ws.extend({
          patternId: z.uuid(),
          personIds: z.array(z.uuid()).min(1).max(200),
          effectiveFrom: IsoDate,
          /** The last day covered, inclusive. Null leaves the assignment open. */
          effectiveTo: IsoDate.nullish(),
          /** Which position of the cycle `effectiveFrom` starts at — how two crews run out of phase. */
          cycleOffset: z.number().int().min(0).max(55).default(0),
        }),
      )
      .output(z.array(RosterAssignment)),

    /** Take a crew off its rotation, from the day after `effectiveTo`. Nothing is deleted. */
    unassign: baseContract
      .route({ method: 'POST', path: '/rosters/unassign', tags: t })
      .input(
        ws.extend({
          personIds: z.array(z.uuid()).min(1).max(200),
          /** The last day the rotation still applies. */
          effectiveTo: IsoDate,
        }),
      )
      .output(z.object({ closed: z.number().int() })),

    /** One person's roster over a range, rotation and overrides already resolved. */
    days: baseContract
      .route({ method: 'GET', path: '/rosters/days', tags: t })
      .input(ws.extend({ personId: z.uuid().optional(), from: IsoDate, to: IsoDate }))
      .output(z.array(RosterDay)),

    /**
     * Change one day, leaving the rotation alone.
     *
     * An empty `shiftIds` is "off that day" and is stored — a planned rest day and a day nothing
     * rosters at all are different facts, and only one of them is somebody's decision.
     */
    set: baseContract
      .route({ method: 'POST', path: '/rosters/days', tags: t })
      .input(
        ws.extend({
          personId: z.uuid(),
          businessDate: IsoDate,
          shiftIds: RosterCycleDay,
          note: z.string().max(500).nullish(),
        }),
      )
      .output(RosterDay),

    /** Drop the exception and let the rotation speak for that day again. */
    clear: baseContract
      .route({ method: 'DELETE', path: '/rosters/days', tags: t })
      .input(ws.extend({ personId: z.uuid(), businessDate: IsoDate }))
      .output(ok),

    /**
     * Who is on which shift, per day — the question a roster exists for and the one a set of weekly
     * schedules cannot be asked without walking everybody's week.
     */
    coverage: baseContract
      .route({ method: 'GET', path: '/rosters/coverage', tags: t })
      .input(ws.extend({ from: IsoDate, to: IsoDate, officeId: z.uuid().optional() }))
      .output(z.array(RosterCoverageDay)),
  },

  // ---------------------------------------------------------------- leave
  leave: {
    types: {
      list: baseContract
        .route({ method: 'GET', path: '/leave/types', tags: t })
        .input(ws.extend({ includeArchived: z.boolean().default(false) }))
        .output(z.array(LeaveType)),
      create: baseContract
        .route({ method: 'POST', path: '/leave/types', tags: t })
        .input(
          ws.extend({
            key: z.string().min(1).max(48),
            name: z.string().min(1).max(120),
            paid: z.boolean().default(true),
            unit: LeaveUnit.default('day'),
            color: z.string().max(32).nullish(),
            icon: z.string().max(48).nullish(),
            requiresDocumentAfterDays: z.number().int().min(1).nullish(),
            countsWorkingDaysOnly: z.boolean().default(true),
            allowNegative: z.boolean().default(false),
            maxNegativeMinutes: z.number().int().min(0).default(0),
          }),
        )
        .output(LeaveType),
      update: baseContract
        .route({ method: 'PATCH', path: '/leave/types/{leaveTypeId}', tags: t })
        .input(
          ws.extend({
            leaveTypeId: z.uuid(),
            name: z.string().min(1).max(120).optional(),
            paid: z.boolean().optional(),
            color: z.string().max(32).nullish(),
            icon: z.string().max(48).nullish(),
            requiresDocumentAfterDays: z.number().int().min(1).nullish(),
            countsWorkingDaysOnly: z.boolean().optional(),
            allowNegative: z.boolean().optional(),
            maxNegativeMinutes: z.number().int().min(0).optional(),
            order: z.number().int().optional(),
          }),
        )
        .output(LeaveType),
      archive: baseContract
        .route({ method: 'DELETE', path: '/leave/types/{leaveTypeId}', tags: t })
        .input(ws.extend({ leaveTypeId: z.uuid() }))
        .output(ok),
    },

    /** Everything a person has, per type. Defaults to the caller when `personId` is omitted. */
    balance: {
      get: baseContract
        .route({ method: 'GET', path: '/leave/balance', tags: t })
        .input(ws.extend({ personId: z.uuid().optional(), periodYear: z.number().int().optional() }))
        .output(z.array(LeaveBalance)),
    },

    /**
     * The movements behind a balance.
     *
     * The reason the ledger is append-only: when somebody disputes a number, this is the answer —
     * a list of what happened, in order, that nobody edited.
     */
    ledger: {
      list: baseContract
        .route({ method: 'GET', path: '/leave/ledger', tags: t })
        .input(
          ws.extend({
            personId: z.uuid(),
            leaveTypeId: z.uuid().optional(),
            periodYear: z.number().int().optional(),
            ...PageInput.shape,
          }),
        )
        .output(page(LeaveLedgerEntry)),
    },

    /** A manual movement. Always carries a reason — an unexplained balance change is the thing HR gets asked about. */
    adjust: baseContract
      .route({ method: 'POST', path: '/leave/adjust', tags: t })
      .input(
        ws.extend({
          personId: z.uuid(),
          leaveTypeId: z.uuid(),
          kind: LedgerKind.default('adjustment'),
          amountMinutes: z.number().int(),
          effectiveOn: IsoDate,
          reason: z.string().min(1).max(500),
        }),
      )
      .output(LeaveLedgerEntry),

    requests: {
      list: baseContract
        .route({ method: 'GET', path: '/leave/requests', tags: t })
        .input(
          ws.extend({
            ...PageInput.shape,
            personId: z.uuid().optional(),
            officeId: z.uuid().optional(),
            status: z.array(LeaveRequest.shape.status).optional(),
            from: IsoDate.optional(),
            to: IsoDate.optional(),
          }),
        )
        .output(page(LeaveRequest)),
      get: baseContract
        .route({ method: 'GET', path: '/leave/requests/{requestId}', tags: t })
        .input(ws.extend({ requestId: z.uuid() }))
        .output(LeaveRequest),
      /** What it would cost and whether it would be refused — before anybody submits. */
      simulate: baseContract
        .route({ method: 'POST', path: '/leave/requests/simulate', tags: t })
        .input(
          ws.extend({
            personId: z.uuid().optional(),
            leaveTypeId: z.uuid(),
            startsOn: IsoDate,
            endsOn: IsoDate,
            startPart: DayPart.default('full'),
            endPart: DayPart.default('full'),
            hours: z.number().min(0).max(24).nullish(),
          }),
        )
        .output(LeaveSimulation),
      create: baseContract
        .route({ method: 'POST', path: '/leave/requests', tags: t })
        .input(
          ws.extend({
            personId: z.uuid().optional(),
            leaveTypeId: z.uuid(),
            startsOn: IsoDate,
            endsOn: IsoDate,
            startPart: DayPart.default('full'),
            endPart: DayPart.default('full'),
            hours: z.number().min(0).max(24).nullish(),
            reason: z.string().max(1000).nullish(),
            documentFileId: z.uuid().nullish(),
            /**
             * Makes a retried submission safe. Two clicks on a slow connection must not book the
             * same week twice and spend the balance twice.
             */
            idempotencyKey: z.string().min(8).max(128).optional(),
          }),
        )
        .output(LeaveRequest),
      /**
       * Cancels a request. An approved one is reversed in the ledger rather than deleted, so the
       * balance goes back up and the history still says what happened.
       */
      cancel: baseContract
        .route({ method: 'POST', path: '/leave/requests/{requestId}/cancel', tags: t })
        .input(ws.extend({ requestId: z.uuid(), reason: z.string().max(500).nullish() }))
        .output(LeaveRequest),
    },

    /** Who is off, over a range — the answer a team actually looks at. */
    team: {
      calendar: baseContract
        .route({ method: 'GET', path: '/leave/calendar', tags: t })
        .input(
          ws.extend({
            from: IsoDate,
            to: IsoDate,
            officeId: z.uuid().optional(),
            orgUnitId: z.uuid().optional(),
          }),
        )
        .output(
          z.array(
            z.object({
              personId: z.uuid(),
              displayName: z.string(),
              requestId: z.uuid(),
              startsOn: IsoDate,
              endsOn: IsoDate,
              status: LeaveRequest.shape.status,
              /**
               * The type's name, or null when the viewer may not see it. Most companies want the
               * team to know somebody is away without knowing it is sick leave.
               */
              leaveTypeName: z.string().nullable(),
              color: z.string().nullable(),
            }),
          ),
        ),
    },
  },

  // ---------------------------------------------------------------- approvals
  approvals: {
    /**
     * Everything waiting on the caller, across every subject type — or everything they have
     * already settled.
     *
     * `status` rather than the `includeDecided` boolean it replaces. That flag was *inclusive*
     * ("also give me the decided ones") while every caller used it as an exclusive two-tab switch,
     * so the screen's "Decided" tab asked for decided-as-well and got pending rows listed under a
     * heading that said somebody had decided them. Both halves read correctly on their own, which
     * is why it survived: an enum makes the two tabs exactly what they say.
     */
    inbox: baseContract
      .route({ method: 'GET', path: '/approvals/inbox', tags: t })
      .input(ws.extend({ ...PageInput.shape, status: z.enum(['pending', 'decided']).default('pending') }))
      .output(page(ApprovalRequest)),
    get: baseContract
      .route({ method: 'GET', path: '/approvals/{requestId}', tags: t })
      .input(ws.extend({ requestId: z.uuid() }))
      .output(ApprovalRequest),
    /**
     * Approve or reject. Idempotent per approver per step — a double click is one decision, and the
     * database refuses the second rather than counting it twice.
     */
    decide: baseContract
      .route({ method: 'POST', path: '/approvals/{requestId}/decide', tags: t })
      .input(
        ws.extend({
          requestId: z.uuid(),
          decision: z.enum(['approve', 'reject']),
          comment: z.string().max(1000).nullish(),
          /** Deciding in somebody's place, through a delegation they created. */
          onBehalfOfId: z.uuid().nullish(),
        }),
      )
      .output(ApprovalRequest),
    chains: {
      list: baseContract
        .route({ method: 'GET', path: '/approvals/chains', tags: t })
        .input(ws.extend({ subjectType: ApprovalSubjectType.optional() }))
        .output(z.array(ApprovalChain)),
      create: baseContract
        .route({ method: 'POST', path: '/approvals/chains', tags: t })
        .input(
          ws.extend({
            name: z.string().min(1).max(120),
            subjectType: ApprovalSubjectType,
            spec: ApprovalChainSpec,
            isDefault: z.boolean().default(false),
          }),
        )
        .output(ApprovalChain),
      update: baseContract
        .route({ method: 'PATCH', path: '/approvals/chains/{chainId}', tags: t })
        .input(
          ws.extend({
            chainId: z.uuid(),
            name: z.string().min(1).max(120).optional(),
            spec: ApprovalChainSpec.optional(),
            isDefault: z.boolean().optional(),
          }),
        )
        .output(ApprovalChain),
      archive: baseContract
        .route({ method: 'DELETE', path: '/approvals/chains/{chainId}', tags: t })
        .input(ws.extend({ chainId: z.uuid() }))
        .output(ok),
    },
    delegations: baseContract
      .route({ method: 'GET', path: '/approvals/delegations', tags: t })
      .input(ws.extend({ personId: z.uuid().optional() }))
      .output(z.array(Delegation)),
    delegate: baseContract
      .route({ method: 'POST', path: '/approvals/delegations', tags: t })
      .input(
        ws.extend({
          toPersonId: z.uuid(),
          subjectType: ApprovalSubjectType.nullish(),
          startsOn: IsoDate,
          endsOn: IsoDate,
          reason: z.string().max(200).nullish(),
        }),
      )
      .output(Delegation),
    revokeDelegation: baseContract
      .route({ method: 'DELETE', path: '/approvals/delegations/{delegationId}', tags: t })
      .input(ws.extend({ delegationId: z.uuid() }))
      .output(ok),
  },

  // ---------------------------------------------------------------- custom fields
  fields: {
    list: baseContract
      .route({ method: 'GET', path: '/fields', tags: t })
      .input(ws.extend({ includeArchived: z.boolean().default(false) }))
      .output(z.array(CustomFieldDef)),
    create: baseContract
      .route({ method: 'POST', path: '/fields', tags: t })
      .input(
        ws.extend({
          key: z.string().min(1).max(48),
          name: z.string().min(1).max(120),
          type: CustomFieldDef.shape.type,
          options: CustomFieldDef.shape.options.optional(),
          required: z.boolean().default(false),
          sensitive: z.boolean().default(false),
          section: CustomFieldDef.shape.section.default('profile'),
        }),
      )
      .output(CustomFieldDef),
    update: baseContract
      .route({ method: 'PATCH', path: '/fields/{fieldId}', tags: t })
      .input(
        ws.extend({
          fieldId: z.uuid(),
          name: z.string().min(1).max(120).optional(),
          options: CustomFieldDef.shape.options.optional(),
          required: z.boolean().optional(),
          sensitive: z.boolean().optional(),
          section: CustomFieldDef.shape.section.optional(),
          order: z.number().int().optional(),
        }),
      )
      .output(CustomFieldDef),
    archive: baseContract
      .route({ method: 'DELETE', path: '/fields/{fieldId}', tags: t })
      .input(ws.extend({ fieldId: z.uuid() }))
      .output(ok),
  },

  // ---------------------------------------------------------------- privacy
  /**
   * Subject access, erasure and retention. All four behind `hr.privacy.manage`, which is granted to
   * nobody by default and ships in the same change as these — see `privacy.ts` for why there is one
   * key rather than four, and why none of this is a capability.
   */
  // ---------------------------------------------------------------- reports
  /**
   * Four aggregates, and one rule that decides all four: **a report may not answer a question its
   * row-level procedure would refuse, and may not narrow below what that procedure already
   * returns.**
   *
   * So each of these costs `hr.report.view` *and* the key that already guards the rows it sums —
   * `hr.attendance.view_team`, which is what reading a whole office's day sheets costs on
   * `attendance.days.list`, or `hr.leave.view_team`, which is what reading somebody else's balance
   * costs on `leave.balance.get`. A reader holding neither gets nothing: not a one-row self-report,
   * because a reports menu that quietly collapses to your own attendance is a menu entry that lies
   * about what it is, and your own attendance is already the attendance page.
   *
   * The population is **not** intersected with `HrAccessService.visiblePersonIds`. That service
   * narrows *fields* rather than rows — it withholds `personalEmail`, `phone`, `hiredOn` and
   * `terminatedOn`, none of which any report reads — and intersecting on it would produce the worst
   * outcome available here: two managers reading different totals under the same title, with
   * nothing on the page to say so.
   */
  reports: {
    /**
     * Scheduled against worked, per person, over a range.
     *
     * Built from `attendance_days` and never from `punches`: punches are raw and append-only, a
     * voided punch survives beside its correction, and summing them double-counts every fix. The
     * day sheet is the projection those punches produce.
     */
    attendance: baseContract
      .route({ method: 'GET', path: '/reports/attendance', tags: t })
      .input(reportInput)
      .output(AttendanceSummaryReport),

    /**
     * Overtime, and how much of it an annual ceiling would not take.
     *
     * `beyondCapMinutes` is null where no ceiling was in force — summed as a nullable column rather
     * than coalesced, so "no ceiling applied to these days" and "a ceiling applied and nothing
     * passed it" stay different answers. No projection: there is no "at this rate you will pass the
     * ceiling in November", because that needs a policy that may not exist.
     */
    overtime: baseContract
      .route({ method: 'GET', path: '/reports/overtime', tags: t })
      .input(reportInput)
      .output(OvertimeReport),

    /**
     * Expected working days, minus days worked, minus approved leave.
     *
     * **Never `status = 'absent'`.** `attendance_days` has a row only where somebody punched — no
     * writer creates one for a day nobody clocked in on — so counting absent rows reports near-zero
     * absence everywhere and looks entirely healthy while doing it. The denominator comes from the
     * calendar instead, and a person the module cannot build one for lands in a named row rather
     * than being counted as present.
     *
     * Held to `MAX_SLICED_REPORT_DAYS` whether it is sliced or not: every person's expectation is
     * their office's calendar on each day, which is a ladder walk per day.
     */
    absence: baseContract
      .route({ method: 'GET', path: '/reports/absence', tags: t })
      .input(reportInput)
      .output(AbsenceReport),

    /**
     * Every balance in the population, per leave type, for one entitlement year.
     *
     * A balance is a position rather than a per-day quantity, so it is attributed as of one date —
     * `asOf`, defaulting to today — and the response says so. Summed from `leave_ledger`, never
     * from `leave_balance_cursor`: the cursor exists to be locked, and a cache that is also the
     * source of truth is one that eventually disagrees with it.
     */
    leaveBalance: baseContract
      .route({ method: 'GET', path: '/reports/leave-balance', tags: t })
      .input(
        ws.extend({
          /** Defaults to the year `asOf` falls in. */
          periodYear: z.number().int().min(1970).max(2200).optional(),
          /** Which day decides who is in the slice. Defaults to today. */
          asOf: IsoDate.optional(),
          by: ReportSliceBy.default('workspace'),
          sliceId: z.uuid().optional(),
          limit: z.number().int().min(1).max(1000).default(100),
        }),
      )
      .output(LeaveBalanceReport),
  },

  // ---------------------------------------------------------------- payroll export
  /**
   * The monthly handover to whoever runs payroll, per legal entity, frozen at v1.
   *
   * `exports.ts` carries the reasoning; three things about the *shape of the surface* belong here:
   *
   * **`legalEntityId` is required, and `periodId` is the range.** `reportInput` makes its slice
   * optional with a `workspace` default and takes free `from`/`to` dates; neither is available here.
   * A workspace is not an employer, and a half-month export is a question about a boundary this
   * module already has an answer for — letting a caller draw their own reintroduces the mixed-finality
   * problem `ReportFinality` exists to name.
   *
   * **`v1` is a procedure, not a parameter.** A later column set ships as `payroll.export.v2` beside
   * this one, with this one unchanged, and both live through at least one deprecation window. A
   * `?version=` on one mutable procedure would make the frozen path a branch inside a function three
   * people will edit, and freezing by intention has never worked.
   *
   * **Both cost three keys.** `hr.payroll.export`, which ships granted to nobody, plus
   * `hr.attendance.view_team` for the hours file and `hr.leave.view_team` for the leave file — the
   * same second-check rule the reports follow, because an export must not answer what the row-level
   * procedure would refuse.
   */
  payroll: {
    export: {
      /**
       * One entity, one period, two CSVs and a manifest.
       *
       * Refuses an open period unless `draft` is set, refuses an entity with nobody in it, and
       * refuses a person with no employment row covering their days here — because a row of zeros is
       * something a payroll clerk will pay from, and an error is not.
       */
      v1: baseContract
        .route({ method: 'GET', path: '/payroll/export/v1', tags: t })
        .input(
          ws.extend({
            /** Required. There is no workspace-wide export: a workspace is not an employer. */
            legalEntityId: z.uuid(),
            /** The range is the period's, never the caller's. */
            periodId: z.uuid(),
            /**
             * Export an open period anyway, and stamp the file as a draft.
             *
             * Not a permission — a statement the caller made, which the file then repeats in its
             * manifest, its filename and its `open_days`. Defaults to false: `reconcile-days` rebuilds
             * every day a period does not close, so the same export at 18:00 and at 09:00 the next
             * morning can differ with nobody having touched anything.
             */
            draft: z.boolean().default(false),
          }),
        )
        .output(PayrollExport),

      /**
       * The same rows as JSON, with no file written and no refusal thrown.
       *
       * So the screen shows the totals and the reasons the export would be refused before anybody
       * downloads anything. Deliberately not versioned: a preview is this module talking to its own
       * screen, and nothing outside Kern parses it.
       */
      preview: baseContract
        .route({ method: 'GET', path: '/payroll/export/preview', tags: t })
        .input(
          ws.extend({
            legalEntityId: z.uuid(),
            periodId: z.uuid(),
            draft: z.boolean().default(false),
          }),
        )
        .output(PayrollExportPreview),
    },
  },

  // ---------------------------------------------------------------- checklists
  /**
   * Onboarding and offboarding checklists, behind the `checklists` capability.
   *
   * Templates are workspace configuration and take `hr.checklist.manage`. Reading a checklist is
   * `hr.checklist.view`, which every member holds — but the handler narrows: without `manage`, a
   * reader sees the checklists about *themselves* and the ones with an item assigned to them, and
   * nothing else. Ticking an item is the assignee's or a manager's; the handler decides, because
   * "whose item is this" is a fact about the row and not about a key.
   */
  checklists: {
    templates: {
      list: baseContract
        .route({ method: 'GET', path: '/checklists/templates', tags: t })
        .input(ws.extend({ includeArchived: z.boolean().default(false) }))
        .output(z.array(ChecklistTemplate)),
      create: baseContract
        .route({ method: 'POST', path: '/checklists/templates', tags: t })
        .input(ws.extend(ChecklistTemplateInput.shape))
        .output(ChecklistTemplate),
      /**
       * Everything, items included. The item list is replaced whole and in the order given — a
       * template is a document somebody edits, not a set of rows somebody patches — and none of
       * it reaches a checklist already started.
       */
      update: baseContract
        .route({ method: 'PATCH', path: '/checklists/templates/{templateId}', tags: t })
        .input(ws.extend({ templateId: z.uuid(), ...ChecklistTemplateInput.partial().shape }))
        .output(ChecklistTemplate),
      archive: baseContract
        .route({ method: 'POST', path: '/checklists/templates/{templateId}/archive', tags: t })
        .input(ws.extend({ templateId: z.uuid(), archived: z.boolean().default(true) }))
        .output(ChecklistTemplate),
    },
    /**
     * Open and finished checklists, newest first, without their items.
     *
     * `mine` is the self-service view — about me, or with something for me to do — and is the
     * whole answer for a reader without `hr.checklist.manage` whatever else they asked for.
     */
    list: baseContract
      .route({ method: 'GET', path: '/checklists', tags: t })
      .input(
        ws.extend({
          personId: z.uuid().optional(),
          status: ChecklistStatus.optional(),
          kind: ChecklistKind.optional(),
          mine: z.boolean().default(false),
          limit: z.number().int().min(1).max(200).default(50),
        }),
      )
      .output(z.array(ChecklistSummary)),
    get: baseContract
      .route({ method: 'GET', path: '/checklists/{checklistId}', tags: t })
      .input(ws.extend({ checklistId: z.uuid() }))
      .output(Checklist),
    /**
     * Start one from a template, for a person, dated from an anchor.
     *
     * The anchor defaults to the person's hire date for onboarding and their leaving date for
     * offboarding, and to today when the record has neither. Assignees are resolved now, from
     * the employment in force today; the template's items are copied and never read again.
     */
    start: baseContract
      .route({ method: 'POST', path: '/checklists', tags: t })
      .input(ws.extend({ personId: z.uuid(), templateId: z.uuid(), anchorDate: IsoDate.optional() }))
      .output(Checklist),
    /** Nothing is deleted: the list stays, marked cancelled, with whatever was ticked. */
    cancel: baseContract
      .route({ method: 'POST', path: '/checklists/{checklistId}/cancel', tags: t })
      .input(ws.extend({ checklistId: z.uuid() }))
      .output(Checklist),
    items: {
      /** Tick it. The assignee, or anybody who may manage checklists; a note is optional. */
      complete: baseContract
        .route({ method: 'POST', path: '/checklists/items/{itemId}/complete', tags: t })
        .input(ws.extend({ itemId: z.uuid(), note: z.string().max(1000).nullish() }))
        .output(Checklist),
      reopen: baseContract
        .route({ method: 'POST', path: '/checklists/items/{itemId}/reopen', tags: t })
        .input(ws.extend({ itemId: z.uuid() }))
        .output(Checklist),
      /** Hand it to somebody, or back to the pool with `null`. The new assignee is told. */
      assign: baseContract
        .route({ method: 'POST', path: '/checklists/items/{itemId}/assign', tags: t })
        .input(ws.extend({ itemId: z.uuid(), assigneePersonId: z.uuid().nullable() }))
        .output(Checklist),
      /** A task that was never on the template — this joiner needs a parking permit. */
      add: baseContract
        .route({ method: 'POST', path: '/checklists/{checklistId}/items', tags: t })
        .input(ws.extend({ checklistId: z.uuid(), ...ChecklistItemInput.shape }))
        .output(Checklist),
      remove: baseContract
        .route({ method: 'DELETE', path: '/checklists/items/{itemId}', tags: t })
        .input(ws.extend({ itemId: z.uuid() }))
        .output(Checklist),
    },
  },

  // ---------------------------------------------------------------- privacy
  privacy: {
    /**
     * Everything HR holds about one person, in one response.
     *
     * `personId` is required and there is no filter: a workspace-wide export is two and a half
     * million rows with decrypted bank details in flight, and it is not offered.
     *
     * The decrypt makes this a bulk read of the sensitive record, so it writes a
     * `sensitive_access_log` row with `via: 'export'` in the same transaction.
     */
    subjectAccess: baseContract
      .route({ method: 'GET', path: '/people/{personId}/privacy/subject-access', tags: t })
      .input(
        ws.extend({
          personId: z.uuid(),
          /** Recorded on the access-log row and shown to the subject in their own bundle. */
          purpose: z.string().max(500).nullish(),
        }),
      )
      .output(SubjectAccessBundle),

    /**
     * Redact a person, and say what survived.
     *
     * **`dryRun` defaults to true**, which is the opposite of every other write in this module and
     * deliberate. This is the one irreversible act HR offers, so a caller that forgets the flag has
     * to get the preview rather than the erasure. It matters more than it reads: core generates an
     * MCP tool from every hosted module's OpenAPI document, so a procedure with a REST route is
     * agent-callable the day it ships, and the call made with no arguments has to be the harmless
     * one. The preview runs the same predicates the run does and returns the same shape.
     *
     * Nothing is deleted. The identifying columns are cleared and every record a wage, an
     * entitlement or an authorisation was computed from stays, listed in `kept` with the basis it
     * survived under. Running it twice is safe and reports zero rows the second time: each step
     * matches only rows that still have something to clear.
     */
    erase: baseContract
      .route({ method: 'POST', path: '/people/{personId}/privacy/erase', tags: t })
      .input(
        ws.extend({
          personId: z.uuid(),
          dryRun: z.boolean().default(true),
          /** Recorded on the person row. The only place this reason is kept. */
          reason: z.string().max(500).nullish(),
          /**
           * Keep the national identity number.
           *
           * The one decision in here that is not the module's to make. A Turkish payroll audit may
           * want it; a GDPR erasure request wants it gone first. The default clears it, the response
           * says which was done, and `caveats` carries `nationalIdKeptForAudit` when it did not.
           */
          keepNationalIdForAudit: z.boolean().default(false),
        }),
      )
      .output(ErasureReport),

    /**
     * Who read somebody's identity, birth date or bank details.
     *
     * **About yourself this carries no permission**, which is why it has no `requires()` and sits in
     * `module.test.ts`'s `SELF_SERVICE` allowlist. Reading your own access log is a thing nobody may
     * lack, exactly like `people.me`; a grantable key here could only ever be one somebody could be
     * denied, and being denied sight of who has been looking at your bank details is not a state
     * this product should be able to express.
     *
     * About anybody else it needs `hr.privacy.manage`, and the handler is what asks — a `personId`
     * that is not the caller's own, or an `actorUserId` at all. The second is not a smaller question
     * than the first: "what has this account been looking at" is an investigation into a colleague,
     * and it is the query that makes this log something to be careful with rather than only
     * something to be reassured by.
     */
    accessLog: {
      list: baseContract
        .route({ method: 'GET', path: '/privacy/access-log', tags: t })
        .input(
          ws.extend({
            ...PageInput.shape,
            /** Whose record. Defaults to the caller's own, which is the self-service case. */
            personId: z.uuid().optional(),
            /** Whose reading. Always an investigation, so always `hr.privacy.manage`. */
            actorUserId: z.uuid().optional(),
          }),
        )
        .output(page(SensitiveAccess)),
    },

    retention: {
      /**
       * The horizons, and — with `withCounts` — how much is already past each one.
       *
       * The counts are the dry run. They cost a query per class that has a horizon set, so they are
       * asked for rather than always computed; a retention screen should ask for them.
       */
      get: baseContract
        .route({ method: 'GET', path: '/privacy/retention', tags: t })
        .input(ws.extend({ withCounts: z.boolean().default(false) }))
        .output(RetentionSettings),
      /**
       * Set them. A field left out is unchanged; a field sent as `null` goes back to "keep
       * indefinitely", which is what every class ships as. `sweepEnabled` left out is unchanged
       * too — a screen saving horizons must not switch the sweep on or off behind somebody's back.
       */
      set: baseContract
        .route({ method: 'PUT', path: '/privacy/retention', tags: t })
        .input(ws.extend({ retention: RetentionPatch.default({}), sweepEnabled: z.boolean().optional() }))
        .output(RetentionSettings),

      /**
       * Sweep now, or say what a sweep would do.
       *
       * **`dryRun` defaults to true**, for the reason `privacy.erase` gives: this is agent-callable
       * the day it ships, and the call made with no arguments has to be the harmless one. A dry run
       * writes nothing but its own record. The act is one transaction per workspace — every class
       * commits or none does — and it is recorded either way, with what each class matched, what
       * was affected and what sat in a locked period and was left alone. Nothing runs for a class
       * with no horizon. The nightly job calls the same code with the same flag off.
       */
      run: baseContract
        .route({ method: 'POST', path: '/privacy/retention/run', tags: t })
        .input(ws.extend({ dryRun: z.boolean().default(true) }))
        .output(RetentionRun),

      runs: {
        /** Every sweep this workspace has run, newest first. Dry runs and failures included. */
        list: baseContract
          .route({ method: 'GET', path: '/privacy/retention/runs', tags: t })
          .input(ws.extend({ limit: z.number().int().min(1).max(200).default(50) }))
          .output(z.array(RetentionRun)),
      },
    },
  },
}
export type HrContract = typeof hrContract
