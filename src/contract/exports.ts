import { Timestamp } from '@kernhq/contracts'
import { z } from 'zod'
import { LeaveUnit } from './leave.js'
import { IsoDate } from './models.js'
import { ReportFinality, ReportScope } from './reports.js'

/**
 * The payroll handover, and the four rules that make it safe to hand over.
 *
 * Kern does not compute pay. This file carries identity, the period, the employment facts that let a
 * provider pick a rate, and quantities — minutes and days. There is no gross, no net, no hourly rate,
 * no deduction and no currency amount anywhere in it; the moment a column reads as money, Kern is a
 * payroll system and owes the accuracy of one. `OvertimeConfig.rate` says the same thing one file
 * over: a multiplier is a fact about a policy, and multiplying anything by it is somebody else's job.
 *
 * **1. Per legal entity, keyed by (entity, period, person).** A person who transfers mid-period
 * produces two rows, one in each entity's file, each carrying only that entity's days. Two entities
 * in one workspace are two filings, in two currencies, to two authorities, on two closing days —
 * `periods.legal_entity_id` exists for exactly that reason and `PolicyService.isLocked` already
 * answers per entity. So `legalEntityId` is a **required** input rather than an optional slice: there
 * is no "export everything", because that is an invitation to send one provider another entity's
 * people.
 *
 * **2. Two files, not one.** `hours.csv` has a fixed column set. `leave.csv` is long-form — one row
 * per person per leave type — because leave types are workspace data (`leave_types` is keyed on
 * `(workspace_id, key)`), so a wide file with a column per type would have a column set that depends
 * on the customer's own rows, and a column set that depends on customer data cannot be frozen.
 *
 * **3. Frozen, and the version travels in four places.** See {@link PAYROLL_EXPORT_CONTRACT}.
 *
 * **4. Refuse rather than guess.** An open period, an entity with nobody in it, or a person with no
 * employment row covering their days is a refusal with a sentence, never a row of zeros a payroll
 * clerk will pay from. The one escape hatch is `draft`, and a draft stamps itself — in the manifest,
 * in the filename, and in every row's `open_days`.
 */

/**
 * The contract identity, and **not** the package version.
 *
 * `@kernhq/module-hr` bumps on every patch and every image in an instance carries one
 * `KERN_VERSION`; the CSV shape has to move on its own axis, so this is a hardcoded literal rather
 * than `packageVersion(import.meta.url)`. `kernVersion` sits in the manifest as provenance and is
 * never the contract identity.
 *
 * It travels in four places, each doing a different job:
 *
 * 1. **The procedure and its route** — `payroll.export.v1`, `GET /payroll/export/v1`. A new shape is
 *    a new procedure, never a parameter on this one: freezing a branch inside a function three people
 *    will edit has never worked, and separate procedures are what make the freeze structural.
 * 2. **The filename** — `kern-payroll-v1_<entity>_2026-06_hours.csv`. The only part that survives
 *    being emailed to a bureau and opened by somebody who never saw the API.
 * 3. **The manifest** — `contract: 'kern-payroll-v1'` beside `generatedAt`, `kernVersion` and the
 *    report header triple.
 * 4. **Every row**, as the first column. A manifest can be separated from its CSVs and a filename can
 *    be changed on the way to a payroll system; a file that has lost both must still be able to say
 *    what shape it is. This is a column in the frozen set, **not** a banner row above the header —
 *    a version line above the column names breaks every importer that assumes row 1 is the header,
 *    which is most of them and all of the spreadsheet ones.
 *
 * What "frozen" forbids, once v1 has shipped: no new column, not even appended at the end; no removed
 * or renamed column; no reordering; no changed emptiness semantics (`beyond_cap_minutes` empty means
 * "no ceiling was in force" and must never start meaning zero); no changed units, so minutes stay
 * minutes and `dayLengthMinutes` stays 480 even if this module later grows a per-workspace working
 * day; and no changed encoding, delimiter, line ending or quoting. A later column is
 * `payroll.export.v2` — a new procedure, a new filename prefix, a new manifest `contract` — shipping
 * alongside v1 with v1 untouched. That is expensive on purpose: the expense is what stops the column
 * set drifting, and a contract nobody pays to change is not frozen.
 */
export const PAYROLL_EXPORT_CONTRACT = 'kern-payroll-v1'

/**
 * `hours.csv`, in order. **This array is the file format.**
 *
 * Every column exists in the schema today. The quantities come from `attendance_days` and never from
 * `punches`: punches are append-only and a voided punch survives beside its correction, so summing
 * them double-counts every fix ever made. The day sheet is the projection that has already applied
 * the schedule, the calendar and the rounding.
 *
 * Three of these carry a decision rather than a number:
 *
 * - `beyond_cap_minutes` is **empty, never `0`**, where no statutory ceiling was in force. Zero means
 *   a ceiling applied and nothing exceeded it. A provider reading 0 for empty is the one place this
 *   export can cause a wrong payment, which is why `capped_days` and `uncapped_days` sit beside it.
 * - `scheduled_worked_minutes` excludes work on unrostered days, because a numerator that includes
 *   them over a denominator that excludes them is how a team that turned up exactly as asked reads
 *   121%.
 * - `employment_changed_in_period` is true when more than one employment row overlaps the period.
 *   Without it the export hands over the end-state FTE for somebody who went 1.0 → 0.6 on the 15th,
 *   and the provider pays the whole month at one of them.
 */
export const PAYROLL_HOURS_COLUMNS = [
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
] as const

/**
 * `leave.csv`, in order. One row per (person, entity, period, leave type).
 *
 * Built from `leave_request_days` filtered `counted and status = 'approved'`, joined out to
 * `leave_requests` → `leave_types`. **Not** `leave_ledger`: the ledger is the balance and carries
 * `grant`, `accrual`, `carry_in` and `expiry`, which are movements rather than leave anybody took in
 * this period. **Not** `leave_requests.minutes` summed per day either — that counts a five-day
 * request five times, an off-by-a-factor this module has already been bitten by once.
 *
 * `days` sums `fraction`, which is exact and needs no day length. `dayLengthMinutes` is published in
 * the manifest for anyone who wants to convert; this file does not convert for them.
 */
export const PAYROLL_LEAVE_COLUMNS = [
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
] as const

export const PayrollHoursRow = z.object({
  personId: z.uuid(),
  /**
   * Unique per **workspace**, not per entity (`hr_people_ws_empno_uq`), and nullable.
   *
   * Exported, and deliberately not the key: a group whose Turkish and Dutch providers each want their
   * own numbering has nowhere to put the second number today, and `HrSettings.employeeNumberPrefix`
   * is one workspace-wide prefix. A per-entity number is a real schema change and it is not v1's job
   * — but the file must not pretend the number it carries is the provider's.
   */
  employeeNo: z.string().nullable(),
  /** Exactly as stored: an erased person keeps their row and carries the erasure token. */
  displayName: z.string(),
  employmentType: z.string(),
  fte: z.number(),
  contractHoursWeek: z.number().nullable(),
  costCenterCode: z.string().nullable(),
  positionTitle: z.string().nullable(),
  /** A joiner or leaver mid-period is the case a provider prorates. */
  hiredOn: IsoDate.nullable(),
  terminatedOn: IsoDate.nullable(),
  /** True when more than one employment row overlapped this person's days in this entity. */
  employmentChangedInPeriod: z.boolean(),
  /** The denominator. Publish it or no total means anything. */
  daySheets: z.number().int(),
  scheduledMinutes: z.number().int(),
  workedMinutes: z.number().int(),
  scheduledWorkedMinutes: z.number().int(),
  breakMinutes: z.number().int(),
  overtimeMinutes: z.number().int(),
  lateMinutes: z.number().int(),
  earlyLeaveMinutes: z.number().int(),
  /** Null where no ceiling was in force — an **empty CSV field**, never zero. */
  beyondCapMinutes: z.number().int().nullable(),
  cappedDays: z.number().int(),
  uncappedDays: z.number().int(),
  /** A locked period can still hold an unlocked day, so both travel per row. */
  lockedDays: z.number().int(),
  openDays: z.number().int(),
  paidLeaveDays: z.number(),
  unpaidLeaveDays: z.number(),
})
export type PayrollHoursRow = z.infer<typeof PayrollHoursRow>

export const PayrollLeaveRow = z.object({
  personId: z.uuid(),
  employeeNo: z.string().nullable(),
  leaveTypeKey: z.string(),
  leaveTypeName: z.string(),
  paid: z.boolean(),
  unit: LeaveUnit,
  /** Days, summed from `fraction`. Never minutes: `MINUTES_PER_DAY` is a hardcoded eight hours. */
  days: z.number(),
  requests: z.number().int(),
})
export type PayrollLeaveRow = z.infer<typeof PayrollLeaveRow>

/** The headline figures over the whole population, so a screen shows a total before a file exists. */
export const PayrollExportTotals = z.object({
  people: z.number().int(),
  daySheets: z.number().int(),
  scheduledMinutes: z.number().int(),
  workedMinutes: z.number().int(),
  scheduledWorkedMinutes: z.number().int(),
  breakMinutes: z.number().int(),
  overtimeMinutes: z.number().int(),
  lateMinutes: z.number().int(),
  earlyLeaveMinutes: z.number().int(),
  beyondCapMinutes: z.number().int().nullable(),
  cappedDays: z.number().int(),
  uncappedDays: z.number().int(),
  lockedDays: z.number().int(),
  openDays: z.number().int(),
  paidLeaveDays: z.number(),
  unpaidLeaveDays: z.number(),
})
export type PayrollExportTotals = z.infer<typeof PayrollExportTotals>

/**
 * Why this export will not be written.
 *
 * `payroll.export.preview` returns these so a screen can show them **before** anybody downloads
 * anything; `payroll.export.v1` throws the first of them. `hr.period.not_locked` mirrors the spelling
 * of `hr.period.locked`, which `PolicyService.assertOpen` throws pointed the other way.
 */
export const PayrollExportRefusalCode = z.enum([
  /** The period is open, and `draft` was not asked for. Tonight's `reconcile-days` may move it. */
  'hr.period.not_locked',
  /** Nobody was employed by this entity on any day of the period. */
  'hr.payroll.empty',
  /** Somebody in the population has no employment row covering their days here. */
  'hr.payroll.no_employment',
])
export type PayrollExportRefusalCode = z.infer<typeof PayrollExportRefusalCode>

export const PayrollExportRefusal = z.object({
  code: PayrollExportRefusalCode,
  /** A sentence naming the fix, not a code a reader has to look up. */
  message: z.string(),
  /** Whose rows caused it, where that is a fact about people. Empty otherwise. */
  personIds: z.array(z.uuid()),
})
export type PayrollExportRefusal = z.infer<typeof PayrollExportRefusal>

/**
 * How the bytes are written, restated in the manifest so a reader never has to infer it.
 *
 * UTF-8 **with a byte order mark**, because Excel on Windows mangles Turkish and Persian names
 * without one and this module ships country packs for both. Comma, CRLF, RFC 4180 quoting, ISO dates,
 * `.` decimal separator with two places on `fte` and on leave-day fractions. Every one of these is
 * frozen for as long as v1 is published.
 */
export const PayrollExportFormat = z.object({
  encoding: z.literal('utf-8'),
  byteOrderMark: z.literal(true),
  delimiter: z.literal(','),
  lineEnding: z.literal('crlf'),
  quoting: z.literal('rfc4180'),
  decimalSeparator: z.literal('.'),
  decimalPlaces: z.literal(2),
  dateFormat: z.literal('iso-8601'),
})
export type PayrollExportFormat = z.infer<typeof PayrollExportFormat>

export const PayrollExportManifest = z.object({
  contract: z.literal(PAYROLL_EXPORT_CONTRACT),
  generatedAt: Timestamp,
  /** Provenance — the platform version that wrote the file. Never the contract identity. */
  kernVersion: z.string(),
  /**
   * `draft` when the caller asked for an open period, `final` otherwise.
   *
   * Not a warning in a toast: the toast does not travel with the CSV, and the CSV is what reaches the
   * provider. So the filename says `DRAFT` too, and every row carries a non-zero `open_days`.
   */
  finality: z.enum(['final', 'draft']),
  draft: z.boolean(),
  legalEntityId: z.uuid(),
  legalEntityName: z.string(),
  /** The fields a filing is made under, so the file states which authority it belongs to. */
  country: z.string(),
  currency: z.string().nullable(),
  periodId: z.uuid(),
  periodStart: IsoDate,
  periodEnd: IsoDate,
  periodStatus: z.enum(['open', 'locked']),
  /** Everybody the entity employed over the period — the denominator, and never omitted. */
  population: z.number().int(),
  /** How many of them have a day sheet or an approved leave day behind the figures. */
  counted: z.number().int(),
  /** Which grants produced this population. Two managers must not read one title over two sets. */
  scope: ReportScope,
  /** Locked against open day sheets. A locked period can still contain an unlocked day. */
  attendance: ReportFinality,
  /** 480. Published so a reader converting days to minutes uses the module's day, not their own. */
  dayLengthMinutes: z.number().int(),
  format: PayrollExportFormat,
  files: z.array(z.object({ name: z.string(), columns: z.array(z.string()), rows: z.number().int() })),
})
export type PayrollExportManifest = z.infer<typeof PayrollExportManifest>

export const PayrollExportFile = z.object({
  name: z.string(),
  contentType: z.string(),
  /** The whole file as text. The CSVs begin with a byte order mark and end every line with CRLF. */
  content: z.string(),
})
export type PayrollExportFile = z.infer<typeof PayrollExportFile>

/**
 * What `payroll.export.v1` hands back: the manifest, and the three files beside each other.
 *
 * Synchronous and streamed into the response rather than delivered as a job, and that is a checked
 * constraint rather than a preference. Core exposes exactly one file procedure over the broker —
 * `files.get` — so a module cannot mint a `FileObject`; `createUpload` requires a user principal and
 * a background job has none. Writing bytes straight into `kernel.storage` would produce an object
 * invisible to `core.files.*`, absent from the workspace file list, uncounted by the `storageBytes`
 * entitlement and deleted by nothing — orphans by design. Async delivery becomes possible the day
 * core grows a procedure that mints a file for a service principal, and that is a change to core.
 */
export const PayrollExport = z.object({
  manifest: PayrollExportManifest,
  /** `hours.csv`, `leave.csv`, `manifest.json`. Three, always, for as long as v1 exists. */
  files: z.array(PayrollExportFile).length(3),
})
export type PayrollExport = z.infer<typeof PayrollExport>

/**
 * The same rows as JSON, with no file and no refusal thrown.
 *
 * So a screen can show the totals and the reasons it would be refused before anybody downloads
 * anything. `exportable` is `refusals.length === 0`.
 */
export const PayrollExportPreview = z.object({
  manifest: PayrollExportManifest,
  refusals: z.array(PayrollExportRefusal),
  exportable: z.boolean(),
  totals: PayrollExportTotals,
  hours: z.array(PayrollHoursRow),
  leave: z.array(PayrollLeaveRow),
})
export type PayrollExportPreview = z.infer<typeof PayrollExportPreview>
