import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, arrayOverlaps, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import {
  type ApprovalChainSpec,
  type ApprovalStepSpec,
  type ApproverSubject,
  MODULE_ID,
} from '../../contract/index.js'
import {
  approvalChains,
  approvalDecisions,
  approvalRequests,
  approvalSteps,
  delegations,
  employments,
  officeAssignments,
  offices,
  orgUnits,
  people,
} from '../schema.js'
import { inForceOn, todayIso } from './db.js'

/** One approval request, as it is stored. */
export type ApprovalRequestRow = typeof approvalRequests.$inferSelect

/** What a chain step's `slaHours` deadline does when it passes. */
export type TimeoutAction = 'remind' | 'escalate' | 'auto_approve'

/**
 * Who an auto-approval is attributed to: nobody.
 *
 * `approval_decisions.approver_id` is `not null` and the contract types it as a uuid, so a timeout's
 * decision needs *a* uuid — and the only honest one is the nil UUID, which `uuidv7()` cannot
 * produce and no person can therefore hold. `source = 'timeout'` on the same row is what says why.
 *
 * It also buys the idempotence for free: `hr_approval_decisions_uq` is unique on
 * `(step_id, approver_id)`, so the database refuses a second auto-approval of one step exactly the
 * way it refuses a manager's double click.
 *
 * And it survives the contract, which is the part worth checking before copying this trick
 * elsewhere: zod's `z.uuid()` rejects a uuid whose version nibble is not 1–8, so most placeholders
 * fail the inbox's own output schema — but it special-cases the nil and max UUIDs and lets both
 * through. Verified against zod 4.4.3, the version this workspace resolves.
 */
export const TIMEOUT_APPROVER_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Turning a decided request into what its subject means — leave booked against the ledger, a
 * regularization's punches written.
 *
 * The engine knows nothing about leave, deliberately: that is what lets one engine serve
 * regularization, overtime and timesheets. So whoever owns the subject supplies this, and the
 * engine calls it inside the same transaction as the decision — either both land or neither does.
 */
export type SubjectApplier = (
  tx: Tx,
  workspaceId: string,
  request: ApprovalRequestRow,
  status: 'approved' | 'rejected',
) => Promise<void>

/** Keyed by `subjectType`, because that is the only thing the engine knows about a subject. */
export type SubjectAppliers = Partial<Record<string, SubjectApplier>>

/**
 * Something an approver (or a requester) has to be told, ready to send once the transaction commits.
 *
 * Collected rather than sent inline because `core.notifications.create` writes on its own
 * connection: a notification sent inside a transaction that then rolls back has already been
 * delivered, and the reader is looking at a request that no longer needs them.
 */
export interface ApprovalNotice {
  type: 'hr.approval.reminder' | 'hr.approval.escalated' | 'hr.approval.auto_approved'
  workspaceId: string
  requestId: string
  subjectType: string
  summary: string
  summaryParams: Record<string, string | number> | null
  userIds: string[]
}

/** What one sweep of one workspace did. */
export interface ApprovalSweep {
  notices: ApprovalNotice[]
  /** Requests whose row changed, so an open inbox can be told to re-read. */
  touchedRequestIds: string[]
  /** Requests a timeout carried to a final status — the event stream's share of the audit trail. */
  decided: Array<{ requestId: string; subjectType: string; subjectId: string; status: string }>
  reminded: number
  escalated: number
  autoApproved: number
}

/**
 * The English fallback each notice is delivered with.
 *
 * Composed here means composed before anyone knows who will read it, so these are English on a
 * Persian screen — the same defect `approval_requests.summary` carries and for the same reason.
 * `data` carries `subjectType` and the request's own `summaryParams`, which is everything a
 * localised renderer needs; the module declares no `notificationTypes` yet, so nothing renders them
 * that way today.
 */
const NOTICE_TITLE: Record<ApprovalNotice['type'], string> = {
  'hr.approval.reminder': 'Still waiting for your approval',
  'hr.approval.escalated': 'An approval passed its deadline and was escalated',
  'hr.approval.auto_approved': 'An approval was granted automatically when its deadline passed',
}

/**
 * How many overdue steps one sweep of one workspace will handle.
 *
 * The sweep runs in a single transaction so a decision and its subject land together, and a
 * transaction that holds a backlog of thousands of rows open is a transaction nobody wants on a
 * shared database. Whatever is left is taken on the next tick an hour later, which is well inside
 * the resolution of a deadline stated in hours.
 */
const SWEEP_BATCH = 500

/**
 * The approval engine. One of these, for everything that needs signing off.
 *
 * Three decisions carry most of the weight:
 *
 * - **The chain is snapshotted when the request is raised.** Editing the workflow afterwards must
 *   not change who has to sign something already in flight. Discovering that approved leave now
 *   needs another signature is very hard to explain to the person who already took the week.
 * - **Approvers are resolved to people at request time**, not looked up at decision time. A
 *   reorganisation in the middle of an approval would otherwise silently move it to somebody else.
 * - **One decision per approver per step**, enforced by a unique index. A double click is one
 *   decision; the database refuses the second rather than counting it towards the quorum twice.
 */
export class ApprovalService {
  /**
   * `appliers` is what a caller that can finish the job passes in.
   *
   * A human decision arrives through the router, which applies the subject itself after calling
   * `decide`. A deadline arrives through a job, which has no router around it — so the sweep will
   * not *complete* a request it cannot also apply, and reminds instead. Passing the same appliers
   * here from the router as well would put both paths on one implementation, which is where they
   * belong.
   */
  constructor(
    private readonly kernel: Kernel,
    private readonly appliers: SubjectAppliers = {},
  ) {}

  /**
   * Expand a subject — "the manager", "whoever heads this office" — into people.
   *
   * Everything is resolved as of `on` rather than now, so a request raised in March is signed by
   * March's manager even when it is decided in May.
   */
  async resolveSubject(
    tx: Tx,
    workspaceId: string,
    subject: ApproverSubject,
    requesterId: string,
    on: string,
  ): Promise<string[]> {
    switch (subject.kind) {
      case 'person':
        return subject.id ? [subject.id] : []

      case 'manager': {
        const m = await this.managerOf(tx, workspaceId, requesterId, on)
        return m ? [m] : []
      }

      case 'manager_of_manager': {
        const m = await this.managerOf(tx, workspaceId, requesterId, on)
        if (!m) return []
        const above = await this.managerOf(tx, workspaceId, m, on)
        // Falls back to the direct manager rather than returning nobody: an empty step would either
        // block the request forever or wave it through, and both are worse than one signature.
        return above ? [above] : [m]
      }

      case 'org_unit_head': {
        const [employment] = await tx
          .select({ orgUnitId: employments.orgUnitId })
          .from(employments)
          .where(
            and(
              eq(employments.workspaceId, workspaceId),
              eq(employments.personId, requesterId),
              inForceOn(employments.effectiveFrom, employments.effectiveTo, on),
            ),
          )
          .limit(1)
        if (!employment?.orgUnitId) return []
        const [unit] = await tx
          .select({ headPersonId: orgUnits.headPersonId })
          .from(orgUnits)
          .where(and(eq(orgUnits.workspaceId, workspaceId), eq(orgUnits.id, employment.orgUnitId)))
          .limit(1)
        return unit?.headPersonId ? [unit.headPersonId] : []
      }

      case 'office_head': {
        // The local-HR step: whoever heads the requester's *primary* office. Non-primary offices
        // grant presence, not authority, so they do not get a say here either.
        const [assignment] = await tx
          .select({ officeId: officeAssignments.officeId })
          .from(officeAssignments)
          .where(
            and(
              eq(officeAssignments.workspaceId, workspaceId),
              eq(officeAssignments.personId, requesterId),
              eq(officeAssignments.isPrimary, true),
              inForceOn(officeAssignments.effectiveFrom, officeAssignments.effectiveTo, on),
            ),
          )
          .limit(1)
        if (!assignment) return []
        const [office] = await tx
          .select({ headPersonId: offices.headPersonId })
          .from(offices)
          .where(and(eq(offices.workspaceId, workspaceId), eq(offices.id, assignment.officeId)))
          .limit(1)
        return office?.headPersonId ? [office.headPersonId] : []
      }

      case 'permission': {
        if (!subject.id) return []
        // Asks core who holds the key, then maps those users to HR people. A permission-based step
        // is how "any HR administrator" is expressed without naming anybody.
        const members = await this.kernel
          .call<Array<{ userId: string }>>(
            'core.workspaces.members',
            { workspaceId, permission: subject.id },
            this.kernel.system,
          )
          .catch(() => [])
        const userIds = members.map((m) => m.userId)
        if (!userIds.length) return []
        const rows = await tx
          .select({ id: people.id })
          .from(people)
          .where(and(eq(people.workspaceId, workspaceId), inArray(people.userId, userIds)))
        return rows.map((r) => r.id)
      }

      case 'group': {
        if (!subject.id) return []
        const members = await this.kernel
          .call<Array<{ userId: string }>>(
            'core.groups.members',
            { workspaceId, groupId: subject.id },
            this.kernel.system,
          )
          .catch(() => [])
        const userIds = members.map((m) => m.userId)
        if (!userIds.length) return []
        const rows = await tx
          .select({ id: people.id })
          .from(people)
          .where(and(eq(people.workspaceId, workspaceId), inArray(people.userId, userIds)))
        return rows.map((r) => r.id)
      }

      default:
        return []
    }
  }

  async managerOf(tx: Tx, workspaceId: string, personId: string, on: string) {
    const [row] = await tx
      .select({ managerPersonId: employments.managerPersonId })
      .from(employments)
      .where(
        and(
          eq(employments.workspaceId, workspaceId),
          eq(employments.personId, personId),
          inForceOn(employments.effectiveFrom, employments.effectiveTo, on),
        ),
      )
      .limit(1)
    return row?.managerPersonId ?? null
  }

  /**
   * The chain for a subject type: the workspace's default, or a single implicit manager step.
   *
   * The implicit fallback is what makes Level 1 work. A company with one approver should not have
   * to build a chain to discover that it has one, and a workspace with the `approvals` capability
   * off never sees a chain editor at all.
   */
  async chainFor(tx: Tx, workspaceId: string, subjectType: string): Promise<ApprovalChainSpec> {
    const [row] = await tx
      .select()
      .from(approvalChains)
      .where(
        and(
          eq(approvalChains.workspaceId, workspaceId),
          eq(approvalChains.subjectType, subjectType),
          eq(approvalChains.isDefault, true),
          isNull(approvalChains.archivedAt),
        ),
      )
      .limit(1)
    if (row) return row.spec as unknown as ApprovalChainSpec
    return {
      steps: [
        {
          name: 'Manager',
          approvers: [{ kind: 'manager' }],
          mode: 'any',
          minApprovals: 1,
          slaHours: null,
          onTimeout: 'remind',
        },
      ],
    }
  }

  /**
   * Raise an approval, resolving every step's approvers now.
   *
   * Returns the request and the people the first step is waiting on, so the caller can notify them
   * without re-reading.
   */
  async raise(
    tx: Tx,
    workspaceId: string,
    input: {
      subjectType: string
      subjectId: string
      summary: string
      /** The same sentence as data, so the inbox reads in the approver's language, not ours. */
      summaryParams?: Record<string, string | number>
      requesterPersonId: string
      requestedBy: string | null
      on?: string
    },
  ) {
    const on = input.on ?? todayIso()
    const spec = await this.chainFor(tx, workspaceId, input.subjectType)

    const resolved: Array<{ step: ApprovalStepSpec; approverIds: string[] }> = []
    for (const step of spec.steps) {
      const ids = new Set<string>()
      for (const subject of step.approvers)
        for (const id of await this.resolveSubject(tx, workspaceId, subject, input.requesterPersonId, on))
          ids.add(id)
      // Nobody approves their own request. Where that would empty a step, the step is dropped
      // rather than left unsatisfiable — a manager requesting leave is approved by the step above.
      ids.delete(input.requesterPersonId)
      resolved.push({ step, approverIds: [...ids] })
    }

    const usable = resolved.filter((r) => r.approverIds.length > 0)

    const [request] = await tx
      .insert(approvalRequests)
      .values({
        id: uuidv7(),
        workspaceId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        summary: input.summary,
        summaryParams: input.summaryParams ?? null,
        requesterPersonId: input.requesterPersonId,
        chain: spec as unknown as Record<string, unknown>,
        // A chain that resolves to nobody at all is auto-approved rather than left pending for
        // ever. A one-person company has no manager, and their leave still has to be bookable.
        status: usable.length ? 'pending' : 'approved',
        currentStep: 0,
        requestedBy: input.requestedBy,
        decidedAt: usable.length ? null : new Date(),
      })
      .returning()

    for (const [index, r] of usable.entries()) {
      await tx.insert(approvalSteps).values({
        id: uuidv7(),
        workspaceId,
        requestId: request!.id,
        stepIndex: index,
        name: r.step.name,
        mode: r.step.mode,
        minApprovals: r.step.minApprovals,
        approverIds: r.approverIds,
        status: 'pending',
        // The deadline policy travels with the step, because the snapshot cannot be indexed back
        // into: `usable` has dropped the steps that resolved to nobody, so `stepIndex` and the
        // spec's array position are the same number only until one step is dropped.
        onTimeout: r.step.onTimeout,
        slaHours: r.step.slaHours,
        // Only the step that is actually waiting has a clock. Every step used to be given one at
        // request time, so a two-step chain with a 24-hour SLA had step 2 overdue before step 1 had
        // been looked at — "you have 24 hours" measured from a moment the approver could not act
        // in. `settleStep` starts the next one when the request reaches it.
        dueAt: index === 0 ? deadlineFrom(r.step.slaHours) : null,
      })
    }

    return {
      request: request!,
      autoApproved: usable.length === 0,
      firstStepApprovers: usable[0]?.approverIds ?? [],
    }
  }

  /**
   * Record a decision and advance.
   *
   * The unique index on `(step_id, approver_id)` is what makes this idempotent: a second decision
   * from the same person is refused by the database, not counted twice towards a quorum.
   */
  async decide(
    tx: Tx,
    workspaceId: string,
    requestId: string,
    approverPersonId: string,
    decision: 'approve' | 'reject',
    comment: string | null,
    onBehalfOfId: string | null,
  ) {
    const [request] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.id, requestId)))
      .limit(1)
    if (!request) throw KernError.notFound('Approval request')
    if (request.status !== 'pending') throw KernError.conflict(`This request is already ${request.status}`)

    const [step] = await tx
      .select()
      .from(approvalSteps)
      .where(and(eq(approvalSteps.requestId, requestId), eq(approvalSteps.stepIndex, request.currentStep)))
      .limit(1)
    if (!step) throw KernError.notFound('Approval step')

    // The person acting must be on the step — either directly, or as somebody's delegate.
    const actingAs = onBehalfOfId ?? approverPersonId
    if (!step.approverIds.includes(actingAs))
      throw KernError.forbidden('You are not an approver on this step')
    if (
      onBehalfOfId &&
      !(await this.mayActFor(tx, workspaceId, approverPersonId, onBehalfOfId, request.subjectType))
    )
      throw KernError.forbidden('You do not hold a delegation from that person for this')

    await tx.insert(approvalDecisions).values({
      id: uuidv7(),
      workspaceId,
      stepId: step.id,
      approverId: actingAs,
      onBehalfOfId: onBehalfOfId ? approverPersonId : null,
      decision,
      comment,
    })

    const decisions = await tx.select().from(approvalDecisions).where(eq(approvalDecisions.stepId, step.id))
    const approvals = decisions.filter((d) => d.decision === 'approve').length
    const rejections = decisions.filter((d) => d.decision === 'reject').length

    // One rejection ends it. Every workflow we have wants that, and "some approvers rejected but it
    // went through anyway" is not a sentence anybody wants to read in an audit.
    if (rejections > 0) {
      await tx.update(approvalSteps).set({ status: 'rejected' }).where(eq(approvalSteps.id, step.id))
      await tx
        .update(approvalRequests)
        .set({ status: 'rejected', decidedAt: new Date(), version: sql`${approvalRequests.version} + 1` })
        .where(eq(approvalRequests.id, requestId))
      return { status: 'rejected' as const, request }
    }

    if (approvals < requiredApprovals(step)) return { status: 'pending' as const, request }

    const advancedTo = await this.settleStep(tx, request, step)
    if (advancedTo !== null) return { status: 'pending' as const, request, advancedTo }
    return { status: 'approved' as const, request }
  }

  /**
   * Mark a satisfied step approved and move the request on — the half of a decision that is the
   * same whether a person made it or a deadline did.
   *
   * Returns the index it advanced to, or null when there was nothing after it and the request is
   * now approved. Starting the next step's clock here is the point: a deadline is a promise about
   * how long an approver has, and it can only be counted from the moment they could act.
   */
  private async settleStep(
    tx: Tx,
    request: ApprovalRequestRow,
    step: typeof approvalSteps.$inferSelect,
    now = new Date(),
  ): Promise<number | null> {
    await tx.update(approvalSteps).set({ status: 'approved' }).where(eq(approvalSteps.id, step.id))

    const [next] = await tx
      .select()
      .from(approvalSteps)
      .where(and(eq(approvalSteps.requestId, request.id), eq(approvalSteps.stepIndex, step.stepIndex + 1)))
      .limit(1)

    if (next) {
      await tx
        .update(approvalRequests)
        .set({ currentStep: next.stepIndex, version: sql`${approvalRequests.version} + 1` })
        .where(eq(approvalRequests.id, request.id))
      // Left alone when the step states no SLA of its own, so a request raised before steps carried
      // `sla_hours` keeps whatever deadline it was given rather than losing it to a null.
      if (next.slaHours)
        await tx
          .update(approvalSteps)
          .set({ dueAt: deadlineFrom(next.slaHours, now) })
          .where(eq(approvalSteps.id, next.id))
      return next.stepIndex
    }

    await tx
      .update(approvalRequests)
      .set({ status: 'approved', decidedAt: now, version: sql`${approvalRequests.version} + 1` })
      .where(eq(approvalRequests.id, request.id))
    return null
  }

  /**
   * Act on every step whose deadline has passed, and say who has to be told.
   *
   * The chain editor has offered `slaHours` and `onTimeout` since the day it shipped and nothing
   * read either one, so a step with a deadline waited exactly as long as a step without one. This
   * is what makes the three answers mean something:
   *
   * - **remind** — tell the approvers again. Once per deadline: the deadline is reached once, and
   *   an hourly job that reminds on every tick is a job an approver mutes.
   * - **escalate** — widen the step to whoever is above its approvers, once, and tell everybody.
   * - **auto_approve** — decide it, attributed to the timeout and never to a person.
   *
   * Nothing here fans out per office, and that is deliberate rather than an oversight: an SLA is an
   * *elapsed duration*, and twenty-four hours is twenty-four hours in Tehran and in New York alike.
   * The per-office fan-out in this module exists for boundaries that are a date in a calendar —
   * "the month has ended" — which is a different question. `auto-clock-out` is the same shape.
   *
   * Idempotence is a column, not a schedule: `timeout_handled_at` is set with the action taken and
   * the query will not look at that step again. The auto-approval has a second guard underneath
   * that one, in the unique index on `(step_id, approver_id)`.
   */
  async sweepTimeouts(tx: Tx, workspaceId: string, now: Date = new Date()): Promise<ApprovalSweep> {
    const due = await tx
      .select({ step: approvalSteps, request: approvalRequests })
      .from(approvalSteps)
      .innerJoin(approvalRequests, eq(approvalRequests.id, approvalSteps.requestId))
      .where(
        and(
          eq(approvalSteps.workspaceId, workspaceId),
          // The three leading predicates are `hr_approval_steps_due_idx`, in its order.
          eq(approvalSteps.status, 'pending'),
          isNotNull(approvalSteps.dueAt),
          lte(approvalSteps.dueAt, now),
          isNull(approvalSteps.timeoutHandledAt),
          eq(approvalRequests.status, 'pending'),
          // Only the step the request is actually standing on. A later step of a live request is
          // pending too, and acting on one would decide a signature out of order.
          eq(approvalSteps.stepIndex, approvalRequests.currentStep),
        ),
      )
      .orderBy(asc(approvalSteps.dueAt))
      .limit(SWEEP_BATCH)
    if (!due.length)
      return {
        notices: [],
        touchedRequestIds: [],
        decided: [],
        reminded: 0,
        escalated: 0,
        autoApproved: 0,
      }

    const sweep: ApprovalSweep = {
      notices: [],
      touchedRequestIds: [],
      decided: [],
      reminded: 0,
      escalated: 0,
      autoApproved: 0,
    }
    const touched = new Set<string>()
    /** Notices before their people have been turned into accounts — one lookup for the whole batch. */
    const pending: Array<{ type: ApprovalNotice['type']; request: ApprovalRequestRow; personIds: string[] }> =
      []

    for (const { step, request } of due) {
      let action = (step.onTimeout as TimeoutAction) ?? 'remind'

      if (action === 'escalate') {
        const above = await this.whoIsAbove(tx, workspaceId, step.approverIds, request.requesterPersonId)
        if (above.length) {
          await tx
            .update(approvalSteps)
            .set({
              approverIds: [...step.approverIds, ...above],
              escalatedAt: now,
              // Escalating must not make the step *harder* to satisfy, and `all` derives what it
              // needs from the length of the array — so widening the set would silently add a
              // signature to collect. The bar is pinned to what it was and the set grows around it.
              mode: step.mode === 'all' ? 'quorum' : step.mode,
              minApprovals: step.mode === 'all' ? step.approverIds.length : step.minApprovals,
            })
            .where(eq(approvalSteps.id, step.id))
          // Everyone on the step, old and new. The people it went over the head of are the ones
          // most owed the sentence, and the ones it landed on cannot act on what they are not told.
          pending.push({
            type: 'hr.approval.escalated',
            request,
            personIds: [...step.approverIds, ...above],
          })
          sweep.escalated++
        } else {
          // The only "who is above" this module has is `employments.manager_person_id`. When it
          // answers nobody there is no hierarchy to escalate into, and inventing one — the office
          // head, whoever holds a permission — would route somebody's leave to a person the
          // workspace never nominated. So the step falls back to the weakest honest action.
          this.kernel.log.warn(
            { module: 'hr', workspaceId, requestId: request.id, stepId: step.id },
            'approval escalation has nobody above its approvers; reminded instead',
          )
          action = 'remind'
        }
      }

      if (action === 'auto_approve') {
        const [next] = await tx
          .select({ id: approvalSteps.id })
          .from(approvalSteps)
          .where(
            and(eq(approvalSteps.requestId, request.id), eq(approvalSteps.stepIndex, step.stepIndex + 1)),
          )
          .limit(1)
        const applier = this.appliers[request.subjectType]

        if (!next && !applier) {
          // Approving the last step is what makes the *request* approved, and an approved request
          // whose subject was never applied is worse than a late one: the leave reads approved in
          // the inbox, stays pending on the employee's own screen, and never costs the balance it
          // was granted from. Advancing to a further step has no subject effect at all, so that
          // half needs nothing and still runs.
          this.kernel.log.warn(
            { module: 'hr', workspaceId, requestId: request.id, subjectType: request.subjectType },
            'auto-approval would complete a request nothing here can apply to its subject; reminded instead',
          )
          action = 'remind'
        } else {
          await tx
            .insert(approvalDecisions)
            .values({
              id: uuidv7(),
              workspaceId,
              stepId: step.id,
              approverId: TIMEOUT_APPROVER_ID,
              onBehalfOfId: null,
              decision: 'approve',
              // Left empty on purpose. A comment is what an approver wrote, and a sentence composed
              // here would be English in every locale and indistinguishable from one somebody
              // typed. `source` is the machine-readable half and it is not a sentence.
              comment: null,
              source: 'timeout',
            })
            .onConflictDoNothing({
              target: [approvalDecisions.stepId, approvalDecisions.approverId],
            })

          const advancedTo = await this.settleStep(tx, request, step, now)
          if (advancedTo === null) {
            // In the same transaction as the decision: either the request is approved and its leave
            // is booked, or neither happened.
            await applier?.(tx, workspaceId, request, 'approved')
            sweep.decided.push({
              requestId: request.id,
              subjectType: request.subjectType,
              subjectId: request.subjectId,
              status: 'approved',
            })
          }
          // The requester first: somebody whose leave was granted by a clock running out should
          // hear it from the system rather than notice it.
          pending.push({
            type: 'hr.approval.auto_approved',
            request,
            personIds: [
              ...(request.requesterPersonId ? [request.requesterPersonId] : []),
              ...step.approverIds,
            ],
          })
          sweep.autoApproved++
        }
      }

      if (action === 'remind') {
        pending.push({ type: 'hr.approval.reminder', request, personIds: step.approverIds })
        sweep.reminded++
      }

      await tx
        .update(approvalSteps)
        .set({ timeoutHandledAt: now, timeoutAction: action })
        .where(eq(approvalSteps.id, step.id))
      touched.add(request.id)
    }

    sweep.touchedRequestIds = [...touched]

    const everyone = [...new Set(pending.flatMap((p) => p.personIds))]
    const accounts = everyone.length
      ? await tx
          .select({ id: people.id, userId: people.userId })
          .from(people)
          .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, everyone)))
      : []
    // An employee need not have a Kern account, and one that was removed from the workspace has had
    // the link cleared. Both are "nothing to deliver", not an error.
    const userIdOf = new Map(accounts.filter((a) => a.userId).map((a) => [a.id, a.userId as string]))

    for (const p of pending) {
      const userIds = [
        ...new Set(p.personIds.map((id) => userIdOf.get(id)).filter((id): id is string => !!id)),
      ]
      if (!userIds.length) continue
      sweep.notices.push({
        type: p.type,
        workspaceId,
        requestId: p.request.id,
        subjectType: p.request.subjectType,
        summary: p.request.summary,
        summaryParams: p.request.summaryParams,
        userIds,
      })
    }

    return sweep
  }

  /**
   * Whoever is above a step's approvers, for an escalation.
   *
   * Asked of each *approver*, not of the requester: a step may be an office head or a permission
   * holder who is nowhere near the requester's own management line, and "two levels above the
   * person asking" would then escalate to somebody with no connection to the step at all.
   *
   * The requester is removed for the same reason `raise` removes them — nobody approves their own
   * request — and so are people already on the step, so an escalation that resolves to the same
   * people is correctly reported as having nowhere to go.
   */
  private async whoIsAbove(
    tx: Tx,
    workspaceId: string,
    approverIds: string[],
    requesterPersonId: string | null,
  ): Promise<string[]> {
    const on = todayIso()
    const above = new Set<string>()
    for (const approverId of approverIds) {
      const manager = await this.managerOf(tx, workspaceId, approverId, on)
      if (manager) above.add(manager)
    }
    for (const id of approverIds) above.delete(id)
    if (requesterPersonId) above.delete(requesterPersonId)
    return [...above]
  }

  /**
   * Send what a sweep produced, **after** its transaction has committed.
   *
   * One failed notification must not cost the decision that caused it, so every call is caught: the
   * decision is in the database either way, and a reminder that did not arrive is a smaller loss
   * than a rollback of the leave it was about. A self-hosted instance with core unreachable from
   * this process gets a warning per notice rather than a failed job.
   */
  async deliverNotices(notices: ApprovalNotice[]): Promise<number> {
    let sent = 0
    for (const notice of notices)
      for (const userId of notice.userIds)
        try {
          await this.kernel.call(
            'core.notifications.create',
            {
              userId,
              workspaceId: notice.workspaceId,
              module: MODULE_ID,
              type: notice.type,
              title: NOTICE_TITLE[notice.type],
              body: notice.summary || null,
              object: null,
              url: '/hr/approvals',
              // The sentence as data, beside the English one above it, so a localised renderer can
              // be added without a second round of notifications.
              data: {
                subjectType: notice.subjectType,
                requestId: notice.requestId,
                params: notice.summaryParams ?? {},
              },
              // One request collapses into one card however many times it is reminded about.
              groupKey: `hr.approval:${notice.requestId}`,
              actorId: null,
            },
            this.kernel.system,
          )
          sent++
        } catch (err) {
          this.kernel.log.warn(
            {
              module: 'hr',
              workspaceId: notice.workspaceId,
              requestId: notice.requestId,
              err: (err as Error).message,
            },
            'approval notification not delivered',
          )
        }
    return sent
  }

  /**
   * Does `actor` hold a live delegation from `from`, **for this kind of thing**?
   *
   * `subjectType` is the half that was missing, and leaving it out granted more than its author
   * did: `Delegation.subjectType` is documented as "null delegates every subject type", so a value
   * means one kind and only that kind. Without the predicate somebody handed leave cover for a
   * fortnight could also sign off attendance corrections and, once they exist, overtime and
   * timesheets — never "decide as anybody", since a live delegation from that person is still
   * required, but wider than what was granted, which is the sort of thing an audit finds rather
   * than a user reports.
   */
  async mayActFor(tx: Tx, workspaceId: string, actor: string, from: string, subjectType: string) {
    const today = todayIso()
    const [row] = await tx
      .select({ id: delegations.id })
      .from(delegations)
      .where(
        and(
          eq(delegations.workspaceId, workspaceId),
          eq(delegations.toPersonId, actor),
          eq(delegations.fromPersonId, from),
          // Null is the wildcard, so it has to be matched explicitly — `eq` on a null column is
          // null, not true, and would refuse exactly the delegations that cover everything.
          or(isNull(delegations.subjectType), eq(delegations.subjectType, subjectType)),
          lte(delegations.startsOn, today),
          sql`${delegations.endsOn} >= ${today}`,
        ),
      )
      .limit(1)
    return !!row
  }

  /** Cancel an in-flight approval, because its subject was withdrawn. */
  async cancel(tx: Tx, workspaceId: string, subjectType: string, subjectId: string) {
    await tx
      .update(approvalRequests)
      .set({ status: 'cancelled', decidedAt: new Date() })
      .where(
        and(
          eq(approvalRequests.workspaceId, workspaceId),
          eq(approvalRequests.subjectType, subjectType),
          eq(approvalRequests.subjectId, subjectId),
          eq(approvalRequests.status, 'pending'),
        ),
      )
  }

  /**
   * Everything waiting on this person, including what they may decide by delegation — or, with
   * `status: 'decided'`, everything they have already settled.
   *
   * The two are exclusive. This took a boolean called `includeDecided` and applied *no* status
   * filter when it was true, so the caller's "Decided" tab listed pending requests under a heading
   * saying they had been decided.
   */
  async inboxFor(
    tx: Tx,
    workspaceId: string,
    personId: string,
    status: 'pending' | 'decided',
    limit: number,
  ) {
    const today = todayIso()
    const delegated = await tx
      .select({ fromPersonId: delegations.fromPersonId, subjectType: delegations.subjectType })
      .from(delegations)
      .where(
        and(
          eq(delegations.workspaceId, workspaceId),
          eq(delegations.toPersonId, personId),
          lte(delegations.startsOn, today),
          sql`${delegations.endsOn} >= ${today}`,
        ),
      )
    const actingFor = [personId, ...delegated.map((d) => d.fromPersonId)]

    /**
     * What each delegator handed over. `null` in the set is the wildcard.
     *
     * One person may delegate twice with different scopes, so this is a set per delegator rather
     * than a single value — taking the last row would silently drop the other grant.
     */
    const scopeOf = new Map<string, Set<string | null>>()
    for (const d of delegated) {
      const set = scopeOf.get(d.fromPersonId) ?? new Set<string | null>()
      set.add(d.subjectType)
      scopeOf.set(d.fromPersonId, set)
    }
    const mayDecide = (approverIds: string[], subjectType: string) =>
      approverIds.some(
        (id) =>
          id === personId ||
          scopeOf.get(id)?.has(null) === true ||
          scopeOf.get(id)?.has(subjectType) === true,
      )

    // The overlap goes through `arrayOverlaps`, which binds the ids as one `uuid[]` parameter. The
    // hand-built `ARRAY['…','…']::uuid[]` it replaces pasted values straight into the statement —
    // they come from this module's own rows, so nothing could be injected through it, but a query
    // that concatenates identifiers is one refactor away from one that does.
    //
    // `approver_ids && …` is the whole point of the GIN index on that column: no btree can answer
    // an array overlap, so this — the query every manager triggers on every page load — was a
    // sequential scan over a table that only ever grows. Only `requestId` is read, so only
    // `requestId` is selected; the rest of the step is fetched by the detail view.
    // `approverIds` comes back too, because a delegation may be narrower than the person who
    // granted it: which of these steps this reader may actually act on depends on the *request's*
    // subject type, which is not known until the requests below are read.
    const steps = await tx
      .select({ requestId: approvalSteps.requestId, approverIds: approvalSteps.approverIds })
      .from(approvalSteps)
      .where(
        and(eq(approvalSteps.workspaceId, workspaceId), arrayOverlaps(approvalSteps.approverIds, actingFor)),
      )
    if (!steps.length) return []

    const approversOf = new Map<string, string[]>()
    for (const s of steps)
      approversOf.set(s.requestId, [...(approversOf.get(s.requestId) ?? []), ...s.approverIds])

    const requestIds = [...approversOf.keys()]
    const where = [eq(approvalRequests.workspaceId, workspaceId), inArray(approvalRequests.id, requestIds)]
    where.push(
      status === 'pending' ? eq(approvalRequests.status, 'pending') : ne(approvalRequests.status, 'pending'),
    )

    const rows = await tx
      .select()
      .from(approvalRequests)
      .where(and(...where))
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(limit)

    // The scope check lands here rather than in SQL because it is a per-row question about two
    // tables. It can return fewer than `limit` — acceptable while this endpoint answers
    // `nextCursor: null` and never pages; if it ever does, the filter has to move into the query
    // or the page will look empty while rows remain.
    return rows.filter((r) => mayDecide(approversOf.get(r.id) ?? [], r.subjectType))
  }
}

/**
 * How many approvals satisfy a step.
 *
 * `all` derives it from the array rather than from `minApprovals`, which is why an escalation that
 * widens the array has to pin the number first — see `sweepTimeouts`.
 */
function requiredApprovals(step: typeof approvalSteps.$inferSelect): number {
  if (step.mode === 'all') return step.approverIds.length
  if (step.mode === 'any') return 1
  return step.minApprovals
}

/** When a step that starts now runs out of time, or null when it never does. */
function deadlineFrom(slaHours: number | null | undefined, from = new Date()): Date | null {
  return slaHours ? new Date(from.getTime() + slaHours * 3600_000) : null
}
