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
import type { LeaveLedgerEntry, LeaveType } from '../contract/leave.js'
import type {
  Calendar,
  CalendarDay,
  CalendarDayKind,
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
import type { Period } from '../contract/policies.js'

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
function refuse(code: 'CONFLICT' | 'NOT_FOUND' | 'BAD_REQUEST', message: string, reason?: string): never {
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

  const people = [
    {
      id: id('d001'),
      displayName: 'Ayşe Yılmaz',
      workEmail: 'ayse@example.test',
      status: 'active',
      timezone: 'Europe/Istanbul',
      employeeNo: 'E-1',
    },
    {
      id: id('d002'),
      displayName: 'Sanne de Vries',
      workEmail: 'sanne@example.test',
      status: 'active',
      timezone: 'Europe/Amsterdam',
      employeeNo: 'E-2',
    },
    {
      id: id('d003'),
      displayName: 'Mehmet Kaya',
      workEmail: 'mehmet@example.test',
      status: 'on_leave',
      timezone: 'Europe/Istanbul',
      employeeNo: 'E-3',
    },
    {
      id: id('d004'),
      displayName: 'Jonas Weber',
      workEmail: 'jonas@example.test',
      status: 'active',
      timezone: 'Europe/Berlin',
      employeeNo: 'E-4',
    },
  ]

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

  const person = (p: (typeof people)[number], workspaceId: string) => ({
    ...p,
    workspaceId,
    userId: null,
    personalEmail: null,
    phone: null,
    photoFileId: null,
    hiredOn: day(-400),
    terminatedOn: null,
    custom: {},
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
  ]

  /** Working days in a range — what lock and unlock report as the days they froze or released. */
  const workingDaysIn = (from: string, to: string) =>
    eachDate(from, to).filter((date) => {
      const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!
      return weekday !== 'sat' && weekday !== 'sun' && date <= day(0)
    }).length

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

  const delegations: Array<Record<string, unknown>> = []

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
      steps: [] as Array<Record<string, unknown>>,
    },
    {
      id: id('f002'),
      subjectType: 'regularization' as const,
      workspaceId: '',
      subjectId: id('c002'),
      summary: `Correction for ${WD[1]}`,
      summaryParams: { date: WD[1]! } as Record<string, string | number> | null,
      status: 'pending' as string,
      currentStep: 0,
      requestedBy: null,
      requesterPersonId: people[2]!.id,
      requesterName: people[2]!.displayName,
      requestedAt: iso(7200_000),
      decidedAt: null as string | null,
      steps: [{ stepIndex: 0 }, { stepIndex: 1 }] as Array<Record<string, unknown>>,
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
      steps: [] as Array<Record<string, unknown>>,
    },
  ]

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
      }) => {
        const added = {
          id: crypto.randomUUID(),
          displayName: input.displayName,
          workEmail: input.workEmail ?? '',
          status: 'active' as const,
          timezone: 'Europe/Istanbul',
          employeeNo: input.employeeNo ?? `E-${people.length + 1}`,
        }
        people.push(added)
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
      }) => {
        const found = people.find((p) => p.id === input.personId) ?? people[0]!
        if (input.displayName) found.displayName = input.displayName
        if (input.workEmail !== undefined) found.workEmail = input.workEmail ?? ''
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
        entities.filter((e) => includeArchived || e.archivedAt === null).map((e) => ({ ...e, workspaceId })),
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
            steps: [],
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
      inbox: async ({
        workspaceId,
        includeDecided = false,
      }: {
        workspaceId: string
        includeDecided?: boolean
      }) => ({
        items: approvalRequests
          .filter((r) => (includeDecided ? r.status !== 'pending' : r.status === 'pending'))
          .map((r) => ({ ...r, workspaceId })),
        nextCursor: null,
      }),

      get: async ({ workspaceId, requestId }: { workspaceId: string; requestId: string }) => {
        const found = approvalRequests.find((r) => r.id === requestId)
        if (!found) refuse('NOT_FOUND', 'Approval request not found')
        return { ...found, workspaceId }
      },

      decide: async ({
        workspaceId,
        requestId,
        decision,
      }: {
        workspaceId: string
        requestId: string
        decision: 'approve' | 'reject'
      }) => {
        const found = approvalRequests.find((r) => r.id === requestId)
        if (!found) refuse('NOT_FOUND', 'Approval request not found')
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
}
