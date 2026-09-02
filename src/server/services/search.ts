import type { core } from '@kernhq/contracts'
import type { Kernel, Tx } from '@kernhq/kernel'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { MODULE_ID } from '../../contract/index.js'
import { employments, orgUnits, people, positions } from '../schema.js'

/** One page of the full reindex. Big enough to be worth a round trip, small enough to hold. */
const SCAN_BATCH = 500

/** Where a person is opened from anywhere in the product — the same URL `presenters` builds. */
export const personUrl = (personId: string) => `/hr?person=${encodeURIComponent(personId)}`
export const PERSON_ICON = 'user'

/** Statuses the directory shows by default, and therefore the ones a search may find. */
const FINDABLE = new Set(['onboarding', 'active', 'on_leave', 'offboarding'])

/** The columns a document is built from, and the two names it borrows. */
export interface IndexablePerson {
  person: typeof people.$inferSelect
  /** The current position's title and org unit's name, resolved at read time so a rename lands. */
  positionTitle: string | null
  orgUnitName: string | null
}

/**
 * The staff directory in the workspace-wide search index, so a colleague's name typed into the
 * command palette opens their card — the one HR screen most of a company opens, reached the way
 * every other thing in Kern is reached.
 *
 * **What goes in is exactly what `hr.person.view` returns to everybody.** The document carries the
 * display name, the employee number, the work email, the position and the department: the
 * directory card. It never carries the personal email, the phone, the hire or termination date —
 * `HrAccessService.forViewer` withholds those four from a reader without a personnel key, and a
 * search hit that matched on a phone number would republish what the card hides. Nothing sensitive
 * is anywhere near this file. `acl` is null because `hr.person.view` is a workspace permission held
 * by `member` by default; the shell already hides the module from anybody without it.
 *
 * **Who is findable is who the directory shows.** A terminated person is out of the index, as is
 * anybody erased: an erasure replaces the name with a pseudonym, and offering that pseudonym in a
 * palette would be offering a door to a record the workspace deliberately closed. `load` answers
 * `null` for both, which is what the indexer treats as "remove this".
 *
 * Both halves are one class, for the reason `module-inventory`'s `SearchService` gives: the
 * document a mutation writes and the document a full reindex writes cannot drift, because they are
 * the same function over the same select. Everything here is best-effort — a person must not fail
 * to save because core's search service is briefly away — and `core.search.reindex` repairs whatever
 * was missed.
 */
export class HrSearchService {
  constructor(private readonly kernel: Kernel) {}

  static document(workspaceId: string, row: IndexablePerson): core.SearchDocument {
    const body = [row.person.employeeNo, row.person.workEmail, row.positionTitle, row.orgUnitName]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part))
      .join('\n')
    return {
      workspaceId: workspaceId as core.SearchDocument['workspaceId'],
      object: { module: MODULE_ID, type: 'person', id: row.person.id },
      title: row.person.displayName,
      body: body || null,
      url: personUrl(row.person.id),
      icon: PERSON_ICON,
      acl: null,
      updatedAt: row.person.updatedAt.toISOString(),
      attributes: {
        status: row.person.status,
        employeeNo: row.person.employeeNo,
      },
    }
  }

  /**
   * The person plus the title and department of the employment in force — the open row with the
   * latest start, which is how every other reader here picks "current".
   */
  private static select(tx: Tx, workspaceId: string) {
    const current = tx
      .selectDistinctOn([employments.personId], {
        personId: employments.personId,
        positionId: employments.positionId,
        orgUnitId: employments.orgUnitId,
      })
      .from(employments)
      .where(and(eq(employments.workspaceId, workspaceId), isNull(employments.effectiveTo)))
      .orderBy(employments.personId, desc(employments.effectiveFrom))
      .as('current_employment')
    return tx
      .select({ person: people, positionTitle: positions.title, orgUnitName: orgUnits.name })
      .from(people)
      .leftJoin(current, eq(current.personId, people.id))
      .leftJoin(
        positions,
        and(eq(positions.id, current.positionId), eq(positions.workspaceId, people.workspaceId)),
      )
      .leftJoin(
        orgUnits,
        and(eq(orgUnits.id, current.orgUnitId), eq(orgUnits.workspaceId, people.workspaceId)),
      )
  }

  private static findable(row: IndexablePerson): boolean {
    return row.person.erasedAt === null && FINDABLE.has(row.person.status)
  }

  /** One person as a document, or `null` for one the index should not hold. */
  async load(workspaceId: string, personId: string): Promise<core.SearchDocument | null> {
    return this.kernel.database.withWorkspace(workspaceId, async (tx) => {
      const [row] = await HrSearchService.select(tx, workspaceId)
        .where(and(eq(people.workspaceId, workspaceId), eq(people.id, personId)))
        .limit(1)
      if (!row || !HrSearchService.findable(row)) return null
      return HrSearchService.document(workspaceId, row)
    })
  }

  /**
   * Every findable person, in pages, for a full reindex. Keyset by id — uuidv7, unique — so a scan
   * of a big workspace neither repeats nor drops a row somebody edits while it runs, and one
   * transaction per page so a reindex does not hold a pooled connection for its whole length.
   */
  async *scan(workspaceId: string): AsyncIterable<core.SearchDocument> {
    let cursor: string | null = null
    for (;;) {
      const rows: IndexablePerson[] = await this.kernel.database.withWorkspace(workspaceId, (tx) =>
        HrSearchService.select(tx, workspaceId)
          .where(
            and(
              eq(people.workspaceId, workspaceId),
              isNull(people.erasedAt),
              cursor ? sql`${people.id} > ${cursor}` : sql`true`,
            ),
          )
          .orderBy(people.id)
          .limit(SCAN_BATCH),
      )
      if (!rows.length) return
      for (const row of rows)
        if (HrSearchService.findable(row)) yield HrSearchService.document(workspaceId, row)
      cursor = rows.at(-1)?.person.id ?? null
    }
  }

  /**
   * Bring the index into step with one person, whichever direction that means.
   *
   * Called after the transaction has committed, never inside it: the index is another service's
   * table, and telling it about a row a rollback then took away cannot be retracted. A failure is
   * logged and swallowed — the directory row is authoritative and the nightly reindex is the repair.
   */
  async reindex(workspaceId: string, personId: string): Promise<void> {
    try {
      const document = await this.load(workspaceId, personId)
      if (document) await this.kernel.call('core.search.index', { documents: [document] })
      else
        await this.kernel.call('core.search.remove', {
          refs: [{ workspaceId, object: { module: MODULE_ID, type: 'person', id: personId } }],
        })
    } catch (err) {
      this.kernel.log.warn(
        { err: err instanceof Error ? err.message : String(err), workspaceId, personId, module: MODULE_ID },
        'hr: could not bring a person into step with the search index',
      )
    }
  }
}
