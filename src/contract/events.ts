import { defineEvent, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'

/**
 * `hr.<entity>.<action>`. Anything that emits one declares it here.
 *
 * These are what the rest of the product reacts to. Chat wants to know when somebody joins so it can
 * add them to a channel; a future calendar wants office holidays; payroll wants an employment
 * change. The payloads carry ids rather than rows on purpose — a subscriber that needs the record
 * asks for it with its own principal, so an event cannot become a way to read data past a permission
 * check.
 */
export const hrEvents = {
  personCreated: defineEvent(
    'hr.person.created',
    z.object({ personId: z.uuid(), workspaceId: WorkspaceId, userId: z.uuid().nullable() }),
  ),
  personUpdated: defineEvent(
    'hr.person.updated',
    z.object({ personId: z.uuid(), workspaceId: WorkspaceId, fields: z.array(z.string()) }),
  ),
  /**
   * Status moved — onboarding to active, active to terminated.
   *
   * Separate from `personUpdated` because the things that care about a lifecycle change (revoking
   * access, closing a leave balance, ending a payroll line) do not want to filter every profile
   * edit to find it.
   */
  personStatusChanged: defineEvent(
    'hr.person.status_changed',
    z.object({
      personId: z.uuid(),
      workspaceId: WorkspaceId,
      from: z.string(),
      to: z.string(),
      on: z.iso.date(),
    }),
  ),
  employmentChanged: defineEvent(
    'hr.employment.changed',
    z.object({
      personId: z.uuid(),
      workspaceId: WorkspaceId,
      employmentId: z.uuid(),
      effectiveFrom: z.iso.date(),
    }),
  ),
  /**
   * Somebody's office changed, or their primary did.
   *
   * Worth its own event because the primary office decides holidays, timezone and policy: anything
   * holding a derived answer for this person has to recompute, and this is how it finds out.
   */
  officeAssignmentChanged: defineEvent(
    'hr.office_assignment.changed',
    z.object({
      personId: z.uuid(),
      workspaceId: WorkspaceId,
      officeId: z.uuid(),
      isPrimary: z.boolean(),
      effectiveFrom: z.iso.date(),
    }),
  ),
  officeCreated: defineEvent(
    'hr.office.created',
    z.object({ officeId: z.uuid(), workspaceId: WorkspaceId, country: z.string() }),
  ),
  leaveRequested: defineEvent(
    'hr.leave.requested',
    z.object({
      requestId: z.uuid(),
      workspaceId: WorkspaceId,
      personId: z.uuid(),
      startsOn: z.iso.date(),
      endsOn: z.iso.date(),
    }),
  ),
  /**
   * Decided either way, with the outcome in the payload.
   *
   * One event rather than approved/rejected pairs: every consumer so far cares that a decision
   * happened and then branches, and two events means two subscriptions to keep in step.
   */
  leaveDecided: defineEvent(
    'hr.leave.decided',
    z.object({
      requestId: z.uuid(),
      workspaceId: WorkspaceId,
      personId: z.uuid(),
      status: z.string(),
      startsOn: z.iso.date(),
      endsOn: z.iso.date(),
    }),
  ),
  /** A balance moved. Carries the delta so a consumer need not re-sum the ledger. */
  leaveBalanceChanged: defineEvent(
    'hr.leave.balance_changed',
    z.object({
      workspaceId: WorkspaceId,
      personId: z.uuid(),
      leaveTypeId: z.uuid(),
      deltaMinutes: z.number().int(),
    }),
  ),
  /**
   * Something needs signing off, and these are the people it is waiting on.
   *
   * Raised once per approval request, after the transaction that created the subject has committed —
   * a rollback must not leave an approver holding a card for a leave request that does not exist.
   * `approverIds` is the *first* step only: later steps are resolved at request time but nobody on
   * them is waiting yet, and telling somebody to act before their turn is worse than telling them
   * late. The step that becomes current later announces itself through `hr.approval.decided`.
   *
   * Nothing is emitted for a chain that resolved to nobody. Auto-approval is not a request, and an
   * empty `approverIds` would only teach a subscriber to filter it back out.
   */
  approvalRequested: defineEvent(
    'hr.approval.requested',
    z.object({
      requestId: z.uuid(),
      workspaceId: WorkspaceId,
      subjectType: z.string(),
      subjectId: z.uuid(),
      approverIds: z.array(z.uuid()),
    }),
  ),
  approvalDecided: defineEvent(
    'hr.approval.decided',
    z.object({
      requestId: z.uuid(),
      workspaceId: WorkspaceId,
      subjectType: z.string(),
      subjectId: z.uuid(),
      status: z.string(),
    }),
  ),
  punchRecorded: defineEvent(
    'hr.punch.recorded',
    z.object({
      punchId: z.uuid(),
      workspaceId: WorkspaceId,
      personId: z.uuid(),
      direction: z.string(),
      businessDate: z.iso.date(),
    }),
  ),
  // `hr.attendance.day_computed` was declared here and never emitted. It fires on every punch —
  // four a day per person, every workday — so declaring it committed us to a stampede on behalf of
  // nobody: nothing in the product subscribes, and a subscriber that appeared would have had to
  // debounce it before doing anything useful. `hr.punch.recorded` already says a day is stale and
  // costs the same. It comes back when something needs the derived totals *and* the emit can afford
  // the fan-out — batched per day rather than per punch, most likely from the nightly job.
  /**
   * A calendar's days changed — a holiday added, a pack applied.
   *
   * Everything derived from a calendar (working days, leave day counts, the attendance day sheet)
   * is stale from here. The payload names the date range touched so a consumer can recompute that
   * window rather than everything.
   */
  calendarChanged: defineEvent(
    'hr.calendar.changed',
    z.object({
      calendarId: z.uuid(),
      workspaceId: WorkspaceId,
      from: z.iso.date().nullable(),
      to: z.iso.date().nullable(),
    }),
  ),
}
