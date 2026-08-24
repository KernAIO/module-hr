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
  /**
   * A calendar's days changed — a holiday added, a pack applied.
   *
   * Everything derived from a calendar (working days, leave day counts, later the attendance day
   * sheet) is stale from here. The payload names the date range touched so a consumer can recompute
   * that window rather than everything.
   */
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
