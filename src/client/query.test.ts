import { describe, expect, it } from 'vitest'
import { addDays, daysInclusive, formatDays, formatDuration, hrKeys, monthRange } from './query.js'

const words = { hours: (n: string) => `${n}h`, minutes: (n: string) => `${n}m` }

describe('hrKeys', () => {
  it('scopes a balance by person, so two people do not share a cache entry', () => {
    expect(hrKeys.leaveBalance('ws', 'alice')).not.toEqual(hrKeys.leaveBalance('ws', 'bob'))
    // No person means "me", and that must be its own entry rather than colliding with a named one.
    expect(hrKeys.leaveBalance('ws', undefined)).toEqual(['hr', 'leave_balance', 'ws', 'me'])
  })

  it('scopes attendance by range, so changing the month refetches', () => {
    expect(hrKeys.attendanceDays('ws', 'a', '2026-01-01', '2026-01-31')).not.toEqual(
      hrKeys.attendanceDays('ws', 'a', '2026-02-01', '2026-02-28'),
    )
  })

  it('starts every key with the module, so one invalidation can clear all of HR', () => {
    for (const key of [
      hrKeys.people('ws'),
      hrKeys.offices('ws'),
      hrKeys.clockState('ws'),
      hrKeys.approvalInbox('ws'),
      hrKeys.costCenters('ws'),
    ])
      expect(key[0]).toBe('hr')
  })

  /**
   * A settings screen asks for the archived rows too, and the pickers elsewhere must never be
   * served that answer — an archived employer offered as the one to file a payroll under is the
   * defect these three keys exist to prevent.
   */
  it('keeps a list that includes archived rows out of the picker’s cache entry', () => {
    expect(hrKeys.entitiesAll('ws')).not.toEqual(hrKeys.entities('ws'))
    expect(hrKeys.officesAll('ws')).not.toEqual(hrKeys.offices('ws'))
    expect(hrKeys.orgUnitsAll('ws')).not.toEqual(hrKeys.orgUnits('ws'))
  })

  /**
   * `router.ts` announces `cost_center` and `legal_entity` after every write and the realtime
   * client invalidates by the `[module, entity]` prefix, so a key spelt any other way — `entities`,
   * say, after the screen rather than after the announcement — is never refetched when somebody
   * else adds one.
   */
  it('names the keys after the entity the server announces', () => {
    expect(hrKeys.costCenters('ws')).toEqual(['hr', 'cost_center', 'ws'])
    expect(hrKeys.entities('ws')).toEqual(['hr', 'legal_entity', 'ws'])
    // The suffix is what keeps it a separate cache; the prefix is what gets it invalidated.
    expect(hrKeys.entitiesAll('ws')).toEqual(['hr', 'legal_entity', 'ws', 'with-archived'])
  })

  /**
   * The screen's own word, where it survives at all, sits *after* the entity.
   *
   * That is the whole shape rule: `['hr', <entity>, <workspace>, …whatever tells two questions
   * apart]`. Put the word second and the `[module, entity]` prefix stops reaching the key, which is
   * the defect `realtime-keys.test.ts` guards the module against; put it third and both hold.
   */
  it('keeps a screen’s own word after the entity, never in its place', () => {
    expect(hrKeys.me('ws')).toEqual(['hr', 'person', 'ws', 'me'])
    expect(hrKeys.clockState('ws')).toEqual(['hr', 'attendance_day', 'ws', 'clock-state'])
    expect(hrKeys.calendarDays('ws', 'cal', '2026-01-01', '2026-01-31')).toEqual([
      'hr',
      'calendar',
      'ws',
      'days',
      'cal',
      '2026-01-01',
      '2026-01-31',
    ])
  })

  /**
   * The one key deliberately off an announced entity, and the reason is the opposite of every other
   * key's: the server logs a `sensitive_access_log` row for each read, so a key under `person`
   * would let a colleague's unrelated write make the cache perform — and record — a disclosure the
   * viewer never asked for. Staleness is the safer failure on this panel, so it sits under its own
   * segment and is refetched by the reveal and by this screen's own write.
   */
  it('keeps the sensitive panel off the broadly-announced person prefix', () => {
    expect(hrKeys.sensitive('ws', 'alice')).toEqual(['hr', 'sensitive', 'ws', 'alice'])
    expect(hrKeys.sensitive('ws', 'alice')[1]).not.toBe('person')
    // Still scoped by subject: one person's fields must never be served from another's entry.
    expect(hrKeys.sensitive('ws', 'alice')).not.toEqual(hrKeys.sensitive('ws', 'bob'))
  })

  /**
   * `'me'` is a scope word, not an id.
   *
   * `hrKeys.me` and `hrKeys.person(ws, 'me')` would build the same tuple, and nothing in the type
   * system says they must not. What keeps them apart is that a person id is a uuidv7 the server
   * minted, so the literal can never be one — the same convention `leaveBalance`, `leaveRequests`,
   * `attendanceDays` and `rosterDays` spell as `personId ?? 'me'`. A real id therefore lands
   * somewhere else, which is what this pins.
   */
  it('keeps a real person id clear of the reserved “me” entry', () => {
    expect(hrKeys.person('ws', '00000000-0000-1000-8000-000000000000')).not.toEqual(hrKeys.me('ws'))
    expect(hrKeys.leaveBalance('ws', '00000000-0000-1000-8000-000000000000')).not.toEqual(
      hrKeys.leaveBalance('ws', undefined),
    )
  })

  /**
   * No two helpers may build the same tuple.
   *
   * Renaming fifty keys onto twenty-six entity names is exactly the change that collapses two
   * different questions onto one cache entry — and the symptom is not an error but one screen
   * quietly showing another's answer. Every helper is built here with representative arguments and
   * the results compared pairwise, so a collision fails a test rather than a demo.
   */
  it('builds a distinct key for every helper', () => {
    const ws = 'ws'
    const range = { from: '2026-01-01', to: '2026-01-31', by: 'workspace' as const, limit: 50 }
    const balanceInput = { asOf: '2026-01-31', by: 'workspace' as const, limit: 50 }
    const built: Array<[string, readonly unknown[]]> = [
      ['people', hrKeys.people(ws)],
      ['people(filtered)', hrKeys.people(ws, { q: 'ada' })],
      ['person', hrKeys.person(ws, 'p1')],
      ['me', hrKeys.me(ws)],
      ['resolution', hrKeys.resolution(ws, 'p1')],
      ['employment', hrKeys.employment(ws, 'p1')],
      ['employmentHistory', hrKeys.employmentHistory(ws, 'p1')],
      ['documents', hrKeys.documents(ws, 'p1')],
      ['sensitive', hrKeys.sensitive(ws, 'p1')],
      ['accessLog', hrKeys.accessLog(ws, 'p1')],
      ['officePeople', hrKeys.officePeople(ws, 'o1', true)],
      ['officePeople(all)', hrKeys.officePeople(ws, 'o1', false)],
      ['orgUnits', hrKeys.orgUnits(ws)],
      ['orgUnitsAll', hrKeys.orgUnitsAll(ws)],
      ['positions', hrKeys.positions(ws)],
      ['offices', hrKeys.offices(ws)],
      ['officesAll', hrKeys.officesAll(ws)],
      ['entities', hrKeys.entities(ws)],
      ['entitiesAll', hrKeys.entitiesAll(ws)],
      ['costCenters', hrKeys.costCenters(ws)],
      ['fields', hrKeys.fields(ws)],
      ['calendars', hrKeys.calendars(ws)],
      ['calendar', hrKeys.calendar(ws, 'cal')],
      ['calendarDays', hrKeys.calendarDays(ws, 'cal', range.from, range.to)],
      ['calendarWorkingDays', hrKeys.calendarWorkingDays(ws, 'cal', range.from, range.to)],
      ['calendarPackPreview', hrKeys.calendarPackPreview(ws, 'cal', 'ir', 2026)],
      ['leaveTypes', hrKeys.leaveTypes(ws)],
      ['leaveBalance(me)', hrKeys.leaveBalance(ws, undefined)],
      ['leaveBalance(p1)', hrKeys.leaveBalance(ws, 'p1')],
      ['leaveRequests(me)', hrKeys.leaveRequests(ws, undefined)],
      ['leaveRequests(p1)', hrKeys.leaveRequests(ws, 'p1')],
      ['leaveCalendar', hrKeys.leaveCalendar(ws, range.from, range.to)],
      ['leaveLedger', hrKeys.leaveLedger(ws, 'p1', 'lt1', 2026)],
      ['clockState', hrKeys.clockState(ws)],
      ['attendanceDays(me)', hrKeys.attendanceDays(ws, undefined, range.from, range.to)],
      ['attendanceDays(p1)', hrKeys.attendanceDays(ws, 'p1', range.from, range.to)],
      ['schedules', hrKeys.schedules(ws)],
      ['periods', hrKeys.periods(ws)],
      ['payrollExportPreview', hrKeys.payrollExportPreview(ws, 'le1', 'per1', true)],
      ['payrollExportPreview(final)', hrKeys.payrollExportPreview(ws, 'le1', 'per1', false)],
      ['approvalInbox(pending)', hrKeys.approvalInbox(ws)],
      ['approvalInbox(decided)', hrKeys.approvalInbox(ws, 'decided')],
      ['approvalChains', hrKeys.approvalChains(ws)],
      ['delegations', hrKeys.delegations(ws)],
      ['retention', hrKeys.retention(ws)],
      ['retentionRuns', hrKeys.retentionRuns(ws)],
      ['rosterShifts', hrKeys.rosterShifts(ws)],
      ['rosterPatterns', hrKeys.rosterPatterns(ws)],
      ['rosterAssignments', hrKeys.rosterAssignments(ws)],
      ['rosterAssignments(p1)', hrKeys.rosterAssignments(ws, 'p1')],
      ['rosterDays(me)', hrKeys.rosterDays(ws, undefined, range.from, range.to)],
      ['rosterDays(p1)', hrKeys.rosterDays(ws, 'p1', range.from, range.to)],
      ['rosterCoverage', hrKeys.rosterCoverage(ws, range.from, range.to)],
      ['rosterCoverage(office)', hrKeys.rosterCoverage(ws, range.from, range.to, 'o1')],
      ['reportAttendance', hrKeys.reportAttendance(ws, range)],
      ['reportOvertime', hrKeys.reportOvertime(ws, range)],
      ['reportAbsence', hrKeys.reportAbsence(ws, range)],
      ['reportLeaveBalance', hrKeys.reportLeaveBalance(ws, balanceInput)],
      ['checklists', hrKeys.checklists(ws)],
      ['checklists(filtered)', hrKeys.checklists(ws, { status: 'open' })],
      ['checklist', hrKeys.checklist(ws, 'c1')],
      ['myChecklistTasks', hrKeys.myChecklistTasks(ws)],
      ['checklistTemplates', hrKeys.checklistTemplates(ws)],
      ['checklistTemplates(archived)', hrKeys.checklistTemplates(ws, true)],
    ]
    // Every helper is represented, so adding one without a sample here is caught rather than
    // silently left out of the comparison.
    expect(new Set(built.map(([name]) => name)).size).toBe(built.length)
    expect(new Set(built.map(([, key]) => key[1])).size).toBeGreaterThanOrEqual(20)
    for (const name of Object.keys(hrKeys))
      expect(built.some(([label]) => label === name || label.startsWith(`${name}(`))).toBe(true)

    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const [name, key] of built) {
      const serialised = JSON.stringify(key)
      const first = seen.get(serialised)
      if (first) collisions.push(`${first} and ${name} both build ${serialised}`)
      else seen.set(serialised, name)
    }
    expect(collisions).toEqual([])
  })
})

describe('monthRange', () => {
  it('covers a whole 31-day month', () => {
    expect(monthRange(new Date(2026, 0, 15))).toEqual({ from: '2026-01-01', to: '2026-01-31' })
  })
  it('covers February in a leap year and a common one', () => {
    expect(monthRange(new Date(2024, 1, 10)).to).toBe('2024-02-29')
    expect(monthRange(new Date(2026, 1, 10)).to).toBe('2026-02-28')
  })
  it('covers a 30-day month', () => {
    expect(monthRange(new Date(2026, 3, 5))).toEqual({ from: '2026-04-01', to: '2026-04-30' })
  })
})

describe('formatDuration', () => {
  it('shows hours and minutes together', () => {
    expect(formatDuration(495, words, 'en')).toBe('8h 15m')
  })
  it('drops an empty part', () => {
    expect(formatDuration(480, words, 'en')).toBe('8h')
    expect(formatDuration(45, words, 'en')).toBe('45m')
    expect(formatDuration(0, words, 'en')).toBe('0m')
  })
  it('keeps a negative readable', () => {
    expect(formatDuration(-90, words, 'en')).toBe('-1h 30m')
  })
  it('uses the locale’s digits', () => {
    // A Persian screen with Latin numerals in the one place a number appears looks broken.
    expect(formatDuration(480, words, 'fa')).toBe('۸h')
  })
})

describe('formatDays', () => {
  it('keeps halves and drops trailing zeros', () => {
    expect(formatDays(20, 'en')).toBe('20')
    expect(formatDays(19.5, 'en')).toBe('19.5')
    expect(formatDays(19.25, 'en')).toBe('19.25')
  })
  it('uses the locale’s digits', () => {
    expect(formatDays(20, 'fa')).toBe('۲۰')
  })
})

describe('roster keys', () => {
  it('uses the entity names the server announces, so a realtime change reaches them', () => {
    // `router.ts` emits `roster_shift`, `roster_pattern`, `roster_assignment` and `roster_day`;
    // the realtime client invalidates by `[module, entity]`, so a key spelt any other way is one a
    // colleague's edit never refreshes.
    expect(hrKeys.rosterShifts('ws').slice(0, 2)).toEqual(['hr', 'roster_shift'])
    expect(hrKeys.rosterPatterns('ws').slice(0, 2)).toEqual(['hr', 'roster_pattern'])
    expect(hrKeys.rosterAssignments('ws').slice(0, 2)).toEqual(['hr', 'roster_assignment'])
    expect(hrKeys.rosterDays('ws', undefined, '2026-01-01', '2026-01-07').slice(0, 2)).toEqual([
      'hr',
      'roster_day',
    ])
    expect(hrKeys.rosterCoverage('ws', '2026-01-01', '2026-01-07').slice(0, 2)).toEqual(['hr', 'roster_day'])
  })
  it('keeps my roster apart from a named person’s, and one office apart from all of them', () => {
    expect(hrKeys.rosterDays('ws', undefined, '2026-01-01', '2026-01-07')).not.toEqual(
      hrKeys.rosterDays('ws', 'alice', '2026-01-01', '2026-01-07'),
    )
    expect(hrKeys.rosterCoverage('ws', '2026-01-01', '2026-01-07')).not.toEqual(
      hrKeys.rosterCoverage('ws', '2026-01-01', '2026-01-07', 'office'),
    )
  })
})

describe('addDays and daysInclusive', () => {
  it('crosses a month and a year', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('counts both ends and goes to zero or below when reversed', () => {
    expect(daysInclusive('2026-01-01', '2026-01-01')).toBe(1)
    expect(daysInclusive('2026-01-01', '2026-01-07')).toBe(7)
    expect(daysInclusive('2026-01-07', '2026-01-01')).toBeLessThanOrEqual(0)
  })
})
