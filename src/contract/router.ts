import { baseContract, PageInput, page, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
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
  WorkingWeek,
} from './models.js'

const ws = z.object({ workspaceId: WorkspaceId })
const t = ['hr'] as const
const ok = z.object({ ok: z.literal(true) })

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
      .output(page(Person)),
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
}
export type HrContract = typeof hrContract
