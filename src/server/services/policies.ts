import { KernError, type Tx } from '@kernhq/kernel'
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  type PolicyKind,
  type PolicySubjectKind,
  type ResolvedPolicy,
  SUBJECT_PRIORITY,
} from '../../contract/index.js'
import { periods, policies, policyAssignments } from '../schema.js'
import { inForceOn, todayIso } from './db.js'
import type { ResolveService } from './resolve.js'

/**
 * Which policy applies, and the boundary that stops a recomputation rewriting history.
 *
 * The ladder is the same one that resolves a calendar — `person → office → legal entity → org unit
 * → position → workspace`, nearest wins — because two precedence rules in one module is one too
 * many. It is encoded as `priority` on the assignment so the database orders it rather than this
 * file knowing the sequence by heart.
 */
export class PolicyService {
  constructor(private readonly resolve: ResolveService) {}

  /**
   * The policy of a kind that applies to one person on one date, with the rung that answered.
   *
   * Returns a `ResolvedPolicy` with nulls rather than throwing when nothing matches: a workspace
   * with no accrual policy is an ordinary state, not an error, and the caller decides whether it
   * means "skip this person" or "use the default".
   */
  async forPerson(
    tx: Tx,
    workspaceId: string,
    personId: string,
    kind: PolicyKind,
    on: string = todayIso(),
  ): Promise<ResolvedPolicy> {
    const resolution = await this.resolve.forPerson(tx, workspaceId, personId, on)

    // Every rung this person stands on, with the id that identifies them at it.
    const candidates: Array<{ kind: PolicySubjectKind; id: string | null }> = [
      { kind: 'person', id: personId },
      { kind: 'office', id: resolution.primaryOfficeId },
      { kind: 'legal_entity', id: resolution.legalEntityId },
      { kind: 'org_unit', id: resolution.orgUnitId },
      { kind: 'workspace', id: null },
    ]

    const matches = await tx
      .select({
        assignment: policyAssignments,
        policy: policies,
      })
      .from(policyAssignments)
      .innerJoin(policies, eq(policies.id, policyAssignments.policyId))
      .where(
        and(
          eq(policyAssignments.workspaceId, workspaceId),
          eq(policies.kind, kind),
          isNull(policies.archivedAt),
          inForceOn(policyAssignments.effectiveFrom, policyAssignments.effectiveTo, on),
          inForceOn(policies.effectiveFrom, policies.effectiveTo, on),
          or(
            ...candidates
              .filter((c) => c.kind === 'workspace' || c.id)
              .map((c) =>
                c.id
                  ? and(eq(policyAssignments.subjectKind, c.kind), eq(policyAssignments.subjectId, c.id))
                  : eq(policyAssignments.subjectKind, 'workspace'),
              ),
          ),
        ),
      )
      // Nearest rung first; a later `effectiveFrom` breaks a tie, so a policy superseded mid-year
      // wins over the one it replaced.
      .orderBy(desc(policyAssignments.priority), desc(policies.effectiveFrom))
      .limit(1)

    const best = matches[0]
    if (!best)
      return { kind, policyId: null, policyName: null, config: null, from: null, fromSubjectId: null }

    return {
      kind,
      policyId: best.policy.id,
      policyName: best.policy.name,
      config: best.policy.config,
      from: best.assignment.subjectKind as PolicySubjectKind,
      fromSubjectId: best.assignment.subjectId,
    }
  }

  /**
   * Resolve one kind for many people at once.
   *
   * An accrual run over five hundred people would otherwise be five hundred ladder walks, each of
   * them several queries deep — the same shape `ResolveService` had to be batched out of.
   */
  async forPeople(
    tx: Tx,
    workspaceId: string,
    personIds: string[],
    kind: PolicyKind,
    on: string = todayIso(),
  ): Promise<Map<string, ResolvedPolicy>> {
    const out = new Map<string, ResolvedPolicy>()
    if (!personIds.length) return out

    const resolutions = await this.resolve.forPeople(tx, workspaceId, personIds, on)

    const rows = await tx
      .select({ assignment: policyAssignments, policy: policies })
      .from(policyAssignments)
      .innerJoin(policies, eq(policies.id, policyAssignments.policyId))
      .where(
        and(
          eq(policyAssignments.workspaceId, workspaceId),
          eq(policies.kind, kind),
          isNull(policies.archivedAt),
          inForceOn(policyAssignments.effectiveFrom, policyAssignments.effectiveTo, on),
          inForceOn(policies.effectiveFrom, policies.effectiveTo, on),
        ),
      )
      .orderBy(desc(policyAssignments.priority), desc(policies.effectiveFrom))

    for (const personId of personIds) {
      const r = resolutions.get(personId)
      const standsOn = new Map<PolicySubjectKind, string | null>([
        ['person', personId],
        ['office', r?.primaryOfficeId ?? null],
        ['legal_entity', r?.legalEntityId ?? null],
        ['org_unit', r?.orgUnitId ?? null],
        ['workspace', null],
      ])

      // Rows are already ordered by priority, so the first that this person stands on wins.
      const best = rows.find((row) => {
        const subjectKind = row.assignment.subjectKind as PolicySubjectKind
        if (subjectKind === 'workspace') return true
        const mine = standsOn.get(subjectKind)
        return mine !== null && mine !== undefined && mine === row.assignment.subjectId
      })

      out.set(
        personId,
        best
          ? {
              kind,
              policyId: best.policy.id,
              policyName: best.policy.name,
              config: best.policy.config,
              from: best.assignment.subjectKind as PolicySubjectKind,
              fromSubjectId: best.assignment.subjectId,
            }
          : { kind, policyId: null, policyName: null, config: null, from: null, fromSubjectId: null },
      )
    }
    return out
  }

  /** The priority a subject kind carries. Written once, so nothing invents its own order. */
  static priorityFor(kind: PolicySubjectKind): number {
    return SUBJECT_PRIORITY[kind]
  }

  /**
   * Is this date inside a locked period?
   *
   * The one question every recomputation asks before writing. A locked month must not move
   * underneath a payroll that has already been filed, so anything affecting it becomes an
   * adjustment in the open period instead.
   */
  async isLocked(
    tx: Tx,
    workspaceId: string,
    on: string,
    legalEntityId: string | null = null,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ id: periods.id })
      .from(periods)
      .where(
        and(
          eq(periods.workspaceId, workspaceId),
          eq(periods.status, 'locked'),
          lte(periods.startsOn, on),
          sql`${periods.endsOn} >= ${on}`,
          // A period for a specific entity locks only that entity's people; one with no entity
          // locks the workspace.
          legalEntityId
            ? or(isNull(periods.legalEntityId), eq(periods.legalEntityId, legalEntityId))
            : isNull(periods.legalEntityId),
        ),
      )
      .limit(1)
    return !!row
  }

  /** Refuses a write into a closed month with a sentence rather than a constraint error. */
  async assertOpen(tx: Tx, workspaceId: string, on: string, legalEntityId: string | null = null) {
    if (await this.isLocked(tx, workspaceId, on, legalEntityId))
      throw KernError.conflict(
        `${on} falls in a locked period. Record it as an adjustment in the open period instead.`,
        'hr.period.locked',
      )
  }
}

/**
 * A short stamp of a config, so a derived row can say what produced it.
 *
 * Not cryptographic — it only has to change when the config does. A stable stringify keeps it from
 * changing when two equal objects happen to have their keys in a different order, which would
 * otherwise mark every row stale on a rewrite that changed nothing.
 */
export function hashConfig(config: Record<string, unknown>): string {
  const stable = JSON.stringify(config, Object.keys(config).sort())
  let hash = 0
  for (let i = 0; i < stable.length; i++) {
    hash = (hash << 5) - hash + stable.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export { asc, inArray }
