import type { Principal } from '@kernhq/contracts'
import type { Kernel, Tx } from '@kernhq/kernel'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { HR_PERMISSIONS } from '../../contract/index.js'
import { employments, officeAssignments, offices, orgUnits, people } from '../schema.js'
import { inForceOn, todayIso } from './db.js'

/**
 * Who a viewer may read, and how much of them.
 *
 * The module has always declared four widths of "other people" and enforced one. `hr.person.view`
 * defaults to `member`, so every colleague read every colleague's whole row — personal email, phone
 * number, hire date, termination date — and `view_team`, `view_office` and `view_all` sat in the
 * role editor gating nothing. This is the thing that reads them.
 *
 * **The split is by field, not by row, and that is a product decision.** A staff directory every
 * colleague can open is what a company wants; hiding half the workforce from an engineer looking up
 * who runs Payroll would be a worse product, not a safer one. So `hr.person.view` still returns
 * every person — as a **card**: name, employee number, work email, photo, status, timezone, office.
 * The four fields in `PERSONNEL_FIELDS` are the *personnel record* behind that card, and the three
 * widening keys decide whose card fills out into one:
 *
 * - nobody's but your own, with `hr.person.view` alone;
 * - `hr.person.view_team` — the org-unit subtree you head, plus your direct reports;
 * - `hr.person.view_office` — everybody assigned to an office you head, primary or not, because a
 *   non-primary assignment is exactly what "visible to that office's local HR" means;
 * - `hr.person.view_all` — the workspace, and the only one that answers `null`.
 *
 * None of the three implies another, so a country HR manager does not silently become a global one.
 * You always see your own record: identity, never a grant. `hr.person.manage` reads what it writes —
 * see `grantsFor`.
 *
 * **Why this is a computed set of ids and not `.use(requires('hr.person.view_team'))`.**
 * `Authz.can` falls through to the workspace-level effective set whenever there is no object-scope
 * binding for the id it was handed, so an object-scoped `requires` passes for anybody holding the
 * key at workspace level and scopes *nothing*. It would look like it worked. The scope has to be
 * derived from the org chart — `org_units.head_person_id` over the ltree subtree, `offices.head_
 * person_id`, `employments.manager_person_id` — which is what these columns are for and what the
 * GiST index on `org_units.path` was built to answer.
 *
 * **What is not resolved yet:** an object-scope *binding* of `view_team`/`view_office` to a unit or
 * office id, which `permissions.ts` describes. `Authz` exposes no way to ask "is this bound *at*
 * this object" — `can(object, id)` answers true for anybody holding the key at workspace level too
 * — so honouring it would mean one `can` call per office in the workspace on every directory read.
 * Headship is what the columns can answer today; the binding needs either `PermissionScopeKind` to
 * grow `org_unit`/`office` or `Authz` to expose its bindings, both changes to the kernel.
 */
export class HrAccessService {
  /** Everything, however it was arrived at. Frozen so no caller can narrow the shared answer. */
  private static readonly UNBOUNDED: HrAccessGrants = Object.freeze({
    all: true,
    team: true,
    office: true,
  })

  constructor(private readonly kernel: Kernel) {}

  /**
   * Which of the three widening keys this viewer holds, at workspace level.
   *
   * Workspace scope on purpose. The keys are declared `scope: 'object'` so an administrator *can*
   * bind them to a unit or an office, but the question here is only "do you hold this key at all";
   * *which* team or office it covers comes from the org chart below, never from the check.
   *
   * `view_all` is asked through `can`, so an owner and an instance admin pass the way they pass
   * everything else and the two narrower reads are skipped. Below them one `effective()` answers
   * every remaining key, rather than three `can` calls resolving the same set three times.
   *
   * **`hr.person.manage` reads everything it can write.** The edit form is populated from the
   * record it is about to save back, so a writer who saw a redacted card would blank the very
   * fields they could not see — silent data loss on an ordinary edit. Managing is workspace-wide
   * already and has no narrow variant to lose, so this takes nothing away from anybody: it only
   * closes the hole a custom role opens by granting `manage` without `view_all`.
   */
  async grantsFor(principal: Principal, workspaceId: string): Promise<HrAccessGrants> {
    const all = await this.kernel.authz.can(principal, HR_PERMISSIONS.personViewAll, {
      kind: 'workspace',
      id: workspaceId,
      workspaceId,
    })
    if (all) return HrAccessService.UNBOUNDED
    const held = await this.kernel.authz.effective(principal, workspaceId)
    if (held.has(HR_PERMISSIONS.personManage)) return HrAccessService.UNBOUNDED
    return {
      all: false,
      team: held.has(HR_PERMISSIONS.personViewTeam),
      office: held.has(HR_PERMISSIONS.personViewOffice),
    }
  }

  /**
   * The people whose full personnel record this viewer may read. `null` means every person.
   *
   * `null` rather than a list of every id in the workspace: an HR administrator in a company of
   * five thousand should not pay for a five-thousand-element set on every directory page, and
   * "unbounded" is a different fact from "happens to cover everybody today".
   *
   * The viewer's own person id is resolved here rather than passed in, because the answer for an
   * unbounded viewer must not cost a lookup at all — and because every caller would otherwise
   * repeat the same two lines before asking.
   */
  async visiblePersonIds(tx: Tx, workspaceId: string, principal: Principal): Promise<string[] | null> {
    const grants = await this.grantsFor(principal, workspaceId)
    if (grants.all) return null

    const viewer = await this.personIdOf(tx, workspaceId, principal)
    // Plenty of members are not employees. They see the directory and no record but — since they
    // have none — nobody's.
    if (!viewer) return []

    const ids = new Set<string>([viewer])
    // One date for both resolvers, so a request that straddles midnight cannot answer the team from
    // one day and the office from the next.
    const today = todayIso()
    if (grants.team) for (const id of await this.teamOf(tx, workspaceId, viewer, today)) ids.add(id)
    if (grants.office) for (const id of await this.officeOf(tx, workspaceId, viewer, today)) ids.add(id)
    return [...ids]
  }

  /** The viewer's own HR record, if they have one. Null for a member who was never made a person. */
  async personIdOf(tx: Tx, workspaceId: string, principal: Principal): Promise<string | null> {
    if (!principal.userId) return null
    const [row] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), eq(people.userId, principal.userId)))
      .limit(1)
    return row?.id ?? null
  }

  /**
   * `view_team`: everybody in the org-unit subtree this person heads, plus their direct reports.
   *
   * Two questions rather than one, because they answer different shapes of manager. A department
   * head is named on `org_units.head_person_id` and needs the whole subtree under it — one GiST
   * lookup on `path <@`, not a recursive walk. A team lead who heads no unit at all is named on
   * their reports' `employments.manager_person_id`, which has its own index.
   *
   * Headship of an *archived* unit grants nothing: a department that has been dissolved should not
   * keep handing out records. Units inside the subtree are not filtered the same way — the people
   * in them are still employed, and losing them because a sub-department was tidied up would be a
   * hole rather than a narrowing.
   */
  /**
   * Scope is asked as of **today**, through `inForceOn`, not "the row with no end date".
   *
   * The two disagree exactly where this module dates rows, and it dates them routinely, in both
   * directions:
   *
   * - `people.offboard` writes `effective_to` = the last working day, which is normally in the
   *   *future*. Keying on a null end date drops somebody the moment their leaving is recorded, so
   *   their manager loses the record for the whole notice period — including `terminatedOn`, the
   *   one field that says when they actually go. That is the failure nobody reports, because a
   *   record that vanishes reads as "HR took it away".
   * - `changeEmployment` closes the open row at `effective_from - 1` and opens the new one, so a
   *   transfer dated 1 October and recorded in August would hand the record to the receiving
   *   manager five weeks early and take it from the current one just as early. A future joiner is
   *   the same shape: created `onboarding` with a future `hired_on`.
   *
   * Every other resolver here answers "who is this today" the same way — `approvals.ts`,
   * `resolve.ts` and the office roster all use `inForceOn`. Visibility must not be the one that
   * disagrees — and the roster was itself changed to this predicate in the same commit, because it
   * had been on the null-end-date test and would otherwise have listed a different set of people
   * from the one whose records this service lets you read, in the same response.
   */
  private async teamOf(
    tx: Tx,
    workspaceId: string,
    viewerPersonId: string,
    today: string,
  ): Promise<string[]> {
    const ids = new Set<string>()

    const headed = await tx
      .select({ path: orgUnits.path })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.workspaceId, workspaceId),
          eq(orgUnits.headPersonId, viewerPersonId),
          isNull(orgUnits.archivedAt),
        ),
      )
    if (headed.length) {
      const subtree = or(...headed.map((u) => sql`${orgUnits.path} <@ ${u.path}::ltree`))
      const rows = await tx
        .select({ personId: employments.personId })
        .from(employments)
        .innerJoin(
          orgUnits,
          and(eq(orgUnits.id, employments.orgUnitId), eq(orgUnits.workspaceId, employments.workspaceId)),
        )
        .where(
          and(
            eq(employments.workspaceId, workspaceId),
            inForceOn(employments.effectiveFrom, employments.effectiveTo, today),
            subtree,
          ),
        )
      for (const r of rows) ids.add(r.personId)
    }

    const reports = await tx
      .select({ personId: employments.personId })
      .from(employments)
      .where(
        and(
          eq(employments.workspaceId, workspaceId),
          eq(employments.managerPersonId, viewerPersonId),
          inForceOn(employments.effectiveFrom, employments.effectiveTo, today),
        ),
      )
    for (const r of reports) ids.add(r.personId)

    return [...ids]
  }

  /**
   * `view_office`: everybody assigned to an office this person heads, as of today.
   *
   * Every open assignment, not only the primary one. The primary decides holidays, timezone and
   * policy; the others grant presence — appearing in that office's directory, being visible to its
   * local HR — and that second half is precisely this permission.
   *
   * An office's `parent_office_id` is not walked. A campus is geography, not authority, and there
   * is no materialised path to walk it with; heading the campus and heading its buildings are two
   * grants until somebody asks for the third.
   */
  private async officeOf(
    tx: Tx,
    workspaceId: string,
    viewerPersonId: string,
    today: string,
  ): Promise<string[]> {
    const headed = await tx
      .select({ id: offices.id })
      .from(offices)
      .where(
        and(
          eq(offices.workspaceId, workspaceId),
          eq(offices.headPersonId, viewerPersonId),
          isNull(offices.archivedAt),
        ),
      )
    if (!headed.length) return []

    const rows = await tx
      .select({ personId: officeAssignments.personId })
      .from(officeAssignments)
      .where(
        and(
          eq(officeAssignments.workspaceId, workspaceId),
          inArray(
            officeAssignments.officeId,
            headed.map((o) => o.id),
          ),
          // As of today, for the reason spelled out on `teamOf`: an office move is dated, so a null
          // end date is neither "here now" nor "here on the day we are asking about".
          inForceOn(officeAssignments.effectiveFrom, officeAssignments.effectiveTo, today),
        ),
      )
    return [...new Set(rows.map((r) => r.personId))]
  }
}

/** Which of the three widening keys a viewer holds. `all` implies the other two. */
export interface HrAccessGrants {
  /** `hr.person.view_all` — every record in the workspace. */
  all: boolean
  /** `hr.person.view_team` — the org-unit subtree you head, plus your direct reports. */
  team: boolean
  /** `hr.person.view_office` — everybody assigned to an office you head. */
  office: boolean
}

/**
 * The fields a directory card does not carry.
 *
 * Personal email and phone are contact details somebody gave their employer, not their colleagues.
 * Hire and termination dates are employment facts: the first is somebody's seniority and the second
 * is the date they were let go, which is not a thing to publish to the whole company on the day it
 * happens.
 *
 * Everything else on `Person` stays: name, employee number, work email, photo, status, timezone,
 * office, and `custom`. A directory that cannot tell you somebody's work email is not a directory.
 *
 * Nulled rather than omitted, because all four are `.nullable()` in the contract — so a card parses
 * as a `Person` and no client has to learn a second shape.
 */
export const PERSONNEL_FIELDS = ['personalEmail', 'phone', 'hiredOn', 'terminatedOn'] as const

/** The shape `forViewer` narrows. Structural, so it fits a row with extra columns joined onto it. */
export interface PersonnelFields {
  personalEmail: string | null
  phone: string | null
  hiredOn: string | null
  terminatedOn: string | null
  personnelHidden: boolean
}

/** What `visiblePersonIds` answered, ready to be asked about one person at a time. */
export type VisiblePeople = ReadonlySet<string> | null

/** Build the lookup once per page rather than scanning an array per row. */
export const visibleSet = (ids: string[] | null): VisiblePeople => (ids === null ? null : new Set(ids))

/** Does this viewer read the record behind the card, or only the card? */
export const seesRecordOf = (visible: VisiblePeople, personId: string): boolean =>
  visible === null || visible.has(personId)

/**
 * A person as this viewer may read them: the whole record, or the directory card.
 *
 * Returns the object it was given when nothing is hidden, so the common path — an HR administrator
 * with `view_all` — allocates nothing.
 */
export function forViewer<T extends PersonnelFields & { id: string }>(person: T, visible: VisiblePeople): T {
  if (seesRecordOf(visible, person.id)) return person
  // `personnelHidden` is what lets a screen tell "withheld" from "empty". This is the only place
  // that nulls these fields, so it is the only place that can honestly say so — a client trying to
  // infer it would be re-deriving the org chart from data it never fetched.
  return {
    ...person,
    personalEmail: null,
    phone: null,
    hiredOn: null,
    terminatedOn: null,
    personnelHidden: true,
  }
}
