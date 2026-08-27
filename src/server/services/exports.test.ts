/**
 * The payroll export's bytes and its refusals, pinned without a database.
 *
 * Every case here is one that produces a file which opens cleanly, looks right, and is wrong:
 *
 * - a display name containing a comma shifts every column after it by one, and the row still parses;
 * - `beyond_cap_minutes` written as `0` tells a provider a statutory ceiling applied and nothing
 *   exceeded it, where in fact none ever applied — the one place this export can cause a wrong
 *   payment;
 * - a version line above the column names makes an importer read `kern-payroll-v1` as the first
 *   column name and every field lands one row down;
 * - a column appended to v1 shifts a positional importer, and the shift lands on `unpaid_leave_days`,
 *   which is a deduction;
 * - an open period exported silently differs from the same export the next morning, because
 *   `reconcile-days` rebuilt the days in between.
 *
 * None of these throws and none fails a type-check, so they are held here, where the answer is
 * visible as text.
 */
import { describe, expect, it } from 'vitest'
import {
  PAYROLL_EXPORT_CONTRACT,
  PAYROLL_HOURS_COLUMNS,
  PAYROLL_LEAVE_COLUMNS,
  type PayrollHoursRow,
  type PayrollLeaveRow,
} from '../../contract/index.js'
import {
  assembleExport,
  CSV_BOM,
  CSV_EOL,
  csvDocument,
  csvField,
  csvLine,
  entitySlug,
  exportFilename,
  exportRefusals,
  fmtBool,
  fmtDecimal,
  fmtInt,
  fmtNullableInt,
  hoursCsvRow,
  leaveCsvRow,
  type PayrollExportAssembly,
  type PayrollFileHeader,
  periodLabel,
  totalsOf,
} from './exports.js'

const HEADER: PayrollFileHeader = {
  legalEntityId: '0198f0c0-0000-7000-8000-0000000000e1',
  legalEntityName: 'Kern Türkiye A.Ş.',
  periodStart: '2026-06-01',
  periodEnd: '2026-06-30',
}

/** A second person, for the cases that are about more than one row. */
const PERSON_B = '0198f0c0-0000-7000-8000-000000000002'

const hoursRow = (patch: Partial<PayrollHoursRow> = {}): PayrollHoursRow => ({
  personId: '0198f0c0-0000-7000-8000-000000000001',
  employeeNo: 'TR-001',
  displayName: 'Ayşe Yılmaz',
  employmentType: 'full_time',
  fte: 1,
  contractHoursWeek: 45,
  costCenterCode: 'CC-IST',
  positionTitle: 'Technician',
  hiredOn: '2024-03-01',
  terminatedOn: null,
  employmentChangedInPeriod: false,
  daySheets: 4,
  scheduledMinutes: 1620,
  workedMinutes: 1830,
  scheduledWorkedMinutes: 1650,
  breakMinutes: 120,
  overtimeMinutes: 90,
  lateMinutes: 10,
  earlyLeaveMinutes: 0,
  beyondCapMinutes: 30,
  cappedDays: 2,
  uncappedDays: 2,
  lockedDays: 4,
  openDays: 0,
  paidLeaveDays: 2,
  unpaidLeaveDays: 0,
  ...patch,
})

const leaveRow = (patch: Partial<PayrollLeaveRow> = {}): PayrollLeaveRow => ({
  personId: '0198f0c0-0000-7000-8000-000000000001',
  employeeNo: 'TR-001',
  leaveTypeKey: 'annual',
  leaveTypeName: 'Annual leave',
  paid: true,
  unit: 'day',
  days: 2,
  requests: 1,
  ...patch,
})

const assembly = (patch: Partial<PayrollExportAssembly> = {}): PayrollExportAssembly => ({
  entity: { id: HEADER.legalEntityId, name: HEADER.legalEntityName, country: 'TR', currency: 'TRY' },
  period: {
    id: '0198f0c0-0000-7000-8000-0000000000d1',
    startsOn: '2026-06-01',
    endsOn: '2026-06-30',
    status: 'locked',
  },
  draft: false,
  generatedAt: '2026-07-01T06:00:00.000Z',
  kernVersion: '1.4.0',
  permissions: ['hr.payroll.export', 'hr.attendance.view_team', 'hr.leave.view_team'],
  dayLengthMinutes: 480,
  population: 1,
  counted: 1,
  attendance: { lockedDays: 4, openDays: 0, final: true, firstOpenDay: null, lastLockedDay: '2026-06-30' },
  hours: [hoursRow()],
  leave: [leaveRow()],
  ...patch,
})

/** Split a rendered CSV back into records the way a well-behaved importer would. */
const records = (csv: string) => csv.replace(CSV_BOM, '').split(CSV_EOL).slice(0, -1)

describe('the oldest bug in this format: a name with a comma in it', () => {
  it('quotes a field containing the delimiter, so the columns after it do not shift', () => {
    expect(csvField('Şirket, A.Ş.')).toBe('"Şirket, A.Ş."')
  })

  it('doubles an embedded quote rather than escaping it with a backslash', () => {
    // RFC 4180 has one escape and it is the quote itself. A backslash parses as a literal backslash
    // in every spreadsheet, and the field then swallows the rest of the line.
    expect(csvField('Ali "Ace" Kaya')).toBe('"Ali ""Ace"" Kaya"')
  })

  it('quotes a field containing a newline, so one row does not become two', () => {
    expect(csvField('Ada\nLovelace')).toBe('"Ada\nLovelace"')
    expect(csvField('Ada\r\nLovelace')).toBe('"Ada\r\nLovelace"')
  })

  it('quotes leading and trailing whitespace, because " 001" and "001" are two employees', () => {
    expect(csvField(' 001')).toBe('" 001"')
    expect(csvField('001 ')).toBe('"001 "')
    expect(csvField('001')).toBe('001')
  })

  it('leaves an ordinary field alone rather than quoting everything', () => {
    expect(csvField('Ayşe Yılmaz')).toBe('Ayşe Yılmaz')
  })

  it('does not edit a value to defend a spreadsheet', () => {
    // A leading `=` is a formula-injection risk in Excel and the usual advice is to prefix it. Doing
    // so would make this file disagree with `people.display_name`, and a payroll file that quietly
    // edits the names in it is worse than one that renders a strange name strangely.
    expect(csvField('=SUM(A1:A9)')).toBe('=SUM(A1:A9)')
  })

  it('survives a whole row of hostile names', () => {
    const line = csvLine(['a,b', 'c"d', 'e\nf', null])
    expect(line).toBe(`"a,b","c""d","e\nf",${CSV_EOL}`)
  })
})

describe('null is an empty field, never zero and never the word null', () => {
  it('writes nothing at all for null', () => {
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
  })

  it('keeps beyond_cap_minutes empty where no ceiling was in force', () => {
    // Empty means the question was never asked of these days. Zero means a ceiling applied and
    // nothing passed it. A provider reading 0 for empty is the one place this export can cause a
    // wrong payment, which is why the column is nullable all the way from `attendance_days`.
    const row = hoursCsvRow(HEADER, hoursRow({ beyondCapMinutes: null, cappedDays: 0, uncappedDays: 2 }))
    const index = PAYROLL_HOURS_COLUMNS.indexOf('beyond_cap_minutes')
    expect(row[index]).toBeNull()
    expect(csvField(row[index])).toBe('')
  })

  it('keeps a zero that means zero', () => {
    const row = hoursCsvRow(HEADER, hoursRow({ beyondCapMinutes: 0, cappedDays: 1, uncappedDays: 1 }))
    expect(row[PAYROLL_HOURS_COLUMNS.indexOf('beyond_cap_minutes')]).toBe('0')
  })

  it('does the same for every other unknown', () => {
    expect(fmtNullableInt(null)).toBeNull()
    expect(fmtNullableInt(0)).toBe('0')
    const row = hoursCsvRow(
      HEADER,
      hoursRow({ employeeNo: null, contractHoursWeek: null, costCenterCode: null, positionTitle: null }),
    )
    expect(row[PAYROLL_HOURS_COLUMNS.indexOf('employee_no')]).toBeNull()
    expect(row[PAYROLL_HOURS_COLUMNS.indexOf('contract_hours_week')]).toBeNull()
    expect(row[PAYROLL_HOURS_COLUMNS.indexOf('cost_center_code')]).toBeNull()
    expect(row[PAYROLL_HOURS_COLUMNS.indexOf('position_title')]).toBeNull()
  })
})

describe('the numbers are spelled one way, for as long as v1 exists', () => {
  it('writes two decimal places with a dot, whatever the server locale is', () => {
    expect(fmtDecimal(1)).toBe('1.00')
    expect(fmtDecimal(0.6)).toBe('0.60')
    expect(fmtDecimal(0.5)).toBe('0.50')
    expect(fmtDecimal(2.005)).toBe('2.01')
  })

  it('never writes -0.00', () => {
    expect(fmtDecimal(-0)).toBe('0.00')
  })

  it('writes booleans as words, not as 1 and 0 a spreadsheet turns into a number column', () => {
    expect(fmtBool(true)).toBe('true')
    expect(fmtBool(false)).toBe('false')
  })

  it('writes minutes as whole numbers', () => {
    expect(fmtInt(1830)).toBe('1830')
    expect(fmtInt(0)).toBe('0')
  })
})

describe('the version travels in the data, not only in the filename', () => {
  it('puts the contract in the first column of every row of both files', () => {
    // A manifest can be separated from its CSVs and a filename can be changed on the way to a
    // payroll system. A file that has lost both must still be able to say what shape it is.
    expect(PAYROLL_HOURS_COLUMNS[0]).toBe('contract')
    expect(PAYROLL_LEAVE_COLUMNS[0]).toBe('contract')
    expect(hoursCsvRow(HEADER, hoursRow())[0]).toBe(PAYROLL_EXPORT_CONTRACT)
    expect(leaveCsvRow(HEADER, leaveRow())[0]).toBe(PAYROLL_EXPORT_CONTRACT)
  })

  it('keeps row 1 as the column names and nothing else', () => {
    // A version banner above the header is read as the first column name by every importer that
    // assumes row 1 is the header — which is most of them — and every field lands one row down.
    const csv = csvDocument(PAYROLL_HOURS_COLUMNS, [hoursCsvRow(HEADER, hoursRow())])
    expect(records(csv)[0]).toBe(PAYROLL_HOURS_COLUMNS.join(','))
  })

  it('repeats the entity and the period on every row, so a row is self-describing', () => {
    const row = leaveCsvRow(HEADER, leaveRow())
    expect(row[PAYROLL_LEAVE_COLUMNS.indexOf('legal_entity_id')]).toBe(HEADER.legalEntityId)
    expect(row[PAYROLL_LEAVE_COLUMNS.indexOf('legal_entity_name')]).toBe(HEADER.legalEntityName)
    expect(row[PAYROLL_LEAVE_COLUMNS.indexOf('period_start')]).toBe('2026-06-01')
    expect(row[PAYROLL_LEAVE_COLUMNS.indexOf('period_end')]).toBe('2026-06-30')
  })
})

describe('the column set is frozen', () => {
  /**
   * The literal column lists, written out.
   *
   * This is the test that costs something to change, on purpose. A column appended to v1 shifts every
   * positional importer, and the shift lands on `unpaid_leave_days` — a deduction. If this assertion
   * fails, the change belongs in `payroll.export.v2` beside an unchanged v1, not here.
   */
  it('has exactly these thirty-one columns in hours.csv, in this order', () => {
    expect([...PAYROLL_HOURS_COLUMNS]).toEqual([
      'contract',
      'legal_entity_id',
      'legal_entity_name',
      'period_start',
      'period_end',
      'person_id',
      'employee_no',
      'display_name',
      'employment_type',
      'fte',
      'contract_hours_week',
      'cost_center_code',
      'position_title',
      'hired_on',
      'terminated_on',
      'employment_changed_in_period',
      'day_sheets',
      'scheduled_minutes',
      'worked_minutes',
      'scheduled_worked_minutes',
      'break_minutes',
      'overtime_minutes',
      'late_minutes',
      'early_leave_minutes',
      'beyond_cap_minutes',
      'capped_days',
      'uncapped_days',
      'locked_days',
      'open_days',
      'paid_leave_days',
      'unpaid_leave_days',
    ])
  })

  it('has exactly these thirteen columns in leave.csv, in this order', () => {
    expect([...PAYROLL_LEAVE_COLUMNS]).toEqual([
      'contract',
      'legal_entity_id',
      'legal_entity_name',
      'period_start',
      'period_end',
      'person_id',
      'employee_no',
      'leave_type_key',
      'leave_type_name',
      'paid',
      'unit',
      'days',
      'requests',
    ])
  })

  it('renders exactly one field per column', () => {
    expect(hoursCsvRow(HEADER, hoursRow())).toHaveLength(PAYROLL_HOURS_COLUMNS.length)
    expect(leaveCsvRow(HEADER, leaveRow())).toHaveLength(PAYROLL_LEAVE_COLUMNS.length)
  })

  it('has no column a reader could mistake for money', () => {
    // Kern does not compute pay. There is no gross, net, rate, tax or currency amount here, and the
    // moment one appears Kern is a payroll system and owes the accuracy of one.
    const money = /rate|gross|net|salary|wage|pay_|amount|currency|tax|deduction/
    for (const column of [...PAYROLL_HOURS_COLUMNS, ...PAYROLL_LEAVE_COLUMNS])
      expect(money.test(column), `${column} reads as money`).toBe(false)
  })
})

describe('the encoding is pinned', () => {
  it('starts with a byte order mark, or Excel on Windows mangles every Turkish name', () => {
    const csv = csvDocument(PAYROLL_HOURS_COLUMNS, [])
    expect(csv.startsWith('﻿')).toBe(true)
  })

  it('ends every line with CRLF', () => {
    const csv = csvDocument(['a', 'b'], [['1', '2']])
    expect(csv).toBe(`${CSV_BOM}a,b\r\n1,2\r\n`)
  })

  it('writes a header even when there are no rows, rather than an empty file', () => {
    expect(records(csvDocument(PAYROLL_LEAVE_COLUMNS, []))).toEqual([PAYROLL_LEAVE_COLUMNS.join(',')])
  })
})

describe('the filename carries the version, the entity and the period', () => {
  it('names a whole calendar month as a month', () => {
    expect(periodLabel('2026-06-01', '2026-06-30')).toBe('2026-06')
    expect(periodLabel('2026-02-01', '2026-02-28')).toBe('2026-02')
    // 2028 is a leap year; the last day is the 29th and the month is still a whole month.
    expect(periodLabel('2028-02-01', '2028-02-29')).toBe('2028-02')
  })

  it('does not round a part-month up to the month it mostly falls in', () => {
    expect(periodLabel('2026-06-01', '2026-06-15')).toBe('2026-06-01_2026-06-15')
    expect(periodLabel('2026-06-02', '2026-06-30')).toBe('2026-06-02_2026-06-30')
  })

  it('transliterates an entity name rather than leaving holes in it', () => {
    expect(entitySlug('Kern Türkiye A.Ş.')).toBe('kern-turkiye-a-s')
    expect(entitySlug('Kern Netherlands B.V.')).toBe('kern-netherlands-b-v')
    // `ı` is a letter in its own right, not an `i` with something added, so stripping combining
    // marks leaves it untouched and it would otherwise become a hyphen.
    expect(entitySlug('Kırşehir Tekstil')).toBe('kirsehir-tekstil')
  })

  it('still produces a filename for a name that transliterates to nothing', () => {
    expect(entitySlug('株式会社')).toBe('entity')
  })

  it('puts the contract first, so two files six months apart cannot be opened under one mapping', () => {
    expect(
      exportFilename({
        entityName: 'Kern Türkiye A.Ş.',
        from: '2026-06-01',
        to: '2026-06-30',
        file: 'hours',
        draft: false,
      }),
    ).toBe('kern-payroll-v1_kern-turkiye-a-s_2026-06_hours.csv')
  })

  it('says DRAFT in the filename, because a toast does not travel with the CSV', () => {
    expect(
      exportFilename({
        entityName: 'Kern Türkiye A.Ş.',
        from: '2026-06-01',
        to: '2026-06-30',
        file: 'leave',
        draft: true,
      }),
    ).toBe('kern-payroll-v1_kern-turkiye-a-s_2026-06_DRAFT_leave.csv')
  })
})

describe('refuse rather than guess', () => {
  const base = {
    legalEntityName: 'Kern Netherlands B.V.',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    periodStatus: 'locked' as const,
    draft: false,
    population: 3,
    withoutEmployment: [],
  }

  it('refuses an open period, and names the two ways out', () => {
    // `reconcile-days` runs at 02:30 over a fourteen-day window and rebuilds every day a period does
    // not close, so the same export at 18:00 and at 09:00 the next morning can differ with nobody
    // having touched anything. Somebody pays from the first file and reconciles against the second.
    const [refusal] = exportRefusals({ ...base, periodStatus: 'open' })
    expect(refusal?.code).toBe('hr.period.not_locked')
    expect(refusal?.message).toContain('Kern Netherlands B.V.')
    expect(refusal?.message).toContain('Lock the period before exporting, or export a draft.')
  })

  it('lets a draft through, and only a draft', () => {
    expect(exportRefusals({ ...base, periodStatus: 'open', draft: true })).toEqual([])
    // The flag is not a general override: it excuses the open period and nothing else.
    expect(
      exportRefusals({ ...base, periodStatus: 'open', draft: true, population: 0 }).map((r) => r.code),
    ).toEqual(['hr.payroll.empty'])
  })

  it('refuses an entity with nobody in it, rather than writing a header and no rows', () => {
    const [refusal] = exportRefusals({ ...base, population: 0 })
    expect(refusal?.code).toBe('hr.payroll.empty')
    expect(refusal?.message).toContain('employed nobody')
  })

  it('refuses somebody with no employment record, because there is no basis to pay them on', () => {
    const [refusal] = exportRefusals({
      ...base,
      withoutEmployment: [
        { personId: '0198f0c0-0000-7000-8000-00000000000a', displayName: 'Jan de Vries' },
        { personId: '0198f0c0-0000-7000-8000-00000000000b', displayName: 'Sanne Bakker' },
      ],
    })
    expect(refusal?.code).toBe('hr.payroll.no_employment')
    expect(refusal?.message).toContain('Jan de Vries, Sanne Bakker')
    expect(refusal?.personIds).toHaveLength(2)
  })

  it('reads as a sentence for one person as well as for several', () => {
    const [refusal] = exportRefusals({
      ...base,
      withoutEmployment: [{ personId: '0198f0c0-0000-7000-8000-00000000000a', displayName: 'Sanne Bakker' }],
    })
    expect(refusal?.message).toBe(
      'Sanne Bakker has no employment record covering their days in Kern Netherlands B.V. over this ' +
        'period, so there is no basis to pay them on. Add an employment record, or move them to the ' +
        'entity that employs them.',
    )
  })

  it('names at most five people, then counts the rest', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      personId: `0198f0c0-0000-7000-8000-00000000000${i}`,
      displayName: `Person ${i}`,
    }))
    const [refusal] = exportRefusals({ ...base, withoutEmployment: many })
    expect(refusal?.message).toContain('and 4 more')
    expect(refusal?.personIds).toHaveLength(9)
  })

  it('reports every reason at once, so a screen shows all of them', () => {
    expect(
      exportRefusals({
        ...base,
        periodStatus: 'open',
        population: 0,
        withoutEmployment: [{ personId: '0198f0c0-0000-7000-8000-00000000000a', displayName: 'Jan' }],
      }).map((r) => r.code),
    ).toEqual(['hr.period.not_locked', 'hr.payroll.empty', 'hr.payroll.no_employment'])
  })

  it('says nothing when there is nothing to say', () => {
    expect(exportRefusals(base)).toEqual([])
  })
})

describe('the totals state their own denominator', () => {
  it('adds the minutes and publishes the day sheets they came from', () => {
    const totals = totalsOf([hoursRow(), hoursRow({ personId: PERSON_B, daySheets: 2, workedMinutes: 1020 })])
    expect(totals.people).toBe(2)
    expect(totals.daySheets).toBe(6)
    expect(totals.workedMinutes).toBe(2850)
  })

  it('keeps beyond_cap_minutes null when no row had a ceiling, and sums it when one did', () => {
    expect(totalsOf([hoursRow({ beyondCapMinutes: null, cappedDays: 0 })]).beyondCapMinutes).toBeNull()
    expect(
      totalsOf([hoursRow({ beyondCapMinutes: 30 }), hoursRow({ personId: PERSON_B, beyondCapMinutes: null })])
        .beyondCapMinutes,
    ).toBe(30)
  })

  it('rounds leave days rather than accumulating floating point across a population', () => {
    const rows = Array.from({ length: 3 }, () => hoursRow({ paidLeaveDays: 0.1 }))
    expect(totalsOf(rows).paidLeaveDays).toBe(0.3)
  })
})

describe('the assembled export', () => {
  it('writes three files: the two CSVs and the manifest beside them', () => {
    const out = assembleExport(assembly())
    expect(out.files.map((f) => f.name)).toEqual([
      'kern-payroll-v1_kern-turkiye-a-s_2026-06_hours.csv',
      'kern-payroll-v1_kern-turkiye-a-s_2026-06_leave.csv',
      'kern-payroll-v1_kern-turkiye-a-s_2026-06_manifest.json',
    ])
  })

  it('carries the contract, the provenance and the format in the manifest', () => {
    const out = assembleExport(assembly())
    expect(out.manifest.contract).toBe(PAYROLL_EXPORT_CONTRACT)
    // Provenance, never the contract identity: the module version moves on every patch and the CSV
    // shape must not move with it.
    expect(out.manifest.kernVersion).toBe('1.4.0')
    expect(out.manifest.dayLengthMinutes).toBe(480)
    expect(out.manifest.format.byteOrderMark).toBe(true)
    expect(out.manifest.format.lineEnding).toBe('crlf')
    expect(out.manifest.scope.permissions).toContain('hr.payroll.export')
  })

  it('states its own denominator: population, counted, and the columns of each file', () => {
    const out = assembleExport(assembly({ population: 12, counted: 9 }))
    expect(out.manifest.population).toBe(12)
    expect(out.manifest.counted).toBe(9)
    expect(out.manifest.files[0]?.columns).toEqual([...PAYROLL_HOURS_COLUMNS])
    expect(out.manifest.files[0]?.rows).toBe(1)
  })

  it('says draft in the manifest and in both filenames when it is one', () => {
    const out = assembleExport(assembly({ draft: true, period: { ...assembly().period, status: 'open' } }))
    expect(out.manifest.finality).toBe('draft')
    expect(out.manifest.draft).toBe(true)
    expect(out.manifest.periodStatus).toBe('open')
    for (const file of out.files) expect(file.name).toContain('_DRAFT_')
  })

  it('says final for a locked period, and never says it for a draft', () => {
    expect(assembleExport(assembly()).manifest.finality).toBe('final')
  })

  it('parses back to one header and one row per person', () => {
    const out = assembleExport(assembly({ hours: [hoursRow(), hoursRow({ personId: PERSON_B })] }))
    expect(records(out.files[0]!.content)).toHaveLength(3)
  })

  it('survives an entity name with a comma in it, in every row of both files', () => {
    const out = assembleExport(
      assembly({ entity: { id: HEADER.legalEntityId, name: 'Kern, A.Ş.', country: 'TR', currency: 'TRY' } }),
    )
    for (const file of out.files.slice(0, 2)) {
      const [, first] = records(file.content)
      expect(first).toContain('"Kern, A.Ş."')
    }
  })

  it('writes a manifest that is valid JSON, ending in a newline', () => {
    const out = assembleExport(assembly())
    const manifest = out.files[2]!
    expect(manifest.content.endsWith('\n')).toBe(true)
    expect(JSON.parse(manifest.content).contract).toBe(PAYROLL_EXPORT_CONTRACT)
  })

  it('declares the media type, so a browser saves rather than renders', () => {
    const out = assembleExport(assembly())
    expect(out.files[0]?.contentType).toBe('text/csv; charset=utf-8')
    expect(out.files[2]?.contentType).toBe('application/json; charset=utf-8')
  })
})
