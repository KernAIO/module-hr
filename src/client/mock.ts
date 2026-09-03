/**
 * The in-memory HR API.
 *
 * A module missing from the mock has working pages and no way to reach them in exactly the
 * environment used for demos and end-to-end tests — so this exists to be *reachable*, not to be a
 * second implementation. It answers the shapes the screens ask for, with data a demo can show.
 *
 * The state below is mutable and every write lands in it. A create that never appears in the next
 * list looks like a broken product rather than a missing backend, and it is the kind of broken
 * nobody can describe well enough to report — so an archive leaves the default list, an update
 * merges, and a suppressed pack day stays suppressed until somebody restores it.
 *
 * Types come from the contract rather than being retyped here. A mock that answers a shape core
 * does not is how a screen works in `dev:mock` and breaks against the real API.
 */
import { ORPCError } from '@orpc/contract'
import type { ApprovalChain, ApprovalChainSpec } from '../contract/approvals.js'
import type { Punch, Regularization, Schedule, ScheduleAssignment } from '../contract/attendance.js'
import {
  PAYROLL_EXPORT_CONTRACT,
  PAYROLL_HOURS_COLUMNS,
  PAYROLL_LEAVE_COLUMNS,
  type PayrollExport,
  type PayrollExportManifest,
  type PayrollExportPreview,
  type PayrollExportRefusal,
  type PayrollHoursRow,
  type PayrollLeaveRow,
} from '../contract/exports.js'
import type { LeaveLedgerEntry, LeaveType } from '../contract/leave.js'
import type {
  Calendar,
  CalendarDay,
  CalendarDayKind,
  CostCenter,
  CustomFieldDef,
  Employment,
  LegalEntity,
  Office,
  OfficeAssignment,
  OrgUnit,
  PersonDocument,
  PersonSensitive,
  Position,
  ResolvedCalendarDay,
  WorkingWeek,
} from '../contract/models.js'
import type { Period, Policy, PolicyAssignment, PolicySubjectKind } from '../contract/policies.js'
import type {
  ErasureCaveat,
  ErasureRedaction,
  ErasureRetained,
  RetentionClass,
  SensitiveAccess,
} from '../contract/privacy.js'
import {
  type AbsenceRow,
  MAX_PERSON_DAYS,
  MAX_REPORT_DAYS,
  MAX_SLICED_REPORT_DAYS,
  type ReportFinality,
  type ReportSliceBy,
} from '../contract/reports.js'
import {
  MAX_COVERAGE_DAYS,
  MAX_ROSTER_DAYS,
  type RosterAssignment,
  type RosterDaySource,
  type RosterPattern,
  type RosterShift,
} from '../contract/rosters.js'

/**
 * A refusal the client cannot tell from the server's.
 *
 * `kernErrorToORPC` turns every `KernError` the router throws into exactly this — same code, same
 * status, same sentence — and the oRPC link hands the browser one back. A bare `Error` would carry
 * the message and *not* the code, so a screen branching on `CONFLICT` takes one path against the
 * mock and another against core, which is the difference the mock exists to erase.
 *
 * Every sentence below is copied from `src/server/router.ts`, because the widget renders the
 * server's own words rather than a translated string.
 */
function refuse(
  code: 'CONFLICT' | 'NOT_FOUND' | 'BAD_REQUEST' | 'FORBIDDEN',
  message: string,
  reason?: string,
): never {
  // A declaration, not a `const` arrow: TypeScript only narrows on a `never` return for one of
  // those, so an arrow would leave every caller believing the row after the guard is still optional.
  //
  // `reason` lands in `data`, which is where `kernErrorToORPC` puts it — and it is passed *only*
  // where the router passes one. A mock that invented a reason the server does not send would be
  // the same bug as a mock that dropped one it does, pointing the other way: the client's lookup
  // would fire in `dev:mock` and never in production.
  throw new ORPCError(code, { message, data: reason ? { reason } : undefined })
}

/** Stored without the tenant, which every call stamps back on. */
type Row<T> = Omit<T, 'workspaceId'>

/**
 * A composed day, tenant included.
 *
 * `WorkspaceId` is a branded string in the contract and a plain one everywhere a mock is handed it,
 * so the brand is dropped here rather than asserted at twenty call sites.
 */
type ResolvedDay = Row<ResolvedCalendarDay> & { workspaceId: string }

/**
 * A deep copy through JSON, which is what the real client does to the same value on its way out.
 *
 * A screen hands these procedures a `$state` proxy — `structuredClone` refuses to clone one, and
 * keeping the proxy would let a later edit in the dialog rewrite a schedule nobody saved.
 */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const now = Date.now()
const iso = (msAgo = 0) => new Date(now - msAgo).toISOString()
const day = (offset: number) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10)

/** Stable ids, so reloading a demo does not move every link in it. The suffix stays hexadecimal. */
const id = (suffix: string) => `01920000-0000-7000-8000-${suffix.padStart(12, '0')}`

/**
 * The seed year.
 *
 * A holiday list is read a year at a time and the calendar screen opens on the current one, so
 * seeding a fixed year would hand every demo after it an empty page.
 */
const YEAR = new Date(now).getFullYear()
const onDay = (monthDay: string) => `${YEAR}-${monthDay}`

const CAL_TR = id('ca01')
const CAL_NL = id('ca02')

const DEFAULT_WEEK: WorkingWeek = { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 }

/** `getUTCDay()` counts from Sunday; the working week is named. */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** Every date in an inclusive range. Stepped in UTC, so a daylight-saving hour cannot skip a day. */
function eachDate(from: string, to: string): string[] {
  const out: string[] = []
  const last = Date.parse(`${to}T00:00:00Z`)
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= last; at += 86_400_000) {
    out.push(new Date(at).toISOString().slice(0, 10))
  }
  return out
}

type PackDay = { monthDay: string; name: string; kind: CalendarDayKind; workingFraction: number }

/**
 * The country packs, behaving the way a pack does: a version, and a set of days per year.
 *
 * The Türkiye calendar is seeded from an *older* version of `tr` — a renamed day, a dropped one and
 * two it never had — because a `pack.preview` that returns nothing proves nothing about the dialog
 * it feeds, and the promise that dialog makes is that an upgrade cannot eat a company's own days.
 */
const PACKS: Record<string, { name: string; days: PackDay[] }> = {
  // Keyed by the uppercase ISO code, and looked up exactly, because `COUNTRY_PACKS` on the server
  // is. A tolerant mock here would hide the fact that a lowercase key finds nothing there.
  TR: {
    name: 'Türkiye',
    days: [
      { monthDay: '01-01', name: "New Year's Day", kind: 'public_holiday', workingFraction: 0 },
      { monthDay: '03-19', name: 'Ramazan Bayramı Arifesi', kind: 'half_day', workingFraction: 0.5 },
      { monthDay: '03-20', name: 'Ramazan Bayramı', kind: 'religious', workingFraction: 0 },
      {
        monthDay: '04-23',
        name: "National Sovereignty and Children's Day",
        kind: 'public_holiday',
        workingFraction: 0,
      },
      { monthDay: '05-01', name: 'Labour and Solidarity Day', kind: 'public_holiday', workingFraction: 0 },
      {
        monthDay: '05-19',
        name: 'Commemoration of Atatürk, Youth and Sports Day',
        kind: 'public_holiday',
        workingFraction: 0,
      },
      { monthDay: '05-27', name: 'Kurban Bayramı', kind: 'religious', workingFraction: 0 },
      {
        monthDay: '07-15',
        name: 'Democracy and National Unity Day',
        kind: 'public_holiday',
        workingFraction: 0,
      },
      { monthDay: '08-30', name: 'Victory Day', kind: 'public_holiday', workingFraction: 0 },
      { monthDay: '10-29', name: 'Republic Day', kind: 'public_holiday', workingFraction: 0 },
    ],
  },
  NL: {
    name: 'Nederland',
    days: [
      { monthDay: '01-01', name: 'Nieuwjaarsdag', kind: 'public_holiday', workingFraction: 0 },
      { monthDay: '04-27', name: 'Koningsdag', kind: 'public_holiday', workingFraction: 0 },
      { monthDay: '05-05', name: 'Bevrijdingsdag', kind: 'public_holiday', workingFraction: 0 },
      { monthDay: '12-25', name: 'Eerste Kerstdag', kind: 'public_holiday', workingFraction: 0 },
      { monthDay: '12-26', name: 'Tweede Kerstdag', kind: 'public_holiday', workingFraction: 0 },
    ],
  },
}

export function createMockHrApi() {
  /** Clock state lives here so the widget behaves across clicks in a demo. */
  let clockedInAt: number | null = null
  let onBreak = false

  // ---------------------------------------------------------------- offices and people

  const offices: Row<Office>[] = [
    {
      id: id('e001'),
      name: 'Istanbul',
      code: 'IST',
      kind: 'head_office',
      parentOfficeId: null,
      legalEntityId: id('1e01'),
      country: 'TR',
      region: '34',
      city: 'Istanbul',
      timezone: 'Europe/Istanbul',
      calendarId: CAL_TR,
      address: { line1: 'Büyükdere Caddesi 1', postalCode: '34394' },
      isDefault: true,
      headPersonId: null,
      archivedAt: null,
      createdAt: iso(400 * 86_400_000),
    },
    {
      id: id('e002'),
      name: 'Amsterdam',
      code: 'AMS',
      kind: 'branch',
      parentOfficeId: null,
      legalEntityId: id('1e02'),
      country: 'NL',
      region: 'NH',
      city: 'Amsterdam',
      timezone: 'Europe/Amsterdam',
      calendarId: CAL_NL,
      address: { line1: 'Keizersgracht 12', postalCode: '1015 CS' },
      isDefault: false,
      headPersonId: null,
      archivedAt: null,
      createdAt: iso(200 * 86_400_000),
    },
    // A third kind on screen, and the one people forget exists: remote is a place like any other,
    // with a country, a zone and a calendar, because everything downstream inherits from an office.
    {
      id: id('e003'),
      name: 'Remote',
      code: null,
      kind: 'remote',
      parentOfficeId: null,
      legalEntityId: id('1e01'),
      country: 'DE',
      region: null,
      city: null,
      timezone: 'Europe/Berlin',
      calendarId: CAL_TR,
      address: null,
      isDefault: false,
      headPersonId: null,
      archivedAt: null,
      createdAt: iso(90 * 86_400_000),
    },
  ]

  const entities: Row<LegalEntity>[] = [
    {
      id: id('1e01'),
      name: 'Kern Teknoloji A.Ş.',
      registrationNo: '123456-5',
      taxNo: '4560123456',
      country: 'TR',
      currency: 'TRY',
      archivedAt: null,
    },
    {
      id: id('1e02'),
      name: 'Kern Europe B.V.',
      registrationNo: '81234567',
      taxNo: 'NL812345678B01',
      country: 'NL',
      currency: 'EUR',
      archivedAt: null,
    },
  ]

  /**
   * Three cost centres, attached three different ways.
   *
   * All three attachments are optional in the contract, and a demo where every row names all of
   * them would hide that — so one is a department inside the Turkish employer, one is a department
   * with no office of its own, and one is a whole office. The org unit ids are the ones `seedUnit`
   * uses further down; `id()` is a pure function, so naming them here is safe.
   */
  const costCenters: Row<CostCenter>[] = [
    {
      id: id('0c01'),
      code: 'CC-ENG',
      name: 'Engineering',
      officeId: id('e001'),
      orgUnitId: id('0a02'),
      legalEntityId: id('1e01'),
      archivedAt: null,
    },
    {
      id: id('0c02'),
      code: 'CC-PC',
      name: 'People & Culture',
      officeId: null,
      orgUnitId: id('0a06'),
      legalEntityId: id('1e01'),
      archivedAt: null,
    },
    {
      id: id('0c03'),
      code: 'CC-AMS',
      name: 'Amsterdam',
      officeId: id('e002'),
      orgUnitId: null,
      legalEntityId: id('1e02'),
      archivedAt: null,
    },
  ]

  const people = [
    {
      id: id('d001'),
      displayName: 'Ayşe Yılmaz',
      hiredOn: day(-400),
      workEmail: 'ayse@example.test',
      status: 'active',
      timezone: 'Europe/Istanbul',
      employeeNo: 'E-1',
    },
    {
      id: id('d002'),
      displayName: 'Sanne de Vries',
      hiredOn: day(-300),
      workEmail: 'sanne@example.test',
      status: 'active',
      timezone: 'Europe/Amsterdam',
      employeeNo: 'E-2',
    },
    {
      id: id('d003'),
      displayName: 'Mehmet Kaya',
      hiredOn: day(-2000),
      workEmail: 'mehmet@example.test',
      status: 'on_leave',
      timezone: 'Europe/Istanbul',
      employeeNo: 'E-3',
    },
    {
      id: id('d004'),
      displayName: 'Jonas Weber',
      hiredOn: day(-80),
      workEmail: 'jonas@example.test',
      status: 'active',
      timezone: 'Europe/Berlin',
      employeeNo: 'E-4',
    },
    // Assigned to Amsterdam and employed by nobody yet: the state the payroll export refuses with
    // `hr.payroll.no_employment`, which is unreachable in a demo where every person has a row.
    {
      id: id('d005'),
      displayName: 'Leyla Demir',
      hiredOn: day(-40),
      workEmail: 'leyla@example.test',
      status: 'active',
      timezone: 'Europe/Amsterdam',
      employeeNo: null,
    },
  ]

  // ---------------------------------------------------------------- custom fields

  /**
   * Three definitions, one of each thing the screens have to handle: a select with options, a
   * plain text field in a second section, and a sensitive one — which the real server strips
   * from `people.custom` for a reader without `hr.person.view_sensitive`, and which the panel
   * therefore draws only inside the disclosed section.
   */
  const fieldDefs: Row<CustomFieldDef>[] = [
    {
      id: id('f001'),
      key: 't_shirt_size',
      name: 'T-shirt size',
      type: 'select',
      options: [
        { value: 's', label: 'S' },
        { value: 'm', label: 'M' },
        { value: 'l', label: 'L' },
        { value: 'xl', label: 'XL' },
      ],
      required: false,
      sensitive: false,
      section: 'profile',
      order: 0,
      archivedAt: null,
    },
    {
      id: id('f002'),
      key: 'desk',
      name: 'Desk',
      type: 'text',
      options: null,
      required: false,
      sensitive: false,
      section: 'employment',
      order: 0,
      archivedAt: null,
    },
    {
      id: id('f003'),
      key: 'passport_no',
      name: 'Passport number',
      type: 'text',
      options: null,
      required: false,
      sensitive: true,
      section: 'other',
      order: 0,
      archivedAt: null,
    },
  ]

  /** `people.custom`, by person. Replaced whole on `people.update`, the way the server does it. */
  const customValues: Record<string, Record<string, unknown>> = {
    [people[0]!.id]: { t_shirt_size: 'm', desk: 'IST-3-14', passport_no: 'U12345678' },
    [people[1]!.id]: { t_shirt_size: 's', desk: 'AMS-1-02' },
  }

  /**
   * Who works where, with exactly one primary each.
   *
   * Sanne holds two: only the primary decides her holidays and her timezone, and the second is
   * presence — she is in Istanbul's roster and nothing about her leave changed. That distinction is
   * the whole reason the roster labels every row, so the seed has to contain a row to label.
   */
  const assignments: Row<OfficeAssignment>[] = [
    {
      id: id('a5001'),
      personId: id('d001'),
      officeId: id('e001'),
      isPrimary: true,
      effectiveFrom: day(-400),
      effectiveTo: null,
      reason: null,
      createdAt: iso(400 * 86_400_000),
    },
    {
      id: id('a5002'),
      personId: id('d002'),
      officeId: id('e002'),
      isPrimary: true,
      effectiveFrom: day(-300),
      effectiveTo: null,
      reason: null,
      createdAt: iso(300 * 86_400_000),
    },
    {
      id: id('a5003'),
      personId: id('d002'),
      officeId: id('e001'),
      isPrimary: false,
      effectiveFrom: day(-120),
      effectiveTo: null,
      reason: 'Two days a week with the platform team',
      createdAt: iso(120 * 86_400_000),
    },
    {
      id: id('a5004'),
      personId: id('d003'),
      officeId: id('e001'),
      isPrimary: true,
      effectiveFrom: day(-250),
      effectiveTo: null,
      reason: null,
      createdAt: iso(250 * 86_400_000),
    },
    {
      id: id('a5005'),
      personId: id('d004'),
      officeId: id('e003'),
      isPrimary: true,
      effectiveFrom: day(-80),
      effectiveTo: null,
      reason: null,
      createdAt: iso(80 * 86_400_000),
    },
    {
      id: id('a5006'),
      personId: id('d005'),
      officeId: id('e002'),
      isPrimary: true,
      effectiveFrom: day(-40),
      effectiveTo: null,
      reason: null,
      createdAt: iso(40 * 86_400_000),
    },
  ]

  const activeAssignments = (personId: string) =>
    assignments.filter((a) => a.personId === personId && a.effectiveTo === null)
  const primaryOfficeId = (personId: string): string | null =>
    activeAssignments(personId).find((a) => a.isPrimary)?.officeId ?? null
  const officeName = (officeId: string | null) => offices.find((o) => o.id === officeId)?.name ?? null
  const liveOffices = () => offices.filter((o) => o.archivedAt === null)
  /**
   * Primary assignments only.
   *
   * Somebody can hold several offices, so counting presence would make the headcounts sum to more
   * people than the company has — and the offices screen adds them up into a "People" tile. The
   * roster is the other half of the same decision: it lists everyone and labels which kind each
   * row is, because presence is worth seeing and is not worth counting.
   */
  const headcount = (officeId: string) =>
    assignments.filter((a) => a.officeId === officeId && a.effectiveTo === null && a.isPrimary).length

  /**
   * Who has been erased, and when. Kept beside the rows rather than on them: erasure is redaction,
   * so the row survives with a token for a name, and the date is what tells a screen it is one.
   */
  const erasedPeople = new Map<string, string>()

  const person = (p: (typeof people)[number], workspaceId: string) => ({
    ...p,
    workspaceId,
    userId: null,
    personalEmail: null,
    phone: null,
    photoFileId: null,
    terminatedOn: null,
    custom: clone(customValues[p.id] ?? {}),
    erasedAt: erasedPeople.get(p.id) ?? null,
    createdAt: iso(400 * 86_400_000),
    updatedAt: iso(),
  })

  // ---------------------------------------------------------------- the org chart

  /**
   * An ltree label: `u` and the id with its dashes removed.
   *
   * The prefix is not decoration — an ltree label cannot start with a digit, and every id here
   * does.
   */
  const unitLabel = (unitId: string) => `u${unitId.replaceAll('-', '')}`

  const orgUnits: Row<OrgUnit>[] = []
  const pathFor = (parentId: string | null, unitId: string): string => {
    const parent = parentId ? orgUnits.find((u) => u.id === parentId) : undefined
    return parent ? `${parent.path}.${unitLabel(unitId)}` : unitLabel(unitId)
  }
  const seedUnit = (
    unitId: string,
    parentId: string | null,
    name: string,
    code: string | null = null,
    headPersonId: string | null = null,
  ) => {
    orgUnits.push({
      id: unitId,
      parentId,
      path: pathFor(parentId, unitId),
      name,
      code,
      headPersonId,
      archivedAt: null,
    })
  }

  // Parent before child, because a path is built from the one above it. Four levels deep so the
  // tree rails and the depth figure have something to draw, and Operations is left empty and
  // childless so archiving a department is reachable at all.
  seedUnit(id('0a01'), null, 'Northstar', 'NS', people[0]!.id)
  seedUnit(id('0a02'), id('0a01'), 'Engineering', 'ENG', people[0]!.id)
  seedUnit(id('0a03'), id('0a02'), 'Platform', 'PLT', people[1]!.id)
  seedUnit(id('0a04'), id('0a03'), 'Infrastructure')
  seedUnit(id('0a05'), id('0a02'), 'Product Engineering')
  seedUnit(id('0a06'), id('0a01'), 'People & Culture', 'PC', people[1]!.id)
  seedUnit(id('0a07'), id('0a01'), 'Operations')

  const positions: Row<Position>[] = [
    {
      id: id('05a1'),
      title: 'Software Engineer',
      code: 'SE',
      jobFamily: 'Engineering',
      level: 'L3',
      archivedAt: null,
    },
    {
      id: id('05a2'),
      title: 'Senior Software Engineer',
      code: 'SSE',
      jobFamily: 'Engineering',
      level: 'L4',
      archivedAt: null,
    },
    {
      id: id('05a3'),
      title: 'Engineering Manager',
      code: 'EM',
      jobFamily: 'Engineering',
      level: 'M1',
      archivedAt: null,
    },
    // A mix on purpose: not every position is levelled, and plenty carry no code at all.
    {
      id: id('05a4'),
      title: 'People Partner',
      code: null,
      jobFamily: 'People',
      level: null,
      archivedAt: null,
    },
    { id: id('05a5'), title: 'Office Manager', code: 'OM', jobFamily: null, level: null, archivedAt: null },
  ]

  /**
   * Who holds which job, effective-dated.
   *
   * The org tree's headcount is a count of *these* — one row per person whose `effectiveTo` is
   * still null — rather than a number stated beside the department. That is what makes archiving a
   * department refuse for a reason somebody can act on, and it is why moving a person changes two
   * screens at once.
   */
  const employments: Row<Employment>[] = [
    // Ayşe was promoted, so her history has two rows and the current one is not the first. A single
    // open row per person makes `employment.history` a list of one and proves nothing about the
    // effective-dated shape it exists to show.
    {
      id: id('eb05'),
      personId: people[0]!.id,
      effectiveFrom: day(-400),
      effectiveTo: day(-201),
      orgUnitId: id('0a02'),
      positionId: id('05a1'),
      legalEntityId: id('1e01'),
      costCenterId: null,
      managerPersonId: null,
      employmentType: 'full_time',
      fte: 1,
      contractHoursWeek: 40,
      reason: null,
      createdAt: iso(400 * 86_400_000),
    },
    {
      id: id('eb01'),
      personId: people[0]!.id,
      effectiveFrom: day(-200),
      effectiveTo: null,
      orgUnitId: id('0a02'),
      positionId: id('05a3'),
      legalEntityId: id('1e01'),
      costCenterId: null,
      managerPersonId: null,
      employmentType: 'full_time',
      fte: 1,
      contractHoursWeek: 40,
      reason: 'Promoted to Engineering Manager',
      createdAt: iso(200 * 86_400_000),
    },
    {
      id: id('eb02'),
      personId: people[1]!.id,
      effectiveFrom: day(-300),
      effectiveTo: null,
      orgUnitId: id('0a03'),
      positionId: id('05a2'),
      legalEntityId: id('1e02'),
      costCenterId: null,
      managerPersonId: people[0]!.id,
      employmentType: 'full_time',
      fte: 1,
      contractHoursWeek: 40,
      reason: null,
      createdAt: iso(300 * 86_400_000),
    },
    {
      id: id('eb03'),
      personId: people[2]!.id,
      effectiveFrom: day(-250),
      effectiveTo: null,
      orgUnitId: id('0a02'),
      positionId: id('05a1'),
      legalEntityId: id('1e01'),
      costCenterId: null,
      managerPersonId: people[0]!.id,
      employmentType: 'full_time',
      fte: 1,
      contractHoursWeek: 40,
      reason: null,
      createdAt: iso(250 * 86_400_000),
    },
    {
      id: id('eb04'),
      personId: people[3]!.id,
      effectiveFrom: day(-80),
      effectiveTo: null,
      orgUnitId: id('0a06'),
      positionId: id('05a4'),
      legalEntityId: id('1e01'),
      costCenterId: null,
      managerPersonId: people[0]!.id,
      employmentType: 'part_time',
      fte: 0.8,
      contractHoursWeek: 32,
      reason: null,
      createdAt: iso(80 * 86_400_000),
    },
  ]

  /** Direct only. The tree sums the subtree itself, so a subtree total here double-counts. */
  const unitHeadcount = (unitId: string) =>
    employments.filter((e) => e.orgUnitId === unitId && e.effectiveTo === null).length

  const descendants = (unitId: string) => {
    const root = orgUnits.find((u) => u.id === unitId)
    if (!root) return []
    return orgUnits.filter((u) => u.path === root.path || u.path.startsWith(`${root.path}.`))
  }

  // ---------------------------------------------------------------- calendars

  const calendars: Row<Calendar>[] = [
    {
      id: CAL_TR,
      name: 'Türkiye',
      extendsId: null,
      country: 'TR',
      region: null,
      workingWeek: { ...DEFAULT_WEEK },
      source: 'pack',
      packKey: 'TR',
      packVersion: String(YEAR),
      archivedAt: null,
    },
    {
      id: CAL_NL,
      name: 'Amsterdam',
      extendsId: CAL_TR,
      country: 'NL',
      region: null,
      workingWeek: { ...DEFAULT_WEEK },
      source: 'custom',
      packKey: null,
      packVersion: null,
      archivedAt: null,
    },
  ]

  let dayCounter = 0
  const nextDayId = () => id(`da${(++dayCounter).toString(16).padStart(4, '0')}`)

  const calDay = (
    calendarId: string,
    monthDay: string,
    name: string,
    kind: CalendarDayKind,
    workingFraction: number,
    source: 'pack' | 'custom',
    note: string | null = null,
  ): Row<CalendarDay> => ({
    id: nextDayId(),
    calendarId,
    date: onDay(monthDay),
    kind,
    name,
    workingFraction,
    source,
    paid: true,
    note,
  })

  /**
   * The raw rows, per calendar. Composition happens on read, exactly as the server does it.
   *
   * The Türkiye rows below are version 1.0 of the `tr` pack: `Labour Day` was renamed in 2.0,
   * `Atatürk Memorial Day` was dropped from it, and two days it now carries are missing here.
   */
  const calendarDays: Row<CalendarDay>[] = [
    calDay(CAL_TR, '01-01', "New Year's Day", 'public_holiday', 0, 'pack'),
    calDay(CAL_TR, '03-19', 'Ramazan Bayramı Arifesi', 'half_day', 0.5, 'pack'),
    calDay(CAL_TR, '04-23', "National Sovereignty and Children's Day", 'public_holiday', 0, 'pack'),
    calDay(CAL_TR, '05-01', 'Labour Day', 'public_holiday', 0, 'pack'),
    calDay(CAL_TR, '05-19', 'Commemoration of Atatürk, Youth and Sports Day', 'public_holiday', 0, 'pack'),
    calDay(CAL_TR, '05-27', 'Kurban Bayramı', 'religious', 0, 'pack'),
    calDay(CAL_TR, '08-30', 'Victory Day', 'public_holiday', 0, 'pack'),
    calDay(CAL_TR, '10-29', 'Republic Day', 'public_holiday', 0, 'pack'),
    calDay(CAL_TR, '11-10', 'Atatürk Memorial Day', 'public_holiday', 0, 'pack'),

    // The pack gives half of the eve; this company closes the whole day. A custom row over a pack
    // row, which is what the list draws as "changed".
    calDay(
      CAL_TR,
      '03-19',
      'Ramazan Bayramı Arifesi',
      'company_closure',
      0,
      'custom',
      'Full day, not the half the pack gives',
    ),
    // The state the screen exists to make visible: a pack day this company works through. The pack
    // row is still underneath it and survives the next upgrade.
    calDay(
      CAL_TR,
      '05-19',
      'Commemoration of Atatürk, Youth and Sports Day',
      'working_override',
      1,
      'custom',
      'Deadline week',
    ),
    calDay(CAL_TR, '07-20', 'Summer shutdown', 'company_closure', 0, 'custom'),
    // 29 October is a Thursday in the seeded year, so this really is the bridge the kind is named for.
    calDay(CAL_TR, '10-30', 'Republic Day bridge', 'bridge', 0, 'custom'),
    calDay(CAL_TR, '12-31', "New Year's Eve", 'half_day', 0.5, 'custom'),
    calDay(CAL_TR, '09-05', 'Stock count', 'working_override', 1, 'custom', 'A worked Saturday'),

    calDay(CAL_NL, '04-27', 'Koningsdag', 'public_holiday', 0, 'custom'),
    calDay(CAL_NL, '05-05', 'Bevrijdingsdag', 'public_holiday', 0, 'custom'),
    calDay(CAL_NL, '12-25', 'Eerste Kerstdag', 'public_holiday', 0, 'custom'),
    calDay(CAL_NL, '12-26', 'Tweede Kerstdag', 'public_holiday', 0, 'custom'),
    // Amsterdam works through two of the days it inherits from Türkiye: one masked outright, one
    // kept as a half day. Both are the branch's own rows sitting over the base's.
    calDay(CAL_NL, '04-23', "National Sovereignty and Children's Day", 'working_override', 1, 'custom'),
    calDay(CAL_NL, '05-01', 'Labour Day (afternoon off)', 'half_day', 0.5, 'custom'),
  ]

  /** Furthest ancestor first, so the nearer calendar's rows land on top of it. */
  function chainOf(calendarId: string): Row<Calendar>[] {
    const chain: Row<Calendar>[] = []
    const seen = new Set<string>()
    let cursor = calendars.find((c) => c.id === calendarId)
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      chain.unshift(cursor)
      const parent: string | null = cursor.extendsId
      cursor = parent ? calendars.find((c) => c.id === parent) : undefined
    }
    return chain
  }

  /**
   * The composed calendar, by date.
   *
   * Nearest calendar wins, and within one calendar a `custom` row wins over a `pack` row on the
   * same date — which is how removing a pack day suppresses it instead of deleting something the
   * next upgrade would only bring back.
   */
  function composeDays(calendarId: string, workspaceId: string): Map<string, ResolvedDay> {
    const byDate = new Map<string, ResolvedDay>()
    for (const cal of chainOf(calendarId)) {
      for (const source of ['pack', 'custom'] as const) {
        for (const row of calendarDays.filter((r) => r.calendarId === cal.id && r.source === source)) {
          byDate.set(row.date, {
            ...row,
            workspaceId,
            fromCalendarId: cal.id,
            fromCalendarName: cal.name,
            overrides: byDate.has(row.date),
          })
        }
      }
    }
    return byDate
  }

  const resolveDay = (calendarId: string, workspaceId: string, date: string): ResolvedDay => {
    const found = composeDays(calendarId, workspaceId).get(date)
    if (!found) refuse('NOT_FOUND', 'Calendar day not found')
    return found
  }

  // ---------------------------------------------------------------- leave, schedules

  const leaveTypes: Row<LeaveType>[] = [
    {
      id: id('b001'),
      key: 'annual',
      name: 'Annual leave',
      paid: true,
      unit: 'day',
      color: '#4c8bf5',
      icon: 'tree-palm',
      requiresDocumentAfterDays: null,
      countsWorkingDaysOnly: true,
      allowNegative: true,
      maxNegativeMinutes: 5 * 480,
      order: 0,
      archivedAt: null,
    },
    {
      id: id('b002'),
      key: 'sick',
      name: 'Sick leave',
      paid: true,
      unit: 'day',
      color: '#dd5a5a',
      icon: 'activity',
      requiresDocumentAfterDays: 3,
      countsWorkingDaysOnly: true,
      allowNegative: false,
      maxNegativeMinutes: 0,
      order: 1,
      archivedAt: null,
    },
    {
      id: id('b003'),
      key: 'unpaid',
      name: 'Unpaid leave',
      paid: false,
      unit: 'day',
      color: '#7a8794',
      icon: 'calendar-days',
      requiresDocumentAfterDays: null,
      countsWorkingDaysOnly: true,
      allowNegative: false,
      maxNegativeMinutes: 0,
      order: 2,
      archivedAt: null,
    },
    // Archived, so the section that shows archived types has something in it and the note about
    // there being no way back is attached to a real row.
    {
      id: id('b004'),
      key: 'study',
      name: 'Study leave',
      paid: true,
      unit: 'day',
      color: '#8a6ee0',
      icon: 'star',
      requiresDocumentAfterDays: null,
      countsWorkingDaysOnly: true,
      allowNegative: false,
      maxNegativeMinutes: 0,
      order: 3,
      archivedAt: iso(60 * 86_400_000),
    },
  ]

  const officeHours = { start: '09:00', end: '18:00', breakMinutes: 60 }
  const night = { start: '22:00', end: '06:00', breakMinutes: 45 }
  const mornings = { start: '09:00', end: '13:00', breakMinutes: 0 }

  const schedules: Row<Schedule>[] = [
    {
      id: id('05c1'),
      name: 'Office hours',
      kind: 'fixed',
      week: {
        mon: { ...officeHours },
        tue: { ...officeHours },
        wed: { ...officeHours },
        thu: { ...officeHours },
        fri: { ...officeHours },
        sat: null,
        sun: null,
      },
      tzMode: 'office',
      tz: null,
      graceInMinutes: 10,
      graceOutMinutes: 10,
      roundingStepMinutes: 0,
      roundingDirection: 'nearest',
      autoClockOutAfterMinutes: null,
      archivedAt: null,
    },
    // The interesting one: 22:00–06:00 is eight hours on the day it starts, not a negative number,
    // and the week grid draws it differently. A model that only ever sees daytime shifts is untested.
    {
      id: id('05c2'),
      name: 'Night shift',
      kind: 'shift',
      week: {
        mon: { ...night },
        tue: { ...night },
        wed: { ...night },
        thu: { ...night },
        fri: null,
        sat: null,
        sun: { ...night },
      },
      tzMode: 'fixed',
      tz: 'Europe/Istanbul',
      graceInMinutes: 15,
      graceOutMinutes: 15,
      roundingStepMinutes: 15,
      roundingDirection: 'nearest',
      autoClockOutAfterMinutes: 720,
      archivedAt: null,
    },
    {
      id: id('05c3'),
      name: 'Part-time mornings',
      kind: 'flexible',
      week: {
        mon: { ...mornings },
        tue: null,
        wed: { ...mornings },
        thu: null,
        fri: { ...mornings },
        sat: null,
        sun: null,
      },
      tzMode: 'person',
      tz: null,
      graceInMinutes: 30,
      graceOutMinutes: 30,
      roundingStepMinutes: 0,
      roundingDirection: 'employee',
      autoClockOutAfterMinutes: null,
      archivedAt: null,
    },
    {
      id: id('05c4'),
      name: 'Summer hours',
      kind: 'fixed',
      week: {
        mon: { start: '08:00', end: '15:00', breakMinutes: 30 },
        tue: { start: '08:00', end: '15:00', breakMinutes: 30 },
        wed: { start: '08:00', end: '15:00', breakMinutes: 30 },
        thu: { start: '08:00', end: '15:00', breakMinutes: 30 },
        fri: { start: '08:00', end: '15:00', breakMinutes: 30 },
        sat: null,
        sun: null,
      },
      tzMode: 'office',
      tz: null,
      graceInMinutes: 0,
      graceOutMinutes: 0,
      roundingStepMinutes: 0,
      roundingDirection: 'nearest',
      autoClockOutAfterMinutes: null,
      archivedAt: iso(30 * 86_400_000),
    },
  ]

  const scheduleAssignments: Row<ScheduleAssignment>[] = [
    {
      id: id('a5c1'),
      personId: id('d001'),
      scheduleId: id('05c1'),
      effectiveFrom: day(-400),
      effectiveTo: null,
    },
    {
      id: id('a5c2'),
      personId: id('d002'),
      scheduleId: id('05c1'),
      effectiveFrom: day(-300),
      effectiveTo: null,
    },
    {
      id: id('a5c3'),
      personId: id('d004'),
      scheduleId: id('05c3'),
      effectiveFrom: day(-80),
      effectiveTo: null,
    },
  ]

  /**
   * The recent working days, most recent first.
   *
   * The interesting days are pinned to positions in *this* list rather than to a raw offset from
   * today: `day(-3)` is a Sunday one week in three, and a leave day or a missing clock-out on a
   * Sunday is a contradiction the day sheet would then have to draw.
   */
  const workdays = (count: number): string[] => {
    const out: string[] = []
    for (let back = 0; out.length < count; back++) {
      const date = day(-back)
      const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!
      if (weekday !== 'sat' && weekday !== 'sun') out.push(date)
    }
    return out
  }
  const WD = workdays(5)
  /** How far the punch seed reaches back — a month plus a fortnight, so any month-start is covered. */
  const SEED_DAYS = 45

  /**
   * An instant from a business date and a wall-clock reading **in the office's zone**.
   *
   * Built as UTC these read three hours late to everybody: the screens format in the viewer's zone,
   * so a seeded `09:00` clock-in was drawn as "12:00 PM" and a nine-to-six day looked like noon to
   * nine. Istanbul has been a fixed +03:00 with no daylight saving since 2016, so the offset is
   * safe to write literally — a zone that still shifts would need the date to decide it.
   */
  const stamp = (date: string, wall: string) => new Date(`${date}T${wall}:00+03:00`).toISOString()

  let punchCounter = 0
  const punch = (
    date: string,
    wall: string,
    direction: Punch['direction'],
    over: Partial<Row<Punch>> = {},
  ): Row<Punch> => ({
    id: id(`9c${(++punchCounter).toString(16).padStart(4, '0')}`),
    personId: people[0]!.id,
    direction,
    at: stamp(date, wall),
    clientReportedAt: null,
    skewMs: null,
    businessDate: date,
    timezone: 'Europe/Istanbul',
    method: 'web',
    officeId: primaryOfficeId(people[0]!.id),
    deviceId: null,
    geo: null,
    trust: 'trusted',
    voidedByPunchId: null,
    note: null,
    createdAt: iso(),
    ...over,
  })

  /**
   * The raw punches behind the day sheet.
   *
   * Every past working day gets a pair, not just the interesting ones. A day sheet that says eight
   * hours with nothing underneath it is the exact statement this page's own header warns about —
   * and opening such a row showed a total above an empty list, which reads as a broken panel.
   *
   * The times match the seeded `Office hours` schedule, so the arithmetic holds: 09:00 to 18:00 is
   * nine hours, less an hour of break, is the 480 minutes the row claims.
   *
   * Three states the panel draws differently sit on top: a punch the device *claimed* while
   * offline, a day whose clock-out never arrived, and a voided punch beside the correcting row that
   * carries the reason.
   */
  const punches: Row<Punch>[] = []

  // Far enough back to cover the current month whatever day of it this runs on.
  for (let back = SEED_DAYS; back >= 1; back--) {
    const date = day(-back)
    const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!
    if (weekday === 'sat' || weekday === 'sun') continue
    if (date === WD[2]) continue // on leave, so nothing was punched
    if (date === WD[3]) {
      // Punched from a phone that was offline: the instant is the device's claim, and it was four
      // minutes out. That pair of facts is what `trust` and `skewMs` exist to keep. No clock-out
      // ever arrived, which is the day's anomaly.
      punches.push(
        punch(date, '09:12', 'in', {
          method: 'mobile',
          trust: 'claimed',
          clientReportedAt: stamp(date, '09:08'),
          skewMs: 240_000,
        }),
      )
      continue
    }
    punches.push(punch(date, '09:00', 'in'))
    punches.push(punch(date, '13:00', 'break_start'))
    punches.push(punch(date, '14:00', 'break_end'))
    punches.push(punch(date, date === WD[1] ? '18:45' : '18:00', 'out'))
  }

  /**
   * The voided pair, wired the way `voidPunch` wires it.
   *
   * Both rows point at the correction: the original because it was voided, and the correction
   * because it is not a punch — it exists to carry the reason and to say what it replaced. The
   * panel hides the self-voiding row and reads the sentence out of its note.
   */
  const voidedOriginal = punch(WD[4]!, '08:00', 'in')
  const voidCorrection = punch(WD[4]!, '08:00', 'in', {
    method: 'manual',
    note: `Voids ${voidedOriginal.id}: Badge reader at the door fired as I walked past.`,
  })
  voidedOriginal.voidedByPunchId = voidCorrection.id
  voidCorrection.voidedByPunchId = voidCorrection.id
  punches.push(voidedOriginal, voidCorrection)

  /**
   * One correction already asked for, on the day the seeded approval names.
   *
   * `subjectId` and `approvalRequestId` line up with the `regularization` row in the approvals
   * inbox on purpose — the same request seen from the two screens that show it, which is the thing
   * a demo cannot fake with two unrelated rows.
   */
  const regularizations: Row<Regularization>[] = [
    {
      id: id('c002'),
      personId: people[0]!.id,
      businessDate: WD[1]!,
      punchId: punches.find((x) => x.businessDate === WD[1] && x.direction === 'out')?.id ?? null,
      proposed: [{ direction: 'out', at: stamp(WD[1]!, '19:00') }],
      reason: 'I worked until 19:00 finishing the migration; the clock-out is wrong.',
      status: 'pending',
      approvalRequestId: id('f002'),
      appliedAt: null,
      createdAt: iso(2 * 86_400_000),
    },
  ]

  // ---------------------------------------------------------------- documents, sensitive, periods

  const documents: Row<PersonDocument>[] = [
    {
      id: id('d0c1'),
      personId: people[0]!.id,
      fileId: id('f11e01'),
      name: 'Employment contract',
      kind: 'contract',
      issuedOn: day(-400),
      expiresOn: null,
      uploadedBy: null,
      createdAt: iso(400 * 86_400_000),
    },
    // Expiring inside the month, because "expires on" is the column the section exists for and a
    // list where nothing ever expires never shows what it does with one.
    {
      id: id('d0c2'),
      personId: people[0]!.id,
      fileId: id('f11e02'),
      name: 'Work permit',
      kind: 'permit',
      issuedOn: day(-380),
      expiresOn: day(20),
      uploadedBy: null,
      createdAt: iso(380 * 86_400_000),
    },
    {
      id: id('d0c3'),
      personId: people[1]!.id,
      fileId: id('f11e03'),
      name: 'Employment contract',
      kind: 'contract',
      issuedOn: day(-300),
      expiresOn: null,
      uploadedBy: null,
      createdAt: iso(300 * 86_400_000),
    },
  ]

  /**
   * Behind a second permission, and a separate shape for that reason.
   *
   * Seeded for one person only: the section has to be able to render "nothing recorded" as well as
   * a filled-in card, and every other person here is that case.
   */
  const sensitive: Row<PersonSensitive>[] = [
    {
      personId: people[0]!.id,
      nationalId: '12345678901',
      birthDate: '1991-04-17',
      iban: 'TR33 0006 1005 1978 6457 8413 26',
      emergencyContact: { name: 'Elif Yılmaz', relationship: 'Sister', phone: '+90 532 000 0000' },
    },
  ]

  const monthStart = (offset: number) => {
    const base = new Date(now)
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1))
    return d.toISOString().slice(0, 10)
  }
  const monthEnd = (offset: number) => {
    const base = new Date(now)
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset + 1, 0))
    return d.toISOString().slice(0, 10)
  }

  const periods: Row<Period>[] = [
    // Last month closed and this month open — the two states the screen switches between, so
    // neither the lock button nor the reopen warning is reachable only in theory.
    {
      id: id('9e01'),
      kind: 'payroll',
      legalEntityId: id('1e01'),
      startsOn: monthStart(-1),
      endsOn: monthEnd(-1),
      status: 'locked',
      lockedAt: iso(5 * 86_400_000),
      lockedBy: null,
      note: 'Filed with payroll',
    },
    {
      id: id('9e02'),
      kind: 'payroll',
      legalEntityId: id('1e01'),
      startsOn: monthStart(0),
      endsOn: monthEnd(0),
      status: 'open',
      lockedAt: null,
      lockedBy: null,
      note: null,
    },
    {
      id: id('9e03'),
      kind: 'attendance',
      legalEntityId: null,
      startsOn: monthStart(-1),
      endsOn: monthEnd(-1),
      status: 'open',
      lockedAt: null,
      lockedBy: null,
      note: null,
    },
    // The Dutch entity's month, closed — so the payroll export has a locked period to refuse for
    // the person above who has an office there and no employment record.
    {
      id: id('9e04'),
      kind: 'payroll',
      legalEntityId: id('1e02'),
      startsOn: monthStart(-1),
      endsOn: monthEnd(-1),
      status: 'locked',
      lockedAt: iso(4 * 86_400_000),
      lockedBy: null,
      note: null,
    },
  ]

  /** Working days in a range — what lock and unlock report as the days they froze or released. */
  const workingDaysIn = (from: string, to: string) =>
    eachDate(from, to).filter((date) => {
      const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!
      return weekday !== 'sat' && weekday !== 'sun' && date <= day(0)
    }).length

  // ---------------------------------------------------------------- accrual policies

  /** The ladder made explicit, straight from `SUBJECT_PRIORITY` in the contract. */
  const PRIORITY: Record<PolicySubjectKind, number> = {
    person: 100,
    office: 80,
    legal_entity: 60,
    org_unit: 40,
    position: 30,
    workspace: 0,
  }

  /**
   * Two policies that differ in more than their name.
   *
   * A list whose column reads the same sentence twice demonstrates nothing — these take different
   * branches of the evaluator: one accrues monthly with a waiting period for joiners, the other on
   * the employee's own anniversary with seniority tiers.
   */
  const policies: Row<Policy>[] = [
    {
      id: id('b011'),
      kind: 'accrual',
      name: 'Monthly accrual',
      config: {
        frequency: 'monthly',
        daysPerYear: 20,
        minutesPerDay: 480,
        seniorityTiers: [],
        waitingPeriodMonths: 3,
        calendar: 'gregorian',
        roundToMinutes: 30,
        leaveTypeKey: 'annual',
      },
      effectiveFrom: `${YEAR}-01-01`,
      effectiveTo: null,
      source: 'custom',
      packKey: null,
      configHash: 'a1b2c3d4',
      archivedAt: null,
    },
    {
      id: id('b012'),
      kind: 'accrual',
      name: 'Anniversary accrual, with seniority',
      config: {
        frequency: 'anniversary',
        daysPerYear: 22,
        minutesPerDay: 480,
        seniorityTiers: [
          { afterYears: 5, daysPerYear: 26 },
          { afterYears: 10, daysPerYear: 30 },
        ],
        waitingPeriodMonths: 0,
        calendar: 'gregorian',
        roundToMinutes: 0,
        leaveTypeKey: 'annual',
      },
      effectiveFrom: `${YEAR}-01-01`,
      effectiveTo: null,
      source: 'custom',
      packKey: null,
      configHash: 'e5f6a7b8',
      archivedAt: null,
    },
  ]

  /**
   * Two rungs, on purpose.
   *
   * The screen's copy says the nearest subject wins; with everything assigned at one rung nothing on
   * screen tests that claim. The workspace-wide monthly policy is what most people get, and Sanne
   * has the anniversary one at the `person` rung — which must visibly beat the office below it.
   */
  const policyAssignments: Row<PolicyAssignment>[] = [
    {
      id: id('b0a1'),
      policyId: id('b011'),
      subjectKind: 'workspace',
      subjectId: null,
      effectiveFrom: `${YEAR}-01-01`,
      effectiveTo: null,
      priority: PRIORITY.workspace,
    },
    {
      id: id('b0a2'),
      policyId: id('b012'),
      subjectKind: 'office',
      subjectId: id('e002'),
      effectiveFrom: `${YEAR}-01-01`,
      effectiveTo: null,
      priority: PRIORITY.office,
    },
    // Mehmet has been here five years, so the tier above `afterYears: 5` is the one that answers
    // for him — without somebody long-serving the seniority branch of the evaluator never fires and
    // the second policy's whole reason for existing goes untested.
    {
      id: id('b0a4'),
      policyId: id('b012'),
      subjectKind: 'person',
      subjectId: people[2]!.id,
      effectiveFrom: `${YEAR}-01-01`,
      effectiveTo: null,
      priority: PRIORITY.person,
    },
    {
      id: id('b0a3'),
      policyId: id('b012'),
      subjectKind: 'person',
      subjectId: people[1]!.id,
      effectiveFrom: `${YEAR}-01-01`,
      effectiveTo: null,
      priority: PRIORITY.person,
    },
  ]

  const assignmentsOf = (policyId: string) => policyAssignments.filter((a) => a.policyId === policyId)

  /**
   * Which policy applies to somebody, and which rung answered.
   *
   * Nearest wins, by the priority the contract publishes — so a policy given to one person beats the
   * one on their office, which beats their legal entity, their department, their position, and
   * finally the whole workspace. This is the claim the screen's copy makes, so it has to be the
   * claim the fixture keeps.
   */
  function resolvePolicyFor(personId: string) {
    const officeId = primaryOfficeId(personId)
    const job = employments.find((e) => e.personId === personId && e.effectiveTo === null)
    const matches = (a: Row<PolicyAssignment>) => {
      switch (a.subjectKind) {
        case 'person':
          return a.subjectId === personId
        case 'office':
          return a.subjectId === officeId
        case 'legal_entity':
          return a.subjectId === job?.legalEntityId
        case 'org_unit':
          return a.subjectId === job?.orgUnitId
        case 'position':
          return a.subjectId === job?.positionId
        default:
          return true
      }
    }
    const best = policyAssignments
      .filter((a) => {
        if (a.effectiveTo !== null) return false
        const policy = policies.find((x) => x.id === a.policyId)
        return Boolean(policy && policy.archivedAt === null) && matches(a)
      })
      .sort((a, b) => b.priority - a.priority)[0]
    const policy = best ? policies.find((x) => x.id === best.policyId) : undefined
    return best && policy ? { assignment: best, policy } : null
  }

  const wholeMonthsBetween = (from: string, to: string) => {
    const a = new Date(`${from}T00:00:00Z`)
    const b = new Date(`${to}T00:00:00Z`)
    let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
    if (b.getUTCDate() < a.getUTCDate()) months -= 1
    return months
  }

  /**
   * What a run would credit — computed, never written.
   *
   * `preview` and `run` share this function for the reason the contract gives: a preview computed
   * differently from the thing it previews is a preview that eventually lies. Only `run` writes,
   * and it writes from these rows.
   */
  function accrualRows(from: string, to: string, onlyPersonId?: string) {
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

    for (const who of people) {
      if (onlyPersonId && who.id !== onlyPersonId) continue
      const skip = (reason: string) =>
        skipped.push({ personId: who.id, displayName: who.displayName, reason })

      if (who.status === 'terminated') {
        skip('No longer employed')
        continue
      }
      const applicable = resolvePolicyFor(who.id)
      if (!applicable) {
        skip('No accrual policy applies')
        continue
      }
      const config = applicable.policy.config as {
        frequency: string
        daysPerYear: number
        minutesPerDay: number
        seniorityTiers: Array<{ afterYears: number; daysPerYear: number }>
        waitingPeriodMonths: number
        roundToMinutes: number
        leaveTypeKey: string
      }
      const served = wholeMonthsBetween(who.hiredOn, from)
      if (served < config.waitingPeriodMonths) {
        skip(`Within the ${config.waitingPeriodMonths}-month waiting period — ${served} served`)
        continue
      }
      const leaveType = leaveTypes.find((lt) => lt.key === config.leaveTypeKey && lt.archivedAt === null)
      if (!leaveType) {
        skip(`No leave type keyed "${config.leaveTypeKey}"`)
        continue
      }

      // Most senior tier reached wins, whatever order they are written in.
      const years = Math.floor(served / 12)
      const tier = [...(config.seniorityTiers ?? [])]
        .filter((t) => years >= t.afterYears)
        .sort((a, b) => b.afterYears - a.afterYears)[0]
      const perYear = tier?.daysPerYear ?? config.daysPerYear

      let minutes = Math.round((perYear * config.minutesPerDay) / 12)
      if (config.roundToMinutes > 0) {
        minutes = Math.round(minutes / config.roundToMinutes) * config.roundToMinutes
      }
      const alreadyAccrued = ledger.some(
        (e) =>
          e.personId === who.id &&
          e.leaveTypeId === leaveType.id &&
          e.kind === 'accrual' &&
          e.effectiveOn >= from &&
          e.effectiveOn <= to,
      )
      const basis = tier
        ? `${perYear} days a year after ${tier.afterYears} years' service`
        : `${perYear} days a year`
      rows.push({
        personId: who.id,
        displayName: who.displayName,
        leaveTypeId: leaveType.id,
        leaveTypeName: leaveType.name,
        minutes,
        days: Math.round((minutes / config.minutesPerDay) * 100) / 100,
        reason: alreadyAccrued
          ? `${basis}, ${config.frequency} — already credited for this period`
          : `${basis}, ${config.frequency}`,
        alreadyAccrued,
      })
    }

    return {
      periodFrom: from,
      periodTo: to,
      rows,
      // What the run would actually add: a row already credited contributes nothing to it.
      totalMinutes: rows.filter((r) => !r.alreadyAccrued).reduce((sum, r) => sum + r.minutes, 0),
      skipped,
    }
  }

  // ---------------------------------------------------------------- approval chains

  const chains: Row<ApprovalChain>[] = [
    {
      id: id('ca11'),
      name: 'Leave — manager then HR',
      subjectType: 'leave',
      isDefault: true,
      archivedAt: null,
      spec: {
        steps: [
          {
            name: 'Manager',
            approvers: [{ kind: 'manager' }],
            mode: 'any',
            minApprovals: 1,
            slaHours: 48,
            onTimeout: 'remind',
          },
          {
            name: 'HR',
            approvers: [{ kind: 'permission', id: 'hr.leave.manage' }],
            mode: 'any',
            minApprovals: 1,
            slaHours: 72,
            onTimeout: 'escalate',
          },
        ],
      },
    },
    // Not the default, so the table has a row without the in-use badge — which is the case the
    // column's description is about, and a table where every row looks the same never shows it.
    {
      id: id('ca12'),
      name: 'Leave — local HR only',
      subjectType: 'leave',
      isDefault: false,
      archivedAt: null,
      spec: {
        steps: [
          {
            name: 'Office head',
            approvers: [{ kind: 'office_head' }],
            mode: 'any',
            minApprovals: 1,
            slaHours: null,
            onTimeout: 'remind',
          },
        ],
      },
    },
    {
      id: id('ca13'),
      name: 'Corrections — manager',
      subjectType: 'regularization',
      isDefault: true,
      archivedAt: null,
      spec: {
        steps: [
          {
            name: 'Manager',
            approvers: [{ kind: 'manager' }, { kind: 'org_unit_head' }],
            mode: 'quorum',
            minApprovals: 1,
            slaHours: 24,
            onTimeout: 'auto_approve',
          },
        ],
      },
    },
  ]

  /** Exactly one default per subject type, which is what `clearDefaultChain` keeps true. */
  const clearDefaultChain = (subjectType: string, except: string) => {
    for (const chain of chains) {
      if (chain.subjectType === subjectType && chain.id !== except) chain.isDefault = false
    }
  }

  /**
   * One live delegation, so a delegate deciding in somebody's place is visible at all.
   *
   * Sanne has handed her approvals to Ayşe — who is `people.me` — for a fortnight around today. The
   * pending leave request below names Sanne and *not* Ayşe on its first step, so the only way that
   * row can be decided is through this delegation. Without both halves the feature degrades to
   * "decide as yourself", which is indistinguishable from the feature not existing.
   */
  const delegations: Array<Record<string, unknown>> = [
    {
      id: id('de01'),
      fromPersonId: people[1]!.id,
      toPersonId: people[0]!.id,
      subjectType: null,
      startsOn: day(-4),
      endsOn: day(10),
      reason: 'Parental leave',
      createdAt: iso(5 * 86_400_000),
    },
    // The narrow one, and the reason both are here. `subjectType: null` above delegates everything;
    // this delegates *time off only*, so the same deputy can decide Mehmet's leave and must not
    // touch his attendance corrections. With only a wildcard seeded, the scope check has nothing to
    // be wrong about and the fix that added it would look like it did nothing.
    {
      id: id('de02'),
      fromPersonId: people[2]!.id,
      toPersonId: people[0]!.id,
      subjectType: 'leave',
      startsOn: day(-2),
      endsOn: day(14),
      reason: 'Covering time off only',
      createdAt: iso(3 * 86_400_000),
    },
  ]

  /**
   * Whether the reader may act on a step, given what the request is about.
   *
   * A set per delegator, not a single value: somebody may hold two delegations from the same person
   * with different scopes, and taking the last row would silently drop the other grant.
   */
  const mayDecide = (approverIds: string[], subjectType: string) => {
    const me = people[0]!.id
    if (approverIds.includes(me)) return true
    return delegations.some(
      (d) =>
        d.toPersonId === me &&
        approverIds.includes(d.fromPersonId as string) &&
        (d.subjectType === null || d.subjectType === subjectType) &&
        String(d.startsOn) <= day(0) &&
        String(d.endsOn) >= day(0),
    )
  }

  let stepCounter = 0
  const step = (
    requestId: string,
    stepIndex: number,
    name: string,
    approverIds: string[],
    over: Record<string, unknown> = {},
  ) => {
    const row = {
      id: id(`5e${(++stepCounter).toString(16).padStart(4, '0')}`),
      requestId,
      stepIndex,
      name,
      mode: 'any' as const,
      minApprovals: 1,
      approverIds,
      status: 'pending' as string,
      dueAt: null as string | null,
      escalatedAt: null,
      decisions: [] as Array<Record<string, unknown>>,
      ...over,
    }
    // The factory owns the id, so it owns the link back to it. Writing `stepId` in the seed instead
    // would make every decision depend on the order these are constructed in.
    for (const decision of row.decisions) decision.stepId = row.id
    return row
  }

  const approvalRequests = [
    {
      id: id('f001'),
      workspaceId: '',
      subjectType: 'leave' as const,
      subjectId: id('c001'),
      summary: `5 day(s) from ${day(14)}`,
      summaryParams: { days: 5, from: day(14), to: day(18) } as Record<string, string | number> | null,
      status: 'pending' as string,
      currentStep: 0,
      requestedBy: null,
      requesterPersonId: people[1]!.id,
      requesterName: people[1]!.displayName,
      requestedAt: iso(3600_000),
      decidedAt: null as string | null,
      // Named on this step: Sanne's manager, who is Ayşe — reachable directly.
      steps: [step(id('f001'), 0, 'Manager', [people[0]!.id])] as Array<Record<string, unknown>>,
    },
    {
      id: id('f002'),
      subjectType: 'regularization' as const,
      workspaceId: '',
      subjectId: id('c002'),
      summary: `Correction for ${WD[1]}`,
      summaryParams: { date: WD[1]! } as Record<string, string | number> | null,
      status: 'pending' as string,
      // On the *second* step, because the first is already decided below. A request parked on a
      // step it has finished would offer the caller a decision they have already made.
      currentStep: 1,
      requestedBy: null,
      requesterPersonId: people[2]!.id,
      requesterName: people[2]!.displayName,
      requestedAt: iso(7200_000),
      decidedAt: null as string | null,
      /**
       * Two steps, and the reason this request is the interesting one.
       *
       * Step 0 is decided, so the step counter has something to count. Step 1 names **Sanne** and
       * not the caller, so the only route to a decision on it is the delegation she left — which is
       * what makes the row read "on behalf of Sanne de Vries" rather than offering the caller's own
       * name and quietly proving nothing.
       */
      steps: [
        step(id('f002'), 0, 'Manager', [people[0]!.id], {
          status: 'approved',
          decisions: [
            {
              id: id('dec01'),
              stepId: '',
              approverId: people[0]!.id,
              onBehalfOfId: null,
              decision: 'approve',
              comment: null,
              at: iso(5400_000),
            },
          ],
        }),
        step(id('f002'), 1, 'HR', [people[1]!.id]),
      ] as Array<Record<string, unknown>>,
    },
    {
      id: id('f003'),
      workspaceId: '',
      subjectType: 'leave' as const,
      subjectId: id('c003'),
      summary: `1 day(s) from ${day(-20)}`,
      summaryParams: { days: 1, from: day(-20), to: day(-20) } as Record<string, string | number> | null,
      status: 'approved' as string,
      currentStep: 0,
      requestedBy: null,
      requesterPersonId: people[0]!.id,
      requesterName: people[0]!.displayName,
      requestedAt: iso(20 * 86_400_000),
      decidedAt: iso(19 * 86_400_000) as string | null,
      steps: [
        step(id('f003'), 0, 'Manager', [people[1]!.id], {
          status: 'approved',
          decisions: [
            {
              id: id('dec02'),
              stepId: '',
              approverId: people[1]!.id,
              onBehalfOfId: null,
              decision: 'approve',
              comment: null,
              at: iso(19 * 86_400_000),
            },
          ],
        }),
      ] as Array<Record<string, unknown>>,
    },
  ]

  /**
   * The pair that makes the narrow delegation observable.
   *
   * Both name Mehmet, who has delegated **time off only**. So his deputy sees the leave request and
   * does not see the correction — and the difference between the two rows is the only thing on
   * screen that shows a scoped delegation is scoped.
   */
  approvalRequests.push(
    {
      id: id('f004'),
      workspaceId: '',
      subjectType: 'leave' as const,
      subjectId: id('c005'),
      summary: `2 day(s) from ${day(21)}`,
      summaryParams: { days: 2, from: day(21), to: day(22) } as Record<string, string | number> | null,
      status: 'pending' as string,
      currentStep: 0,
      requestedBy: null,
      requesterPersonId: people[3]!.id,
      requesterName: people[3]!.displayName,
      requestedAt: iso(1800_000),
      decidedAt: null as string | null,
      steps: [step(id('f004'), 0, 'Manager', [people[2]!.id])] as Array<Record<string, unknown>>,
    },
    {
      id: id('f005'),
      workspaceId: '',
      subjectType: 'regularization' as const,
      subjectId: id('c006'),
      summary: `Correction for ${WD[3]}`,
      summaryParams: { date: WD[3]! } as Record<string, string | number> | null,
      status: 'pending' as string,
      currentStep: 0,
      requestedBy: null,
      requesterPersonId: people[3]!.id,
      requesterName: people[3]!.displayName,
      requestedAt: iso(2400_000),
      decidedAt: null as string | null,
      steps: [step(id('f005'), 0, 'Manager', [people[2]!.id])] as Array<Record<string, unknown>>,
    },
  )

  const leaveRequests: Array<Record<string, unknown>> = [
    {
      id: id('c001'),
      workspaceId: '',
      personId: people[0]!.id,
      leaveTypeId: id('b001'),
      startsOn: day(14),
      endsOn: day(18),
      startPart: 'full',
      endPart: 'full',
      hours: null,
      workingDays: 5,
      minutes: 5 * 480,
      status: 'pending',
      reason: null,
      documentFileId: null,
      approvalRequestId: null,
      decidedAt: null,
      createdAt: iso(),
      updatedAt: iso(),
    },
    // The row `f003` in the approvals inbox refers to. It had no request behind it, so the decided
    // tab named a subject nothing could open — and `withdrawn`, which only an approved request can
    // reach, was unreachable in the mock.
    {
      id: id('c003'),
      workspaceId: '',
      personId: people[0]!.id,
      leaveTypeId: id('b001'),
      startsOn: day(-20),
      endsOn: day(-20),
      startPart: 'full',
      endPart: 'full',
      hours: null,
      workingDays: 1,
      minutes: 480,
      status: 'approved',
      reason: null,
      documentFileId: null,
      approvalRequestId: id('f003'),
      decidedAt: iso(19 * 86_400_000),
      createdAt: iso(20 * 86_400_000),
      updatedAt: iso(19 * 86_400_000),
    },
    // Booked, then cancelled. The ledger below carries its consumption *and* the reversal that
    // undid it, rather than the consumption having quietly disappeared.
    {
      id: id('c004'),
      workspaceId: '',
      personId: people[0]!.id,
      leaveTypeId: id('b001'),
      startsOn: day(-45),
      endsOn: day(-44),
      startPart: 'full',
      endPart: 'full',
      hours: null,
      workingDays: 2,
      minutes: 2 * 480,
      status: 'cancelled',
      reason: null,
      documentFileId: null,
      approvalRequestId: null,
      decidedAt: iso(50 * 86_400_000),
      createdAt: iso(60 * 86_400_000),
      updatedAt: iso(50 * 86_400_000),
    },
  ]

  /**
   * The movements behind a balance.
   *
   * This is the screen somebody opens when they disagree with a number, so it has to contain the
   * shape of the argument: an entitlement granted, months of accrual, leave spent — and a
   * **reversal sitting beside the consumption it reverses**, because a cancelled booking that
   * showed as a gap would misrepresent the one property the ledger exists to have. Nothing here is
   * ever edited or removed; a mistake is another row.
   */
  let ledgerCounter = 0
  const entry = (
    personId: string,
    leaveTypeId: string,
    kind: LeaveLedgerEntry['kind'],
    amountMinutes: number,
    effectiveOn: string,
    over: Partial<Row<LeaveLedgerEntry>> = {},
  ): Row<LeaveLedgerEntry> => ({
    id: id(`1ed${(++ledgerCounter).toString(16).padStart(3, '0')}`),
    personId,
    leaveTypeId,
    kind,
    amountMinutes,
    effectiveOn,
    periodYear: Number(effectiveOn.slice(0, 4)),
    requestId: null,
    reversesEntryId: null,
    policyHash: null,
    reason: null,
    createdBy: null,
    createdAt: iso(),
    ...over,
  })

  const ANNUAL = id('b001')
  const SICK = id('b002')
  const ME = people[0]!.id

  const carriedIn = entry(ME, ANNUAL, 'carry_in', 3 * 480, `${YEAR}-01-01`, {
    reason: 'Carried forward from last year',
  })
  const spentThenCancelled = entry(ME, ANNUAL, 'consumption', -2 * 480, day(-45), {
    requestId: id('c004'),
    reason: '2 days',
  })

  const ledger: Row<LeaveLedgerEntry>[] = [
    carriedIn,
    entry(ME, ANNUAL, 'grant', 20 * 480, `${YEAR}-01-01`, { reason: 'Annual entitlement' }),
    entry(ME, ANNUAL, 'accrual', 480, `${YEAR}-01-31`),
    entry(ME, ANNUAL, 'accrual', 480, `${YEAR}-02-28`),
    entry(ME, ANNUAL, 'accrual', 480, `${YEAR}-03-31`),
    // The carry-forward deadline came and went, and what was left of last year lapsed.
    entry(ME, ANNUAL, 'expiry', -3 * 480, `${YEAR}-03-31`, {
      reversesEntryId: carriedIn.id,
      reason: 'Carry-forward deadline',
    }),
    spentThenCancelled,
    entry(ME, ANNUAL, 'reversal', 2 * 480, day(-50), {
      requestId: id('c004'),
      reversesEntryId: spentThenCancelled.id,
      reason: 'Request cancelled',
    }),
    entry(ME, ANNUAL, 'consumption', -480, day(-20), { requestId: id('c003'), reason: '1 day' }),
    entry(ME, ANNUAL, 'adjustment', 480, day(-10), {
      reason: 'Public holiday fell inside an approved request',
    }),
    entry(ME, SICK, 'grant', 10 * 480, `${YEAR}-01-01`, { reason: 'Annual entitlement' }),
  ]
  // Everybody else gets their entitlement and nothing else: a balance of zero for three of four
  // people would read as a broken tile rather than as an untouched allowance.
  for (const other of people.slice(1)) {
    ledger.push(entry(other.id, ANNUAL, 'grant', 20 * 480, `${YEAR}-01-01`, { reason: 'Annual entitlement' }))
    ledger.push(entry(other.id, SICK, 'grant', 10 * 480, `${YEAR}-01-01`, { reason: 'Annual entitlement' }))
  }

  // ---------------------------------------------------------------- privacy

  /** Every retention class, in the order the settings screen shows them — the server's list. */
  const RETENTION_CLASSES: RetentionClass[] = [
    'punchDetail',
    'punches',
    'attendanceDays',
    'leave',
    'personHistory',
    'personDocuments',
    'terminatedPeople',
    'sensitiveAccessLog',
  ]
  /** Null everywhere: the shipped state. No number here is a default, on the server or in a demo. */
  const retention: Record<RetentionClass, number | null> = {
    punchDetail: null,
    punches: null,
    attendanceDays: null,
    leave: null,
    personHistory: null,
    personDocuments: null,
    terminatedPeople: null,
    sensitiveAccessLog: null,
  }
  let retentionUpdatedAt: string | null = null
  let retentionUpdatedBy: string | null = null

  /**
   * Two accounts that have read Ayşe's details: a colleague with an HR record of her own, and an
   * administrator who has none — the row the panel has to render without a person to name.
   */
  const HR_ACCOUNT = id('ac0001')
  const ADMIN_ACCOUNT = id('ac0002')
  const ALL_SENSITIVE = ['nationalId', 'birthDate', 'iban', 'emergencyContact'] as const
  const accessLog: Row<SensitiveAccess>[] = [
    {
      id: id('5a01'),
      personId: people[0]!.id,
      actorUserId: HR_ACCOUNT,
      actorPersonId: people[1]!.id,
      fields: [...ALL_SENSITIVE],
      purpose: 'Payroll onboarding',
      via: 'ui',
      at: iso(30 * 86_400_000),
    },
    {
      id: id('5a02'),
      personId: people[0]!.id,
      actorUserId: ADMIN_ACCOUNT,
      actorPersonId: null,
      fields: ['emergencyContact'],
      purpose: null,
      via: 'api',
      at: iso(6 * 86_400_000),
    },
    {
      id: id('5a03'),
      personId: people[0]!.id,
      actorUserId: HR_ACCOUNT,
      actorPersonId: people[1]!.id,
      fields: [...ALL_SENSITIVE],
      purpose: 'Subject access request',
      via: 'export',
      at: iso(2 * 3600_000),
    },
  ]
  let accessLogCounter = accessLog.length

  /**
   * Record a read, the way `PeopleService.readSensitive` does: one row per read, naming only the
   * fields that actually came back with a value. An empty list is a fact too — the record was
   * opened and there was nothing in it — so the row is written either way.
   */
  const logRead = (personId: string, via: SensitiveAccess['via'], purpose: string | null) => {
    const row = sensitive.find((x) => x.personId === personId)
    accessLog.push({
      id: id(`5a${(++accessLogCounter).toString(16).padStart(2, '0')}`),
      personId,
      actorUserId: HR_ACCOUNT,
      actorPersonId: people[1]!.id,
      fields: ALL_SENSITIVE.filter((f) => row?.[f] != null),
      purpose,
      via,
      at: iso(),
    })
  }

  /** The pseudonym an erased person is shown under — `erasureDisplayName` on the server. */
  const erasureToken = (p: (typeof people)[number]) => p.employeeNo?.trim() || `person-${p.id.slice(0, 8)}`

  const beforeCutoff = (stamp: string, cutoff: string) => stamp.slice(0, 10) < cutoff

  /** How many rows are already past a horizon — the dry run the settings screen shows. */
  const pastHorizon = (cls: RetentionClass, cutoff: string): number => {
    switch (cls) {
      case 'punchDetail':
        return punches.filter(
          (p) => p.businessDate < cutoff && (p.geo !== null || p.deviceId !== null || p.note !== null),
        ).length
      case 'punches':
        return punches.filter((p) => p.businessDate < cutoff).length
      case 'attendanceDays':
        return new Set(punches.filter((p) => p.businessDate < cutoff).map((p) => p.businessDate)).size
      case 'leave':
        return ledger.filter((e) => e.effectiveOn < cutoff).length
      case 'personHistory':
        return 0
      case 'personDocuments':
        return documents.filter((d) => beforeCutoff(d.createdAt, cutoff)).length
      case 'terminatedPeople':
        return people.filter((p) => p.status === 'terminated' && !erasedPeople.has(p.id)).length
      case 'sensitiveAccessLog':
        return accessLog.filter((a) => beforeCutoff(a.at, cutoff)).length
    }
  }

  const retentionState = (workspaceId: string, withCounts: boolean) => ({
    workspaceId,
    classes: RETENTION_CLASSES.map((cls) => {
      const days = retention[cls]
      return { class: cls, days, dueNow: withCounts && days !== null ? pastHorizon(cls, day(-days)) : null }
    }),
    updatedAt: retentionUpdatedAt,
    updatedBy: retentionUpdatedBy,
    // False, and saying so is the point: nothing in HR deletes on these horizons yet.
    sweepEnabled: false as const,
  })

  // ---------------------------------------------------------------- rosters

  /**
   * Three shifts, one 4-on-4-off rotation, two people on it out of phase, and one changed day.
   *
   * Ayşe and Sanne share the rotation with a `cycleOffset` four apart, which is the whole reason
   * an offset exists: Sanne works exactly the days Ayşe is off, so the coverage grid has somebody
   * on every day and an "off" row that is never empty. The override takes Ayşe off a day the
   * rotation would have put her on Late, with a note, so the person view has one row of each
   * source to draw and the grid has a day where the rotation and the roster disagree.
   */
  const SHIFT_EARLY = id('5e01')
  const SHIFT_LATE = id('5e02')
  const SHIFT_NIGHT = id('5e03')
  const rosterShifts: Row<RosterShift>[] = [
    {
      id: SHIFT_EARLY,
      name: 'Early',
      code: 'E',
      start: '06:00',
      end: '14:00',
      breakMinutes: 30,
      graceInMinutes: 5,
      graceOutMinutes: 5,
      color: '#2563EB',
      archivedAt: null,
    },
    {
      id: SHIFT_LATE,
      name: 'Late',
      code: 'L',
      start: '14:00',
      end: '22:00',
      breakMinutes: 30,
      graceInMinutes: 5,
      graceOutMinutes: 5,
      color: '#D97706',
      archivedAt: null,
    },
    {
      id: SHIFT_NIGHT,
      name: 'Night',
      code: 'N',
      start: '22:00',
      end: '06:00',
      breakMinutes: 45,
      graceInMinutes: 15,
      graceOutMinutes: 15,
      color: '#7C3AED',
      archivedAt: null,
    },
  ]

  const PATTERN_4X4 = id('5f01')
  const rosterPatterns: Row<RosterPattern>[] = [
    {
      id: PATTERN_4X4,
      name: '4 on, 4 off',
      anchorDate: day(-8),
      days: [[SHIFT_EARLY], [SHIFT_EARLY], [SHIFT_LATE], [SHIFT_LATE], [], [], [], []],
      archivedAt: null,
    },
  ]

  const rosterAssignments: Row<RosterAssignment>[] = [
    {
      id: id('5a01'),
      personId: id('d001'),
      patternId: PATTERN_4X4,
      effectiveFrom: day(-60),
      effectiveTo: null,
      cycleOffset: 0,
      createdAt: iso(60 * 86_400_000),
    },
    {
      id: id('5a02'),
      personId: id('d002'),
      patternId: PATTERN_4X4,
      effectiveFrom: day(-60),
      effectiveTo: null,
      cycleOffset: 4,
      createdAt: iso(60 * 86_400_000),
    },
  ]

  type RosterOverride = { personId: string; businessDate: string; shiftIds: string[]; note: string | null }
  const rosterOverrides: RosterOverride[] = [
    { personId: id('d001'), businessDate: day(2), shiftIds: [], note: 'Swapped with Sanne — dentist' },
  ]

  /** Whole days between two dates, stepped in UTC like `eachDate`, so a DST hour cannot skip one. */
  const rosterDaysBetween = (from: string, to: string) =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

  /**
   * The rotation's arithmetic, as `services/rosters.ts` does it: `((raw % len) + len) % len`,
   * because a date before the anchor gives a negative index and `days[-3]` reads as a rest day.
   */
  const cycleIndexFor = (pattern: Row<RosterPattern>, date: string, cycleOffset: number) => {
    const len = pattern.days.length
    if (len <= 0) return -1
    const raw = rosterDaysBetween(pattern.anchorDate, date) + cycleOffset
    return ((raw % len) + len) % len
  }

  const rosterAssignmentOn = (personId: string, date: string) => {
    let best: Row<RosterAssignment> | null = null
    for (const a of rosterAssignments) {
      if (a.personId !== personId || a.effectiveFrom > date) continue
      if (a.effectiveTo !== null && a.effectiveTo < date) continue
      if (!best || a.effectiveFrom > best.effectiveFrom) best = a
    }
    return best
  }

  /** Override, then rotation, then nothing — an empty override wins over the rotation on purpose. */
  const rosterPlanFor = (
    personId: string,
    date: string,
  ): { shiftIds: string[]; source: RosterDaySource; note: string | null } => {
    const override = rosterOverrides.find((o) => o.personId === personId && o.businessDate === date)
    if (override) return { shiftIds: [...override.shiftIds], source: 'override', note: override.note }
    const assignment = rosterAssignmentOn(personId, date)
    const pattern = assignment ? rosterPatterns.find((p) => p.id === assignment.patternId) : undefined
    if (!assignment || !pattern) return { shiftIds: [], source: 'none', note: null }
    const index = cycleIndexFor(pattern, date, assignment.cycleOffset)
    if (index < 0) return { shiftIds: [], source: 'none', note: null }
    return { shiftIds: [...(pattern.days[index] ?? [])], source: 'pattern', note: null }
  }

  /** Archived shifts included: a rostered day that names one is retired, not empty. */
  const rosterShiftRows = (shiftIds: readonly string[], workspaceId: string) =>
    shiftIds.flatMap((shiftId) => {
      const shift = rosterShifts.find((s) => s.id === shiftId)
      return shift ? [{ ...shift, workspaceId }] : []
    })

  const rosterDayFor = (personId: string, date: string, workspaceId: string) => {
    const plan = rosterPlanFor(personId, date)
    return {
      personId,
      businessDate: date,
      shifts: rosterShiftRows(plan.shiftIds, workspaceId),
      source: plan.source,
      note: plan.note,
    }
  }

  /** The router's range refusals, in its order and its words. */
  const MAX_COVERAGE_CELLS = 4200
  const rosterRefusal = (input: { from: string; to: string; coverage: boolean; population?: number }) => {
    if (input.to < input.from)
      refuse('BAD_REQUEST', `The end date ${input.to} is before the start date ${input.from}.`)
    const days = rosterDaysBetween(input.from, input.to) + 1
    const max = input.coverage ? MAX_COVERAGE_DAYS : MAX_ROSTER_DAYS
    if (days > max)
      refuse(
        'BAD_REQUEST',
        input.coverage
          ? `A coverage grid covers at most ${max} days, and this one asks for ${days}. Ask for a shorter range.`
          : `A roster covers at most ${max} days, and this one asks for ${days}. Ask for a shorter range.`,
      )
    if (input.coverage && input.population !== undefined) {
      const cells = input.population * days
      if (cells > MAX_COVERAGE_CELLS)
        refuse(
          'BAD_REQUEST',
          `${input.population} people over ${days} days is ${cells} person-days, and a coverage grid resolves at most ${MAX_COVERAGE_CELLS}. Ask for one office, or a shorter range.`,
        )
    }
  }

  const assertRosterShiftsExist = (shiftIds: readonly string[]) => {
    const wanted = [...new Set(shiftIds)]
    const missing = wanted.filter((shiftId) => !rosterShifts.some((s) => s.id === shiftId))
    if (missing.length)
      refuse(
        'BAD_REQUEST',
        missing.length === 1
          ? `This roster names a shift this workspace does not have: ${missing[0]}.`
          : `This roster names shifts this workspace does not have: ${missing.join(', ')}.`,
      )
  }

  return {
    people: {
      list: async ({
        workspaceId,
        q,
        officeId,
        status,
        limit = 50,
      }: {
        workspaceId: string
        q?: string
        officeId?: string
        status?: string[]
        limit?: number
      }) => {
        let items = people
        if (officeId) items = items.filter((p) => primaryOfficeId(p.id) === officeId)
        if (status?.length) items = items.filter((p) => status.includes(p.status))
        if (q) items = items.filter((p) => p.displayName.toLowerCase().includes(q.toLowerCase()))
        // Carries officeName too: a mock that answers a different shape from core is how a screen
        // works in `dev:mock` and breaks against the real API.
        return {
          items: items.slice(0, limit).map((p) => ({
            ...person(p, workspaceId),
            officeId: primaryOfficeId(p.id),
            officeName: officeName(primaryOfficeId(p.id)),
          })),
          nextCursor: null,
          // The count before the page, because a widget asking for one row draws this number.
          total: items.length,
        }
      },
      get: async ({ workspaceId, personId }: { workspaceId: string; personId: string }) => {
        const found = people.find((p) => p.id === personId) ?? people[0]!
        return person(found, workspaceId)
      },
      me: async ({ workspaceId }: { workspaceId: string }) => person(people[0]!, workspaceId),
      create: async (input: {
        workspaceId: string
        displayName: string
        workEmail?: string | null
        employeeNo?: string | null
        hiredOn?: string | null
        officeId?: string | null
        employmentType?: string
        custom?: Record<string, unknown>
      }) => {
        const added = {
          id: crypto.randomUUID(),
          displayName: input.displayName,
          workEmail: input.workEmail ?? '',
          status: 'active' as const,
          timezone: 'Europe/Istanbul',
          hiredOn: input.hiredOn ?? day(0),
          employeeNo: input.employeeNo ?? `E-${people.length + 1}`,
        }
        people.push(added)
        if (input.custom) customValues[added.id] = clone(input.custom)
        // A new person lands in the default office when nobody chose one, which is what the default
        // flag is for.
        assignments.push({
          id: crypto.randomUUID(),
          personId: added.id,
          officeId: input.officeId ?? liveOffices().find((o) => o.isDefault)?.id ?? offices[0]!.id,
          isPrimary: true,
          effectiveFrom: input.hiredOn ?? day(0),
          effectiveTo: null,
          reason: null,
          createdAt: iso(),
        })
        return person(added, input.workspaceId)
      },
      update: async (input: {
        workspaceId: string
        personId: string
        displayName?: string
        workEmail?: string | null
        personalEmail?: string | null
        phone?: string | null
        custom?: Record<string, unknown>
      }) => {
        const found = people.find((p) => p.id === input.personId) ?? people[0]!
        if (input.displayName) found.displayName = input.displayName
        if (input.workEmail !== undefined) found.workEmail = input.workEmail ?? ''
        // Replaced, never merged — `people.update` sets the column to what it was sent, so a
        // screen that sends only the keys it edited erases the rest. Same here, so it shows.
        if (input.custom !== undefined) customValues[found.id] = clone(input.custom)
        return {
          ...person(found, input.workspaceId),
          personalEmail: input.personalEmail ?? null,
          phone: input.phone ?? null,
        }
      },
      /**
       * Behind a second permission, and never folded into `Person`.
       *
       * Returns an empty record rather than refusing when nothing is on file: "nothing recorded" is
       * an ordinary answer and a 404 would make the section look broken for most of the directory.
       */
      sensitive: {
        get: async ({ workspaceId, personId }: { workspaceId: string; personId: string }) => {
          const row = sensitive.find((x) => x.personId === personId)
          // Written with the read, as the server does: opening the section is a disclosure, and the
          // subject's own access log has to show it without a reload.
          logRead(personId, 'ui', null)
          return {
            workspaceId,
            personId,
            nationalId: row?.nationalId ?? null,
            birthDate: row?.birthDate ?? null,
            iban: row?.iban ?? null,
            emergencyContact: row?.emergencyContact ?? null,
          }
        },

        update: async (input: {
          workspaceId: string
          personId: string
          nationalId?: string | null
          birthDate?: string | null
          iban?: string | null
          emergencyContact?: PersonSensitive['emergencyContact']
        }) => {
          let row = sensitive.find((x) => x.personId === input.personId)
          if (!row) {
            row = {
              personId: input.personId,
              nationalId: null,
              birthDate: null,
              iban: null,
              emergencyContact: null,
            }
            sensitive.push(row)
          }
          if (input.nationalId !== undefined) row.nationalId = input.nationalId
          if (input.birthDate !== undefined) row.birthDate = input.birthDate
          if (input.iban !== undefined) row.iban = input.iban
          if (input.emergencyContact !== undefined) row.emergencyContact = input.emergencyContact
          return { ...row, workspaceId: input.workspaceId }
        },
      },

      offboard: async (input: { workspaceId: string; personId: string; on: string }) => {
        const found = people.find((p) => p.id === input.personId) ?? people[0]!
        found.status = 'terminated'
        return { ...person(found, input.workspaceId), terminatedOn: input.on }
      },
    },

    fields: {
      list: async ({
        workspaceId,
        includeArchived = false,
      }: {
        workspaceId: string
        includeArchived?: boolean
      }) =>
        fieldDefs
          .filter((f) => includeArchived || f.archivedAt === null)
          .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
          .map((f) => ({ ...clone(f), workspaceId })),

      create: async (input: {
        workspaceId: string
        key: string
        name: string
        type: CustomFieldDef['type']
        options?: CustomFieldDef['options']
        required?: boolean
        sensitive?: boolean
        section?: CustomFieldDef['section']
      }) => {
        // The unique index on (workspace, key), as the server would refuse it.
        if (fieldDefs.some((f) => f.key === input.key))
          refuse('CONFLICT', `A field with the key "${input.key}" already exists.`)
        const created: Row<CustomFieldDef> = {
          id: crypto.randomUUID(),
          key: input.key,
          name: input.name,
          type: input.type,
          options: input.options ? clone(input.options) : null,
          required: input.required ?? false,
          sensitive: input.sensitive ?? false,
          section: input.section ?? 'profile',
          order: 0,
          archivedAt: null,
        }
        fieldDefs.push(created)
        return { ...clone(created), workspaceId: input.workspaceId }
      },

      update: async (input: {
        workspaceId: string
        fieldId: string
        name?: string
        options?: CustomFieldDef['options']
        required?: boolean
        sensitive?: boolean
        section?: CustomFieldDef['section']
        order?: number
      }) => {
        const found = fieldDefs.find((f) => f.id === input.fieldId)
        if (!found) refuse('NOT_FOUND', 'Field not found')
        if (input.name !== undefined) found.name = input.name
        if (input.options !== undefined) found.options = input.options ? clone(input.options) : null
        if (input.required !== undefined) found.required = input.required
        if (input.sensitive !== undefined) found.sensitive = input.sensitive
        if (input.section !== undefined) found.section = input.section
        if (input.order !== undefined) found.order = input.order
        return { ...clone(found), workspaceId: input.workspaceId }
      },

      // Archived, never dropped: the values stay in `customValues`, as they stay in `people.custom`.
      archive: async ({ fieldId }: { workspaceId: string; fieldId: string }) => {
        const found = fieldDefs.find((f) => f.id === fieldId)
        if (found) found.archivedAt = iso()
        return { ok: true }
      },
    },

    employment: {
      /**
       * The open row, or null.
       *
       * Read out of the same table the org chart counts rather than synthesised beside it — a
       * person's department on their own page and the headcount on the chart have to be the same
       * fact. Null is an ordinary answer: a record created a minute ago has no employment yet.
       */
      current: async ({ workspaceId, personId }: { workspaceId: string; personId: string }) => {
        const row = employments.find((e) => e.personId === personId && e.effectiveTo === null)
        return row ? { ...row, workspaceId } : null
      },

      /** Newest first: the question this answers is "what changed", and the last change is the news. */
      history: async ({ workspaceId, personId }: { workspaceId: string; personId: string }) =>
        employments
          .filter((e) => e.personId === personId)
          .slice()
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
          .map((e) => ({ ...e, workspaceId })),

      /**
       * Closes the open row and opens a new one. Never an update.
       *
       * Overwriting would lose the answer to "who did she report to in March", which is the
       * question a leave approval from March needs — so the previous row is closed the day before
       * the new one starts and everything unstated is carried forward from it.
       */
      change: async (input: {
        workspaceId: string
        personId: string
        effectiveFrom: string
        orgUnitId?: string | null
        positionId?: string | null
        legalEntityId?: string | null
        costCenterId?: string | null
        managerPersonId?: string | null
        employmentType?: Employment['employmentType']
        fte?: number
        contractHoursWeek?: number | null
        reason?: string | null
      }) => {
        const open = employments.find((e) => e.personId === input.personId && e.effectiveTo === null)
        if (open) {
          const dayBefore = new Date(Date.parse(`${input.effectiveFrom}T00:00:00Z`) - 86_400_000)
          open.effectiveTo = dayBefore.toISOString().slice(0, 10)
        }
        const created: Row<Employment> = {
          id: crypto.randomUUID(),
          personId: input.personId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: null,
          orgUnitId: input.orgUnitId !== undefined ? input.orgUnitId : (open?.orgUnitId ?? null),
          positionId: input.positionId !== undefined ? input.positionId : (open?.positionId ?? null),
          legalEntityId:
            input.legalEntityId !== undefined ? input.legalEntityId : (open?.legalEntityId ?? null),
          costCenterId: input.costCenterId !== undefined ? input.costCenterId : (open?.costCenterId ?? null),
          managerPersonId:
            input.managerPersonId !== undefined ? input.managerPersonId : (open?.managerPersonId ?? null),
          employmentType: input.employmentType ?? open?.employmentType ?? 'full_time',
          fte: input.fte ?? open?.fte ?? 1,
          contractHoursWeek:
            input.contractHoursWeek !== undefined
              ? input.contractHoursWeek
              : (open?.contractHoursWeek ?? null),
          reason: input.reason ?? null,
          createdAt: iso(),
        }
        employments.push(created)
        return { ...created, workspaceId: input.workspaceId }
      },
    },

    documents: {
      list: async ({ workspaceId, personId }: { workspaceId: string; personId: string }) =>
        documents
          .filter((d) => d.personId === personId)
          .slice()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((d) => ({ ...d, workspaceId })),

      attach: async (input: {
        workspaceId: string
        personId: string
        fileId: string
        name: string
        kind?: string
        issuedOn?: string | null
        expiresOn?: string | null
      }) => {
        const created: Row<PersonDocument> = {
          id: crypto.randomUUID(),
          personId: input.personId,
          fileId: input.fileId,
          name: input.name,
          kind: input.kind ?? 'other',
          issuedOn: input.issuedOn ?? null,
          expiresOn: input.expiresOn ?? null,
          uploadedBy: null,
          createdAt: iso(),
        }
        documents.push(created)
        return { ...created, workspaceId: input.workspaceId }
      },

      remove: async ({ documentId }: { workspaceId: string; personId: string; documentId: string }) => {
        const at = documents.findIndex((d) => d.id === documentId)
        if (at < 0) refuse('NOT_FOUND', 'Document not found')
        documents.splice(at, 1)
        return { ok: true as const }
      },
    },

    org: {
      units: {
        tree: async ({
          workspaceId,
          includeArchived = false,
        }: {
          workspaceId: string
          includeArchived?: boolean
        }) =>
          orgUnits
            .filter((u) => includeArchived || u.archivedAt === null)
            .slice()
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((u) => ({ ...u, workspaceId, headcount: unitHeadcount(u.id) })),

        create: async (input: {
          workspaceId: string
          name: string
          parentId?: string | null
          code?: string | null
          headPersonId?: string | null
        }) => {
          const unitId = crypto.randomUUID()
          const created: Row<OrgUnit> = {
            id: unitId,
            parentId: input.parentId ?? null,
            path: pathFor(input.parentId ?? null, unitId),
            name: input.name,
            code: input.code ?? null,
            headPersonId: input.headPersonId ?? null,
            archivedAt: null,
          }
          orgUnits.push(created)
          return { ...created, workspaceId: input.workspaceId }
        },

        update: async (input: {
          workspaceId: string
          unitId: string
          name?: string
          code?: string | null
          headPersonId?: string | null
        }) => {
          const found = orgUnits.find((u) => u.id === input.unitId)
          if (!found) refuse('NOT_FOUND', 'Department not found')
          if (input.name !== undefined) found.name = input.name
          if (input.code !== undefined) found.code = input.code
          if (input.headPersonId !== undefined) found.headPersonId = input.headPersonId
          return { ...found, workspaceId: input.workspaceId }
        },

        /**
         * Reparent a unit and rewrite the path of everything beneath it.
         *
         * Moving a unit under its own descendant would detach that branch from the root — the one
         * way an ltree hierarchy is corrupted beyond repair by an ordinary drag — so it is refused
         * before anything is written, exactly as the router refuses it.
         */
        move: async (input: { workspaceId: string; unitId: string; parentId: string | null }) => {
          const unit = orgUnits.find((u) => u.id === input.unitId)
          if (!unit) refuse('NOT_FOUND', 'Department not found')
          let parentPath: string | null = null
          if (input.parentId) {
            const target = orgUnits.find((u) => u.id === input.parentId)
            if (!target) refuse('NOT_FOUND', 'Department not found')
            if (target.path === unit.path || target.path.startsWith(`${unit.path}.`)) {
              refuse('BAD_REQUEST', 'A department cannot be moved underneath itself.')
            }
            parentPath = target.path
          }
          const label = unit.path.split('.').pop()!
          const nextPath = parentPath ? `${parentPath}.${label}` : label
          // The whole subtree in one pass, the way the server's single UPDATE does it — walking
          // and reparenting one node at a time is where a half-moved branch comes from.
          const moved = descendants(unit.id)
          const wasPath = unit.path
          for (const row of moved) row.path = `${nextPath}${row.path.slice(wasPath.length)}`
          unit.parentId = input.parentId
          return moved
            .slice()
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((u) => ({ ...u, workspaceId: input.workspaceId }))
        },

        archive: async ({ unitId }: { workspaceId: string; unitId: string }) => {
          const found = orgUnits.find((u) => u.id === unitId)
          if (!found) refuse('NOT_FOUND', 'Department not found')
          const held = unitHeadcount(unitId)
          if (held > 0) {
            refuse('CONFLICT', `${held} people still report into this department. Move them first.`)
          }
          found.archivedAt = iso()
          return { ok: true as const }
        },
      },

      positions: {
        list: async ({
          workspaceId,
          includeArchived = false,
        }: {
          workspaceId: string
          includeArchived?: boolean
        }) =>
          positions
            .filter((row) => includeArchived || row.archivedAt === null)
            .map((row) => ({ ...row, workspaceId })),

        create: async (input: {
          workspaceId: string
          title: string
          code?: string | null
          jobFamily?: string | null
          level?: string | null
        }) => {
          const created: Row<Position> = {
            id: crypto.randomUUID(),
            title: input.title,
            code: input.code ?? null,
            jobFamily: input.jobFamily ?? null,
            level: input.level ?? null,
            archivedAt: null,
          }
          positions.push(created)
          return { ...created, workspaceId: input.workspaceId }
        },

        update: async (input: {
          workspaceId: string
          positionId: string
          title?: string
          code?: string | null
          jobFamily?: string | null
          level?: string | null
        }) => {
          const found = positions.find((row) => row.id === input.positionId)
          if (!found) refuse('NOT_FOUND', 'Position not found')
          if (input.title !== undefined) found.title = input.title
          if (input.code !== undefined) found.code = input.code
          if (input.jobFamily !== undefined) found.jobFamily = input.jobFamily
          if (input.level !== undefined) found.level = input.level
          return { ...found, workspaceId: input.workspaceId }
        },

        // No refusal here: the router archives a position without checking who holds it.
        archive: async ({ positionId }: { workspaceId: string; positionId: string }) => {
          const found = positions.find((row) => row.id === positionId)
          if (!found) refuse('NOT_FOUND', 'Position not found')
          found.archivedAt = iso()
          return { ok: true as const }
        },
      },
    },

    offices: {
      list: async ({
        workspaceId,
        includeArchived = false,
      }: {
        workspaceId: string
        includeArchived?: boolean
      }) =>
        offices
          .filter((o) => includeArchived || o.archivedAt === null)
          .map((o) => ({ ...o, workspaceId, headcount: headcount(o.id) })),

      get: async ({ workspaceId, officeId }: { workspaceId: string; officeId: string }) => {
        const found = offices.find((o) => o.id === officeId)
        if (!found) refuse('NOT_FOUND', 'Office not found')
        return { ...found, workspaceId }
      },

      create: async (input: {
        workspaceId: string
        name: string
        kind?: Office['kind']
        country: string
        region?: string | null
        city?: string | null
        timezone: string
        code?: string | null
        parentOfficeId?: string | null
        legalEntityId?: string | null
        seedCalendarFromPack?: boolean
      }) => {
        const created: Row<Office> = {
          id: crypto.randomUUID(),
          name: input.name,
          code: input.code ?? null,
          kind: input.kind ?? 'branch',
          parentOfficeId: input.parentOfficeId ?? null,
          legalEntityId: input.legalEntityId ?? null,
          country: input.country,
          region: input.region ?? null,
          city: input.city ?? null,
          timezone: input.timezone,
          calendarId: null,
          address: null,
          // The workspace already has a default and only ever has one.
          isDefault: false,
          headPersonId: null,
          archivedAt: null,
          createdAt: iso(),
        }
        // The pack is copied as a *base* the office's calendar extends, never inlined — so seeding
        // makes a calendar rather than a heap of days.
        // The office's own calendar *extends* the country pack rather than copying it, so a pack
        // refresh reaches this office without reconciling a copy. It is made even when no pack
        // exists for the country — an office with no calendar at all has no working week to resolve,
        // and the router does not leave one in that state.
        if (input.seedCalendarFromPack !== false) {
          const key = input.country
          let base = calendars.find((c) => c.source === 'pack' && c.packKey === key)
          if (!base && PACKS[key]) {
            base = {
              id: crypto.randomUUID(),
              name: PACKS[key]!.name,
              extendsId: null,
              country: input.country,
              region: null,
              workingWeek: { ...DEFAULT_WEEK },
              source: 'pack',
              packKey: key,
              packVersion: String(YEAR),
              archivedAt: null,
            }
            calendars.push(base)
            for (const packDay of PACKS[key]!.days) {
              calendarDays.push(
                calDay(
                  base.id,
                  packDay.monthDay,
                  packDay.name,
                  packDay.kind,
                  packDay.workingFraction,
                  'pack',
                ),
              )
            }
          }
          const own: Row<Calendar> = {
            id: crypto.randomUUID(),
            name: input.name,
            extendsId: base?.id ?? null,
            country: input.country,
            region: input.region ?? null,
            workingWeek: base ? { ...base.workingWeek } : { ...DEFAULT_WEEK },
            source: 'custom',
            packKey: null,
            packVersion: null,
            archivedAt: null,
          }
          calendars.push(own)
          created.calendarId = own.id
        }
        offices.push(created)
        return { ...created, workspaceId: input.workspaceId }
      },

      update: async (input: {
        workspaceId: string
        officeId: string
        name?: string
        kind?: Office['kind']
        country?: string
        region?: string | null
        city?: string | null
        timezone?: string
        calendarId?: string | null
        legalEntityId?: string | null
        headPersonId?: string | null
        code?: string | null
      }) => {
        const found = offices.find((o) => o.id === input.officeId)
        if (!found) refuse('NOT_FOUND', 'Office not found')
        if (input.name !== undefined) found.name = input.name
        if (input.kind !== undefined) found.kind = input.kind
        if (input.country !== undefined) found.country = input.country
        if (input.region !== undefined) found.region = input.region
        if (input.city !== undefined) found.city = input.city
        if (input.timezone !== undefined) found.timezone = input.timezone
        if (input.calendarId !== undefined) found.calendarId = input.calendarId
        if (input.legalEntityId !== undefined) found.legalEntityId = input.legalEntityId
        if (input.headPersonId !== undefined) found.headPersonId = input.headPersonId
        if (input.code !== undefined) found.code = input.code
        return { ...found, workspaceId: input.workspaceId }
      },

      archive: async ({ officeId }: { workspaceId: string; officeId: string }) => {
        const found = offices.find((o) => o.id === officeId)
        if (!found) refuse('NOT_FOUND', 'Office not found')
        // The default office is where everyone without an assignment lands and where the resolution
        // ladder bottoms out, so it has to be handed over before it can go.
        if (found.isDefault) {
          refuse(
            'CONFLICT',
            'This is the default office. Make another office the default before archiving it.',
          )
        }
        // Presence counts here, not only primaries: archiving an office out from under somebody who
        // still appears in its directory is the same problem either way.
        const held = assignments.filter((a) => a.officeId === officeId && a.effectiveTo === null).length
        if (held > 0) refuse('CONFLICT', `${held} people still work here. Move them first.`)
        found.archivedAt = iso()
        return { ok: true as const }
      },

      /** Moves the flag rather than adding a second one: exactly one office is ever the default. */
      setDefault: async ({ workspaceId, officeId }: { workspaceId: string; officeId: string }) => {
        const found = offices.find((o) => o.id === officeId)
        if (!found) refuse('NOT_FOUND', 'Office not found')
        for (const office of offices) office.isDefault = office.id === officeId
        return { ...found, workspaceId }
      },

      people: async ({
        workspaceId,
        officeId,
        primaryOnly = false,
        limit = 50,
      }: {
        workspaceId: string
        officeId: string
        primaryOnly?: boolean
        limit?: number
      }) => {
        const rows = assignments.filter(
          (a) => a.officeId === officeId && a.effectiveTo === null && (!primaryOnly || a.isPrimary),
        )
        const items = rows.flatMap((a) => {
          const found = people.find((p) => p.id === a.personId)
          return found ? [{ ...person(found, workspaceId), isPrimaryHere: a.isPrimary }] : []
        })
        return { items: items.slice(0, limit), nextCursor: null, total: items.length }
      },

      assign: async (input: {
        workspaceId: string
        officeId: string
        personId: string
        isPrimary?: boolean
        effectiveFrom: string
        reason?: string | null
      }) => {
        const isPrimary = input.isPrimary ?? true
        // One primary at a time. Somebody who assigns a second office expecting a calendar to
        // change has been misled, and the roster says so — so the state behind it has to match.
        if (isPrimary) {
          for (const a of activeAssignments(input.personId)) a.isPrimary = false
        }
        const existing = activeAssignments(input.personId).find((a) => a.officeId === input.officeId)
        if (existing) {
          existing.isPrimary = isPrimary
          existing.effectiveFrom = input.effectiveFrom
          existing.reason = input.reason ?? null
        } else {
          assignments.push({
            id: crypto.randomUUID(),
            personId: input.personId,
            officeId: input.officeId,
            isPrimary,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: null,
            reason: input.reason ?? null,
            createdAt: iso(),
          })
        }
        return activeAssignments(input.personId).map((a) => ({ ...a, workspaceId: input.workspaceId }))
      },

      unassign: async ({
        officeId,
        personId,
        effectiveTo,
      }: {
        workspaceId: string
        officeId: string
        personId: string
        effectiveTo: string
      }) => {
        const found = activeAssignments(personId).find((a) => a.officeId === officeId)
        if (!found) refuse('NOT_FOUND', 'Office assignment not found')
        // The router will not let the primary go rather than picking a replacement on somebody's
        // behalf: which office decides their holidays is a decision, not a fallback.
        if (found.isPrimary) {
          refuse('CONFLICT', 'This is their primary office. Assign another office as primary first.')
        }
        found.effectiveTo = effectiveTo
        return { ok: true as const }
      },

      resolveFor: async ({ workspaceId, personId }: { workspaceId: string; personId: string }) => {
        const p = people.find((x) => x.id === personId) ?? people[0]!
        const primary = primaryOfficeId(p.id)
        const office = offices.find((o) => o.id === primary) ?? offices[0]!
        const calendar = calendars.find((c) => c.id === office.calendarId) ?? null
        void workspaceId
        return {
          personId: p.id,
          on: day(0),
          primaryOfficeId: office.id,
          primaryOfficeName: office.name,
          otherOfficeIds: activeAssignments(p.id)
            .filter((a) => a.officeId !== office.id)
            .map((a) => a.officeId),
          country: office.country,
          timezone: office.timezone,
          timezoneFrom: 'office' as const,
          calendarId: office.calendarId,
          calendarFrom: office.calendarId ? ('office' as const) : null,
          workingWeek: calendar?.workingWeek ?? { ...DEFAULT_WEEK },
          legalEntityId: office.legalEntityId,
          orgUnitId: null,
          orgUnitPath: null,
          // Anybody but the subject: a resolution panel saying somebody reports to themselves reads
          // as a bug in the ladder rather than as seed data.
          managerPersonId: people.find((x) => x.id !== p.id)?.id ?? null,
        }
      },
    },

    entities: {
      list: async ({
        workspaceId,
        includeArchived = false,
      }: {
        workspaceId: string
        includeArchived?: boolean
      }) =>
        entities
          .filter((e) => includeArchived || e.archivedAt === null)
          // The router orders by name, and the settings screen draws the list in the order it
          // arrives — so a mock in insertion order would put a new employer somewhere the real API
          // never does.
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => ({ ...e, workspaceId })),

      get: async ({ workspaceId, entityId }: { workspaceId: string; entityId: string }) => {
        const found = entities.find((e) => e.id === entityId)
        if (!found) refuse('NOT_FOUND', 'Legal entity not found')
        return { ...found, workspaceId }
      },

      create: async (input: {
        workspaceId: string
        name: string
        country: string
        registrationNo?: string | null
        taxNo?: string | null
        currency?: string | null
      }) => {
        const created: Row<LegalEntity> = {
          id: crypto.randomUUID(),
          name: input.name,
          registrationNo: input.registrationNo ?? null,
          taxNo: input.taxNo ?? null,
          country: input.country,
          currency: input.currency ?? null,
          archivedAt: null,
        }
        entities.push(created)
        return { ...created, workspaceId: input.workspaceId }
      },

      update: async (input: {
        workspaceId: string
        entityId: string
        name?: string
        country?: string
        registrationNo?: string | null
        taxNo?: string | null
        currency?: string | null
      }) => {
        const found = entities.find((e) => e.id === input.entityId)
        if (!found) refuse('NOT_FOUND', 'Legal entity not found')
        // `!== undefined`, not truthiness: the router patches every key it was handed, and `null` is
        // how a registration number is cleared. Dropping it would make the field unclearable.
        if (input.name !== undefined) found.name = input.name
        if (input.country !== undefined) found.country = input.country
        if (input.registrationNo !== undefined) found.registrationNo = input.registrationNo
        if (input.taxNo !== undefined) found.taxNo = input.taxNo
        if (input.currency !== undefined) found.currency = input.currency
        return { ...found, workspaceId: input.workspaceId }
      },

      // Archived, never deleted: an office, a period and a payroll export all name their employer,
      // and a row whose employer has vanished is a filing nobody can explain.
      archive: async ({ entityId }: { workspaceId: string; entityId: string }) => {
        const found = entities.find((e) => e.id === entityId)
        // The router's `update` touches no rows for an unknown id and still answers `ok`. Refusing
        // keeps the demo's own state honest, and no screen can reach it — archiving is only ever
        // offered on a row already on the page.
        if (!found) refuse('NOT_FOUND', 'Legal entity not found')
        found.archivedAt = iso()
        return { ok: true as const }
      },

      costCenters: {
        list: async ({
          workspaceId,
          includeArchived = false,
        }: {
          workspaceId: string
          includeArchived?: boolean
        }) =>
          costCenters
            .filter((c) => includeArchived || c.archivedAt === null)
            // By code, as the router orders them.
            .sort((a, b) => a.code.localeCompare(b.code))
            .map((c) => ({ ...c, workspaceId })),

        create: async (input: {
          workspaceId: string
          code: string
          name: string
          officeId?: string | null
          orgUnitId?: string | null
          legalEntityId?: string | null
        }) => {
          // The unique index on (workspace, code), as the server would refuse it. Archived rows
          // count: the index does not exclude them, so a code freed by archiving is not free.
          if (costCenters.some((c) => c.code === input.code))
            refuse('CONFLICT', 'That code is already used by another cost centre.')
          const created: Row<CostCenter> = {
            id: crypto.randomUUID(),
            code: input.code,
            name: input.name,
            officeId: input.officeId ?? null,
            orgUnitId: input.orgUnitId ?? null,
            legalEntityId: input.legalEntityId ?? null,
            archivedAt: null,
          }
          costCenters.push(created)
          return { ...created, workspaceId: input.workspaceId }
        },

        archive: async ({ costCenterId }: { workspaceId: string; costCenterId: string }) => {
          const found = costCenters.find((c) => c.id === costCenterId)
          if (!found) refuse('NOT_FOUND', 'Cost centre not found')
          found.archivedAt = iso()
          return { ok: true as const }
        },
      },
    },

    calendars: {
      list: async ({
        workspaceId,
        includeArchived = false,
      }: {
        workspaceId: string
        includeArchived?: boolean
      }) =>
        calendars
          .filter((c) => includeArchived || c.archivedAt === null)
          .map((c) => ({
            ...c,
            workspaceId,
            // What makes archiving a calendar an office's problem rather than a free action.
            officeIds: liveOffices()
              .filter((o) => o.calendarId === c.id)
              .map((o) => o.id),
          })),

      get: async ({ workspaceId, calendarId }: { workspaceId: string; calendarId: string }) => {
        const found = calendars.find((c) => c.id === calendarId)
        if (!found) refuse('NOT_FOUND', 'Calendar not found')
        return { ...found, workspaceId }
      },

      create: async (input: {
        workspaceId: string
        name: string
        extendsId?: string | null
        country?: string | null
        region?: string | null
        workingWeek?: WorkingWeek
      }) => {
        const created: Row<Calendar> = {
          id: crypto.randomUUID(),
          name: input.name,
          extendsId: input.extendsId ?? null,
          country: input.country ?? null,
          region: input.region ?? null,
          workingWeek: input.workingWeek ? clone(input.workingWeek) : { ...DEFAULT_WEEK },
          source: 'custom',
          packKey: null,
          packVersion: null,
          archivedAt: null,
        }
        calendars.push(created)
        return { ...created, workspaceId: input.workspaceId }
      },

      update: async (input: {
        workspaceId: string
        calendarId: string
        name?: string
        workingWeek?: WorkingWeek
        extendsId?: string | null
      }) => {
        const found = calendars.find((c) => c.id === input.calendarId)
        if (!found) refuse('NOT_FOUND', 'Calendar not found')
        if (input.name !== undefined) found.name = input.name
        if (input.workingWeek !== undefined) found.workingWeek = clone(input.workingWeek)
        if (input.extendsId !== undefined) {
          // Composing would never terminate, so this is refused rather than quietly ignored.
          if (input.extendsId === found.id) refuse('BAD_REQUEST', 'A calendar cannot extend itself.')
          found.extendsId = input.extendsId
        }
        return { ...found, workspaceId: input.workspaceId }
      },

      archive: async ({ calendarId }: { workspaceId: string; calendarId: string }) => {
        const found = calendars.find((c) => c.id === calendarId)
        if (!found) refuse('NOT_FOUND', 'Calendar not found')
        const used = liveOffices().filter((o) => o.calendarId === calendarId).length
        if (used > 0) {
          refuse('CONFLICT', `${used} offices use this calendar. Point them at another one first.`)
        }
        found.archivedAt = iso()
        return { ok: true as const }
      },

      days: {
        list: async ({
          workspaceId,
          calendarId,
          from,
          to,
        }: {
          workspaceId: string
          calendarId: string
          from: string
          to: string
        }) =>
          [...composeDays(calendarId, workspaceId).values()]
            .filter((d) => d.date >= from && d.date <= to)
            .sort((a, b) => a.date.localeCompare(b.date)),

        add: async (input: {
          workspaceId: string
          calendarId: string
          date: string
          name: string
          kind?: CalendarDayKind
          workingFraction?: number
          paid?: boolean
          note?: string | null
        }) => {
          const row: Row<CalendarDay> = {
            id: nextDayId(),
            calendarId: input.calendarId,
            date: input.date,
            kind: input.kind ?? 'company_closure',
            name: input.name,
            workingFraction: input.workingFraction ?? 0,
            source: 'custom',
            paid: input.paid ?? true,
            note: input.note ?? null,
          }
          // One custom row per date per calendar. A second would be invisible — composition keeps
          // the nearest — so adding a day that already exists would look like doing nothing.
          const at = calendarDays.findIndex(
            (r) => r.calendarId === input.calendarId && r.date === input.date && r.source === 'custom',
          )
          if (at >= 0) calendarDays.splice(at, 1, { ...row, id: calendarDays[at]!.id })
          else calendarDays.push(row)
          return resolveDay(input.calendarId, input.workspaceId, input.date)
        },

        update: async (input: {
          workspaceId: string
          calendarId: string
          dayId: string
          name?: string
          kind?: CalendarDayKind
          workingFraction?: number
          paid?: boolean
          note?: string | null
        }) => {
          const target = calendarDays.find((r) => r.id === input.dayId)
          if (!target) refuse('NOT_FOUND', 'Calendar day not found')
          const merged = {
            name: input.name ?? target.name,
            kind: input.kind ?? target.kind,
            workingFraction: input.workingFraction ?? target.workingFraction,
            paid: input.paid ?? target.paid,
            note: input.note !== undefined ? input.note : target.note,
          }
          // A pack row belongs to the pack, and so does a row inherited from a base calendar:
          // editing either writes this calendar's own row over it rather than changing something
          // the next upgrade would overwrite.
          if (target.source === 'pack' || target.calendarId !== input.calendarId) {
            const existing = calendarDays.find(
              (r) => r.calendarId === input.calendarId && r.date === target.date && r.source === 'custom',
            )
            if (existing) Object.assign(existing, merged)
            else {
              calendarDays.push({
                id: nextDayId(),
                calendarId: input.calendarId,
                date: target.date,
                source: 'custom',
                ...merged,
              })
            }
          } else {
            Object.assign(target, merged)
          }
          return resolveDay(input.calendarId, input.workspaceId, target.date)
        },

        /**
         * A custom row is deleted; a pack row is masked.
         *
         * Deleting a pack day would only bring it back on the next upgrade, so the mask is a custom
         * row over it — which is also why deleting *that* row is what gives the pack's day back.
         */
        remove: async ({ calendarId, dayId }: { workspaceId: string; calendarId: string; dayId: string }) => {
          const target = calendarDays.find((r) => r.id === dayId)
          if (!target) refuse('NOT_FOUND', 'Calendar day not found')
          if (target.source === 'custom' && target.calendarId === calendarId) {
            calendarDays.splice(calendarDays.indexOf(target), 1)
            return { ok: true as const, suppressed: false }
          }
          calendarDays.push({
            id: nextDayId(),
            calendarId,
            date: target.date,
            kind: 'working_override',
            name: target.name,
            workingFraction: 1,
            source: 'custom',
            paid: target.paid,
            note: null,
          })
          return { ok: true as const, suppressed: true }
        },
      },

      pack: {
        preview: async ({
          calendarId,
          packKey,
          year,
        }: {
          workspaceId: string
          calendarId: string
          packKey: string
          year: number
        }) => {
          // An unknown key is an empty incoming set rather than an error, because that is what
          // `packDays` returns on the server — so the diff then proposes dropping every pack day
          // the calendar has. See the note in the report: that is the server's behaviour, not a
          // kindness the mock invents, and it is worth somebody looking at.
          const wanted = new Map((PACKS[packKey]?.days ?? []).map((d) => [`${year}-${d.monthDay}`, d]))
          const installed = calendarDays.filter(
            (r) => r.calendarId === calendarId && r.source === 'pack' && r.date.startsWith(`${year}-`),
          )
          const byDate = new Map(installed.map((r) => [r.date, r]))
          return {
            packKey,
            packVersion: String(year),
            added: [...wanted.entries()]
              .filter(([date]) => !byDate.has(date))
              .map(([date, d]) => ({ date, name: d.name })),
            changed: [...wanted.entries()].flatMap(([date, d]) => {
              const had = byDate.get(date)
              return had && had.name !== d.name ? [{ date, name: d.name, was: had.name }] : []
            }),
            removed: installed
              .filter((r) => !wanted.has(r.date))
              .map((r) => ({ date: r.date, name: r.name })),
            // Always untouched, and listed precisely so the dialog can say so out loud.
            keptCustom: calendarDays
              .filter(
                (r) => r.calendarId === calendarId && r.source === 'custom' && r.date.startsWith(`${year}-`),
              )
              .map((r) => ({ date: r.date, name: r.name })),
          }
        },

        apply: async ({
          calendarId,
          packKey,
          year,
        }: {
          workspaceId: string
          calendarId: string
          packKey: string
          year: number
        }) => {
          const wanted = new Map((PACKS[packKey]?.days ?? []).map((d) => [`${year}-${d.monthDay}`, d]))
          let added = 0
          let changed = 0
          let removed = 0
          for (const row of [...calendarDays]) {
            if (row.calendarId !== calendarId || row.source !== 'pack' || !row.date.startsWith(`${year}-`)) {
              continue
            }
            const want = wanted.get(row.date)
            if (!want) {
              calendarDays.splice(calendarDays.indexOf(row), 1)
              removed += 1
              continue
            }
            if (
              row.name !== want.name ||
              row.kind !== want.kind ||
              row.workingFraction !== want.workingFraction
            ) {
              row.name = want.name
              row.kind = want.kind
              row.workingFraction = want.workingFraction
              changed += 1
            }
            wanted.delete(row.date)
          }
          for (const [date, want] of wanted) {
            calendarDays.push({
              id: nextDayId(),
              calendarId,
              date,
              kind: want.kind,
              name: want.name,
              workingFraction: want.workingFraction,
              source: 'pack',
              paid: true,
              note: null,
            })
            added += 1
          }
          const calendar = calendars.find((c) => c.id === calendarId)
          if (calendar) {
            calendar.packKey = packKey
            calendar.packVersion = String(year)
          }
          return { ok: true as const, added, changed, removed }
        },
      },

      workingDays: async ({
        workspaceId,
        personId,
        calendarId,
        from,
        to,
      }: {
        workspaceId: string
        personId?: string
        calendarId?: string
        from: string
        to: string
      }) => {
        const resolved =
          calendarId ??
          (personId ? (offices.find((o) => o.id === primaryOfficeId(personId))?.calendarId ?? null) : null) ??
          calendars[0]?.id ??
          ''
        const week = calendars.find((c) => c.id === resolved)?.workingWeek ?? DEFAULT_WEEK
        const byDate = composeDays(resolved, workspaceId)
        const breakdown = eachDate(from, to).map((date) => {
          const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!
          const base = week[weekday]
          const hit = byDate.get(date)
          // The calendar day wins outright rather than being capped by the week: a working override
          // on a Saturday is exactly the case the kind exists for.
          return {
            date,
            fraction: hit ? hit.workingFraction : base,
            reason: hit ? hit.name : base === 0 ? 'weekend' : null,
          }
        })
        return {
          days: Math.round(breakdown.reduce((sum, d) => sum + d.fraction, 0) * 100) / 100,
          breakdown,
        }
      },
    },

    leave: {
      types: {
        list: async ({
          workspaceId,
          includeArchived = false,
        }: {
          workspaceId: string
          includeArchived?: boolean
        }) =>
          leaveTypes
            .filter((lt) => includeArchived || lt.archivedAt === null)
            .slice()
            .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
            .map((lt) => ({ ...lt, workspaceId })),

        create: async (input: {
          workspaceId: string
          key: string
          name: string
          paid?: boolean
          unit?: LeaveType['unit']
          color?: string | null
          icon?: string | null
          requiresDocumentAfterDays?: number | null
          countsWorkingDaysOnly?: boolean
          allowNegative?: boolean
          maxNegativeMinutes?: number
        }) => {
          const created: Row<LeaveType> = {
            id: crypto.randomUUID(),
            key: input.key,
            name: input.name,
            paid: input.paid ?? true,
            unit: input.unit ?? 'day',
            color: input.color ?? null,
            icon: input.icon ?? null,
            requiresDocumentAfterDays: input.requiresDocumentAfterDays ?? null,
            countsWorkingDaysOnly: input.countsWorkingDaysOnly ?? true,
            allowNegative: input.allowNegative ?? false,
            maxNegativeMinutes: input.maxNegativeMinutes ?? 0,
            order: leaveTypes.length,
            archivedAt: null,
          }
          leaveTypes.push(created)
          return { ...created, workspaceId: input.workspaceId }
        },

        update: async (input: {
          workspaceId: string
          leaveTypeId: string
          name?: string
          paid?: boolean
          color?: string | null
          icon?: string | null
          requiresDocumentAfterDays?: number | null
          countsWorkingDaysOnly?: boolean
          allowNegative?: boolean
          maxNegativeMinutes?: number
          order?: number
        }) => {
          const found = leaveTypes.find((lt) => lt.id === input.leaveTypeId)
          if (!found) refuse('NOT_FOUND', 'Leave type not found')
          if (input.name !== undefined) found.name = input.name
          if (input.paid !== undefined) found.paid = input.paid
          if (input.color !== undefined) found.color = input.color
          if (input.icon !== undefined) found.icon = input.icon
          if (input.requiresDocumentAfterDays !== undefined) {
            found.requiresDocumentAfterDays = input.requiresDocumentAfterDays
          }
          if (input.countsWorkingDaysOnly !== undefined) {
            found.countsWorkingDaysOnly = input.countsWorkingDaysOnly
          }
          if (input.allowNegative !== undefined) found.allowNegative = input.allowNegative
          if (input.maxNegativeMinutes !== undefined) found.maxNegativeMinutes = input.maxNegativeMinutes
          if (input.order !== undefined) found.order = input.order
          return { ...found, workspaceId: input.workspaceId }
        },

        archive: async ({ leaveTypeId }: { workspaceId: string; leaveTypeId: string }) => {
          const found = leaveTypes.find((lt) => lt.id === leaveTypeId)
          if (!found) refuse('NOT_FOUND', 'Leave type not found')
          found.archivedAt = iso()
          return { ok: true as const }
        },
      },
      balance: {
        /**
         * Summed from the ledger, never stored.
         *
         * The ledger screen exists to explain this number, so a tile that stated its own would
         * contradict the screen that opens from it — on first click, which is the worst place for
         * two numbers to disagree.
         */
        get: async ({ personId, periodYear }: { personId?: string; periodYear?: number }) => {
          const who = personId ?? people[0]!.id
          const year = periodYear ?? YEAR
          return leaveTypes
            .filter((lt) => lt.archivedAt === null)
            .map((lt) => {
              const rows = ledger.filter(
                (e) => e.personId === who && e.leaveTypeId === lt.id && e.periodYear === year,
              )
              const balanceMinutes = rows.reduce((sum, e) => sum + e.amountMinutes, 0)
              const mine = leaveRequests.filter(
                (r) => r.personId === who && r.leaveTypeId === lt.id,
              ) as Array<Record<string, unknown>>
              const minutesOf = (status: string) =>
                mine.filter((r) => r.status === status).reduce((sum, r) => sum + Number(r.minutes ?? 0), 0)
              const pendingMinutes = minutesOf('pending')
              const bookedMinutes = minutesOf('approved')
              const perUnit = lt.unit === 'hour' ? 60 : 480
              return {
                personId: who,
                leaveTypeId: lt.id,
                leaveTypeName: lt.name,
                unit: lt.unit,
                periodYear: year,
                balanceMinutes,
                bookedMinutes,
                pendingMinutes,
                availableMinutes: balanceMinutes - pendingMinutes,
                balance: Math.round((balanceMinutes / perUnit) * 100) / 100,
                available: Math.round(((balanceMinutes - pendingMinutes) / perUnit) * 100) / 100,
              }
            })
        },
      },

      ledger: {
        /** Newest first, so the movement somebody is arguing about is the one at the top. */
        list: async ({
          workspaceId,
          personId,
          leaveTypeId,
          periodYear,
          limit = 50,
        }: {
          workspaceId: string
          personId: string
          leaveTypeId?: string
          periodYear?: number
          limit?: number
        }) => {
          const items = ledger
            .filter(
              (e) =>
                e.personId === personId &&
                (!leaveTypeId || e.leaveTypeId === leaveTypeId) &&
                (periodYear === undefined || e.periodYear === periodYear),
            )
            .slice()
            .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn) || b.id.localeCompare(a.id))
          return {
            items: items.slice(0, limit).map((e) => ({ ...e, workspaceId })),
            nextCursor: null,
            total: items.length,
          }
        },
      },

      /** Appends. There is no edit and no delete — a wrong adjustment is corrected by another row. */
      adjust: async (input: {
        workspaceId: string
        personId: string
        leaveTypeId: string
        kind?: LeaveLedgerEntry['kind']
        amountMinutes: number
        effectiveOn: string
        reason: string
      }) => {
        const created = entry(
          input.personId,
          input.leaveTypeId,
          input.kind ?? 'adjustment',
          input.amountMinutes,
          input.effectiveOn,
          { reason: input.reason },
        )
        ledger.push(created)
        return { ...created, workspaceId: input.workspaceId }
      },

      requests: {
        list: async ({ workspaceId }: { workspaceId: string }) => ({
          items: leaveRequests.map((r) => ({ ...r, workspaceId })),
          nextCursor: null,
        }),
        simulate: async ({
          startsOn,
          endsOn,
        }: {
          workspaceId: string
          leaveTypeId: string
          startsOn: string
          endsOn: string
        }) => {
          const from = Date.parse(`${startsOn}T00:00:00Z`)
          const to = Date.parse(`${endsOn}T00:00:00Z`)
          const workingDays = Math.max(1, Math.round((to - from) / 86_400_000) + 1)
          const minutes = workingDays * 480
          return {
            workingDays,
            minutes,
            days: [],
            balanceBeforeMinutes: 20 * 480,
            balanceAfterMinutes: 20 * 480 - minutes,
            blockers: minutes > 20 * 480 ? [{ code: 'insufficient', message: 'Not enough balance' }] : [],
          }
        },
        create: async (input: {
          workspaceId: string
          leaveTypeId: string
          startsOn: string
          endsOn: string
          reason?: string | null
        }) => {
          const row = {
            id: crypto.randomUUID(),
            workspaceId: input.workspaceId,
            personId: people[0]!.id,
            leaveTypeId: input.leaveTypeId,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
            startPart: 'full',
            endPart: 'full',
            hours: null,
            workingDays: 1,
            minutes: 480,
            status: 'pending',
            reason: input.reason ?? null,
            documentFileId: null,
            approvalRequestId: null,
            decidedAt: null,
            createdAt: iso(),
            updatedAt: iso(),
          }
          leaveRequests.push(row)
          return row
        },
        /**
         * Two end states, not one, and each refuses differently.
         *
         * `withdrawn` is the requester taking approved leave back and `cancelled` is a request that
         * never got that far — telling somebody their own withdrawal was "already cancelled" is a
         * small lie about who did what, which is why the router carries a reason beside each
         * sentence rather than one sentence for both.
         *
         * The old version fell back to `leaveRequests[0]` when the id did not match, so an unknown
         * id cancelled somebody else's leave and reported success.
         */
        cancel: async ({ requestId }: { workspaceId: string; requestId: string }) => {
          const row = leaveRequests.find((r) => r.id === requestId)
          if (!row) refuse('NOT_FOUND', 'Leave request not found')
          if (row.status === 'cancelled') {
            refuse('CONFLICT', 'That request is already cancelled.', 'hr.leave.already_cancelled')
          }
          if (row.status === 'withdrawn') {
            refuse('CONFLICT', 'That request was already withdrawn.', 'hr.leave.already_withdrawn')
          }
          row.status = row.status === 'approved' ? 'withdrawn' : 'cancelled'
          row.decidedAt = iso()
          row.updatedAt = iso()
          return { ...row }
        },
      },
      team: {
        calendar: async () =>
          people
            .filter((p) => p.status === 'on_leave')
            .map((p) => ({
              personId: p.id,
              displayName: p.displayName,
              requestId: id('c002'),
              startsOn: day(-1),
              endsOn: day(3),
              status: 'approved' as const,
              leaveTypeName: 'Annual leave',
              color: '#4c8bf5',
            })),
      },
    },

    attendance: {
      state: async ({ workspaceId, personId }: { workspaceId: string; personId?: string }) => {
        void workspaceId
        return {
          personId: personId ?? people[0]!.id,
          businessDate: day(0),
          clockedIn: clockedInAt !== null,
          onBreak,
          since: clockedInAt ? new Date(clockedInAt).toISOString() : null,
          workedMinutesToday: clockedInAt ? Math.round((Date.now() - clockedInAt) / 60_000) : 0,
          timezone: 'Europe/Istanbul',
        }
      },
      /**
       * The transitions the router refuses, refused here too, in its order and its words.
       *
       * `punch()` answers a double-tapped button with a CONFLICT carrying a sentence rather than a
       * constraint error, and the widget renders that sentence. A mock that accepts all four
       * leaves a probe edited into a component as the only way to reach that branch — which is
       * exactly what happened, in a file nobody meant to ship.
       *
       * Each carries the router's `reason` beside its sentence. The sentence is English; the reason
       * is what a client can translate, and it reaches `data.reason` on both sides.
       */
      clockIn: async () => {
        if (clockedInAt !== null)
          refuse('CONFLICT', 'You are already clocked in.', 'hr.clock.already_clocked_in')
        clockedInAt = Date.now()
        return mockPunch('in')
      },
      clockOut: async () => {
        if (clockedInAt === null) refuse('CONFLICT', 'You are not clocked in.', 'hr.clock.not_clocked_in')
        clockedInAt = null
        onBreak = false
        return mockPunch('out')
      },
      breakStart: async () => {
        if (clockedInAt === null)
          refuse('CONFLICT', 'Clock in before starting a break.', 'hr.clock.break_before_clock_in')
        if (onBreak) refuse('CONFLICT', 'You are already on a break.', 'hr.clock.already_on_break')
        onBreak = true
        return mockPunch('break_start')
      },
      breakEnd: async () => {
        if (!onBreak) refuse('CONFLICT', 'You are not on a break.', 'hr.clock.not_on_break')
        onBreak = false
        return mockPunch('break_end')
      },
      days: {
        /**
         * A month of day sheets, built for the range asked for.
         *
         * The page asks for `monthRange()`, so a fixed handful of rows answered the same five days
         * whatever it asked and left the rest of the month empty. Weekends come out of the working
         * week; the days worth looking at are pinned to `WD`, and the totals on a day that has
         * punches are read off them rather than invented beside them.
         */
        list: async ({
          workspaceId,
          personId,
          from,
          to,
          limit = 50,
        }: {
          workspaceId: string
          personId?: string
          from: string
          to: string
          limit?: number
        }) => {
          const who = personId ?? people[0]!.id
          const today = day(0)
          // Built up to `limit` rather than built and then sliced: a caller that asks for a decade
          // would otherwise materialise every day of it to return the first fifty.
          const items = []
          for (const date of eachDate(from, to)) {
            if (date > today) break
            if (items.length >= limit) break
            items.push(attendanceDay(date, who, workspaceId))
          }
          return { items, nextCursor: null }
        },
      },

      punches: {
        list: async ({
          workspaceId,
          personId,
          from,
          to,
          includeVoided = false,
          limit = 50,
        }: {
          workspaceId: string
          personId?: string
          from: string
          to: string
          includeVoided?: boolean
          limit?: number
        }) => {
          const who = personId ?? people[0]!.id
          const items = punches
            .filter(
              (row) =>
                row.personId === who &&
                row.businessDate >= from &&
                row.businessDate <= to &&
                (includeVoided || row.voidedByPunchId === null),
            )
            .sort((a, b) => a.at.localeCompare(b.at))
          return { items: items.slice(0, limit).map((row) => ({ ...row, workspaceId })), nextCursor: null }
        },

        /**
         * A void writes a correcting row; it never edits or deletes the original.
         *
         * The correction is stamped with the original's own instant and direction and points at
         * itself, so nothing counts it as a punch — it is there to carry the reason and to say what
         * it replaced. That is the whole difference between a corrected timesheet and an edited one.
         */
        void: async ({
          workspaceId,
          punchId,
          reason,
        }: {
          workspaceId: string
          punchId: string
          reason: string
        }) => {
          void workspaceId
          const original = punches.find((row) => row.id === punchId)
          if (!original) refuse('NOT_FOUND', 'Punch not found')
          if (original.voidedByPunchId) refuse('CONFLICT', 'That punch is already voided')
          const correction = punch(original.businessDate, '00:00', original.direction, {
            at: original.at,
            method: 'manual',
            note: `Voids ${punchId}: ${reason}`,
          })
          correction.voidedByPunchId = correction.id
          original.voidedByPunchId = correction.id
          punches.push(correction)
          return { ok: true as const }
        },
      },

      regularizations: {
        list: async ({
          workspaceId,
          personId,
          status,
          limit = 50,
        }: {
          workspaceId: string
          personId?: string
          status?: string[]
          limit?: number
        }) => {
          const who = personId ?? people[0]!.id
          const items = regularizations
            .filter((row) => row.personId === who && (!status?.length || status.includes(row.status)))
            .sort((a, b) => b.businessDate.localeCompare(a.businessDate))
          return { items: items.slice(0, limit).map((row) => ({ ...row, workspaceId })), nextCursor: null }
        },

        request: async (input: {
          workspaceId: string
          personId?: string
          businessDate: string
          punchId?: string | null
          proposed: Array<{ direction: string; at: string }>
          reason: string
        }) => {
          const who = input.personId ?? people[0]!.id
          const created: Row<Regularization> = {
            id: crypto.randomUUID(),
            personId: who,
            businessDate: input.businessDate,
            punchId: input.punchId ?? null,
            proposed: input.proposed as Regularization['proposed'],
            reason: input.reason,
            status: 'pending',
            approvalRequestId: crypto.randomUUID(),
            appliedAt: null,
            createdAt: iso(),
          }
          regularizations.push(created)
          // The same engine leave uses, so the request appears in the approvals inbox rather than
          // only in the list it was made from — one request, both screens, as the server has it.
          approvalRequests.push({
            id: created.approvalRequestId!,
            workspaceId: '',
            subjectType: 'regularization' as const,
            subjectId: created.id,
            summary: `Correction for ${input.businessDate}`,
            summaryParams: { date: input.businessDate },
            status: 'pending',
            currentStep: 0,
            requestedBy: null,
            requesterPersonId: who,
            requesterName: people.find((x) => x.id === who)?.displayName ?? '',
            requestedAt: iso(),
            decidedAt: null,
            // A step, not an empty array: a request raised through the mock has to be decidable the
            // same way a seeded one is, or the newest row in the inbox is the one that behaves
            // differently from every other.
            steps: [step(created.approvalRequestId!, 0, 'Manager', [people[0]!.id])],
          })
          return { ...created, workspaceId: input.workspaceId }
        },
      },

      schedules: {
        list: async ({
          workspaceId,
          includeArchived = false,
        }: {
          workspaceId: string
          includeArchived?: boolean
        }) =>
          schedules
            .filter((s) => includeArchived || s.archivedAt === null)
            .map((s) => ({ ...s, workspaceId })),

        create: async (input: {
          workspaceId: string
          name: string
          kind?: Schedule['kind']
          week: Schedule['week']
          tzMode?: Schedule['tzMode']
          tz?: string | null
          graceInMinutes?: number
          graceOutMinutes?: number
          roundingStepMinutes?: number
          roundingDirection?: Schedule['roundingDirection']
          autoClockOutAfterMinutes?: number | null
        }) => {
          const created: Row<Schedule> = {
            id: crypto.randomUUID(),
            name: input.name,
            kind: input.kind ?? 'fixed',
            week: clone(input.week),
            tzMode: input.tzMode ?? 'office',
            tz: input.tz ?? null,
            graceInMinutes: input.graceInMinutes ?? 0,
            graceOutMinutes: input.graceOutMinutes ?? 0,
            roundingStepMinutes: input.roundingStepMinutes ?? 0,
            roundingDirection: input.roundingDirection ?? 'nearest',
            autoClockOutAfterMinutes: input.autoClockOutAfterMinutes ?? null,
            archivedAt: null,
          }
          schedules.push(created)
          return { ...created, workspaceId: input.workspaceId }
        },

        update: async (input: {
          workspaceId: string
          scheduleId: string
          name?: string
          week?: Schedule['week']
          graceInMinutes?: number
          graceOutMinutes?: number
          roundingStepMinutes?: number
          roundingDirection?: Schedule['roundingDirection']
          autoClockOutAfterMinutes?: number | null
        }) => {
          const found = schedules.find((s) => s.id === input.scheduleId)
          if (!found) refuse('NOT_FOUND', 'Schedule not found')
          if (input.name !== undefined) found.name = input.name
          if (input.week !== undefined) found.week = clone(input.week)
          if (input.graceInMinutes !== undefined) found.graceInMinutes = input.graceInMinutes
          if (input.graceOutMinutes !== undefined) found.graceOutMinutes = input.graceOutMinutes
          if (input.roundingStepMinutes !== undefined) {
            found.roundingStepMinutes = input.roundingStepMinutes
          }
          if (input.roundingDirection !== undefined) found.roundingDirection = input.roundingDirection
          if (input.autoClockOutAfterMinutes !== undefined) {
            found.autoClockOutAfterMinutes = input.autoClockOutAfterMinutes
          }
          return { ...found, workspaceId: input.workspaceId }
        },

        archive: async ({ scheduleId }: { workspaceId: string; scheduleId: string }) => {
          const found = schedules.find((s) => s.id === scheduleId)
          if (!found) refuse('NOT_FOUND', 'Schedule not found')
          found.archivedAt = iso()
          return { ok: true as const }
        },

        assign: async (input: {
          workspaceId: string
          scheduleId: string
          personId: string
          effectiveFrom: string
        }) => {
          // Effective-dated, so the earlier assignment is closed rather than replaced: the days
          // already computed were measured against it.
          for (const a of scheduleAssignments) {
            if (a.personId === input.personId && a.effectiveTo === null) a.effectiveTo = input.effectiveFrom
          }
          scheduleAssignments.push({
            id: crypto.randomUUID(),
            personId: input.personId,
            scheduleId: input.scheduleId,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: null,
          })
          return scheduleAssignments
            .filter((a) => a.personId === input.personId)
            .map((a) => ({ ...a, workspaceId: input.workspaceId }))
        },
      },
    },

    /**
     * The four reports, over the same seeds the day sheet and the balance tile are drawn from.
     *
     * Derived, never stated: a report that named its own numbers would disagree with the month
     * underneath it on the first click through to a person. The population is who sits in the
     * slice today — the mock has no history of office moves to attribute day by day — and the
     * refusals copy the router's sentences, because the screen checks the caps before asking and
     * these are what it shows when it did not.
     */
    reports: {
      attendance: async (input: MockReportInput) => {
        const { slice, personIds, dates } = reportPopulation(input)
        const rows = dayRows(input.workspaceId, personIds, dates)
        const totals = {
          days: sumOf(rows, (r) => r.days),
          scheduledMinutes: sumOf(rows, (r) => r.scheduledMinutes),
          workedMinutes: sumOf(rows, (r) => r.workedMinutes),
          scheduledWorkedMinutes: sumOf(rows, (r) => r.scheduledWorkedMinutes),
          breakMinutes: sumOf(rows, (r) => r.breakMinutes),
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          noScheduleDays: 0,
          unknownScheduleDays: 0,
        }
        const shown = [...rows].sort((a, b) => b.workedMinutes - a.workedMinutes).slice(0, input.limit ?? 100)
        return {
          header: mockReportHeader({
            input,
            slice,
            population: personIds.length,
            counted: rows.length,
            shown: shown.length,
            permissions: ['hr.report.view', 'hr.attendance.view_team'],
          }),
          finality: mergeMockFinality(rows.map((r) => r.finality)),
          totals: {
            ...totals,
            workedRatio: mockRatio(totals.scheduledWorkedMinutes, totals.scheduledMinutes),
          },
          rows: shown.map((r) => ({
            personId: r.personId,
            displayName: nameOf(r.personId),
            days: r.days,
            scheduledMinutes: r.scheduledMinutes,
            workedMinutes: r.workedMinutes,
            scheduledWorkedMinutes: r.scheduledWorkedMinutes,
            breakMinutes: r.breakMinutes,
            lateMinutes: 0,
            earlyLeaveMinutes: 0,
            workedRatio: mockRatio(r.scheduledWorkedMinutes, r.scheduledMinutes),
            noScheduleDays: 0,
            unknownScheduleDays: 0,
          })),
        }
      },

      overtime: async (input: MockReportInput) => {
        const { slice, personIds, dates } = reportPopulation(input)
        const rows = dayRows(input.workspaceId, personIds, dates)
        const shown = [...rows]
          .sort((a, b) => b.overtimeMinutes - a.overtimeMinutes)
          .slice(0, input.limit ?? 100)
        return {
          header: mockReportHeader({
            input,
            slice,
            population: personIds.length,
            counted: rows.length,
            shown: shown.length,
            permissions: ['hr.report.view', 'hr.attendance.view_team'],
          }),
          finality: mergeMockFinality(rows.map((r) => r.finality)),
          totals: {
            days: sumOf(rows, (r) => r.days),
            overtimeMinutes: sumOf(rows, (r) => r.overtimeMinutes),
            // Null, not zero: the demo workspace has no overtime policy with an annual ceiling, and
            // "no ceiling applied" is a different fact from "one applied and nothing exceeded it".
            beyondCapMinutes: null,
            cappedDays: 0,
            uncappedDays: sumOf(rows, (r) => r.days),
          },
          rows: shown.map((r) => ({
            personId: r.personId,
            displayName: nameOf(r.personId),
            days: r.days,
            overtimeMinutes: r.overtimeMinutes,
            beyondCapMinutes: null,
            cappedDays: 0,
            uncappedDays: r.days,
          })),
        }
      },

      absence: async (input: MockReportInput) => {
        // Always a per-day report, sliced or not: the server walks the calendar ladder per day
        // whichever way it is asked, so the shorter cap applies whichever way it is asked.
        const { slice, personIds, dates } = reportPopulation(input, true)
        const rows: AbsenceRow[] = personIds.map((personId) => {
          const empty = {
            personId,
            displayName: nameOf(personId),
            expectedDays: null,
            workedDays: null,
            leaveDays: null,
            absentDays: null,
            absenceRate: null,
          }
          if (!hasScheduleIn(personId, input.from, input.to)) return { ...empty, basis: 'no_schedule' }
          const office = offices.find((o) => o.id === primaryOfficeId(personId))
          if (!office?.calendarId) return { ...empty, basis: 'no_calendar' }
          // Weekdays only: the seeded calendars carry holidays, but the day sheet the worked count
          // is read from does not know them either, and the two have to agree.
          const sheets = dates
            .filter((date) => !isWeekend(date))
            .map((date) => attendanceDay(date, personId, input.workspaceId))
          const expectedDays = sheets.length
          const workedDays = sheets.filter((s) => s.workedMinutes > 0).length
          const leaveDays = sheets.filter((s) => s.status === 'leave').length
          const absentDays = Math.max(0, expectedDays - workedDays - leaveDays)
          return {
            ...empty,
            basis: 'calendar',
            expectedDays,
            workedDays,
            leaveDays,
            absentDays,
            absenceRate: mockRatio(absentDays, expectedDays),
          }
        })
        const measured = rows.filter((r) => r.basis === 'calendar')
        const expected = sumOf(measured, (r) => r.expectedDays ?? 0)
        const worked = sumOf(measured, (r) => r.workedDays ?? 0)
        const leave = sumOf(measured, (r) => r.leaveDays ?? 0)
        const absent = Math.max(0, expected - worked - leave)
        // Measured people first, then the two named buckets, so a row limit cannot hide them.
        const shown = [...rows]
          .sort(
            (a, b) =>
              (a.basis === 'calendar' ? 0 : 1) - (b.basis === 'calendar' ? 0 : 1) ||
              (b.absentDays ?? -1) - (a.absentDays ?? -1),
          )
          .slice(0, input.limit ?? 100)
        return {
          header: mockReportHeader({
            input,
            slice,
            population: personIds.length,
            counted: measured.length,
            shown: shown.length,
            permissions: ['hr.report.view', 'hr.attendance.view_team'],
            attribution: 'each_day',
          }),
          finality: mergeMockFinality(
            measured.map((r) =>
              finalityOf(
                r.personId,
                dates.filter((date) => !isWeekend(date)),
              ),
            ),
          ),
          leaveCounted: true,
          totals: {
            measured: measured.length,
            expectedDays: expected,
            workedDays: worked,
            leaveDays: leave,
            absentDays: absent,
            absenceRate: mockRatio(absent, expected),
          },
          excluded: {
            noSchedule: rows.filter((r) => r.basis === 'no_schedule').length,
            noCalendar: rows.filter((r) => r.basis === 'no_calendar').length,
          },
          rows: shown,
        }
      },

      leaveBalance: async (input: {
        workspaceId: string
        periodYear?: number
        asOf?: string
        by?: ReportSliceBy
        sliceId?: string
        limit?: number
      }) => {
        const asOf = input.asOf ?? day(0)
        const periodYear = input.periodYear ?? Number(asOf.slice(0, 4))
        const { slice, personIds } = reportPopulation({ ...input, from: asOf, to: asOf })
        const types = leaveTypes.filter((lt) => lt.archivedAt === null)
        // Summed from the ledger and the live requests, exactly as `leave.balance.get` above does
        // for one person — so the tile and the report never disagree about the same number.
        const all = personIds.flatMap((personId) =>
          types.flatMap((lt) => {
            const balanceMinutes = ledger
              .filter(
                (e) => e.personId === personId && e.leaveTypeId === lt.id && e.periodYear === periodYear,
              )
              .reduce((sum, e) => sum + e.amountMinutes, 0)
            const mine = leaveRequests.filter((r) => r.personId === personId && r.leaveTypeId === lt.id)
            const minutesOf = (status: string) =>
              mine.filter((r) => r.status === status).reduce((sum, r) => sum + Number(r.minutes ?? 0), 0)
            const bookedMinutes = minutesOf('approved')
            const pendingMinutes = minutesOf('pending')
            if (!balanceMinutes && !bookedMinutes && !pendingMinutes) return []
            const perUnit = lt.unit === 'hour' ? 60 : 480
            const availableMinutes = balanceMinutes - pendingMinutes
            return [
              {
                personId,
                displayName: nameOf(personId),
                leaveTypeId: lt.id,
                leaveTypeName: lt.name,
                unit: lt.unit,
                order: lt.order,
                balanceMinutes,
                bookedMinutes,
                pendingMinutes,
                availableMinutes,
                balance: round2(balanceMinutes / perUnit),
                available: round2(availableMinutes / perUnit),
              },
            ]
          }),
        )
        const counted = [...new Set(all.map((r) => r.personId))].sort((a, b) =>
          nameOf(a).localeCompare(nameOf(b)),
        )
        const keep = new Set(counted.slice(0, input.limit ?? 100))
        const totals = new Map<
          string,
          {
            people: number
            balanceMinutes: number
            bookedMinutes: number
            pendingMinutes: number
            availableMinutes: number
          }
        >()
        for (const row of all) {
          const found = totals.get(row.leaveTypeId) ?? {
            people: 0,
            balanceMinutes: 0,
            bookedMinutes: 0,
            pendingMinutes: 0,
            availableMinutes: 0,
          }
          found.people += 1
          found.balanceMinutes += row.balanceMinutes
          found.bookedMinutes += row.bookedMinutes
          found.pendingMinutes += row.pendingMinutes
          found.availableMinutes += row.availableMinutes
          totals.set(row.leaveTypeId, found)
        }
        return {
          header: mockReportHeader({
            input: { from: asOf, to: asOf, by: input.by },
            slice,
            population: personIds.length,
            counted: counted.length,
            shown: keep.size,
            permissions: ['hr.report.view', 'hr.leave.view_team'],
            attribution: 'as_of_date',
            attributionOn: asOf,
          }),
          periodYear,
          dayLengthMinutes: 480,
          totals: types
            .filter((lt) => totals.has(lt.id))
            .map((lt) => ({
              leaveTypeId: lt.id,
              leaveTypeName: lt.name,
              unit: lt.unit,
              ...totals.get(lt.id)!,
            })),
          rows: all
            .filter((r) => keep.has(r.personId))
            .sort((a, b) => nameOf(a.personId).localeCompare(nameOf(b.personId)) || a.order - b.order)
            .map(({ order: _order, ...row }) => row),
        }
      },
    },

    rosters: {
      shifts: {
        list: async ({
          workspaceId,
          includeArchived = false,
        }: {
          workspaceId: string
          includeArchived?: boolean
        }) =>
          rosterShifts
            .filter((s) => includeArchived || s.archivedAt === null)
            .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name))
            .map((s) => ({ ...s, workspaceId })),

        create: async (input: {
          workspaceId: string
          name: string
          code?: string | null
          start: string
          end: string
          breakMinutes?: number
          graceInMinutes?: number
          graceOutMinutes?: number
          color?: string | null
        }) => {
          const created: Row<RosterShift> = {
            id: crypto.randomUUID(),
            name: input.name,
            code: input.code ?? null,
            start: input.start,
            end: input.end,
            breakMinutes: input.breakMinutes ?? 0,
            graceInMinutes: input.graceInMinutes ?? 0,
            graceOutMinutes: input.graceOutMinutes ?? 0,
            color: input.color ?? null,
            archivedAt: null,
          }
          rosterShifts.push(created)
          return { ...created, workspaceId: input.workspaceId }
        },

        update: async (input: {
          workspaceId: string
          shiftId: string
          name?: string
          code?: string | null
          start?: string
          end?: string
          breakMinutes?: number
          graceInMinutes?: number
          graceOutMinutes?: number
          color?: string | null
        }) => {
          const found = rosterShifts.find((s) => s.id === input.shiftId)
          if (!found) refuse('NOT_FOUND', 'Shift not found')
          if (input.name !== undefined) found.name = input.name
          if (input.code !== undefined) found.code = input.code ?? null
          if (input.start !== undefined) found.start = input.start
          if (input.end !== undefined) found.end = input.end
          if (input.breakMinutes !== undefined) found.breakMinutes = input.breakMinutes
          if (input.graceInMinutes !== undefined) found.graceInMinutes = input.graceInMinutes
          if (input.graceOutMinutes !== undefined) found.graceOutMinutes = input.graceOutMinutes
          if (input.color !== undefined) found.color = input.color ?? null
          return { ...found, workspaceId: input.workspaceId }
        },

        /** Archived, not deleted: rotations and changed days keep pointing at it. */
        archive: async ({ shiftId }: { workspaceId: string; shiftId: string }) => {
          const found = rosterShifts.find((s) => s.id === shiftId)
          if (found) found.archivedAt = iso()
          return { ok: true as const }
        },
      },

      patterns: {
        list: async ({
          workspaceId,
          includeArchived = false,
        }: {
          workspaceId: string
          includeArchived?: boolean
        }) =>
          rosterPatterns
            .filter((p) => includeArchived || p.archivedAt === null)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((p) => ({ ...p, days: clone(p.days), workspaceId })),

        create: async (input: {
          workspaceId: string
          name: string
          anchorDate: string
          days: string[][]
        }) => {
          assertRosterShiftsExist(input.days.flat())
          const created: Row<RosterPattern> = {
            id: crypto.randomUUID(),
            name: input.name,
            anchorDate: input.anchorDate,
            days: clone(input.days),
            archivedAt: null,
          }
          rosterPatterns.push(created)
          return { ...created, days: clone(created.days), workspaceId: input.workspaceId }
        },

        update: async (input: {
          workspaceId: string
          patternId: string
          name?: string
          anchorDate?: string
          days?: string[][]
        }) => {
          if (input.days) assertRosterShiftsExist(input.days.flat())
          const found = rosterPatterns.find((p) => p.id === input.patternId)
          if (!found) refuse('NOT_FOUND', 'Rotation not found')
          if (input.name !== undefined) found.name = input.name
          if (input.anchorDate !== undefined) found.anchorDate = input.anchorDate
          if (input.days !== undefined) found.days = clone(input.days)
          return { ...found, days: clone(found.days), workspaceId: input.workspaceId }
        },

        /** Hidden from the pickers, still read by everybody already on it. */
        archive: async ({ patternId }: { workspaceId: string; patternId: string }) => {
          const found = rosterPatterns.find((p) => p.id === patternId)
          if (found) found.archivedAt = iso()
          return { ok: true as const }
        },
      },

      assignments: async ({
        workspaceId,
        personId,
        patternId,
      }: {
        workspaceId: string
        personId?: string
        patternId?: string
      }) =>
        rosterAssignments
          .filter((a) => (!personId || a.personId === personId) && (!patternId || a.patternId === patternId))
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || a.id.localeCompare(b.id))
          .map((a) => ({ ...a, workspaceId })),

      /**
       * The router's two refusals, in its order and its words: somebody not in the workspace, and
       * somebody whose *later* assignment this one would have to trim backwards. An assignment
       * already running on the start date is closed the day before, as the server does it.
       */
      assign: async (input: {
        workspaceId: string
        patternId: string
        personIds: string[]
        effectiveFrom: string
        effectiveTo?: string | null
        cycleOffset?: number
      }) => {
        const pattern = rosterPatterns.find((p) => p.id === input.patternId)
        if (!pattern) refuse('NOT_FOUND', 'Rotation not found')
        const personIds = [...new Set(input.personIds)]
        if (personIds.some((personId) => !people.some((p) => p.id === personId)))
          refuse('BAD_REQUEST', 'This list names somebody who is not in this workspace.')
        const dayBefore = day(rosterDaysBetween(day(0), input.effectiveFrom) - 1)
        for (const a of rosterAssignments) {
          if (!personIds.includes(a.personId)) continue
          if (
            a.effectiveFrom <= dayBefore &&
            (a.effectiveTo === null || a.effectiveTo >= input.effectiveFrom)
          )
            a.effectiveTo = dayBefore
        }
        const clash = rosterAssignments
          .filter(
            (a) =>
              personIds.includes(a.personId) &&
              a.effectiveFrom >= input.effectiveFrom &&
              (!input.effectiveTo || a.effectiveFrom <= input.effectiveTo),
          )
          .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0]
        if (clash) {
          const who = people.find((p) => p.id === clash.personId)?.displayName ?? 'Somebody in this list'
          refuse(
            'BAD_REQUEST',
            `${who} already starts a rotation on ${clash.effectiveFrom}. End that one first, or give this assignment an end date before it.`,
          )
        }
        for (const personId of personIds) {
          rosterAssignments.push({
            id: crypto.randomUUID(),
            personId,
            patternId: input.patternId,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo ?? null,
            cycleOffset: input.cycleOffset ?? 0,
            createdAt: iso(),
          })
        }
        return rosterAssignments
          .filter((a) => personIds.includes(a.personId))
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || a.id.localeCompare(b.id))
          .map((a) => ({ ...a, workspaceId: input.workspaceId }))
      },

      /** Only assignments that have started by that date; one for next month is left alone. */
      unassign: async ({
        personIds,
        effectiveTo,
      }: {
        workspaceId: string
        personIds: string[]
        effectiveTo: string
      }) => {
        let closed = 0
        for (const a of rosterAssignments) {
          if (!personIds.includes(a.personId) || a.effectiveTo !== null || a.effectiveFrom > effectiveTo)
            continue
          a.effectiveTo = effectiveTo
          closed++
        }
        return { closed }
      },

      days: async ({
        workspaceId,
        personId,
        from,
        to,
      }: {
        workspaceId: string
        personId?: string
        from: string
        to: string
      }) => {
        const who = personId ?? people[0]!.id
        rosterRefusal({ from, to, coverage: false })
        return eachDate(from, to).map((date) => rosterDayFor(who, date, workspaceId))
      },

      /** One override per person-day: a second edit of the same Tuesday replaces the first. */
      set: async (input: {
        workspaceId: string
        personId: string
        businessDate: string
        shiftIds: string[]
        note?: string | null
      }) => {
        if (!people.some((p) => p.id === input.personId)) refuse('NOT_FOUND', 'Employee not found')
        assertRosterShiftsExist(input.shiftIds)
        const existing = rosterOverrides.find(
          (o) => o.personId === input.personId && o.businessDate === input.businessDate,
        )
        if (existing) {
          existing.shiftIds = [...input.shiftIds]
          existing.note = input.note ?? null
        } else {
          rosterOverrides.push({
            personId: input.personId,
            businessDate: input.businessDate,
            shiftIds: [...input.shiftIds],
            note: input.note ?? null,
          })
        }
        return rosterDayFor(input.personId, input.businessDate, input.workspaceId)
      },

      clear: async ({
        personId,
        businessDate,
      }: {
        workspaceId: string
        personId: string
        businessDate: string
      }) => {
        const at = rosterOverrides.findIndex(
          (o) => o.personId === personId && o.businessDate === businessDate,
        )
        if (at >= 0) rosterOverrides.splice(at, 1)
        return { ok: true as const }
      },

      /**
       * Who is on which shift, per day. The population is whoever a rotation covers in the range,
       * narrowed to one office through the office assignments when asked — the same two queries
       * the router runs, and the same rule that `none` belongs in neither column.
       */
      coverage: async ({
        workspaceId,
        from,
        to,
        officeId,
      }: {
        workspaceId: string
        from: string
        to: string
        officeId?: string
      }) => {
        rosterRefusal({ from, to, coverage: true })
        let personIds = [
          ...new Set(
            rosterAssignments
              .filter((a) => a.effectiveFrom <= to && (a.effectiveTo === null || a.effectiveTo >= from))
              .map((a) => a.personId),
          ),
        ]
        if (officeId) {
          const here = new Set(
            assignments
              .filter((a) => a.officeId === officeId && a.effectiveTo === null)
              .map((a) => a.personId),
          )
          personIds = personIds.filter((personId) => here.has(personId))
        }
        const dates = eachDate(from, to)
        if (!personIds.length) return dates.map((businessDate) => ({ businessDate, slots: [], off: [] }))
        rosterRefusal({ from, to, coverage: true, population: personIds.length })
        void workspaceId
        const named = (personId: string) => ({
          personId,
          displayName: people.find((p) => p.id === personId)?.displayName ?? '',
        })
        return dates.map((businessDate) => {
          // `Row<RosterShift>` plus a plain tenant: the brand is dropped here as everywhere else.
          const slots = new Map<
            string,
            { shift: Row<RosterShift> & { workspaceId: string }; people: string[] }
          >()
          const off: string[] = []
          for (const personId of personIds) {
            const plan = rosterPlanFor(personId, businessDate)
            if (plan.source === 'none') continue
            if (!plan.shiftIds.length) {
              off.push(personId)
              continue
            }
            for (const shift of rosterShiftRows(plan.shiftIds, workspaceId)) {
              const slot = slots.get(shift.id) ?? { shift, people: [] }
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
              .map((slot) => ({ shift: slot.shift, people: slot.people.map(named) })),
            off: off.map(named),
          }
        })
      },
    },

    policies: {
      list: async ({
        workspaceId,
        kind,
        includeArchived = false,
      }: {
        workspaceId: string
        kind?: string
        includeArchived?: boolean
      }) =>
        policies
          .filter((row) => (!kind || row.kind === kind) && (includeArchived || row.archivedAt === null))
          .map((row) => ({
            ...row,
            workspaceId,
            assignments: assignmentsOf(row.id).map((a) => ({ ...a, workspaceId })),
          })),

      get: async ({ workspaceId, policyId }: { workspaceId: string; policyId: string }) => {
        const found = policies.find((row) => row.id === policyId)
        if (!found) refuse('NOT_FOUND', 'Policy not found')
        return {
          ...found,
          workspaceId,
          assignments: assignmentsOf(found.id).map((a) => ({ ...a, workspaceId })),
        }
      },

      create: async (input: {
        workspaceId: string
        kind: Policy['kind']
        name: string
        config: Record<string, unknown>
        effectiveFrom: string
        effectiveTo?: string | null
      }) => {
        const created: Row<Policy> = {
          id: crypto.randomUUID(),
          kind: input.kind,
          name: input.name,
          config: clone(input.config),
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          source: 'custom',
          packKey: null,
          // A hash of the config, because that is what a derived row records — a literal would make
          // every policy look identical to a recomputation deciding whether a figure is stale.
          configHash: Math.abs(
            [...JSON.stringify(input.config)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7),
          )
            .toString(16)
            .padStart(8, '0'),
          archivedAt: null,
        }
        policies.push(created)
        return { ...created, workspaceId: input.workspaceId }
      },

      update: async (input: {
        workspaceId: string
        policyId: string
        name?: string
        config?: Record<string, unknown>
        effectiveTo?: string | null
      }) => {
        const found = policies.find((row) => row.id === input.policyId)
        if (!found) refuse('NOT_FOUND', 'Policy not found')
        if (input.name !== undefined) found.name = input.name
        if (input.config !== undefined) found.config = clone(input.config)
        if (input.effectiveTo !== undefined) found.effectiveTo = input.effectiveTo
        return { ...found, workspaceId: input.workspaceId }
      },

      /**
       * Archived, never deleted, and **the assignments are left where they are**.
       *
       * The router neither refuses nor cascades — a ledger entry names the policy that produced it,
       * so a movement whose policy had vanished would be a number nobody can explain. That means an
       * archived policy with live assignments is a state an administrator genuinely reaches, and the
       * fixture can reach it too rather than only in theory.
       */
      archive: async ({ policyId }: { workspaceId: string; policyId: string }) => {
        const found = policies.find((row) => row.id === policyId)
        if (!found) refuse('NOT_FOUND', 'Policy not found')
        found.archivedAt = iso()
        return { ok: true as const }
      },

      assign: async (input: {
        workspaceId: string
        policyId: string
        subjectKind: PolicySubjectKind
        subjectId?: string | null
        effectiveFrom: string
        effectiveTo?: string | null
      }) => {
        const created: Row<PolicyAssignment> = {
          id: crypto.randomUUID(),
          policyId: input.policyId,
          subjectKind: input.subjectKind,
          // `workspace` needs no id, and storing one would make the rung look narrower than it is.
          subjectId: input.subjectKind === 'workspace' ? null : (input.subjectId ?? null),
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          priority: PRIORITY[input.subjectKind],
        }
        policyAssignments.push(created)
        return { ...created, workspaceId: input.workspaceId }
      },

      unassign: async ({ assignmentId }: { workspaceId: string; assignmentId: string }) => {
        const at = policyAssignments.findIndex((a) => a.id === assignmentId)
        if (at < 0) refuse('NOT_FOUND', 'Policy assignment not found')
        policyAssignments.splice(at, 1)
        return { ok: true as const }
      },

      resolveFor: async ({ workspaceId, personId }: { workspaceId: string; personId: string }) => {
        const applicable = resolvePolicyFor(personId)
        void workspaceId
        return applicable
          ? [
              {
                kind: 'accrual' as const,
                policyId: applicable.policy.id,
                policyName: applicable.policy.name,
                config: applicable.policy.config,
                from: applicable.assignment.subjectKind,
                subjectId: applicable.assignment.subjectId,
              },
            ]
          : []
      },
    },

    accrual: {
      /**
       * A query, and it **writes nothing**.
       *
       * The contract makes it a query for exactly this reason: a preview that filed ledger entries
       * would credit everybody the moment somebody looked at the screen meant to tell them what a
       * run *would* do. It returns the same rows `run` credits from, so the two cannot disagree.
       */
      preview: async ({
        workspaceId,
        from,
        to,
        personId,
      }: {
        workspaceId: string
        from: string
        to: string
        personId?: string
      }) => {
        void workspaceId
        return accrualRows(from, to, personId)
      },

      /**
       * Credits the ledger, and is idempotent per person, per leave type, per period.
       *
       * A second run over the same window credits nothing, because every row it would write is
       * already `alreadyAccrued` — an accrual job that double-credits when somebody clicks twice is
       * worse than one that never ran.
       */
      run: async ({
        workspaceId,
        from,
        to,
        personId,
      }: {
        workspaceId: string
        from: string
        to: string
        personId?: string
      }) => {
        void workspaceId
        const preview = accrualRows(from, to, personId)
        let credited = 0
        let totalMinutes = 0
        for (const row of preview.rows) {
          if (row.alreadyAccrued) continue
          ledger.push(
            entry(row.personId, row.leaveTypeId, 'accrual', row.minutes, to, { reason: row.reason }),
          )
          credited += 1
          totalMinutes += row.minutes
        }
        return {
          credited,
          // Everything the run passed over: those already credited, and those it never reached.
          skipped: preview.skipped.length + preview.rows.filter((r) => r.alreadyAccrued).length,
          totalMinutes,
        }
      },
    },

    payroll: {
      export: {
        /**
         * The same rows the server would hand back, with every refusal returned rather than thrown.
         *
         * Built from the seeds above the way `PayrollExportService.collect` builds them from the
         * tables: the population is everybody the ladder puts in the entity on some day of the
         * period, the hours are the day sheets summed, the leave is approved days grouped by type.
         */
        preview: async (input: {
          workspaceId: string
          legalEntityId: string
          periodId: string
          draft?: boolean
        }): Promise<PayrollExportPreview> => {
          const data = collectPayroll(
            input.workspaceId,
            input.legalEntityId,
            input.periodId,
            input.draft ?? false,
          )
          return {
            manifest: data.manifest,
            refusals: data.refusals,
            exportable: data.refusals.length === 0,
            totals: data.totals,
            hours: data.hours,
            leave: data.leave,
          }
        },

        /** Throws the first refusal with its code, exactly as the router does, or writes the three files. */
        v1: async (input: {
          workspaceId: string
          legalEntityId: string
          periodId: string
          draft?: boolean
        }): Promise<PayrollExport> => {
          const data = collectPayroll(
            input.workspaceId,
            input.legalEntityId,
            input.periodId,
            input.draft ?? false,
          )
          const [first] = data.refusals
          if (first) refuse('CONFLICT', first.message, first.code)
          const header = [
            PAYROLL_EXPORT_CONTRACT,
            data.manifest.legalEntityId,
            data.manifest.legalEntityName,
            data.manifest.periodStart,
            data.manifest.periodEnd,
          ]
          const dec = (n: number) => (Math.round(n * 100) / 100 || 0).toFixed(2)
          const int = (n: number) => String(Math.round(n))
          const bool = (b: boolean) => (b ? 'true' : 'false')
          const hoursRows = data.hours.map((r) => [
            ...header,
            r.personId,
            r.employeeNo,
            r.displayName,
            r.employmentType,
            dec(r.fte),
            r.contractHoursWeek === null ? null : dec(r.contractHoursWeek),
            r.costCenterCode,
            r.positionTitle,
            r.hiredOn,
            r.terminatedOn,
            bool(r.employmentChangedInPeriod),
            int(r.daySheets),
            int(r.scheduledMinutes),
            int(r.workedMinutes),
            int(r.scheduledWorkedMinutes),
            int(r.breakMinutes),
            int(r.overtimeMinutes),
            int(r.lateMinutes),
            int(r.earlyLeaveMinutes),
            // Empty, never `0`: the field the whole format exists to get right.
            r.beyondCapMinutes === null ? null : int(r.beyondCapMinutes),
            int(r.cappedDays),
            int(r.uncappedDays),
            int(r.lockedDays),
            int(r.openDays),
            dec(r.paidLeaveDays),
            dec(r.unpaidLeaveDays),
          ])
          const leaveRows = data.leave.map((r) => [
            ...header,
            r.personId,
            r.employeeNo,
            r.leaveTypeKey,
            r.leaveTypeName,
            bool(r.paid),
            r.unit,
            dec(r.days),
            int(r.requests),
          ])
          const [hoursFile, leaveFile] = data.manifest.files
          return {
            manifest: data.manifest,
            files: [
              {
                name: hoursFile?.name ?? '',
                contentType: 'text/csv; charset=utf-8',
                content: csvDocument(PAYROLL_HOURS_COLUMNS, hoursRows),
              },
              {
                name: leaveFile?.name ?? '',
                contentType: 'text/csv; charset=utf-8',
                content: csvDocument(PAYROLL_LEAVE_COLUMNS, leaveRows),
              },
              {
                name: payrollFilename(
                  data.manifest.legalEntityName,
                  data.manifest,
                  'manifest',
                  data.manifest.draft,
                ),
                contentType: 'application/json; charset=utf-8',
                content: `${JSON.stringify(data.manifest, null, 2)}\n`,
              },
            ],
          }
        },
      },
    },

    periods: {
      list: async ({
        workspaceId,
        kind,
        limit = 50,
      }: {
        workspaceId: string
        kind?: string
        limit?: number
      }) => {
        const items = periods
          .filter((row) => !kind || row.kind === kind)
          .slice()
          .sort((a, b) => b.startsOn.localeCompare(a.startsOn))
        return { items: items.slice(0, limit).map((row) => ({ ...row, workspaceId })), nextCursor: null }
      },

      create: async (input: {
        workspaceId: string
        kind?: Period['kind']
        legalEntityId?: string | null
        startsOn: string
        endsOn: string
      }) => {
        if (input.endsOn < input.startsOn) refuse('BAD_REQUEST', 'A period cannot end before it starts.')
        const created: Row<Period> = {
          id: crypto.randomUUID(),
          kind: input.kind ?? 'payroll',
          legalEntityId: input.legalEntityId ?? null,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          status: 'open',
          lockedAt: null,
          lockedBy: null,
          note: null,
        }
        periods.push(created)
        return { ...created, workspaceId: input.workspaceId }
      },

      lock: async (input: { workspaceId: string; periodId: string; note?: string | null }) => {
        const found = periods.find((row) => row.id === input.periodId)
        if (!found) refuse('NOT_FOUND', 'Period not found')
        if (found.status === 'locked') refuse('CONFLICT', 'That period is already locked.')
        found.status = 'locked'
        found.lockedAt = iso()
        found.note = input.note ?? null
        return {
          ...found,
          workspaceId: input.workspaceId,
          lockedDays: workingDaysIn(found.startsOn, found.endsOn),
        }
      },

      /**
       * Reopens it. No refusal for a period that is already open — the router has none either, and
       * inventing one here would be a rule the server does not have.
       */
      unlock: async (input: { workspaceId: string; periodId: string; reason: string }) => {
        const found = periods.find((row) => row.id === input.periodId)
        if (!found) refuse('NOT_FOUND', 'Period not found')
        const days = found.status === 'locked' ? workingDaysIn(found.startsOn, found.endsOn) : 0
        found.status = 'open'
        found.lockedAt = null
        found.lockedBy = null
        found.note = `Reopened: ${input.reason}`
        return { ...found, workspaceId: input.workspaceId, unlockedDays: days }
      },
    },

    approvals: {
      /**
       * Both tabs have something in them on purpose.
       *
       * A demo whose "Decided" tab is empty looks like a broken filter rather than an empty
       * history, and the two-step request is what shows the step counter at all.
       */
      /**
       * Everything waiting on this reader — including what they may decide by delegation — or,
       * with `status: 'decided'`, everything already settled. The two are exclusive.
       *
       * The scope check is the half that is easy to miss: a delegation may be narrower than the
       * person who granted it, so whether a step is actionable depends on the *request's* subject
       * type and cannot be answered from the step alone.
       */
      inbox: async ({
        workspaceId,
        status = 'pending',
        limit = 50,
      }: {
        workspaceId: string
        status?: 'pending' | 'decided'
        limit?: number
      }) => {
        const items = approvalRequests
          .filter((r) => (status === 'pending' ? r.status === 'pending' : r.status !== 'pending'))
          .filter((r) =>
            mayDecide(
              (r.steps as Array<{ approverIds?: string[] }>).flatMap((st) => st.approverIds ?? []),
              r.subjectType,
            ),
          )
          .map((r) => ({ ...r, workspaceId }))
        return { items: items.slice(0, limit), nextCursor: null }
      },

      get: async ({ workspaceId, requestId }: { workspaceId: string; requestId: string }) => {
        const found = approvalRequests.find((r) => r.id === requestId)
        if (!found) refuse('NOT_FOUND', 'Approval request not found')
        return { ...found, workspaceId }
      },

      /**
       * Records who decided, and in whose place.
       *
       * The two ids mean opposite things on the two sides, which is easy to get backwards: on the
       * way in, `onBehalfOfId` is *whose place you are taking*; on the stored row, `approverId` is
       * the person the step actually names and `onBehalfOfId` is *whose hands it was*. That is what
       * lets the decided row read "decided by Ayşe for Sanne" rather than losing one of the two
       * names. `approvals.ts` does the same swap.
       */
      decide: async ({
        workspaceId,
        requestId,
        decision,
        comment = null,
        onBehalfOfId = null,
      }: {
        workspaceId: string
        requestId: string
        decision: 'approve' | 'reject'
        comment?: string | null
        onBehalfOfId?: string | null
      }) => {
        const found = approvalRequests.find((r) => r.id === requestId)
        if (!found) refuse('NOT_FOUND', 'Approval request not found')
        const me = people[0]!.id
        const actingAs = onBehalfOfId ?? me
        const current = found.steps[found.currentStep] as
          | { id: string; approverIds?: string[]; status?: string; decisions?: unknown[] }
          | undefined
        // The same two refusals the service raises, in its words: being on the step is not the same
        // question as holding a delegation from somebody who is.
        if (current?.approverIds && !current.approverIds.includes(actingAs)) {
          refuse('FORBIDDEN', 'You are not an approver on this step')
        }
        if (
          onBehalfOfId &&
          !delegations.some(
            (d) =>
              d.fromPersonId === onBehalfOfId &&
              d.toPersonId === me &&
              // Null is the wildcard — a delegation scoped to another subject type does not cover
              // this request, and one scoped to nothing covers everything. `mayActFor` matches the
              // null explicitly for the same reason.
              (d.subjectType === null || d.subjectType === found.subjectType) &&
              String(d.startsOn) <= day(0) &&
              String(d.endsOn) >= day(0),
          )
        ) {
          refuse('FORBIDDEN', 'You do not hold a delegation from that person for this')
        }
        if (current) {
          current.decisions = [
            ...(current.decisions ?? []),
            {
              id: crypto.randomUUID(),
              stepId: current.id,
              approverId: actingAs,
              onBehalfOfId: onBehalfOfId ? me : null,
              decision,
              comment,
              at: iso(),
            },
          ]
          current.status = decision === 'approve' ? 'approved' : 'rejected'
        }
        // A middle step advances rather than settling: the inbox has to be able to show that.
        const last = found.currentStep >= Math.max(found.steps.length - 1, 0)
        if (decision === 'reject' || last) found.status = decision === 'approve' ? 'approved' : 'rejected'
        else found.currentStep += 1
        found.decidedAt = found.status === 'pending' ? null : iso()
        return { ...found, workspaceId }
      },

      chains: {
        /** Archived chains are gone from here: the list is what a request can still be routed by. */
        list: async ({ workspaceId, subjectType }: { workspaceId: string; subjectType?: string }) =>
          chains
            .filter((c) => c.archivedAt === null && (!subjectType || c.subjectType === subjectType))
            .map((c) => ({ ...c, workspaceId })),

        create: async (input: {
          workspaceId: string
          name: string
          subjectType: ApprovalChain['subjectType']
          spec: ApprovalChainSpec
          isDefault?: boolean
        }) => {
          const created: Row<ApprovalChain> = {
            id: crypto.randomUUID(),
            name: input.name,
            subjectType: input.subjectType,
            spec: clone(input.spec),
            isDefault: input.isDefault ?? false,
            archivedAt: null,
          }
          chains.push(created)
          // Exactly one default per subject type: promoting this one demotes whichever held it.
          if (created.isDefault) clearDefaultChain(created.subjectType, created.id)
          return { ...created, workspaceId: input.workspaceId }
        },

        update: async (input: {
          workspaceId: string
          chainId: string
          name?: string
          spec?: ApprovalChainSpec
          isDefault?: boolean
        }) => {
          const found = chains.find((c) => c.id === input.chainId)
          if (!found) refuse('NOT_FOUND', 'Approval chain not found')
          if (input.name !== undefined) found.name = input.name
          if (input.spec !== undefined) found.spec = clone(input.spec)
          if (input.isDefault !== undefined) found.isDefault = input.isDefault
          if (found.isDefault) clearDefaultChain(found.subjectType, found.id)
          return { ...found, workspaceId: input.workspaceId }
        },

        archive: async ({ chainId }: { workspaceId: string; chainId: string }) => {
          const found = chains.find((c) => c.id === chainId)
          if (!found) refuse('NOT_FOUND', 'Approval chain not found')
          found.archivedAt = iso()
          return { ok: true as const }
        },
      },

      delegations: async ({ workspaceId }: { workspaceId: string }) =>
        delegations.map((d) => ({ ...d, workspaceId })),

      delegate: async ({
        workspaceId,
        toPersonId,
        startsOn,
        endsOn,
        subjectType = null,
        reason = null,
      }: {
        workspaceId: string
        toPersonId: string
        startsOn: string
        endsOn: string
        subjectType?: string | null
        reason?: string | null
      }) => {
        const created = {
          id: crypto.randomUUID(),
          workspaceId,
          fromPersonId: people[0]!.id,
          toPersonId,
          subjectType,
          startsOn,
          endsOn,
          reason,
          createdAt: iso(),
        }
        delegations.push(created)
        return created
      },

      revokeDelegation: async ({ delegationId }: { delegationId: string }) => {
        const at = delegations.findIndex((d) => d.id === delegationId)
        if (at >= 0) delegations.splice(at, 1)
        return { ok: true }
      },
    },

    /**
     * Subject access, erasure and retention, on the same positions the server takes: nothing is
     * deleted, an erasure clears columns and reports what stayed, a preview and a run are one
     * predicate, and an export is a logged read of the sensitive record.
     */
    privacy: {
      retention: {
        get: async ({ workspaceId, withCounts = false }: { workspaceId: string; withCounts?: boolean }) =>
          retentionState(workspaceId, withCounts),
        set: async ({
          workspaceId,
          retention: patch,
        }: {
          workspaceId: string
          retention: Partial<Record<RetentionClass, number | null>>
        }) => {
          // A field left out is unchanged; a field sent as null goes back to "keep indefinitely".
          for (const [key, value] of Object.entries(patch)) retention[key as RetentionClass] = value ?? null
          retentionUpdatedAt = iso()
          retentionUpdatedBy = HR_ACCOUNT
          return retentionState(workspaceId, false)
        },
      },

      accessLog: {
        list: async ({
          workspaceId,
          personId,
          actorUserId,
          cursor,
          limit = 50,
        }: {
          workspaceId: string
          personId?: string
          actorUserId?: string
          cursor?: string
          limit?: number
        }) => {
          // The caller's own record when none is named — `people.me` is Ayşe here, as everywhere.
          const subject = actorUserId ? personId : (personId ?? people[0]!.id)
          const rows = accessLog
            .filter((a) => (subject ? a.personId === subject : true))
            .filter((a) => (actorUserId ? a.actorUserId === actorUserId : true))
            .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
          const start = cursor ? Number(cursor) : 0
          const items = rows.slice(start, start + limit).map((r) => ({ ...r, workspaceId }))
          return { items, nextCursor: start + limit < rows.length ? String(start + limit) : null }
        },
      },

      subjectAccess: async ({
        workspaceId,
        personId,
        purpose,
      }: {
        workspaceId: string
        personId: string
        purpose?: string | null
      }) => {
        const found = people.find((p) => p.id === personId)
        if (!found) refuse('NOT_FOUND', 'Person not found')
        // The decrypt is a bulk read of the sensitive record, and it is logged before the bundle
        // leaves — the subject sees this row in their own log.
        logRead(personId, 'export', purpose ?? null)
        const sens = sensitive.find((x) => x.personId === personId)
        const mine = <T extends { personId: string }>(rows: T[]) =>
          rows.filter((r) => r.personId === personId).map((r) => ({ ...r, workspaceId }))
        const ofPerson = (rows: Array<Record<string, unknown>>, key: string) =>
          rows.filter((r) => r[key] === personId).map((r) => ({ ...r, workspaceId }))
        // Oldest first, so the running balance in the bundle reads down the ledger.
        const myLedger = mine(ledger).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
        const myPunches = mine(punches).sort((a, b) => b.at.localeCompare(a.at))
        const dates = [...new Set(myPunches.map((p) => p.businessDate))].sort().reverse()
        return {
          manifest: {
            workspaceId,
            personId,
            generatedAt: iso(),
            generatedBy: HR_ACCOUNT,
            moduleVersion: 'mock',
            truncated: [],
            excluded: [{ section: 'documents.contents', reason: 'fileContentsNotExportable' as const }],
          },
          person: person(found, workspaceId),
          sensitive: {
            workspaceId,
            personId,
            nationalId: sens?.nationalId ?? null,
            birthDate: sens?.birthDate ?? null,
            iban: sens?.iban ?? null,
            emergencyContact: sens?.emergencyContact ?? null,
          },
          employment: mine(employments),
          offices: mine(assignments),
          history: [],
          documents: mine(documents),
          leave: {
            types: leaveTypes.map((lt) => ({ ...lt, workspaceId })),
            requests: ofPerson(leaveRequests, 'personId'),
            days: [],
            ledger: myLedger,
            closingBalanceMinutes: myLedger.reduce((sum, e) => sum + e.amountMinutes, 0),
          },
          attendance: { punches: myPunches, days: dates.map((d) => attendanceDay(d, personId, workspaceId)) },
          regularizations: mine(regularizations),
          approvals: {
            raised: approvalRequests
              .filter((r) => r.requesterPersonId === personId)
              .map((r) => ({ ...r, workspaceId })),
            approverOn: [],
            decisions: [],
          },
          delegations: {
            given: ofPerson(delegations, 'fromPersonId'),
            received: ofPerson(delegations, 'toPersonId'),
          },
          policiesInForce: [],
          accessLog: accessLog
            .filter((a) => a.personId === personId)
            .sort((a, b) => b.at.localeCompare(a.at))
            .map((a) => ({ ...a, workspaceId })),
        }
      },

      /**
       * Redact one person, or say what redacting them would do.
       *
       * `dryRun` defaults to true here as in the contract. Every step matches only rows that still
       * have something to clear, so a second run reports zero everywhere and keeps the first
       * erasure's date — the two properties the settings screen's preview and confirmation rest on.
       */
      erase: async (input: {
        workspaceId: string
        personId: string
        dryRun?: boolean
        reason?: string | null
        keepNationalIdForAudit?: boolean
      }) => {
        const found = people.find((p) => p.id === input.personId)
        if (!found) refuse('NOT_FOUND', 'Person not found')
        const dryRun = input.dryRun ?? true
        const keepId = input.keepNationalIdForAudit ?? false
        const token = erasureToken(found)
        const already = erasedPeople.get(found.id) ?? null
        const sens = sensitive.find((x) => x.personId === found.id)
        const sensitiveDirty =
          sens !== undefined &&
          (sens.birthDate !== null ||
            sens.iban !== null ||
            sens.emergencyContact !== null ||
            (!keepId && sens.nationalId !== null))
        const dirtyPunches = punches.filter(
          (p) =>
            p.personId === found.id &&
            (p.geo !== null || p.deviceId !== null || p.note !== null || p.clientReportedAt !== null),
        )
        const myRequests = leaveRequests.filter(
          (r) => r.personId === found.id && (r.reason != null || r.documentFileId != null),
        )
        const myLedger = ledger.filter((e) => e.personId === found.id && e.reason !== null)
        const myEmployments = employments.filter((e) => e.personId === found.id && e.reason !== null)
        const myAssignments = assignments.filter((a) => a.personId === found.id && a.reason !== null)
        const myRegs = regularizations.filter((r) => r.personId === found.id && r.reason !== '')
        const myDelegations = delegations.filter(
          (d) => (d.fromPersonId === found.id || d.toPersonId === found.id) && d.reason != null,
        )
        const myApprovals = approvalRequests.filter(
          (r) => r.requesterPersonId === found.id && (r.summary !== '' || r.summaryParams !== null),
        )
        const unitHeadships = orgUnits.filter((u) => u.headPersonId === found.id)
        const officeHeadships = offices.filter((o) => o.headPersonId === found.id)

        const steps: Array<ErasureRedaction & { apply: () => void }> = [
          {
            class: 'identity',
            table: 'people',
            rows: already ? 0 : 1,
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
            apply: () => {
              found.displayName = token
              found.workEmail = ''
              customValues[found.id] = {}
              erasedPeople.set(found.id, iso())
            },
          },
          {
            class: 'sensitive',
            table: 'people_sensitive',
            rows: sensitiveDirty ? 1 : 0,
            columns: keepId
              ? ['birthDate', 'iban', 'emergencyContact']
              : ['nationalId', 'birthDate', 'iban', 'emergencyContact'],
            apply: () => {
              if (!sens) return
              if (!keepId) sens.nationalId = null
              sens.birthDate = null
              sens.iban = null
              sens.emergencyContact = null
            },
          },
          {
            class: 'headship',
            table: 'offices',
            rows: officeHeadships.length,
            columns: ['headPersonId'],
            apply: () => {
              for (const o of officeHeadships) o.headPersonId = null
            },
          },
          {
            class: 'headship',
            table: 'org_units',
            rows: unitHeadships.length,
            columns: ['headPersonId'],
            apply: () => {
              for (const u of unitHeadships) u.headPersonId = null
            },
          },
          // The mock keeps no person history, so there is nothing to clear and nothing to keep.
          { class: 'history', table: 'person_history', rows: 0, columns: ['from', 'to'], apply: () => {} },
          {
            class: 'punches',
            table: 'punches',
            rows: dirtyPunches.length,
            columns: ['geo', 'deviceId', 'note', 'clientReportedAt'],
            apply: () => {
              for (const p of dirtyPunches) {
                p.geo = null
                p.deviceId = null
                p.note = null
                p.clientReportedAt = null
              }
            },
          },
          {
            class: 'leaveRequests',
            table: 'leave_requests',
            rows: myRequests.length,
            columns: ['reason', 'documentFileId'],
            apply: () => {
              for (const r of myRequests) {
                r.reason = null
                r.documentFileId = null
              }
            },
          },
          {
            class: 'leaveLedger',
            table: 'leave_ledger',
            rows: myLedger.length,
            columns: ['reason'],
            apply: () => {
              for (const e of myLedger) e.reason = null
            },
          },
          {
            class: 'employment',
            table: 'employments',
            rows: myEmployments.length,
            columns: ['reason'],
            apply: () => {
              for (const e of myEmployments) e.reason = null
            },
          },
          {
            class: 'officeAssignments',
            table: 'office_assignments',
            rows: myAssignments.length,
            columns: ['reason'],
            apply: () => {
              for (const a of myAssignments) a.reason = null
            },
          },
          {
            class: 'regularizations',
            table: 'regularizations',
            rows: myRegs.length,
            columns: ['reason'],
            apply: () => {
              for (const r of myRegs) r.reason = ''
            },
          },
          {
            class: 'delegations',
            table: 'delegations',
            rows: myDelegations.length,
            columns: ['reason'],
            apply: () => {
              for (const d of myDelegations) d.reason = null
            },
          },
          {
            class: 'approvals',
            table: 'approval_requests',
            rows: myApprovals.length,
            columns: ['summary', 'summaryParams', 'chain'],
            apply: () => {
              for (const r of myApprovals) {
                r.summary = ''
                r.summaryParams = null
                r.requesterName = token
              }
            },
          },
          {
            class: 'approvalDecisions',
            table: 'approval_decisions',
            rows: 0,
            columns: ['comment'],
            apply: () => {},
          },
        ]
        const redacted: ErasureRedaction[] = steps.map(({ apply, ...step }) => {
          if (step.rows > 0 && !dryRun) apply()
          return step
        })

        const basis = (days: number | null, fallback: ErasureRetained['basis']): ErasureRetained['basis'] =>
          days === null ? fallback : 'retentionHorizon'
        const countOf = (rows: ReadonlyArray<{ personId: string }>) =>
          rows.filter((r) => r.personId === found.id).length
        const kept: ErasureRetained[] = [
          {
            class: 'employment',
            table: 'employments',
            rows: countOf(employments),
            basis: 'payRecord',
            retentionDays: null,
          },
          {
            class: 'officeAssignments',
            table: 'office_assignments',
            rows: countOf(assignments),
            basis: 'payRecord',
            retentionDays: null,
          },
          {
            class: 'leaveLedger',
            table: 'leave_ledger',
            rows: countOf(ledger),
            basis: basis(retention.leave, 'payRecord'),
            retentionDays: retention.leave,
          },
          {
            class: 'leaveRequests',
            table: 'leave_requests',
            rows: leaveRequests.filter((r) => r.personId === found.id).length,
            basis: basis(retention.leave, 'payRecord'),
            retentionDays: retention.leave,
          },
          {
            class: 'attendance',
            table: 'attendance_days',
            rows: new Set(punches.filter((p) => p.personId === found.id).map((p) => p.businessDate)).size,
            basis: basis(retention.attendanceDays, 'payRecord'),
            retentionDays: retention.attendanceDays,
          },
          {
            class: 'punches',
            table: 'punches',
            rows: countOf(punches),
            basis: basis(retention.punches, 'payRecord'),
            retentionDays: retention.punches,
          },
          {
            class: 'history',
            table: 'person_history',
            rows: 0,
            basis: basis(retention.personHistory, 'auditTrail'),
            retentionDays: retention.personHistory,
          },
          {
            class: 'history',
            table: 'person_history',
            rows: 0,
            basis: 'anotherPersonsRecord',
            retentionDays: null,
          },
          {
            class: 'documents',
            table: 'person_documents',
            rows: countOf(documents),
            basis: 'notRemovable',
            retentionDays: retention.personDocuments,
          },
          {
            class: 'approvals',
            table: 'approval_requests',
            rows: approvalRequests.filter((r) => r.requesterPersonId === found.id).length,
            basis: 'auditTrail',
            retentionDays: null,
          },
        ]
        const caveats: ErasureCaveat[] = []
        if (keepId) caveats.push('nationalIdKeptForAudit')
        if (kept.some((k) => k.class === 'documents' && k.rows > 0)) caveats.push('documentFilesRemain')

        return {
          workspaceId: input.workspaceId,
          personId: found.id,
          dryRun,
          // A replay keeps the first erasure's date rather than restamping it.
          erasedAt: already ?? (dryRun ? null : (erasedPeople.get(found.id) ?? null)),
          displayName: token,
          redacted,
          kept,
          caveats,
          filesRemaining: [],
        }
      },
    },
  }

  /** Kept, not just returned: expanding today's row after clocking in has to show the punch. */
  function mockPunch(direction: Punch['direction']) {
    const row = punch(day(0), '00:00', direction, { at: new Date().toISOString() })
    punches.push(row)
    return { ...row, workspaceId: '' }
  }

  /**
   * One day's sheet, derived the way the server's is.
   *
   * `firstIn` and `lastOut` are read off the live punches rather than stated beside them, so a void
   * or a fresh clock-in moves the header of the panel it sits above instead of contradicting it.
   */
  function attendanceDay(date: string, personId: string, workspaceId: string) {
    const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!
    const weekend = weekday === 'sat' || weekday === 'sun'
    const live = punches
      .filter((row) => row.personId === personId && row.businessDate === date && !row.voidedByPunchId)
      .sort((a, b) => a.at.localeCompare(b.at))
    const firstIn = live.find((row) => row.direction === 'in')?.at ?? null
    const lastOut = [...live].reverse().find((row) => row.direction === 'out')?.at ?? null

    const leave = date === WD[2]
    // A day whose clock-out never arrived. It is the only seeded anomaly, and without one the
    // counted badge on the row and the list of sentences inside the panel are both unreachable.
    const unclosed = date === WD[3]
    const overtime = date === WD[1] ? 45 : 0
    const worked = weekend || leave ? 0 : unclosed ? 240 : 480 + overtime

    return {
      id: id(`a${date.replaceAll('-', '')}`),
      workspaceId,
      personId,
      businessDate: date,
      scheduledMinutes: weekend ? 0 : 480,
      workedMinutes: date === day(0) && clockedInAt === null ? 0 : worked,
      breakMinutes: weekend || leave ? 0 : 60,
      overtimeMinutes: overtime,
      // Null, not zero: the demo workspace has no overtime policy with an annual cap, and
      // "no ceiling applied" is a different fact from "one applied and nothing exceeded it".
      beyondCapMinutes: null,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      status: weekend
        ? ('weekend' as const)
        : leave
          ? ('leave' as const)
          : unclosed || date === day(0)
            ? ('pending' as const)
            : ('present' as const),
      leaveRequestId: leave ? ((leaveRequests[0]?.id as string | null) ?? null) : null,
      anomalies: unclosed ? ['missing_clock_out'] : [],
      firstIn,
      lastOut: unclosed ? null : lastOut,
      policyHash: null,
      locked: false,
      computedAt: iso(),
    }
  }

  // ---------------------------------------------------------------- payroll export

  /**
   * Which entity a person belonged to on a date: their employment's, else their primary office's.
   *
   * The same ladder `ReportsService.population` walks per date, and the half that matters here is
   * the fallback — somebody with an office and no employment row is in the entity's file through
   * their desk, which is exactly the person the export refuses to pay.
   */
  function entityOn(personId: string, date: string): string | null {
    const employment = employments.find(
      (e) =>
        e.personId === personId &&
        e.effectiveFrom <= date &&
        (e.effectiveTo === null || e.effectiveTo >= date),
    )
    if (employment?.legalEntityId) return employment.legalEntityId
    const primary = assignments.find(
      (a) =>
        a.personId === personId &&
        a.isPrimary &&
        a.effectiveFrom <= date &&
        (a.effectiveTo === null || a.effectiveTo >= date),
    )
    return primary ? (offices.find((o) => o.id === primary.officeId)?.legalEntityId ?? null) : null
  }

  /** RFC 4180: a comma, a quote, a line break or edge whitespace gets the field quoted. Null is empty. */
  function csvField(value: string | null): string {
    if (value === null) return ''
    return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  }

  /** BOM, the column names, then the rows, CRLF — the frozen v1 encoding. */
  function csvDocument(
    columns: readonly string[],
    rows: ReadonlyArray<ReadonlyArray<string | null>>,
  ): string {
    const line = (fields: ReadonlyArray<string | null>) => `${fields.map(csvField).join(',')}\r\n`
    return `﻿${line(columns)}${rows.map(line).join('')}`
  }

  /** `kern-payroll-v1_kern-teknoloji-a-s_2026-06_DRAFT_hours.csv`, spelled the way the server spells it. */
  function payrollFilename(
    entityName: string,
    period: { periodStart: string; periodEnd: string },
    file: 'hours' | 'leave' | 'manifest',
    draft: boolean,
  ): string {
    const slug =
      entityName
        .replace(/[ıİ]/g, 'i')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'entity'
    const [year, month, first] = period.periodStart.split('-')
    const lastOfMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    const wholeMonth =
      first === '01' && period.periodEnd === `${year}-${month}-${String(lastOfMonth).padStart(2, '0')}`
    const label = wholeMonth ? `${year}-${month}` : `${period.periodStart}_${period.periodEnd}`
    const extension = file === 'manifest' ? 'json' : 'csv'
    return `${PAYROLL_EXPORT_CONTRACT}_${slug}_${label}_${draft ? 'DRAFT_' : ''}${file}.${extension}`
  }

  /**
   * One entity, one period, every row — and every reason it should not be written.
   *
   * The refusals are returned, never thrown: the preview shows all of them at once, and `v1` throws
   * the first. Every sentence is copied from `services/exports.ts`, because the screen renders the
   * server's words where it has no translation of its own.
   */
  function collectPayroll(workspaceId: string, legalEntityId: string, periodId: string, draft: boolean) {
    const entity = entities.find((e) => e.id === legalEntityId)
    if (!entity) refuse('NOT_FOUND', 'Legal entity not found')
    const period = periods.find((p) => p.id === periodId)
    if (!period) refuse('NOT_FOUND', 'Period not found')
    if (period.kind !== 'payroll')
      refuse(
        'BAD_REQUEST',
        'That period is an attendance period, not a payroll one. A payroll export takes a payroll period.',
      )
    if (period.legalEntityId && period.legalEntityId !== entity.id)
      refuse(
        'BAD_REQUEST',
        `That period belongs to another legal entity. Lock and export ${entity.name}'s own period.`,
      )

    const dates = eachDate(period.startsOn, period.endsOn)
    const today = day(0)
    const locked = period.status === 'locked'

    const datesByPerson = new Map<string, string[]>()
    for (const p of people) {
      const mine = dates.filter((date) => entityOn(p.id, date) === entity.id)
      if (mine.length) datesByPerson.set(p.id, mine)
    }

    const withoutEmployment: Array<{ personId: string; displayName: string }> = []
    const hours: PayrollHoursRow[] = []
    const leave: PayrollLeaveRow[] = []
    let lockedDays = 0
    let openDays = 0
    let firstOpenDay: string | null = null
    let lastLockedDay: string | null = null
    let counted = 0

    for (const [personId, mine] of datesByPerson) {
      const person = people.find((p) => p.id === personId)
      if (!person) continue
      const windowFrom = mine[0] ?? period.startsOn
      const windowTo = mine[mine.length - 1] ?? period.endsOn
      const overlapping = employments
        .filter(
          (e) =>
            e.personId === personId &&
            e.effectiveFrom <= period.endsOn &&
            (e.effectiveTo === null || e.effectiveTo >= period.startsOn),
        )
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      const here = overlapping.filter(
        (e) =>
          e.effectiveFrom <= windowTo &&
          (e.effectiveTo === null || e.effectiveTo >= windowFrom) &&
          (e.legalEntityId === null || e.legalEntityId === entity.id),
      )
      const last = here[here.length - 1]
      if (!last) withoutEmployment.push({ personId, displayName: person.displayName })

      // Day sheets exist up to today, which is what `attendance.days.list` answers too. A locked
      // period's sheets count as locked here because the seeded sheet never consults the periods.
      const sheets = mine
        .filter((date) => date <= today)
        .map((date) => attendanceDay(date, personId, workspaceId))
      const sum = (of: (row: (typeof sheets)[number]) => number) =>
        sheets.reduce((total, row) => total + of(row), 0)
      if (locked) {
        lockedDays += sheets.length
        const lastSheet = sheets[sheets.length - 1]
        if (lastSheet && (lastLockedDay === null || lastSheet.businessDate > lastLockedDay))
          lastLockedDay = lastSheet.businessDate
      } else {
        openDays += sheets.length
        const firstSheet = sheets[0]
        if (firstSheet && (firstOpenDay === null || firstSheet.businessDate < firstOpenDay))
          firstOpenDay = firstSheet.businessDate
      }

      // Approved leave on the days this person was in the entity, one row per type.
      const byType = new Map<string, { days: number; requests: Set<string> }>()
      for (const request of leaveRequests) {
        if (request.personId !== personId || request.status !== 'approved') continue
        const taken = eachDate(String(request.startsOn), String(request.endsOn)).filter((date) => {
          const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]
          return mine.includes(date) && weekday !== 'sat' && weekday !== 'sun'
        })
        if (!taken.length) continue
        const typeId = String(request.leaveTypeId)
        const group = byType.get(typeId) ?? { days: 0, requests: new Set<string>() }
        group.days += taken.length
        group.requests.add(String(request.id))
        byType.set(typeId, group)
      }
      let paidLeaveDays = 0
      let unpaidLeaveDays = 0
      for (const [typeId, group] of byType) {
        const type = leaveTypes.find((lt) => lt.id === typeId)
        if (!type) continue
        if (type.paid) paidLeaveDays += group.days
        else unpaidLeaveDays += group.days
        leave.push({
          personId,
          employeeNo: person.employeeNo,
          leaveTypeKey: type.key,
          leaveTypeName: type.name,
          paid: type.paid,
          unit: type.unit,
          days: group.days,
          requests: group.requests.size,
        })
      }

      if (sheets.length || byType.size) counted += 1

      const position = last ? positions.find((p) => p.id === last.positionId) : undefined
      hours.push({
        personId,
        employeeNo: person.employeeNo,
        displayName: person.displayName,
        employmentType: last?.employmentType ?? '',
        fte: last?.fte ?? 0,
        contractHoursWeek: last?.contractHoursWeek ?? null,
        costCenterCode: null,
        positionTitle: position?.title ?? null,
        hiredOn: person.hiredOn,
        terminatedOn: null,
        employmentChangedInPeriod: overlapping.length > 1,
        daySheets: sheets.length,
        scheduledMinutes: sum((r) => r.scheduledMinutes),
        workedMinutes: sum((r) => r.workedMinutes),
        scheduledWorkedMinutes: sum((r) => (r.scheduledMinutes > 0 ? r.workedMinutes : 0)),
        breakMinutes: sum((r) => r.breakMinutes),
        overtimeMinutes: sum((r) => r.overtimeMinutes),
        lateMinutes: sum((r) => r.lateMinutes),
        earlyLeaveMinutes: sum((r) => r.earlyLeaveMinutes),
        // Null, never zero: the demo workspace has no ceiling, and "none applied" is not "0 over".
        beyondCapMinutes: null,
        cappedDays: 0,
        uncappedDays: sheets.length,
        lockedDays: locked ? sheets.length : 0,
        openDays: locked ? 0 : sheets.length,
        paidLeaveDays,
        unpaidLeaveDays,
      })
    }

    // Employee numbers first in code-unit order, then names — the server's frozen row order.
    const order = (a: { employeeNo: string | null; displayName: string }, b: typeof a) => {
      if ((a.employeeNo === null) !== (b.employeeNo === null)) return a.employeeNo === null ? 1 : -1
      if (a.employeeNo !== null && b.employeeNo !== null && a.employeeNo !== b.employeeNo)
        return a.employeeNo < b.employeeNo ? -1 : 1
      return a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0
    }
    hours.sort(order)
    const nameOf = (personId: string) => people.find((p) => p.id === personId)?.displayName ?? ''
    leave.sort((a, b) => {
      const person = order(
        { employeeNo: a.employeeNo, displayName: nameOf(a.personId) },
        { employeeNo: b.employeeNo, displayName: nameOf(b.personId) },
      )
      return person !== 0 ? person : a.leaveTypeKey.localeCompare(b.leaveTypeKey)
    })

    const total = (of: (row: PayrollHoursRow) => number) => hours.reduce((sum, row) => sum + of(row), 0)
    const caps = hours.map((r) => r.beyondCapMinutes).filter((v): v is number => v !== null)

    const refusals: PayrollExportRefusal[] = []
    if (period.status === 'open' && !draft)
      refusals.push({
        code: 'hr.period.not_locked',
        message: `${period.startsOn} to ${period.endsOn} is still open for ${entity.name}. Lock the period before exporting, or export a draft.`,
        personIds: [],
      })
    if (datesByPerson.size === 0)
      refusals.push({
        code: 'hr.payroll.empty',
        message: `${entity.name} employed nobody between ${period.startsOn} and ${period.endsOn}. There is nothing to export.`,
        personIds: [],
      })
    if (withoutEmployment.length) {
      const one = withoutEmployment.length === 1
      const shown = withoutEmployment.slice(0, 5).map((p) => p.displayName)
      const rest = withoutEmployment.length - shown.length
      const names = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
      refusals.push({
        code: 'hr.payroll.no_employment',
        message:
          (one
            ? `${withoutEmployment[0]?.displayName} has no employment record covering their days `
            : `${withoutEmployment.length} people have no employment record covering their days `) +
          `in ${entity.name} over this period, so there is no basis to pay ` +
          (one ? 'them on. ' : `them on: ${names}. `) +
          'Add an employment record, or move them to the entity that employs them.',
        personIds: withoutEmployment.map((p) => p.personId),
      })
    }

    const range = { periodStart: period.startsOn, periodEnd: period.endsOn }
    const manifest: PayrollExportManifest = {
      contract: PAYROLL_EXPORT_CONTRACT,
      generatedAt: iso(),
      kernVersion: 'mock',
      finality: draft ? 'draft' : 'final',
      draft,
      legalEntityId: entity.id,
      legalEntityName: entity.name,
      country: entity.country,
      currency: entity.currency ?? null,
      periodId: period.id,
      periodStart: period.startsOn,
      periodEnd: period.endsOn,
      periodStatus: period.status,
      population: datesByPerson.size,
      counted,
      scope: {
        permissions: ['hr.payroll.export', 'hr.attendance.view_team', 'hr.leave.view_team'],
        askedAt: 'workspace',
      },
      attendance: { lockedDays, openDays, final: openDays === 0, firstOpenDay, lastLockedDay },
      dayLengthMinutes: 480,
      format: {
        encoding: 'utf-8',
        byteOrderMark: true,
        delimiter: ',',
        lineEnding: 'crlf',
        quoting: 'rfc4180',
        decimalSeparator: '.',
        decimalPlaces: 2,
        dateFormat: 'iso-8601',
      },
      files: [
        {
          name: payrollFilename(entity.name, range, 'hours', draft),
          columns: [...PAYROLL_HOURS_COLUMNS],
          rows: hours.length,
        },
        {
          name: payrollFilename(entity.name, range, 'leave', draft),
          columns: [...PAYROLL_LEAVE_COLUMNS],
          rows: leave.length,
        },
      ],
    }

    return {
      manifest,
      refusals,
      hours,
      leave,
      totals: {
        people: hours.length,
        daySheets: total((r) => r.daySheets),
        scheduledMinutes: total((r) => r.scheduledMinutes),
        workedMinutes: total((r) => r.workedMinutes),
        scheduledWorkedMinutes: total((r) => r.scheduledWorkedMinutes),
        breakMinutes: total((r) => r.breakMinutes),
        overtimeMinutes: total((r) => r.overtimeMinutes),
        lateMinutes: total((r) => r.lateMinutes),
        earlyLeaveMinutes: total((r) => r.earlyLeaveMinutes),
        beyondCapMinutes: caps.length ? caps.reduce((sum, v) => sum + v, 0) : null,
        cappedDays: total((r) => r.cappedDays),
        uncappedDays: total((r) => r.uncappedDays),
        lockedDays: total((r) => r.lockedDays),
        openDays: total((r) => r.openDays),
        paidLeaveDays: total((r) => r.paidLeaveDays),
        unpaidLeaveDays: total((r) => r.unpaidLeaveDays),
      },
    }
  }

  // ---------------------------------------------------------------- reports

  type MockReportInput = {
    workspaceId: string
    from: string
    to: string
    by?: ReportSliceBy
    sliceId?: string
    limit?: number
  }

  function sumOf<T>(rows: readonly T[], pick: (row: T) => number): number {
    return rows.reduce((acc, row) => acc + pick(row), 0)
  }
  function round2(n: number): number {
    return Math.round(n * 100) / 100
  }
  /** Null when there is nothing to divide by — a screen draws that as an em dash, never as 0%. */
  function mockRatio(numerator: number, denominator: number): number | null {
    return denominator > 0 ? round2(numerator / denominator) : null
  }
  function nameOf(personId: string): string {
    return people.find((p) => p.id === personId)?.displayName ?? ''
  }
  function entityOf(personId: string): string | null {
    return offices.find((o) => o.id === primaryOfficeId(personId))?.legalEntityId ?? null
  }
  function isWeekend(date: string): boolean {
    const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!
    return weekday === 'sat' || weekday === 'sun'
  }
  function hasScheduleIn(personId: string, from: string, to: string): boolean {
    return scheduleAssignments.some(
      (a) =>
        a.personId === personId && a.effectiveFrom <= to && (a.effectiveTo === null || a.effectiveTo >= from),
    )
  }

  /**
   * Who a report is about, refusing what the router refuses and in its words.
   *
   * The range refusals are the server's own sentences — `rangeRefusal` in `services/reports.ts` —
   * so the error state a screen draws against the mock is the one it draws against core.
   */
  function reportPopulation(
    input: MockReportInput,
    perDay = false,
  ): {
    slice: { by: ReportSliceBy; id: string | null; name: string | null }
    personIds: string[]
    dates: string[]
  } {
    const by = input.by ?? 'workspace'
    if (by !== 'workspace' && !input.sliceId)
      refuse('BAD_REQUEST', 'A report sliced by an office or a legal entity needs the id of one.')
    const days = input.to < input.from ? 0 : eachDate(input.from, input.to).length
    if (days === 0) refuse('BAD_REQUEST', `The end date ${input.to} is before the start date ${input.from}.`)
    const sliced = perDay || by !== 'workspace'
    const max = sliced ? MAX_SLICED_REPORT_DAYS : MAX_REPORT_DAYS
    if (days > max) {
      refuse(
        'BAD_REQUEST',
        sliced
          ? `A report attributed day by day covers at most ${max} days, and this one asks for ${days}. Ask for a shorter range, or drop the slice.`
          : `A report covers at most ${max} days, and this one asks for ${days}.`,
      )
    }

    const slice = { by, id: by === 'workspace' ? null : (input.sliceId ?? null), name: null as string | null }
    let personIds = people.map((p) => p.id)
    if (by === 'office') {
      personIds = personIds.filter((personId) => primaryOfficeId(personId) === slice.id)
      slice.name = officeName(slice.id)
    } else if (by === 'legal_entity') {
      personIds = personIds.filter((personId) => entityOf(personId) === slice.id)
      slice.name = entities.find((e) => e.id === slice.id)?.name ?? null
    }
    if (sliced && personIds.length * days > MAX_PERSON_DAYS) {
      refuse(
        'BAD_REQUEST',
        `${personIds.length} people over ${days} days is ${personIds.length * days} person-days, and this report resolves at most ${MAX_PERSON_DAYS}. Ask for one office, or a shorter range.`,
      )
    }
    // A day sheet exists only for a day that has happened.
    const dates = eachDate(input.from, input.to).filter((date) => date <= day(0))
    return { slice, personIds, dates }
  }

  function mockReportHeader(args: {
    input: { from: string; to: string; by?: ReportSliceBy }
    slice: { by: ReportSliceBy; id: string | null; name: string | null }
    population: number
    counted: number
    shown: number
    permissions: string[]
    attribution?: 'each_day' | 'as_of_date' | 'not_applicable'
    attributionOn?: string
  }) {
    const by = args.input.by ?? 'workspace'
    return {
      from: args.input.from,
      to: args.input.to,
      slice: args.slice,
      scope: { permissions: args.permissions, askedAt: 'workspace' as const },
      population: args.population,
      counted: args.counted,
      attribution:
        args.attribution ?? (by === 'workspace' ? ('not_applicable' as const) : ('each_day' as const)),
      attributionOn: args.attributionOn ?? null,
      truncated: args.shown < args.counted,
    }
  }

  /**
   * Which of a person's days a locked period has frozen.
   *
   * Read off the seeded periods rather than the sheet's `locked` flag, which the mock never sets:
   * last month is locked for the Turkish entity and open for the Dutch one, so a range that
   * straddles the month boundary shows the mixed-finality line the contract exists to force.
   */
  function finalityOf(personId: string, dates: string[]): Omit<ReportFinality, 'final'> {
    const entity = entityOf(personId)
    const isLocked = (date: string) =>
      periods.some(
        (p) =>
          p.status === 'locked' &&
          p.startsOn <= date &&
          date <= p.endsOn &&
          (p.legalEntityId === null || p.legalEntityId === entity),
      )
    const out: Omit<ReportFinality, 'final'> = {
      lockedDays: 0,
      openDays: 0,
      firstOpenDay: null,
      lastLockedDay: null,
    }
    for (const date of dates) {
      if (isLocked(date)) {
        out.lockedDays++
        if (out.lastLockedDay === null || date > out.lastLockedDay) out.lastLockedDay = date
      } else {
        out.openDays++
        if (out.firstOpenDay === null || date < out.firstOpenDay) out.firstOpenDay = date
      }
    }
    return out
  }

  /** The server's `mergeFinality`: final only when something was locked and nothing is open. */
  function mergeMockFinality(parts: ReadonlyArray<Omit<ReportFinality, 'final'>>): ReportFinality {
    const merged: ReportFinality = {
      lockedDays: 0,
      openDays: 0,
      final: false,
      firstOpenDay: null,
      lastLockedDay: null,
    }
    for (const part of parts) {
      merged.lockedDays += part.lockedDays
      merged.openDays += part.openDays
      if (part.firstOpenDay && (merged.firstOpenDay === null || part.firstOpenDay < merged.firstOpenDay))
        merged.firstOpenDay = part.firstOpenDay
      if (part.lastLockedDay && (merged.lastLockedDay === null || part.lastLockedDay > merged.lastLockedDay))
        merged.lastLockedDay = part.lastLockedDay
    }
    merged.final = merged.lockedDays > 0 && merged.openDays === 0
    return merged
  }

  /**
   * One row per person who has a day sheet in the range — which in this mock is everybody with a
   * schedule assignment, because the day sheet is built from the schedule. Somebody without one has
   * no sheet, so they are in the population and not in the count.
   */
  function dayRows(workspaceId: string, personIds: string[], dates: string[]) {
    return personIds
      .filter((personId) => dates.length > 0 && hasScheduleIn(personId, dates[0]!, dates[dates.length - 1]!))
      .map((personId) => {
        const sheets = dates.map((date) => attendanceDay(date, personId, workspaceId))
        const workedMinutes = sumOf(sheets, (s) => s.workedMinutes)
        return {
          personId,
          days: sheets.length,
          scheduledMinutes: sumOf(sheets, (s) => s.scheduledMinutes),
          workedMinutes,
          scheduledWorkedMinutes: workedMinutes,
          breakMinutes: sumOf(sheets, (s) => s.breakMinutes),
          overtimeMinutes: sumOf(sheets, (s) => s.overtimeMinutes),
          finality: finalityOf(personId, dates),
        }
      })
  }
}
