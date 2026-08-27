import { KernError, type Tx } from '@kernhq/kernel'
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  PAYROLL_EXPORT_CONTRACT,
  PAYROLL_HOURS_COLUMNS,
  PAYROLL_LEAVE_COLUMNS,
} from '../../contract/exports.js'
import type {
  IsoDate,
  PayrollExport,
  PayrollExportManifest,
  PayrollExportRefusal,
  PayrollExportTotals,
  PayrollHoursRow,
  PayrollLeaveRow,
  ReportFinality,
} from '../../contract/index.js'
import {
  costCenters,
  employments,
  leaveRequestDays,
  leaveRequests,
  leaveTypes,
  legalEntities,
  people,
  periods,
  positions,
} from '../schema.js'
import { num } from './db.js'
import {
  capTotal,
  type DayAggregateRow,
  mergeFinality,
  type ReportsService,
  rangeRefusal,
  round2,
} from './reports.js'

/**
 * The payroll export: what it refuses, how it is spelled, and where each number comes from.
 *
 * Same shape as `reports.ts` next door and for the same reason. **Everything above the class is
 * pure** — no `tx`, no clock, no kernel — because the decisions worth pinning here are decisions
 * about *characters*, and a character is invisible in a query plan. A display name with a comma, a
 * quote or a newline is the oldest bug in this format and the one a customer finds first; a
 * `beyond_cap_minutes` written as `0` instead of an empty field is the one that causes a wrong
 * payment. Neither throws, neither fails a type-check, and both look like a working file.
 *
 * **Everything below the class is aggregated in the database.** Day sheets and approved leave are
 * grouped in Postgres, one query per set of people who belonged to the entity on the same days —
 * which for a month nobody transferred through is one query for the whole entity. Nothing here reads
 * a period of day sheets into the process to add them up.
 *
 * Kern does not compute pay. There is no rate, no gross, no net, no deduction and no currency amount
 * below this line, and there must not be one above it either.
 */

// ====================================================================== pure

/**
 * UTF-8 byte order mark.
 *
 * Excel on Windows reads a BOM-less UTF-8 CSV as the system code page and mangles every Turkish and
 * Persian name in it — and this module ships country packs for both. Frozen with the rest of the
 * format: v1 has a BOM for as long as v1 is published.
 */
export const CSV_BOM = '﻿'

/** CRLF, per RFC 4180 and frozen with the rest of the format. */
export const CSV_EOL = '\r\n'

/**
 * When a field has to be quoted: a comma, a quote, a line break, or leading/trailing whitespace.
 *
 * The first three are RFC 4180's rule and the reason this function exists — `Şirket, A.Ş.` in a
 * display name silently shifts every column after it by one, and the row still parses, so nothing
 * reports an error and the figures land under the wrong headings. The last is not required by the
 * standard and is kept anyway, because a bureau's importer trimming " 001" to "001" is a different
 * employee.
 */
const NEEDS_QUOTING = /[",\r\n]|^\s|\s$/

/**
 * One CSV field, RFC 4180.
 *
 * **Null is an empty field, never `0` and never the word "null".** That distinction is the whole
 * point of `beyond_cap_minutes`: empty means no statutory ceiling was in force, `0` means one was and
 * nothing exceeded it, and a provider reading `0` for empty is the one place this export can cause a
 * wrong payment.
 *
 * A value is never altered to defend a spreadsheet. Prefixing a leading `=` or `+` to stop Excel
 * evaluating it is the usual advice, and it would make this file disagree with `people.display_name`
 * — a payroll file that quietly edits the names in it is worse than one that renders a strange name
 * strangely.
 */
export function csvField(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return NEEDS_QUOTING.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** One CSV record, terminated. */
export function csvLine(fields: ReadonlyArray<string | null | undefined>): string {
  return `${fields.map(csvField).join(',')}${CSV_EOL}`
}

/**
 * A whole CSV: BOM, the column names, then the rows.
 *
 * **Row 1 is the column names and nothing else.** No version banner above them: a line like
 * `kern-payroll-v1` in row 1 is read as the first column name by every importer that assumes the
 * header is the first row — which is most of them and all of the spreadsheet ones — and every field
 * then lands one row down. The version rides in the first *column* instead, where an importer sees
 * it as data.
 */
export function csvDocument(
  columns: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
): string {
  return CSV_BOM + csvLine(columns) + rows.map(csvLine).join('')
}

/** An integer, as text. */
export const fmtInt = (value: number): string => String(Math.round(value))

/** An integer that may be unknown. Null stays null so `csvField` writes an empty field. */
export const fmtNullableInt = (value: number | null): string | null => (value === null ? null : fmtInt(value))

/**
 * Two decimal places, `.` separated, and never `-0.00`.
 *
 * `fte` and every leave-day figure are written this way, frozen: halves and quarters add up exactly
 * at two places, and a locale-dependent separator would make one customer's file unreadable by
 * another's importer.
 */
export function fmtDecimal(value: number): string {
  const rounded = round2(value)
  return (rounded === 0 ? 0 : rounded).toFixed(2)
}

/** `true` / `false`, spelled out. Not 1/0, which a spreadsheet turns into a number column. */
export const fmtBool = (value: boolean): string => (value ? 'true' : 'false')

/**
 * The handful of letters `NFD` cannot decompose, for the filename slug.
 *
 * Turkish `ı` is the one that matters here — it is a letter in its own right rather than an `i` with
 * something added, so stripping combining marks leaves it untouched and it would become a hyphen.
 * `Kırşehir` reading as `k-r-ehir` in a filename is the kind of detail a customer reads as
 * carelessness.
 */
const SLUG_LETTERS: Record<string, string> = {
  ı: 'i',
  İ: 'i',
  ø: 'o',
  Ø: 'o',
  đ: 'd',
  Đ: 'd',
  ł: 'l',
  Ł: 'l',
  ß: 'ss',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  þ: 'th',
  ð: 'd',
}

/**
 * A legal entity's name, safe for a filename on any filesystem a bureau might use.
 *
 * `Kern Türkiye A.Ş.` → `kern-turkiye-a-s`. Lossy on purpose: the exact name travels in the manifest
 * and in every row of both CSVs, so the filename only has to be legible and stable.
 */
export function entitySlug(name: string): string {
  const letters = [...name].map((ch) => SLUG_LETTERS[ch] ?? ch).join('')
  const ascii = letters.normalize('NFD').replace(/\p{M}/gu, '')
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  // An entity named only in a script that transliterates to nothing still needs a filename.
  return slug || 'entity'
}

/** The last day of `YYYY-MM`, so a whole calendar month can be recognised as one. */
function lastDayOf(year: string, month: string): string {
  const day = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
  return String(day).padStart(2, '0')
}

/**
 * `2026-06` for a whole calendar month, `2026-06-01_2026-06-15` for anything else.
 *
 * A payroll period is nearly always a month and a bureau reads `2026-06` at a glance; a period that
 * is not one says so rather than being rounded to the month it mostly falls in.
 */
export function periodLabel(from: IsoDate, to: IsoDate): string {
  const [fromYear, fromMonth, fromDay] = from.split('-')
  const [toYear, toMonth, toDay] = to.split('-')
  if (!fromYear || !fromMonth || !toYear || !toMonth) return `${from}_${to}`
  const wholeMonth =
    fromYear === toYear && fromMonth === toMonth && fromDay === '01' && toDay === lastDayOf(toYear, toMonth)
  return wholeMonth ? `${fromYear}-${fromMonth}` : `${from}_${to}`
}

/**
 * `kern-payroll-v1_kern-turkiye-a-s_2026-06_hours.csv`, and `DRAFT` where it belongs.
 *
 * The filename is the only part of this export that survives being emailed to a bureau, dropped on a
 * shared drive and opened by somebody who never saw the API, so the contract version leads it. A
 * bureau that receives two files six months apart and opens both under one mapping is the failure
 * this prevents, and it is a failure nobody sees an error for.
 */
export function exportFilename(input: {
  entityName: string
  from: IsoDate
  to: IsoDate
  file: 'hours' | 'leave' | 'manifest'
  draft: boolean
}): string {
  const extension = input.file === 'manifest' ? 'json' : 'csv'
  const draft = input.draft ? 'DRAFT_' : ''
  const slug = entitySlug(input.entityName)
  return `${PAYROLL_EXPORT_CONTRACT}_${slug}_${periodLabel(input.from, input.to)}_${draft}${input.file}.${extension}`
}

/** What every row of both files repeats, so a row that has lost its manifest still identifies itself. */
export interface PayrollFileHeader {
  legalEntityId: string
  legalEntityName: string
  periodStart: IsoDate
  periodEnd: IsoDate
}

/**
 * One `hours.csv` record, in `PAYROLL_HOURS_COLUMNS` order.
 *
 * The order is the file format. Nothing here may be reordered, renamed, added to or removed while v1
 * is published — a positional importer shifts on an appended column, and the shift lands on
 * `unpaid_leave_days`, which is a deduction.
 */
export function hoursCsvRow(header: PayrollFileHeader, row: PayrollHoursRow): Array<string | null> {
  return [
    PAYROLL_EXPORT_CONTRACT,
    header.legalEntityId,
    header.legalEntityName,
    header.periodStart,
    header.periodEnd,
    row.personId,
    row.employeeNo,
    row.displayName,
    row.employmentType,
    fmtDecimal(row.fte),
    row.contractHoursWeek === null ? null : fmtDecimal(row.contractHoursWeek),
    row.costCenterCode,
    row.positionTitle,
    row.hiredOn,
    row.terminatedOn,
    fmtBool(row.employmentChangedInPeriod),
    fmtInt(row.daySheets),
    fmtInt(row.scheduledMinutes),
    fmtInt(row.workedMinutes),
    fmtInt(row.scheduledWorkedMinutes),
    fmtInt(row.breakMinutes),
    fmtInt(row.overtimeMinutes),
    fmtInt(row.lateMinutes),
    fmtInt(row.earlyLeaveMinutes),
    // The empty field the whole class exists for. Never `fmtInt(row.beyondCapMinutes ?? 0)`.
    fmtNullableInt(row.beyondCapMinutes),
    fmtInt(row.cappedDays),
    fmtInt(row.uncappedDays),
    fmtInt(row.lockedDays),
    fmtInt(row.openDays),
    fmtDecimal(row.paidLeaveDays),
    fmtDecimal(row.unpaidLeaveDays),
  ]
}

/** One `leave.csv` record, in `PAYROLL_LEAVE_COLUMNS` order. Frozen exactly as above. */
export function leaveCsvRow(header: PayrollFileHeader, row: PayrollLeaveRow): Array<string | null> {
  return [
    PAYROLL_EXPORT_CONTRACT,
    header.legalEntityId,
    header.legalEntityName,
    header.periodStart,
    header.periodEnd,
    row.personId,
    row.employeeNo,
    row.leaveTypeKey,
    row.leaveTypeName,
    fmtBool(row.paid),
    row.unit,
    fmtDecimal(row.days),
    fmtInt(row.requests),
  ]
}

/**
 * Everything over the whole population, so a screen states a total before a file exists.
 *
 * `beyondCapMinutes` is totalled through `capTotal` rather than added up: a sum that coalesces null
 * to zero would report "nothing exceeded the ceiling" for a workspace where no ceiling ever applied.
 */
export function totalsOf(rows: readonly PayrollHoursRow[]): PayrollExportTotals {
  const sum = (of: (row: PayrollHoursRow) => number) => rows.reduce((total, row) => total + of(row), 0)
  return {
    people: rows.length,
    daySheets: sum((r) => r.daySheets),
    scheduledMinutes: sum((r) => r.scheduledMinutes),
    workedMinutes: sum((r) => r.workedMinutes),
    scheduledWorkedMinutes: sum((r) => r.scheduledWorkedMinutes),
    breakMinutes: sum((r) => r.breakMinutes),
    overtimeMinutes: sum((r) => r.overtimeMinutes),
    lateMinutes: sum((r) => r.lateMinutes),
    earlyLeaveMinutes: sum((r) => r.earlyLeaveMinutes),
    beyondCapMinutes: capTotal(rows.map((r) => r.beyondCapMinutes)).beyondCapMinutes,
    cappedDays: sum((r) => r.cappedDays),
    uncappedDays: sum((r) => r.uncappedDays),
    lockedDays: sum((r) => r.lockedDays),
    openDays: sum((r) => r.openDays),
    paidLeaveDays: round2(sum((r) => r.paidLeaveDays)),
    unpaidLeaveDays: round2(sum((r) => r.unpaidLeaveDays)),
  }
}

/** At most five names, then a count. A refusal listing four hundred people is a refusal nobody reads. */
function namesFor(withoutEmployment: ReadonlyArray<{ displayName: string }>): string {
  const shown = withoutEmployment.slice(0, 5).map((p) => p.displayName)
  const rest = withoutEmployment.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
}

/**
 * Why this export will not be written — the whole list, so a screen shows all of it at once.
 *
 * **Refuse rather than guess** is the rule, and each of these is a case where the alternative is a
 * row of zeros somebody pays from:
 *
 * - **An open period may still move.** `reconcile-days` runs at 02:30 over a fourteen-day window and
 *   rebuilds every day a period does not close, so the same export at 18:00 and at 09:00 the next
 *   morning can differ with nobody having touched anything. Somebody pays from the first file and
 *   reconciles against the second. `draft` is the one escape hatch, and it is a statement the caller
 *   makes which the file then repeats — never a toast, because the toast does not travel with the CSV.
 * - **An entity with nobody in it** is a mistyped id or an entity nobody has been moved into yet. An
 *   empty file with a correct header looks like a month in which nobody worked.
 * - **A person with no employment row** has no employment type, no FTE, no cost centre and no
 *   position — every field a provider picks a rate from, blank. They reach the population through
 *   their office rather than their employment, which is a real state the ladder allows and not one
 *   anything should be paid on.
 */
export function exportRefusals(input: {
  legalEntityName: string
  periodStart: IsoDate
  periodEnd: IsoDate
  periodStatus: 'open' | 'locked'
  draft: boolean
  population: number
  withoutEmployment: ReadonlyArray<{ personId: string; displayName: string }>
}): PayrollExportRefusal[] {
  const refusals: PayrollExportRefusal[] = []
  if (input.periodStatus === 'open' && !input.draft)
    refusals.push({
      code: 'hr.period.not_locked',
      message:
        `${input.periodStart} to ${input.periodEnd} is still open for ${input.legalEntityName}. ` +
        'Lock the period before exporting, or export a draft.',
      personIds: [],
    })
  if (input.population === 0)
    refusals.push({
      code: 'hr.payroll.empty',
      message:
        `${input.legalEntityName} employed nobody between ${input.periodStart} and ` +
        `${input.periodEnd}. There is nothing to export.`,
      personIds: [],
    })
  if (input.withoutEmployment.length) {
    const one = input.withoutEmployment.length === 1
    refusals.push({
      code: 'hr.payroll.no_employment',
      message:
        (one
          ? `${input.withoutEmployment[0]?.displayName} has no employment record covering their days `
          : `${input.withoutEmployment.length} people have no employment record covering their days `) +
        `in ${input.legalEntityName} over this period, so there is no basis to pay ` +
        (one ? 'them on. ' : `them on: ${namesFor(input.withoutEmployment)}. `) +
        'Add an employment record, or move them to the entity that employs them.',
      personIds: input.withoutEmployment.map((p) => p.personId),
    })
  }
  return refusals
}

/**
 * People with an employee number first, in code-unit order; everybody else after them, by name.
 *
 * Deliberately **not** `localeCompare`: a frozen file format whose row order depends on the server's
 * locale is one that produces two different files from one database, and a bureau diffing last
 * month's against this month's would see every row move.
 */
function byPayrollOrder(
  a: { employeeNo: string | null; displayName: string; personId: string },
  b: { employeeNo: string | null; displayName: string; personId: string },
): number {
  if ((a.employeeNo === null) !== (b.employeeNo === null)) return a.employeeNo === null ? 1 : -1
  if (a.employeeNo !== null && b.employeeNo !== null && a.employeeNo !== b.employeeNo)
    return a.employeeNo < b.employeeNo ? -1 : 1
  if (a.displayName !== b.displayName) return a.displayName < b.displayName ? -1 : 1
  return a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0
}

/** Everything `assembleExport` needs that is not one of the rows. */
export interface PayrollExportAssembly {
  entity: { id: string; name: string; country: string; currency: string | null }
  period: { id: string; startsOn: IsoDate; endsOn: IsoDate; status: 'open' | 'locked' }
  draft: boolean
  generatedAt: string
  kernVersion: string
  /** The keys that produced this population, on the response so two readers cannot disagree silently. */
  permissions: string[]
  dayLengthMinutes: number
  population: number
  counted: number
  attendance: ReportFinality
  hours: readonly PayrollHoursRow[]
  leave: readonly PayrollLeaveRow[]
}

/** The manifest, without the files — shared by the export and its preview. */
export function exportManifest(input: PayrollExportAssembly): PayrollExportManifest {
  const header: PayrollFileHeader = {
    legalEntityId: input.entity.id,
    legalEntityName: input.entity.name,
    periodStart: input.period.startsOn,
    periodEnd: input.period.endsOn,
  }
  const named = (file: 'hours' | 'leave' | 'manifest') =>
    exportFilename({
      entityName: input.entity.name,
      from: header.periodStart,
      to: header.periodEnd,
      file,
      draft: input.draft,
    })
  return {
    contract: PAYROLL_EXPORT_CONTRACT,
    generatedAt: input.generatedAt,
    kernVersion: input.kernVersion,
    finality: input.draft ? 'draft' : 'final',
    draft: input.draft,
    legalEntityId: input.entity.id,
    legalEntityName: input.entity.name,
    country: input.entity.country,
    currency: input.entity.currency,
    periodId: input.period.id,
    periodStart: input.period.startsOn,
    periodEnd: input.period.endsOn,
    periodStatus: input.period.status,
    population: input.population,
    counted: input.counted,
    scope: { permissions: input.permissions, askedAt: 'workspace' },
    attendance: input.attendance,
    dayLengthMinutes: input.dayLengthMinutes,
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
      { name: named('hours'), columns: [...PAYROLL_HOURS_COLUMNS], rows: input.hours.length },
      { name: named('leave'), columns: [...PAYROLL_LEAVE_COLUMNS], rows: input.leave.length },
    ],
  }
}

/**
 * The three files, from rows that have already been fetched.
 *
 * Pure, so the test pins the bytes without a database: the column order, the quoting, the empty
 * `beyond_cap_minutes`, the filenames and the manifest beside them are all decided here.
 */
export function assembleExport(input: PayrollExportAssembly): PayrollExport {
  const manifest = exportManifest(input)
  const header: PayrollFileHeader = {
    legalEntityId: input.entity.id,
    legalEntityName: input.entity.name,
    periodStart: input.period.startsOn,
    periodEnd: input.period.endsOn,
  }
  const hoursFile = manifest.files[0]!
  const leaveFile = manifest.files[1]!
  return {
    manifest,
    files: [
      {
        name: hoursFile.name,
        contentType: 'text/csv; charset=utf-8',
        content: csvDocument(
          PAYROLL_HOURS_COLUMNS,
          input.hours.map((row) => hoursCsvRow(header, row)),
        ),
      },
      {
        name: leaveFile.name,
        contentType: 'text/csv; charset=utf-8',
        content: csvDocument(
          PAYROLL_LEAVE_COLUMNS,
          input.leave.map((row) => leaveCsvRow(header, row)),
        ),
      },
      {
        name: exportFilename({
          entityName: input.entity.name,
          from: input.period.startsOn,
          to: input.period.endsOn,
          file: 'manifest',
          draft: input.draft,
        }),
        contentType: 'application/json; charset=utf-8',
        content: `${JSON.stringify(manifest, null, 2)}\n`,
      },
    ],
  }
}

// ====================================================================== database

/** What one person's employment looked like over their days in this entity. */
interface EmploymentFacts {
  employmentType: string
  fte: number
  contractHoursWeek: number | null
  costCenterCode: string | null
  positionTitle: string | null
  changedInPeriod: boolean
}

/** A set of people over a set of dates, the same spelling `ReportsService.groupsFor` returns. */
interface DateGroup {
  personIds: string[] | null
  dates: string[] | null
}

interface LeaveAggregateRow {
  personId: string
  leaveTypeKey: string
  leaveTypeName: string
  paid: boolean
  unit: 'day' | 'half_day' | 'hour'
  days: number
  requests: number
}

/** Everything one export needs, before it is turned into bytes. */
export interface PayrollExportData {
  entity: { id: string; name: string; country: string; currency: string | null }
  period: { id: string; startsOn: string; endsOn: string; status: 'open' | 'locked' }
  population: number
  counted: number
  attendance: ReportFinality
  hours: PayrollHoursRow[]
  leave: PayrollLeaveRow[]
  refusals: PayrollExportRefusal[]
  totals: PayrollExportTotals
}

export class PayrollExportService {
  constructor(private readonly reports: ReportsService) {}

  /**
   * One entity, one period, every row — and every reason it should not be written.
   *
   * The refusals are *returned* rather than thrown, because `payroll.export.preview` has to show all
   * of them at once on a screen. `payroll.export.v1` throws the first.
   *
   * The membership question is the whole design in one line: a row is keyed by (entity, period,
   * person), and a person who transfers mid-period produces two rows, one in each entity's file,
   * each carrying only that entity's days. `ReportsService.population` already answers it — the
   * ladder resolves `employment.legalEntityId ?? office.legalEntityId` per **date**, which is what
   * `setPeriodLock` does on the write side. Attributing the whole period to the entity somebody
   * happened to end it in would report one employer's hours under the other's name and be wrong for
   * both.
   */
  async collect(
    tx: Tx,
    input: { workspaceId: string; legalEntityId: string; periodId: string; draft: boolean },
  ): Promise<PayrollExportData> {
    const entity = await this.entity(tx, input.workspaceId, input.legalEntityId)
    if (!entity) throw KernError.notFound('Legal entity')
    const period = await this.period(tx, input.workspaceId, input.periodId)
    if (!period) throw KernError.notFound('Period')
    if (period.kind !== 'payroll')
      throw KernError.badRequest(
        'That period is an attendance period, not a payroll one. A payroll export takes a payroll period.',
      )
    // A period naming an entity covers only that entity; one naming none covers the workspace. The
    // same rule `PolicyService.isLocked` applies, so a lock and its export cannot disagree.
    if (period.legalEntityId && period.legalEntityId !== entity.id)
      throw KernError.badRequest(
        `That period belongs to another legal entity. Lock and export ${entity.name}'s own period.`,
      )

    const from = period.startsOn
    const to = period.endsOn
    // A period is a month and this never fires in practice — but `periods.create` takes any two
    // dates, and the refusal names both numbers rather than running for minutes.
    const refusal = rangeRefusal({ from, to, perDay: true })
    if (refusal) throw KernError.badRequest(refusal)

    const population = await this.reports.population(
      tx,
      input.workspaceId,
      { by: 'legal_entity', id: entity.id },
      from,
      to,
    )

    // One pair of queries per set of people who belonged to the entity on the same days — which for a
    // month nobody transferred through is one pair for the whole entity.
    const groups: DateGroup[] = this.reports.groupsFor(population, from, to)
    const dayRows: DayAggregateRow[] = []
    const leaveRows: LeaveAggregateRow[] = []
    for (const group of groups) {
      dayRows.push(...(await this.reports.dayAggregate(tx, input.workspaceId, group, from, to)))
      leaveRows.push(...(await this.leaveAggregate(tx, input.workspaceId, group, from, to)))
    }

    const facts = await this.peopleFacts(tx, input.workspaceId, population.personIds)
    const employment = await this.employmentFacts(
      tx,
      input.workspaceId,
      entity.id,
      population.personIds,
      population.datesByPerson,
      from,
      to,
    )

    const dayByPerson = new Map(dayRows.map((r) => [r.personId, r]))
    const leaveByPerson = new Map<string, LeaveAggregateRow[]>()
    for (const row of leaveRows) {
      const found = leaveByPerson.get(row.personId)
      if (found) found.push(row)
      else leaveByPerson.set(row.personId, [row])
    }

    const withoutEmployment: Array<{ personId: string; displayName: string }> = []
    const hours: PayrollHoursRow[] = []
    for (const personId of population.personIds) {
      const person = facts.get(personId)
      const mine = employment.get(personId)
      const displayName = person?.displayName ?? ''
      if (!mine) withoutEmployment.push({ personId, displayName })
      const day = dayByPerson.get(personId)
      const leave = leaveByPerson.get(personId) ?? []
      const paidLeaveDays = leave.filter((l) => l.paid).reduce((total, l) => total + l.days, 0)
      const unpaidLeaveDays = leave.filter((l) => !l.paid).reduce((total, l) => total + l.days, 0)
      hours.push({
        personId,
        employeeNo: person?.employeeNo ?? null,
        displayName,
        // Empty rather than invented where there is no employment row. The row is refused above; it
        // is still built, because the preview has to show the reader which people the refusal is about.
        employmentType: mine?.employmentType ?? '',
        fte: mine?.fte ?? 0,
        contractHoursWeek: mine?.contractHoursWeek ?? null,
        costCenterCode: mine?.costCenterCode ?? null,
        positionTitle: mine?.positionTitle ?? null,
        hiredOn: person?.hiredOn ?? null,
        terminatedOn: person?.terminatedOn ?? null,
        employmentChangedInPeriod: mine?.changedInPeriod ?? false,
        daySheets: day?.days ?? 0,
        scheduledMinutes: day?.scheduledMinutes ?? 0,
        workedMinutes: day?.workedMinutes ?? 0,
        scheduledWorkedMinutes: day?.scheduledWorkedMinutes ?? 0,
        breakMinutes: day?.breakMinutes ?? 0,
        overtimeMinutes: day?.overtimeMinutes ?? 0,
        lateMinutes: day?.lateMinutes ?? 0,
        earlyLeaveMinutes: day?.earlyLeaveMinutes ?? 0,
        // `?? null` and never `?? 0`: somebody with no day sheet at all had no ceiling asked of them.
        beyondCapMinutes: day?.beyondCapMinutes ?? null,
        cappedDays: day?.cappedDays ?? 0,
        uncappedDays: day?.uncappedDays ?? 0,
        lockedDays: day?.lockedDays ?? 0,
        openDays: day?.openDays ?? 0,
        paidLeaveDays: round2(paidLeaveDays),
        unpaidLeaveDays: round2(unpaidLeaveDays),
      })
    }
    hours.sort(byPayrollOrder)

    const leave: PayrollLeaveRow[] = leaveRows
      .map((row) => ({
        personId: row.personId,
        employeeNo: facts.get(row.personId)?.employeeNo ?? null,
        leaveTypeKey: row.leaveTypeKey,
        leaveTypeName: row.leaveTypeName,
        paid: row.paid,
        unit: row.unit,
        days: round2(row.days),
        requests: row.requests,
      }))
      .sort((a, b) => {
        const person = byPayrollOrder(
          {
            employeeNo: a.employeeNo,
            displayName: facts.get(a.personId)?.displayName ?? '',
            personId: a.personId,
          },
          {
            employeeNo: b.employeeNo,
            displayName: facts.get(b.personId)?.displayName ?? '',
            personId: b.personId,
          },
        )
        return person !== 0
          ? person
          : a.leaveTypeKey < b.leaveTypeKey
            ? -1
            : a.leaveTypeKey > b.leaveTypeKey
              ? 1
              : 0
      })

    const counted = new Set([...dayByPerson.keys(), ...leaveByPerson.keys()]).size

    return {
      entity,
      period: { id: period.id, startsOn: from, endsOn: to, status: period.status as 'open' | 'locked' },
      population: population.personIds.length,
      counted,
      attendance: mergeFinality(dayRows),
      hours,
      leave,
      totals: totalsOf(hours),
      refusals: exportRefusals({
        legalEntityName: entity.name,
        periodStart: from,
        periodEnd: to,
        periodStatus: period.status as 'open' | 'locked',
        draft: input.draft,
        population: population.personIds.length,
        withoutEmployment,
      }),
    }
  }

  /** The employer this file is addressed on behalf of: the fields a filing is made under. */
  async entity(tx: Tx, workspaceId: string, legalEntityId: string) {
    const [row] = await tx
      .select({
        id: legalEntities.id,
        name: legalEntities.name,
        country: legalEntities.country,
        currency: legalEntities.currency,
      })
      .from(legalEntities)
      .where(and(eq(legalEntities.workspaceId, workspaceId), eq(legalEntities.id, legalEntityId)))
      .limit(1)
    return row
  }

  /** The period, which is the range. A caller does not get to draw their own boundary. */
  async period(tx: Tx, workspaceId: string, periodId: string) {
    const [row] = await tx
      .select({
        id: periods.id,
        kind: periods.kind,
        legalEntityId: periods.legalEntityId,
        startsOn: periods.startsOn,
        endsOn: periods.endsOn,
        status: periods.status,
      })
      .from(periods)
      .where(and(eq(periods.workspaceId, workspaceId), eq(periods.id, periodId)))
      .limit(1)
    return row
  }

  /** Identity and the two dates a provider prorates a joiner or a leaver on. */
  async peopleFacts(tx: Tx, workspaceId: string, personIds: string[]) {
    const out = new Map<
      string,
      { employeeNo: string | null; displayName: string; hiredOn: string | null; terminatedOn: string | null }
    >()
    if (!personIds.length) return out
    const rows = await tx
      .select({
        id: people.id,
        employeeNo: people.employeeNo,
        displayName: people.displayName,
        hiredOn: people.hiredOn,
        terminatedOn: people.terminatedOn,
      })
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, personIds)))
    for (const row of rows)
      out.set(row.id, {
        employeeNo: row.employeeNo,
        displayName: row.displayName,
        hiredOn: row.hiredOn,
        terminatedOn: row.terminatedOn,
      })
    return out
  }

  /**
   * The employment facts that let a provider pick a rate, per person — and whether they moved.
   *
   * Two different questions over one set of rows, and answering both from the same filter is a bug
   * this had until it was run against a database:
   *
   * **Which facts to publish** is a question about *this entity's days*. A row qualifies when it
   * overlaps the days the person belonged to this entity and it either names this entity or names
   * none — the second half because the ladder falls back from the employment to the office, so
   * somebody employed with a null entity is genuinely in this file through their desk. The **last**
   * qualifying row wins, so a transferring person contributes their TR row to the TR file and their
   * NL row to the NL file, and neither file carries the other's FTE.
   *
   * **Whether anything changed** is a question about *the period*, over every row, entity or not.
   * Counting only this entity's rows reports `false` for the one case the column exists for: somebody
   * who left the entity on the 15th looks, in this file, like a full-time employee of it for a period
   * running to the 30th, and a monthly-salaried person is then paid a whole month here and a partial
   * month next door. `day_sheets` hints at it and a flag states it. Publishing the end state silently
   * is the failure; the flag is what makes it visible without this module inventing a weighted
   * average nobody asked for.
   */
  async employmentFacts(
    tx: Tx,
    workspaceId: string,
    legalEntityId: string,
    personIds: string[],
    datesByPerson: Map<string, string[]> | null,
    from: string,
    to: string,
  ): Promise<Map<string, EmploymentFacts>> {
    const out = new Map<string, EmploymentFacts>()
    if (!personIds.length) return out

    // Every row overlapping the period, whichever entity it names. The entity narrowing happens
    // below, on the facts alone, because `changedInPeriod` has to see the rows this file excludes.
    const rows = await tx
      .select({
        personId: employments.personId,
        effectiveFrom: employments.effectiveFrom,
        effectiveTo: employments.effectiveTo,
        legalEntityId: employments.legalEntityId,
        employmentType: employments.employmentType,
        fte: employments.fte,
        contractHoursWeek: employments.contractHoursWeek,
        costCenterCode: costCenters.code,
        positionTitle: positions.title,
      })
      .from(employments)
      .leftJoin(costCenters, eq(costCenters.id, employments.costCenterId))
      .leftJoin(positions, eq(positions.id, employments.positionId))
      .where(
        and(
          eq(employments.workspaceId, workspaceId),
          inArray(employments.personId, personIds),
          lte(employments.effectiveFrom, to),
          or(isNull(employments.effectiveTo), gte(employments.effectiveTo, from)),
        ),
      )
      .orderBy(asc(employments.personId), asc(employments.effectiveFrom))

    for (const personId of personIds) {
      const mine = rows.filter((r) => r.personId === personId)
      // The days this person was in this entity. `min`..`max` rather than the exact set: a wider
      // window can only ever admit an extra employment row, and admitting one is the honest direction
      // to be wrong in against silently publishing one of two FTEs.
      const dates = datesByPerson?.get(personId)
      const windowFrom = dates?.[0] ?? from
      const windowTo = dates?.[dates.length - 1] ?? to
      const here = mine.filter(
        (r) =>
          r.effectiveFrom <= windowTo &&
          (r.effectiveTo === null || r.effectiveTo >= windowFrom) &&
          (r.legalEntityId === null || r.legalEntityId === legalEntityId),
      )
      const last = here[here.length - 1]
      if (!last) continue
      out.set(personId, {
        employmentType: last.employmentType,
        fte: num(last.fte, 0),
        contractHoursWeek: last.contractHoursWeek === null ? null : num(last.contractHoursWeek),
        costCenterCode: last.costCenterCode,
        positionTitle: last.positionTitle,
        // `mine`, not `here`: a transfer out of this entity is a change this file has to declare,
        // and it is invisible in `here` by construction.
        changedInPeriod: mine.length > 1,
      })
    }
    return out
  }

  /**
   * Approved leave, per person per type, aggregated in the database.
   *
   * `leave_request_days` filtered `counted and status = 'approved'`, joined out to `leave_requests` →
   * `leave_types`. Three things this is deliberately not:
   *
   * - **not `leave_ledger`**, which is the balance and carries grants, accruals, carry-in and expiry
   *   — movements that are not leave anybody took in this period;
   * - **not `leave_requests.minutes` summed per day**, which counts a five-day request five times;
   * - **not converted to minutes**, because `fraction` is exact and `MINUTES_PER_DAY` is a hardcoded
   *   eight hours. The manifest publishes the day length for anyone who wants to convert.
   *
   * `sum(fraction)` cannot double count: `hr_leave_days_no_double_booking` refuses a second live row
   * on one person-day, so the join fans out to exactly one row per date.
   */
  async leaveAggregate(
    tx: Tx,
    workspaceId: string,
    group: DateGroup,
    from: string,
    to: string,
  ): Promise<LeaveAggregateRow[]> {
    const where = [
      eq(leaveRequestDays.workspaceId, workspaceId),
      eq(leaveRequestDays.counted, true),
      eq(leaveRequestDays.status, 'approved'),
    ]
    if (group.dates === null) {
      where.push(gte(leaveRequestDays.date, from), lte(leaveRequestDays.date, to))
    } else {
      if (!group.dates.length) return []
      where.push(inArray(leaveRequestDays.date, group.dates))
    }
    if (group.personIds !== null) {
      if (!group.personIds.length) return []
      where.push(inArray(leaveRequestDays.personId, group.personIds))
    }

    const rows = await tx
      .select({
        personId: leaveRequestDays.personId,
        leaveTypeKey: leaveTypes.key,
        leaveTypeName: leaveTypes.name,
        paid: leaveTypes.paid,
        unit: leaveTypes.unit,
        days: sql<string>`coalesce(sum(${leaveRequestDays.fraction}), 0)`,
        requests: sql<string>`count(distinct ${leaveRequestDays.requestId})`,
      })
      .from(leaveRequestDays)
      .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(and(...where))
      .groupBy(
        leaveRequestDays.personId,
        leaveTypes.id,
        leaveTypes.key,
        leaveTypes.name,
        leaveTypes.paid,
        leaveTypes.unit,
      )

    return rows.map((r) => ({
      personId: r.personId,
      leaveTypeKey: r.leaveTypeKey,
      leaveTypeName: r.leaveTypeName,
      paid: r.paid,
      unit: r.unit as 'day' | 'half_day' | 'hour',
      days: num(r.days),
      requests: Number(r.requests ?? 0),
    }))
  }
}
