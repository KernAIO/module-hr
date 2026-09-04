/**
 * Query keys for HR.
 *
 * `[module, entity, …scope]`, so a realtime `change` event invalidates precisely what it touched.
 *
 * **The second segment is the entity the server announces, never the screen's word for it.**
 * `@kernhq/ui`'s realtime client invalidates by the `[module, entity]` prefix, so a key spelt after
 * the screen — `leave-requests`, `offices`, `me` — is one that a *colleague's* edit never refreshes:
 * the tab that made the change invalidates explicitly and looks right, every other tab stays stale
 * until a reload. Anything a screen needs to tell two questions apart goes *after* the entity, so
 * the prefix still reaches the key. `realtime-keys.test.ts` holds every key in this file and every
 * inline key in a component to that rule, and lists the reasoning for the keys whose entity is not
 * obvious from their name.
 *
 * The scope is part of the key wherever a screen can ask the same question about different subjects
 * — a balance for me and a balance for somebody I manage are different answers, and sharing a key
 * would serve one person the other's numbers from cache.
 */
export const hrKeys = {
  people: (ws: string, filters?: Record<string, unknown>) =>
    filters ? (['hr', 'person', ws, filters] as const) : (['hr', 'person', ws] as const),
  person: (ws: string, id: string) => ['hr', 'person', ws, id] as const,
  /**
   * The viewer's own record: `people.me` answers with a person, and a write to one announces `person`.
   *
   * A person id is a uuidv7 the server minted, so the literal `'me'` can never be one — which is
   * what reserves it as a scope word here, and in `leaveBalance`, `leaveRequests`,
   * `attendanceDays` and `rosterDays`, whose `personId ?? 'me'` spells the same convention. No
   * caller may pass `'me'` as an id.
   */
  me: (ws: string) => ['hr', 'person', ws, 'me'] as const,
  /**
   * Which office, calendar, timezone and policies apply to one person.
   *
   * `person`: the ladder moves when somebody's office assignment does, and `offices.assign` and
   * `offices.unassign` both announce the *person* they moved rather than the office.
   *
   * That covers the common case and not all of it. `services/resolve.ts` also reads the office's
   * own `timezone` and `calendarId` and the calendar row behind them, and a write to either
   * announces `office` or `calendar` — neither of which reaches a `person`-prefixed key. An
   * office's timezone edit therefore arrives on this screen only on a reload.
   */
  resolution: (ws: string, personId: string) => ['hr', 'person', ws, 'resolution', personId] as const,
  /** `person`, because `employment.change` announces the person whose job it changed. */
  employment: (ws: string, personId: string) => ['hr', 'person', ws, 'employment', personId] as const,
  orgUnits: (ws: string) => ['hr', 'org_unit', ws] as const,
  offices: (ws: string) => ['hr', 'office', ws] as const,
  /**
   * Offices with the archived ones, as the cost-centre list needs them: a budget booked against an
   * office that has since been archived still has to say which office, or the row reads as attached
   * to nothing. Its own entry for the same reason `orgUnitsAll` is one — a query that asks for more
   * cannot share a key with the pickers that must never offer it.
   */
  officesAll: (ws: string) => ['hr', 'office', ws, 'with-archived'] as const,
  calendars: (ws: string) => ['hr', 'calendar', ws] as const,
  /**
   * One calendar's days. The word comes before the calendar id rather than after it, which is what
   * keeps this apart from `calendar` below — the same prefix followed by an id and nothing else.
   */
  calendarDays: (ws: string, calendarId: string, from: string, to: string) =>
    ['hr', 'calendar', ws, 'days', calendarId, from, to] as const,
  leaveTypes: (ws: string) => ['hr', 'leave_type', ws] as const,
  leaveBalance: (ws: string, personId: string | undefined) =>
    ['hr', 'leave_balance', ws, personId ?? 'me'] as const,
  leaveRequests: (ws: string, personId: string | undefined) =>
    ['hr', 'leave_request', ws, personId ?? 'me'] as const,
  /** Who is away, from the approved requests — `leave_request` is what filing and cancelling announce. */
  leaveCalendar: (ws: string, from: string, to: string) =>
    ['hr', 'leave_request', ws, 'calendar', from, to] as const,
  /** `attendance_day`: a punch rebuilds a day sheet and announces it, and that is the clock's answer. */
  clockState: (ws: string) => ['hr', 'attendance_day', ws, 'clock-state'] as const,
  attendanceDays: (ws: string, personId: string | undefined, from: string, to: string) =>
    ['hr', 'attendance_day', ws, personId ?? 'me', from, to] as const,
  schedules: (ws: string) => ['hr', 'schedule', ws] as const,
  /**
   * `includeDecided` is part of the key, not a filter over one cached list.
   *
   * The two answers are different rows from the server — the waiting list is what a step is
   * pending on, the decided one is history — so sharing a key would show one tab the other's
   * contents for as long as the refetch takes.
   */
  approvalInbox: (ws: string, status: 'pending' | 'decided' = 'pending') =>
    ['hr', 'approval', ws, status] as const,
  delegations: (ws: string) => ['hr', 'delegation', ws] as const,
  calendar: (ws: string, id: string) => ['hr', 'calendar', ws, id] as const,
  calendarWorkingDays: (ws: string, calendarId: string, from: string, to: string) =>
    ['hr', 'calendar', ws, 'working-days', calendarId, from, to] as const,
  /**
   * The pack diff is keyed by the pack and the year as well as the calendar: an admin comparing two
   * years must not be shown the first one's answer while the second is still in flight.
   */
  calendarPackPreview: (ws: string, calendarId: string, packKey: string, year: number) =>
    ['hr', 'calendar', ws, 'pack-preview', calendarId, packKey, year] as const,
  /**
   * The live employers, as every picker wants them.
   *
   * Spelt `legal_entity` because that is the entity `router.ts` announces after a write, and the
   * realtime client invalidates by the `[module, entity]` prefix — a key named after the screen
   * would never be refetched when somebody else adds an employer.
   */
  entities: (ws: string) => ['hr', 'legal_entity', ws] as const,
  /**
   * The employers, archived ones included, as only the settings screen wants them.
   *
   * Its own entry rather than `entities`: the pickers on offices, periods and accrual cache that
   * one and must never be handed an archived employer to assign somebody to. This screen fetches
   * both and splits them, so the archived toggle costs no round trip — the same split
   * `orgUnitsAll` makes, for the same reason.
   *
   * Spelt `legal_entity` for the reason `entities` is, and the `with-archived` suffix keeps it a
   * separate cache while still sitting under the `['hr', 'legal_entity']` prefix a write
   * invalidates — so both are refetched, and neither is served the other's answer.
   */
  entitiesAll: (ws: string) => ['hr', 'legal_entity', ws, 'with-archived'] as const,
  /**
   * Cost centres, archived ones included; the settings screen is the only asker.
   *
   * Spelt `cost_center` because that is the entity `router.ts` announces after a write, and the
   * realtime client invalidates by the `[module, entity]` prefix — a key named after the screen
   * would never be refetched when somebody else adds one.
   */
  costCenters: (ws: string) => ['hr', 'cost_center', ws] as const,
  /**
   * One office's roster. `person`, not `office`: the rows move when somebody is assigned, unassigned
   * or renamed, and every one of those announces the person — an office's own edits do not change
   * who is in it.
   */
  officePeople: (ws: string, officeId: string, primaryOnly: boolean) =>
    ['hr', 'person', ws, 'office-people', officeId, primaryOnly ? 'primary' : 'all'] as const,
  /**
   * The ledger is keyed by the leave type *and* the year as well as the person: the panel anchors
   * its running balance on the balance the server computed for one entitlement year, so serving it
   * another year's entries from cache would draw a column of numbers reconciling to nothing.
   */
  leaveLedger: (ws: string, personId: string, leaveTypeId: string, periodYear: number) =>
    ['hr', 'leave_balance', ws, 'ledger', personId, leaveTypeId, periodYear] as const,
  /** `person`: `employment.change` writes the history and announces the person it belongs to. */
  employmentHistory: (ws: string, personId: string) =>
    ['hr', 'person', ws, 'employment-history', personId] as const,
  /** `person`: attaching and removing a document both announce the person it hangs off. */
  documents: (ws: string, personId: string) => ['hr', 'person', ws, 'documents', personId] as const,
  /**
   * The encrypted half of a person record — and the one key in this file deliberately outside the
   * entity rule. Its own segment, `sensitive`, rather than `person`.
   *
   * The server logs every read of these fields to `sensitive_access_log`. Under the `person`
   * prefix, *any* person announcement — a colleague's rename, a checklist tick, a retention sweep
   * — would refetch a revealed panel and write a disclosure row for a read nobody performed: the
   * viewer did not ask, the cache did. For the most sensitive screen in the module staleness is
   * the safer failure, so cross-user invalidation is intentionally not received here. The panel
   * fetches when the viewer reveals it, and this screen's own write invalidates this key
   * explicitly — so every fresh read stays an intentional, logged one.
   *
   * `realtime-keys.test.ts` records this as the module's only key not named after an announced
   * entity, with the same reasoning, so it cannot be mistaken for one that was missed.
   */
  sensitive: (ws: string, personId: string) => ['hr', 'sensitive', ws, personId] as const,
  /**
   * The live definitions, as every person form and panel reads them; the settings screen adds a
   * suffix. `field`, singular, because that is the entity `router.ts` announces after a write and
   * the realtime client invalidates by `[module, entity]`.
   */
  fields: (ws: string) => ['hr', 'field', ws] as const,
  /**
   * The org editor asks for archived units too, so it cannot share `orgUnits` with the chart —
   * a toggle that changes what a query asks for has to change the key, or the cache answers the
   * question it was asked last time and the switch appears to do nothing.
   */
  orgUnitsAll: (ws: string) => ['hr', 'org_unit', ws, 'with-archived'] as const,
  positions: (ws: string) => ['hr', 'position', ws, 'with-archived'] as const,
  /** Every period in one read: `periods.list` returns no cursor, so there is nothing to page. */
  periods: (ws: string) => ['hr', 'period', ws] as const,
  /**
   * The payroll preview is keyed by everything the server was asked: the same period previewed as
   * a draft and as a final export answers differently (`refusals`, the filenames, `finality`), and
   * serving one from the other's cache would show a reader a file that is not the one they get.
   *
   * `period`, because what the preview refuses on is the period's lock — the one thing about it a
   * colleague changes from another screen.
   */
  payrollExportPreview: (ws: string, legalEntityId: string, periodId: string, draft: boolean) =>
    ['hr', 'period', ws, 'export-preview', legalEntityId, periodId, draft ? 'draft' : 'final'] as const,
  approvalChains: (ws: string) => ['hr', 'approval_chain', ws] as const,
  /**
   * The horizons with their counts. One read per workspace; the settings screen is the only asker.
   *
   * `retention_run`, because the counts are what a sweep changes, and a run finishing has to
   * refresh both the list and the counts beside it — which is why this sits under the runs prefix.
   *
   * The horizons themselves are not covered, and no prefix would cover them: `privacy.retention.set`
   * (`router.ts`) announces nothing at all, so a *second* admin saving a horizon never reaches this
   * screen. What refreshes it is a sweep's `retention_run` announcement and this screen's own
   * write, which invalidates the key directly. Closing that gap means announcing on the setter.
   */
  retention: (ws: string) => ['hr', 'retention_run', ws, 'settings'] as const,
  /**
   * Every retention sweep that ran. Keyed by the entity name the server announces
   * (`changed(ws, 'retention_run', …)`), so a run finishing on the nightly job or in somebody
   * else's tab refreshes the list rather than leaving it a reload behind.
   */
  retentionRuns: (ws: string) => ['hr', 'retention_run', ws] as const,
  /**
   * Who read one person's sensitive fields. Keyed by the subject, because the same panel asks about
   * different people and a viewer's own log must never be served a colleague's from cache.
   */
  accessLog: (ws: string, personId: string) => ['hr', 'person', ws, 'access-log', personId] as const,
  /**
   * Rosters are keyed by the entity name the server announces, not by a screen's name for it.
   *
   * `router.ts` calls `changed(ws, 'roster_shift' | 'roster_pattern' | 'roster_assignment' |
   * 'roster_day', …)` after every write, and the realtime client invalidates by the
   * `[module, entity]` prefix — so a key spelt `roster-shifts` would never be refetched when
   * somebody else edits a shift, and the coverage grid on a second screen would keep yesterday's
   * answer until a reload.
   */
  rosterShifts: (ws: string) => ['hr', 'roster_shift', ws] as const,
  rosterPatterns: (ws: string) => ['hr', 'roster_pattern', ws] as const,
  rosterAssignments: (ws: string, personId?: string) =>
    personId
      ? (['hr', 'roster_assignment', ws, personId] as const)
      : (['hr', 'roster_assignment', ws] as const),
  rosterDays: (ws: string, personId: string | undefined, from: string, to: string) =>
    ['hr', 'roster_day', ws, personId ?? 'me', from, to] as const,
  /**
   * Coverage sits under `roster_day` too, because there is no `roster_coverage` entity to announce
   * and a key can carry one prefix. An override is the change that happens day to day and comes
   * from another screen, so that is the one worth following live; a rotation or an assignment
   * changes from the settings page, which invalidates all of `['hr']` after its own writes.
   */
  rosterCoverage: (ws: string, from: string, to: string, officeId?: string) =>
    ['hr', 'roster_day', ws, 'coverage', from, to, officeId ?? 'all'] as const,
  /**
   * A report is keyed by everything that decides its population and its figures — the range, the
   * slice and the row limit — because the same title over a different population is a different
   * report, and serving one from the other's cache is exactly the defect `ReportHeader` exists to
   * prevent. The balance report is keyed on its `asOf` date instead of a range.
   *
   * The three day-sheet reports sit under `attendance_day` and the balance report under
   * `leave_balance`: a colleague's punch moves the first three, an adjustment or an accrual run
   * moves the last one.
   */
  reportAttendance: (ws: string, input: ReportRangeInput) =>
    ['hr', 'attendance_day', ws, 'report-attendance', input] as const,
  reportOvertime: (ws: string, input: ReportRangeInput) =>
    ['hr', 'attendance_day', ws, 'report-overtime', input] as const,
  reportAbsence: (ws: string, input: ReportRangeInput) =>
    ['hr', 'attendance_day', ws, 'report-absence', input] as const,
  reportLeaveBalance: (ws: string, input: ReportBalanceInput) =>
    ['hr', 'leave_balance', ws, 'report-leave-balance', input] as const,
  /**
   * Checklists are keyed by the entity the server announces — `router.ts` calls
   * `changed(ws, 'checklist' | 'checklist_template', …)` after every write — so a tick on one
   * screen reaches every other list, panel section and widget through the realtime client's
   * `[module, entity]` invalidation rather than through a reload.
   *
   * The filters are part of the key: an open-only list and an all-status list are different rows
   * from the server, and sharing one key would show a filter the other's answer for as long as the
   * refetch takes.
   */
  checklists: (ws: string, filters?: Record<string, unknown>) =>
    filters
      ? (['hr', 'checklist', ws, 'list', filters] as const)
      : (['hr', 'checklist', ws, 'list'] as const),
  checklist: (ws: string, id: string) => ['hr', 'checklist', ws, 'one', id] as const,
  /** The open lists with something for the reader to do, items included — the widget and My tasks. */
  myChecklistTasks: (ws: string) => ['hr', 'checklist', ws, 'mine'] as const,
  checklistTemplates: (ws: string, includeArchived = false) =>
    ['hr', 'checklist_template', ws, includeArchived ? 'with-archived' : 'live'] as const,
} as const

/** What narrows a day-sheet report: the range, the slice, and how many rows to draw. */
export interface ReportRangeInput {
  from: string
  to: string
  by: 'workspace' | 'office' | 'legal_entity'
  sliceId?: string
  limit: number
}

/** The balance report is a position, so one date stands in for the range. */
export interface ReportBalanceInput {
  asOf: string
  by: 'workspace' | 'office' | 'legal_entity'
  sliceId?: string
  limit: number
}

/**
 * `iso` moved by `n` calendar days.
 *
 * Stepped in UTC and read back as a date, so a daylight-saving change in the viewer's zone cannot
 * turn "+1 day" into 23 hours and land on the same date twice — the same reason `mock.ts` steps its
 * ranges that way.
 */
export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

/** How many calendar days `from`..`to` covers, both ends included. Zero or less when reversed. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}

/** `YYYY-MM-DD` for a date, in the viewer's own zone rather than UTC. */
export const isoDate = (d: Date = new Date()): string => new Intl.DateTimeFormat('en-CA').format(d)

/** The first and last day of the month containing `d`, as ISO dates. */
export function monthRange(d: Date = new Date()): { from: string; to: string } {
  const y = d.getFullYear()
  const mo = d.getMonth()
  const last = new Date(y, mo + 1, 0).getDate()
  const p = (n: number) => String(n).padStart(2, '0')
  return { from: `${y}-${p(mo + 1)}-01`, to: `${y}-${p(mo + 1)}-${p(last)}` }
}

/**
 * Minutes as a duration somebody reads.
 *
 * Takes the wording as parameters rather than importing `$msg`, because a `.ts` module that imports
 * `$msg` cannot be unit-tested — SvelteKit's aliases come from a plugin vitest does not run.
 */
export function formatDuration(
  minutes: number,
  words: { hours: (n: string) => string; minutes: (n: string) => string },
  locale?: string,
): string {
  const sign = minutes < 0 ? '-' : ''
  const abs = Math.abs(Math.round(minutes))
  const h = Math.floor(abs / 60)
  const mi = abs % 60
  const n = (v: number) => new Intl.NumberFormat(locale).format(v)
  if (h && mi) return `${sign}${words.hours(n(h))} ${words.minutes(n(mi))}`
  if (h) return `${sign}${words.hours(n(h))}`
  return `${sign}${words.minutes(n(mi))}`
}

/** Days, in the viewer's digits, with halves kept and trailing zeros dropped. */
export const formatDays = (days: number, locale?: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(days)
