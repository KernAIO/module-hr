import { Timestamp, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import { IsoDate } from './models.js'

const ws = { workspaceId: WorkspaceId }

/**
 * One approval engine, for everything that needs signing off.
 *
 * Keyed by `subjectType` + `subjectId` rather than by a foreign key to leave, so regularization,
 * overtime and timesheets attach to it later without a schema change. That seam is the reason this
 * is not just a few columns on `leave_requests`.
 *
 * The chain is **snapshotted onto the request when it is raised**. Editing the workflow afterwards
 * must not change who has to sign a request already in flight — the version of that mistake where
 * somebody's approved leave silently needs another signature is very hard to explain.
 */

export const ApprovalSubjectType = z.enum(['leave', 'regularization', 'overtime', 'timesheet', 'shift_swap'])
export type ApprovalSubjectType = z.infer<typeof ApprovalSubjectType>

/**
 * Who is being asked. Resolved to people when the request is raised, so a later reorganisation does
 * not silently move an in-flight approval to somebody else.
 */
export const ApproverSubject = z.object({
  kind: z.enum([
    'person',
    /** The requester's manager on the day the request was raised. */
    'manager',
    /** Two levels up. Falls back to one level if there is nobody above. */
    'manager_of_manager',
    /** Whoever heads the requester's department. */
    'org_unit_head',
    /** Whoever heads the requester's primary office — the local-HR step. */
    'office_head',
    /** Anybody holding a permission key, workspace-wide. */
    'permission',
    'group',
  ]),
  /** Person id, permission key or group id, depending on `kind`. */
  id: z.string().max(128).optional(),
})
export type ApproverSubject = z.infer<typeof ApproverSubject>

export const ApprovalStepMode = z.enum([
  /** Everyone named must approve. */
  'all',
  /** Any one of them is enough. */
  'any',
  /** `minApprovals` of them. */
  'quorum',
])

export const ApprovalStepSpec = z.object({
  name: z.string().max(80),
  approvers: z.array(ApproverSubject).min(1),
  mode: ApprovalStepMode,
  minApprovals: z.number().int().min(1),
  /** Hours before the step is escalated or auto-decided. Null means it waits forever. */
  slaHours: z.number().int().min(1).nullable(),
  onTimeout: z.enum(['remind', 'escalate', 'auto_approve']),
})
export type ApprovalStepSpec = z.infer<typeof ApprovalStepSpec>

/** Steps run in order; the request advances only when the current one is satisfied. */
export const ApprovalChainSpec = z.object({
  steps: z.array(ApprovalStepSpec).min(1),
})
export type ApprovalChainSpec = z.infer<typeof ApprovalChainSpec>

export const ApprovalChain = z.object({
  id: z.uuid(),
  ...ws,
  name: z.string().min(1).max(120),
  subjectType: ApprovalSubjectType,
  spec: ApprovalChainSpec,
  /** Used when nothing more specific matches. Exactly one per subject type. */
  isDefault: z.boolean(),
  archivedAt: Timestamp.nullable(),
})
export type ApprovalChain = z.infer<typeof ApprovalChain>

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'cancelled'])
export type ApprovalStatus = z.infer<typeof ApprovalStatus>

export const ApprovalDecision = z.object({
  id: z.uuid(),
  stepId: z.uuid(),
  approverId: z.uuid(),
  /** Set when somebody decided in another person's place through a delegation. */
  onBehalfOfId: z.uuid().nullable(),
  decision: z.enum(['approve', 'reject']),
  comment: z.string().max(1000).nullable(),
  at: Timestamp,
})
export type ApprovalDecision = z.infer<typeof ApprovalDecision>

export const ApprovalStep = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  stepIndex: z.number().int(),
  name: z.string(),
  mode: ApprovalStepMode,
  minApprovals: z.number().int(),
  /** Expanded at request time; a later reorganisation does not move an in-flight approval. */
  approverIds: z.array(z.uuid()),
  status: ApprovalStatus,
  dueAt: Timestamp.nullable(),
  escalatedAt: Timestamp.nullable(),
  decisions: z.array(ApprovalDecision),
})
export type ApprovalStep = z.infer<typeof ApprovalStep>

export const ApprovalRequest = z.object({
  id: z.uuid(),
  ...ws,
  subjectType: ApprovalSubjectType,
  subjectId: z.uuid(),
  /** A one-line description of what is being approved, so an inbox is readable without joins. */
  summary: z.string().max(200),
  status: ApprovalStatus,
  currentStep: z.number().int(),
  requestedBy: z.uuid().nullable(),
  requestedAt: Timestamp,
  decidedAt: Timestamp.nullable(),
  steps: z.array(ApprovalStep),
})
export type ApprovalRequest = z.infer<typeof ApprovalRequest>

/**
 * Somebody else may decide in my place while I am away.
 *
 * A delegation does not move the request; it lets the delegate act on it, and the decision records
 * both people. "Who approved this" must never become ambiguous.
 */
export const Delegation = z.object({
  id: z.uuid(),
  ...ws,
  fromPersonId: z.uuid(),
  toPersonId: z.uuid(),
  /** Null delegates every subject type. */
  subjectType: ApprovalSubjectType.nullable(),
  startsOn: IsoDate,
  endsOn: IsoDate,
  reason: z.string().max(200).nullable(),
  createdAt: Timestamp,
})
export type Delegation = z.infer<typeof Delegation>
