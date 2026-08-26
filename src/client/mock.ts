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
import type { Schedule, ScheduleAssignment } from '../contract/attendance.js'
import type { LeaveType } from '../contract/leave.js'
import type {
  Calendar,
  CalendarDay,
  CalendarDayKind,
  LegalEntity,
  Office,
  OfficeAssignment,
  ResolvedCalendarDay,
  WorkingWeek,
} from '../contract/models.js'

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
const PACKS: Record<string, { version: string; days: PackDay[] }> = {
  tr: {
    version: '2.0',
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
  nl: {
    version: '2.0',
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
  /** Primary only: a headcount that counted presence would sum to more people than the company has. */
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
      packKey: 'tr',
      packVersion: '1.0',
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
    if (!found) throw new Error('Calendar day not found')
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
      summary: `Correction for ${day(-1)}`,
      summaryParams: { date: day(-1) } as Record<string, string | number> | null,
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
  ]

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
      offboard: async (input: { workspaceId: string; personId: string; on: string }) => {
        const found = people.find((p) => p.id === input.personId) ?? people[0]!
        found.status = 'terminated'
        return { ...person(found, input.workspaceId), terminatedOn: input.on }
      },
    },

    employment: {
      current: async ({ workspaceId, personId }: { workspaceId: string; personId: string }) => ({
        id: id('ee01'),
        workspaceId,
        personId,
        effectiveFrom: day(-400),
        effectiveTo: null,
        orgUnitId: null,
        positionId: null,
        legalEntityId: null,
        costCenterId: null,
        managerPersonId: people.find((x) => x.id !== personId)?.id ?? null,
        employmentType: 'full_time' as const,
        fte: 1,
        contractHoursWeek: 40,
        reason: null,
        createdAt: iso(),
      }),
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
        if (!found) throw new Error('Office not found')
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
        if (input.seedCalendarFromPack !== false && PACKS[input.country.toLowerCase()]) {
          const key = input.country.toLowerCase()
          const seeded: Row<Calendar> = {
            id: crypto.randomUUID(),
            name: input.name,
            extendsId: null,
            country: input.country,
            region: input.region ?? null,
            workingWeek: { ...DEFAULT_WEEK },
            source: 'pack',
            packKey: key,
            packVersion: PACKS[key]!.version,
            archivedAt: null,
          }
          calendars.push(seeded)
          for (const packDay of PACKS[key]!.days) {
            calendarDays.push(
              calDay(
                seeded.id,
                packDay.monthDay,
                packDay.name,
                packDay.kind,
                packDay.workingFraction,
                'pack',
              ),
            )
          }
          created.calendarId = seeded.id
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
        if (!found) throw new Error('Office not found')
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
        if (!found) throw new Error('Office not found')
        // Every new person lands in the default office, so the workspace has to keep having one.
        if (found.isDefault) throw new Error('Move the default to another office first')
        found.archivedAt = iso()
        return { ok: true as const }
      },

      /** Moves the flag rather than adding a second one: exactly one office is ever the default. */
      setDefault: async ({ workspaceId, officeId }: { workspaceId: string; officeId: string }) => {
        const found = offices.find((o) => o.id === officeId)
        if (!found) throw new Error('Office not found')
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
        if (!found) throw new Error('That person is not assigned to this office')
        found.effectiveTo = effectiveTo
        // Leaving somebody with offices and no primary would leave their holidays undecided.
        const rest = activeAssignments(personId)
        if (found.isPrimary && rest.length > 0 && !rest.some((a) => a.isPrimary)) rest[0]!.isPrimary = true
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
        if (!found) throw new Error('Calendar not found')
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
        if (!found) throw new Error('Calendar not found')
        if (input.name !== undefined) found.name = input.name
        if (input.workingWeek !== undefined) found.workingWeek = clone(input.workingWeek)
        // A calendar that extends itself would compose forever.
        if (input.extendsId !== undefined && input.extendsId !== found.id) {
          found.extendsId = input.extendsId
        }
        return { ...found, workspaceId: input.workspaceId }
      },

      archive: async ({ calendarId }: { workspaceId: string; calendarId: string }) => {
        const found = calendars.find((c) => c.id === calendarId)
        if (!found) throw new Error('Calendar not found')
        if (liveOffices().some((o) => o.calendarId === calendarId)) {
          throw new Error('An office still resolves its holidays through this calendar')
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
          if (!target) throw new Error('Calendar day not found')
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
          if (!target) throw new Error('Calendar day not found')
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
          const pack = PACKS[packKey.toLowerCase()]
          // A pack key that does not exist is a typo, and saying so beats an empty diff that reads
          // as "nothing would change".
          if (!pack) throw new Error(`There is no holiday pack named "${packKey}"`)
          const wanted = new Map(pack.days.map((d) => [`${year}-${d.monthDay}`, d]))
          const installed = calendarDays.filter(
            (r) => r.calendarId === calendarId && r.source === 'pack' && r.date.startsWith(`${year}-`),
          )
          const byDate = new Map(installed.map((r) => [r.date, r]))
          return {
            packKey: packKey.toLowerCase(),
            packVersion: pack.version,
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
          const pack = PACKS[packKey.toLowerCase()]
          if (!pack) throw new Error(`There is no holiday pack named "${packKey}"`)
          const wanted = new Map(pack.days.map((d) => [`${year}-${d.monthDay}`, d]))
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
            calendar.packKey = packKey.toLowerCase()
            calendar.packVersion = pack.version
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
          if (!found) throw new Error('Leave type not found')
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
          if (!found) throw new Error('Leave type not found')
          found.archivedAt = iso()
          return { ok: true as const }
        },
      },
      balance: {
        /** One row per type somebody can still book, so the tiles say as much as the picker offers. */
        get: async ({ personId }: { personId?: string }) =>
          leaveTypes
            .filter((lt) => lt.archivedAt === null)
            .map((lt, index) => {
              const balanceMinutes = [20, 10, 0][index] ?? 0
              const pending = index === 0 ? 5 : 0
              return {
                personId: personId ?? people[0]!.id,
                leaveTypeId: lt.id,
                leaveTypeName: lt.name,
                unit: lt.unit,
                periodYear: YEAR,
                balanceMinutes: balanceMinutes * 480,
                bookedMinutes: 0,
                pendingMinutes: pending * 480,
                availableMinutes: (balanceMinutes - pending) * 480,
                balance: balanceMinutes,
                available: balanceMinutes - pending,
              }
            }),
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
        cancel: async ({ requestId }: { workspaceId: string; requestId: string }) => {
          const row = leaveRequests.find((r) => r.id === requestId) ?? leaveRequests[0]!
          row.status = 'cancelled'
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
      clockIn: async () => {
        clockedInAt = Date.now()
        return mockPunch('in')
      },
      clockOut: async () => {
        clockedInAt = null
        onBreak = false
        return mockPunch('out')
      },
      breakStart: async () => {
        onBreak = true
        return mockPunch('break_start')
      },
      breakEnd: async () => {
        onBreak = false
        return mockPunch('break_end')
      },
      days: {
        list: async ({ workspaceId }: { workspaceId: string }) => ({
          items: [0, 1, 2, 3, 4].map((n) => ({
            id: id(`a000${n}`),
            workspaceId,
            personId: people[0]!.id,
            businessDate: day(-n),
            scheduledMinutes: 480,
            workedMinutes: n === 2 ? 0 : 480 + (n === 1 ? 45 : 0),
            breakMinutes: 60,
            overtimeMinutes: n === 1 ? 45 : 0,
            lateMinutes: 0,
            earlyLeaveMinutes: 0,
            status: n === 2 ? ('leave' as const) : ('present' as const),
            leaveRequestId: null,
            anomalies: [],
            firstIn: iso(n * 86_400_000),
            lastOut: iso(n * 86_400_000 - 8 * 3600_000),
            policyHash: null,
            locked: false,
            computedAt: iso(),
          })),
          nextCursor: null,
        }),
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
          if (!found) throw new Error('Schedule not found')
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
          if (!found) throw new Error('Schedule not found')
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
        if (!found) throw new Error('Approval request not found')
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
        if (!found) throw new Error('Approval request not found')
        // A middle step advances rather than settling: the inbox has to be able to show that.
        const last = found.currentStep >= Math.max(found.steps.length - 1, 0)
        if (decision === 'reject' || last) found.status = decision === 'approve' ? 'approved' : 'rejected'
        else found.currentStep += 1
        found.decidedAt = found.status === 'pending' ? null : iso()
        return { ...found, workspaceId }
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

  function mockPunch(direction: string) {
    return {
      id: crypto.randomUUID(),
      workspaceId: '',
      personId: people[0]!.id,
      direction,
      at: new Date().toISOString(),
      clientReportedAt: null,
      skewMs: null,
      businessDate: day(0),
      timezone: 'Europe/Istanbul',
      method: 'web',
      officeId: primaryOfficeId(people[0]!.id),
      deviceId: null,
      geo: null,
      trust: 'trusted',
      voidedByPunchId: null,
      note: null,
      createdAt: new Date().toISOString(),
    }
  }
}
