import { z } from 'zod'
import { LeaveUnit } from './leave.js'
import { IsoDate } from './models.js'

/**
 * Four numbers a company acts on, and the three rules that make them safe to act on.
 *
 * **1. A total states its own denominator.** "47 hours of overtime" means nothing on its own; "47
 * hours · 12 of 38 people · 1–31 October · Istanbul office" is a fact. Every report here carries a
 * `ReportHeader` saying who it counted, over what range, under which slice, and — because two
 * managers must never read the same title over different populations — **which permission produced
 * it**. A report is a separate grant, not a narrowing: a reader without the key gets nothing rather
 * than a quieter number.
 *
 * **2. Unknown is not zero.** Every figure a person's data cannot answer is `null` here, and a
 * screen renders `null` as an em dash. Never 0%, never "0 days absent". The three that bite:
 * somebody with no schedule has no attendance percentage (the denominator is zero, not the
 * numerator); an office with no calendar attached has no expected working days (Mon–Fri would be an
 * assumption this module does not make, and it is wrong for every Gulf and Iranian office); and
 * `beyondCapMinutes` is null where **no cap was in force**, which is a different fact from a cap
 * that nothing exceeded.
 *
 * **3. Nothing here is projected or entitled.** No year-end balance, no "at this rate you will pass
 * the annual ceiling in November", no allowance remaining. All three need either a policy that may
 * not exist or a workspace day length this module does not hold — `MINUTES_PER_DAY` is a constant,
 * so a `day`-unit figure is an 8-hour day whatever the leave type is called. `dayLengthMinutes` on
 * the balance report says so on its face rather than leaving a reader to assume their own.
 *
 * The reports read; nothing here recomputes a day sheet. A "refresh" on a reports page is a write
 * into a month payroll may already have filed, and `AttendanceService.recomputeDay` is the only
 * thing entitled to decide whether a day may move.
 */

/**
 * The longest range a report may cover, in days.
 *
 * A year, because an annual overtime figure against a statutory ceiling is a real question and a
 * two-year one is not. An unsliced attendance or overtime report is a single grouped aggregate, so
 * the length costs the database and nothing else.
 */
export const MAX_REPORT_DAYS = 366

/**
 * The longest range a report may cover once it is **sliced**, and the range the absence report is
 * held to whatever it is sliced by.
 *
 * Both walk the resolution ladder once per day in the range, because a number has to be attributed
 * to the office in force on the day it describes rather than the one somebody sits in today. That
 * is a handful of small indexed queries per day; a quarter is fine and a year is not. The absence
 * report pays it unsliced as well, because a person's expected days come from their office's
 * calendar and that is the same walk.
 *
 * The honest fix is a range-aware batch in `ResolveService` — one walk that answers a span rather
 * than a date. Until that exists, this is the cap rather than a slow report nobody can cancel.
 */
export const MAX_SLICED_REPORT_DAYS = 92

/**
 * The most person-days a per-day report will resolve before refusing.
 *
 * `people × days`, and it is a refusal with both numbers in it rather than a timeout: a report that
 * quietly takes four minutes is worse than one that says "1,900 people over 92 days is 174,800
 * person-days — ask for one office, or a shorter range".
 */
export const MAX_PERSON_DAYS = 60_000

/**
 * How a report was narrowed.
 *
 * `workspace` is everybody; `office` and `legal_entity` are what the resolution ladder can answer
 * about a person on a date. **There is no `cost_center`**, and the omission is deliberate:
 * `PersonResolution` carries `primaryOfficeId`, `legalEntityId` and `orgUnitId` and no cost centre,
 * so a cost-centre slice would have to join `employments` inside a report handler — a second
 * resolution ladder, which is the drift `ResolveService`'s header exists to prevent. It arrives
 * when `PersonResolution` grows the field, not before.
 */
export const ReportSliceBy = z.enum(['workspace', 'office', 'legal_entity'])
export type ReportSliceBy = z.infer<typeof ReportSliceBy>

export const ReportSlice = z.object({
  by: ReportSliceBy,
  /** Null for `workspace`, which needs no id. */
  id: z.uuid().nullable(),
  /** Resolved for the reader, so the report can name its own population without a second call. */
  name: z.string().nullable(),
})
export type ReportSlice = z.infer<typeof ReportSlice>

/**
 * When a person was attributed to the slice.
 *
 * `each_day` is what everything in this module that computes a *number* already does — a day sheet
 * is rebuilt against the entity in force on the day it covers, a period lock resolves per date, the
 * accrual job resolves on the last day of the period. Copying the nearest list handler, which
 * filters on "assignment with no end date", is the wrong instinct: it hands a transfer's whole
 * previous quarter to the receiving office.
 *
 * `as_of_date` is honest for a balance, which is a position rather than a per-day quantity, and
 * `attributionOn` says which date. `not_applicable` is an unsliced report, where nobody is
 * attributed to anything.
 */
export const ReportAttribution = z.enum(['each_day', 'as_of_date', 'not_applicable'])
export type ReportAttribution = z.infer<typeof ReportAttribution>

/**
 * Which grant produced this population, and at what scope it was asked.
 *
 * On the response rather than left implicit, because the failure this prevents is not a leak: it is
 * two managers opening "Overtime · October · Istanbul", getting different totals under one title,
 * and neither being told why. `askedAt` is always `workspace` — `hr.attendance.view_team` and
 * `hr.leave.view_team` are declared at object scope, and `Authz.can(object, id)` falls through to
 * the workspace-level effective set, so binding a key to an office id narrows nothing today. Saying
 * so here stops a reader inferring a narrowing that is not happening.
 */
export const ReportScope = z.object({
  /** `hr.report.view`, plus the data key the figures needed. */
  permissions: z.array(z.string()).min(1),
  askedAt: z.literal('workspace'),
})
export type ReportScope = z.infer<typeof ReportScope>

export const ReportHeader = z.object({
  from: IsoDate,
  to: IsoDate,
  slice: ReportSlice,
  scope: ReportScope,
  /** Everybody the slice covers over the range. **The denominator**, and never omitted. */
  population: z.number().int(),
  /** How many of `population` have anything at all behind the figures. */
  counted: z.number().int(),
  attribution: ReportAttribution,
  /** The date `as_of_date` attribution used. Null for the other two. */
  attributionOn: IsoDate.nullable(),
  /** True when `rows` is the top `limit` of `counted` rather than all of it. */
  truncated: z.boolean(),
})
export type ReportHeader = z.infer<typeof ReportHeader>

/**
 * Whether the figures can move again.
 *
 * A range that straddles a lock boundary mixes final figures with provisional ones — tonight's
 * `reconcile-days` will change the open half — so a report must never present the mixed total as
 * final. Where a workspace has no periods at all (the `periods` capability ships off), every day is
 * open and that is entirely normal: `final: false` with `lockedDays: 0` is not a warning.
 */
export const ReportFinality = z.object({
  lockedDays: z.number().int(),
  openDays: z.number().int(),
  /** True only when every day counted sits inside a locked period. */
  final: z.boolean(),
  /** The earliest day still able to move, or null when none is. */
  firstOpenDay: IsoDate.nullable(),
  /** The latest day already frozen, or null when none is. */
  lastLockedDay: IsoDate.nullable(),
})
export type ReportFinality = z.infer<typeof ReportFinality>

// ---------------------------------------------------------------- attendance summary

export const AttendanceSummaryRow = z.object({
  personId: z.uuid(),
  /**
   * The directory name, and the erasure token for somebody who has been erased.
   *
   * Their day sheets and ledger entries survive an erasure by design, so the row stays and the
   * token is shown as it is stored. Dropping the row would change the total; printing "Unknown"
   * would hide that this is a person the workspace deliberately redacted.
   */
  displayName: z.string(),
  /** Day sheets counted. Not the length of the range — a day nobody punched has no sheet. */
  days: z.number().int(),
  scheduledMinutes: z.number().int(),
  /** Everything worked, including on days no schedule was in force. */
  workedMinutes: z.number().int(),
  /**
   * The part of `workedMinutes` that fell on a day a schedule *was* in force.
   *
   * Published because it is `workedRatio`'s numerator and dividing the two columns above would give
   * a different, wrong number. Mixing unscheduled work into a ratio whose denominator excludes those
   * days is how an attendance report reads 121% for a team that turned up exactly as asked: one
   * colleague clocking in on a day nobody rostered them adds to the top and nothing to the bottom.
   */
  scheduledWorkedMinutes: z.number().int(),
  breakMinutes: z.number().int(),
  lateMinutes: z.number().int(),
  earlyLeaveMinutes: z.number().int(),
  /**
   * `scheduledWorked ÷ scheduled`, 0–1 — **null when nothing was scheduled**.
   *
   * Somebody with no schedule assignment owes no hours, so the denominator is zero and the answer
   * is unknown rather than 0% or 100%. In a workspace that clocks in only part of its staff, that
   * is most of the directory.
   */
  workedRatio: z.number().nullable(),
  /** Sheets produced with no schedule in force, read off the policy stamp rather than guessed. */
  noScheduleDays: z.number().int(),
  /** Sheets with no policy stamp at all, where neither state can be claimed. */
  unknownScheduleDays: z.number().int(),
})
export type AttendanceSummaryRow = z.infer<typeof AttendanceSummaryRow>

export const AttendanceSummaryTotals = AttendanceSummaryRow.omit({
  personId: true,
  displayName: true,
})
export type AttendanceSummaryTotals = z.infer<typeof AttendanceSummaryTotals>

export const AttendanceSummaryReport = z.object({
  header: ReportHeader,
  finality: ReportFinality,
  /** Over the whole population, never only the rows returned. */
  totals: AttendanceSummaryTotals,
  rows: z.array(AttendanceSummaryRow),
})
export type AttendanceSummaryReport = z.infer<typeof AttendanceSummaryReport>

// ---------------------------------------------------------------- overtime

export const OvertimeRow = z.object({
  personId: z.uuid(),
  displayName: z.string(),
  days: z.number().int(),
  overtimeMinutes: z.number().int(),
  /**
   * Overtime an annual ceiling would not take — **null when no ceiling was in force on any day
   * counted**, which is not zero.
   *
   * Zero means a ceiling applied and nothing passed it. Null means the question was never asked of
   * these days. Coalescing the two destroys the distinction the column exists for, and it is the
   * distinction a statutory-ceiling conversation turns on.
   */
  beyondCapMinutes: z.number().int().nullable(),
  /** Days a ceiling applied to. Zero here is why `beyondCapMinutes` is null. */
  cappedDays: z.number().int(),
  uncappedDays: z.number().int(),
})
export type OvertimeRow = z.infer<typeof OvertimeRow>

export const OvertimeTotals = OvertimeRow.omit({ personId: true, displayName: true })
export type OvertimeTotals = z.infer<typeof OvertimeTotals>

export const OvertimeReport = z.object({
  header: ReportHeader,
  finality: ReportFinality,
  totals: OvertimeTotals,
  rows: z.array(OvertimeRow),
})
export type OvertimeReport = z.infer<typeof OvertimeReport>

// ---------------------------------------------------------------- absence

/**
 * What the expected-days figure rests on, per person.
 *
 * `no_schedule` and `no_calendar` are **named rows, not silent drops**. A person with no schedule
 * assignment owes no hours, so "absent" is not a fact this module holds about them — and in a
 * workspace that clocks in only its shift staff they are the majority. An office with no calendar
 * attached would fall back to Monday–Friday, which is an assumption rather than an answer, so the
 * expectation is withheld and the reason is printed instead.
 */
export const AbsenceBasis = z.enum(['calendar', 'no_calendar', 'no_schedule'])
export type AbsenceBasis = z.infer<typeof AbsenceBasis>

export const AbsenceRow = z.object({
  personId: z.uuid(),
  displayName: z.string(),
  basis: AbsenceBasis,
  /** Working days the calendar expected, weighted for half days. Null unless `basis` is `calendar`. */
  expectedDays: z.number().nullable(),
  /** Expected days with a day sheet showing work. */
  workedDays: z.number().nullable(),
  /**
   * Expected days covered by approved, counted leave.
   *
   * **Null when the `leave` capability is off** rather than zero — the column is omitted, not
   * answered. There is no breakdown by leave type here and there will not be one under this key:
   * the team calendar deliberately withholds the type from anybody without `hr.leave.view_ledger`,
   * so that the team can know somebody is away without knowing it is sick leave, and a per-type
   * column would republish exactly that.
   */
  leaveDays: z.number().nullable(),
  /** `expected − worked − leave`, floored at zero. Null wherever `expectedDays` is. */
  absentDays: z.number().nullable(),
  /** `absent ÷ expected`, 0–1. Null when there was nothing to expect. */
  absenceRate: z.number().nullable(),
})
export type AbsenceRow = z.infer<typeof AbsenceRow>

export const AbsenceTotals = z.object({
  /** People whose `basis` is `calendar` — the only ones the totals below are computed over. */
  measured: z.number().int(),
  expectedDays: z.number(),
  workedDays: z.number(),
  leaveDays: z.number().nullable(),
  absentDays: z.number(),
  absenceRate: z.number().nullable(),
})
export type AbsenceTotals = z.infer<typeof AbsenceTotals>

export const AbsenceReport = z.object({
  header: ReportHeader,
  finality: ReportFinality,
  /**
   * Whether approved leave was subtracted at all.
   *
   * False when the `leave` capability is off in this workspace, in which case every `leaveDays` is
   * null and `absentDays` is `expected − worked`. Saying so is what stops a reader treating an
   * inflated absence figure as a fact about attendance.
   */
  leaveCounted: z.boolean(),
  totals: AbsenceTotals,
  /** The two named buckets held out of the denominator, so nobody is dropped in silence. */
  excluded: z.object({ noSchedule: z.number().int(), noCalendar: z.number().int() }),
  rows: z.array(AbsenceRow),
})
export type AbsenceReport = z.infer<typeof AbsenceReport>

// ---------------------------------------------------------------- leave balance

export const LeaveBalanceRow = z.object({
  personId: z.uuid(),
  displayName: z.string(),
  leaveTypeId: z.uuid(),
  leaveTypeName: z.string(),
  unit: LeaveUnit,
  /** The authoritative figures. Minutes, because half days and hourly leave divide a day. */
  balanceMinutes: z.number().int(),
  bookedMinutes: z.number().int(),
  pendingMinutes: z.number().int(),
  availableMinutes: z.number().int(),
  /** The same two in the leave type's own unit, for display. Read `dayLengthMinutes` first. */
  balance: z.number(),
  available: z.number(),
})
export type LeaveBalanceRow = z.infer<typeof LeaveBalanceRow>

export const LeaveBalanceReport = z.object({
  header: ReportHeader,
  periodYear: z.number().int(),
  /**
   * How long a `day` is when a day-unit figure is rendered here.
   *
   * A constant in this module, not a workspace setting — so "12.5 days" is 12.5 eight-hour days
   * whatever the workspace's own day happens to be. Published rather than assumed, because a report
   * that prints days without saying which day is the quiet way this goes wrong.
   */
  dayLengthMinutes: z.number().int(),
  /**
   * One line per leave type, over the whole population.
   *
   * There is no entitlement, allowance-remaining or projected year-end column, here or on a row.
   * Each of those needs an accrual policy, and a company that grants a fixed allowance on 1 January
   * has none — `PolicyService.forPerson` answers `{ policyId: null }` rather than throwing, and a
   * balance relabelled as an entitlement would be this module inventing the number it declined to
   * guess everywhere else.
   */
  totals: z.array(
    z.object({
      leaveTypeId: z.uuid(),
      leaveTypeName: z.string(),
      unit: LeaveUnit,
      /** People holding a non-zero position in this type. */
      people: z.number().int(),
      balanceMinutes: z.number().int(),
      bookedMinutes: z.number().int(),
      pendingMinutes: z.number().int(),
      availableMinutes: z.number().int(),
    }),
  ),
  rows: z.array(LeaveBalanceRow),
})
export type LeaveBalanceReport = z.infer<typeof LeaveBalanceReport>
