import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { ApprovalChainSpec, ApprovalStepSpec, ApproverSubject } from '../../contract/index.js'
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
  constructor(private readonly kernel: Kernel) {}

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
        status: index === 0 ? 'pending' : 'pending',
        dueAt: r.step.slaHours ? new Date(Date.now() + r.step.slaHours * 3600_000) : null,
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
    if (onBehalfOfId && !(await this.mayActFor(tx, workspaceId, approverPersonId, onBehalfOfId)))
      throw KernError.forbidden('You do not hold a delegation from that person')

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

    const needed = step.mode === 'all' ? step.approverIds.length : step.mode === 'any' ? 1 : step.minApprovals
    if (approvals < needed) return { status: 'pending' as const, request }

    await tx.update(approvalSteps).set({ status: 'approved' }).where(eq(approvalSteps.id, step.id))

    const [next] = await tx
      .select()
      .from(approvalSteps)
      .where(
        and(eq(approvalSteps.requestId, requestId), eq(approvalSteps.stepIndex, request.currentStep + 1)),
      )
      .limit(1)

    if (next) {
      await tx
        .update(approvalRequests)
        .set({ currentStep: request.currentStep + 1, version: sql`${approvalRequests.version} + 1` })
        .where(eq(approvalRequests.id, requestId))
      return { status: 'pending' as const, request, advancedTo: next.stepIndex }
    }

    await tx
      .update(approvalRequests)
      .set({ status: 'approved', decidedAt: new Date(), version: sql`${approvalRequests.version} + 1` })
      .where(eq(approvalRequests.id, requestId))
    return { status: 'approved' as const, request }
  }

  /** Does `actor` hold a live delegation from `from`? */
  async mayActFor(tx: Tx, workspaceId: string, actor: string, from: string) {
    const today = todayIso()
    const [row] = await tx
      .select({ id: delegations.id })
      .from(delegations)
      .where(
        and(
          eq(delegations.workspaceId, workspaceId),
          eq(delegations.toPersonId, actor),
          eq(delegations.fromPersonId, from),
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

  /** Everything waiting on this person, including what they may decide by delegation. */
  async inboxFor(tx: Tx, workspaceId: string, personId: string, includeDecided: boolean, limit: number) {
    const today = todayIso()
    const delegated = await tx
      .select({ fromPersonId: delegations.fromPersonId })
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

    const steps = await tx
      .select()
      .from(approvalSteps)
      .where(
        and(
          eq(approvalSteps.workspaceId, workspaceId),
          sql`${approvalSteps.approverIds} && ${sql.raw(`ARRAY[${actingFor.map((i) => `'${i}'`).join(',')}]::uuid[]`)}`,
        ),
      )
    if (!steps.length) return []

    const requestIds = [...new Set(steps.map((s) => s.requestId))]
    const where = [eq(approvalRequests.workspaceId, workspaceId), inArray(approvalRequests.id, requestIds)]
    if (!includeDecided) where.push(eq(approvalRequests.status, 'pending'))

    return tx
      .select()
      .from(approvalRequests)
      .where(and(...where))
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(limit)
  }
}

export { or }
