import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, desc, eq, exists, inArray, isNull, or, sql } from 'drizzle-orm'
import type {
  Checklist,
  ChecklistAssignee,
  ChecklistItem,
  ChecklistItemInput,
  ChecklistKind,
  ChecklistStatus,
  ChecklistSummary,
  ChecklistTemplate,
  ChecklistTemplateInput,
  ChecklistTemplateItem,
} from '../../contract/checklists.js'
import { MODULE_ID } from '../../contract/index.js'
import { checklistItems, checklists, checklistTemplateItems, checklistTemplates, people } from '../schema.js'
import { todayIso } from './db.js'
import type { ResolveService } from './resolve.js'

type TemplateRow = typeof checklistTemplates.$inferSelect
type TemplateItemRow = typeof checklistTemplateItems.$inferSelect
type ChecklistRow = typeof checklists.$inferSelect
type ItemRow = typeof checklistItems.$inferSelect

/**
 * Who is asking, as far as a checklist cares.
 *
 * `manage` is `hr.checklist.manage`, resolved by the router before the transaction opens. `personId`
 * is the caller's own HR record, or null for an account with none — plenty of accounts are not
 * employees, and an administrator with no record still manages checklists.
 */
export interface ChecklistViewer {
  personId: string | null
  manage: boolean
}

/** What starting a checklist wrote, and who has to be told once it has committed. */
export interface Started {
  checklist: Checklist
  /** Person ids with at least one item, the person the list is about excluded — they know. */
  assigneePersonIds: string[]
}

/** What ticking an item wrote, and whether it was the last one. */
export interface Ticked {
  checklist: Checklist
  completedNow: boolean
}

/** `YYYY-MM-DD` plus `n` days, in UTC, which is the only arithmetic a date needs here. */
export const shiftDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Onboarding and offboarding checklists.
 *
 * The contract argues the shape; what this file adds is the three rules the handlers lean on:
 *
 * - **A template is copied at start and never read again.** `start` resolves every item to a real
 *   person and a real date and writes rows; nothing below joins back to the template.
 * - **Visibility narrows by handler, not by key.** Everybody holds `hr.checklist.view`; without
 *   `manage`, `list` and `get` answer only the checklists about the caller or with an item assigned
 *   to them, and answer `NOT_FOUND` — not `FORBIDDEN` — for the rest, because "there is a checklist
 *   about your colleague and you may not see it" is itself a fact about the colleague.
 * - **An item is ticked by its assignee or by a manager, and a list finishes itself.** The last
 *   tick closes the checklist in the same transaction; reopening any item reopens it. There is no
 *   "close" button because there is nothing a closed list means beyond every task being done.
 */
export class ChecklistService {
  constructor(
    private readonly kernel: Kernel,
    private readonly resolve: ResolveService,
  ) {}

  // ------------------------------------------------------------------------------- templates

  static toTemplate(row: TemplateRow, items: TemplateItemRow[]): ChecklistTemplate {
    return {
      id: row.id,
      workspaceId: row.workspaceId as ChecklistTemplate['workspaceId'],
      name: row.name,
      kind: row.kind as ChecklistKind,
      isDefault: row.isDefault,
      items: items
        .filter((item) => item.templateId === row.id)
        .sort((a, b) => a.order - b.order)
        .map(
          (item): ChecklistTemplateItem => ({
            id: item.id,
            title: item.title,
            description: item.description,
            assignee: item.assignee as ChecklistAssignee,
            assigneePersonId: item.assigneePersonId,
            dueOffsetDays: item.dueOffsetDays,
            order: item.order,
          }),
        ),
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  async listTemplates(tx: Tx, workspaceId: string, includeArchived: boolean): Promise<ChecklistTemplate[]> {
    const where = [eq(checklistTemplates.workspaceId, workspaceId)]
    if (!includeArchived) where.push(isNull(checklistTemplates.archivedAt))
    const rows = await tx
      .select()
      .from(checklistTemplates)
      .where(and(...where))
      .orderBy(asc(checklistTemplates.kind), asc(checklistTemplates.name))
    if (!rows.length) return []
    const items = await tx
      .select()
      .from(checklistTemplateItems)
      .where(
        and(
          eq(checklistTemplateItems.workspaceId, workspaceId),
          inArray(
            checklistTemplateItems.templateId,
            rows.map((r) => r.id),
          ),
        ),
      )
    return rows.map((row) => ChecklistService.toTemplate(row, items))
  }

  async getTemplate(tx: Tx, workspaceId: string, templateId: string): Promise<ChecklistTemplate> {
    const [row] = await tx
      .select()
      .from(checklistTemplates)
      .where(and(eq(checklistTemplates.workspaceId, workspaceId), eq(checklistTemplates.id, templateId)))
      .limit(1)
    if (!row) throw KernError.notFound('Checklist template')
    const items = await tx
      .select()
      .from(checklistTemplateItems)
      .where(
        and(
          eq(checklistTemplateItems.workspaceId, workspaceId),
          eq(checklistTemplateItems.templateId, row.id),
        ),
      )
    return ChecklistService.toTemplate(row, items)
  }

  /**
   * A `specific` item names somebody; every other kind names nobody. Refused here rather than
   * stored, because a template that says "a specific person" and names none is a task that will
   * land in the pool without anybody having decided it should.
   */
  private static checkItems(items: ChecklistTemplateInput['items']): void {
    for (const item of items) {
      if (item.assignee === 'specific' && !item.assigneePersonId)
        throw KernError.badRequest(`“${item.title}” is assigned to a specific person but names nobody.`, {
          reason: 'hr.checklist.assignee_missing',
          item: item.title,
        })
      if (item.assignee !== 'specific' && item.assigneePersonId)
        throw KernError.badRequest(`“${item.title}” names a person but is not assigned to a specific one.`, {
          reason: 'hr.checklist.assignee_unexpected',
          item: item.title,
        })
    }
  }

  /** Every named person has to be this workspace's. An id is a claim, and it is checked. */
  private async requirePeople(tx: Tx, workspaceId: string, personIds: string[]): Promise<void> {
    const wanted = [...new Set(personIds)]
    if (!wanted.length) return
    const rows = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, wanted)))
    if (rows.length !== wanted.length) throw KernError.notFound('Person')
  }

  private async writeItems(
    tx: Tx,
    workspaceId: string,
    templateId: string,
    items: ChecklistTemplateInput['items'],
  ): Promise<void> {
    await tx
      .delete(checklistTemplateItems)
      .where(
        and(
          eq(checklistTemplateItems.workspaceId, workspaceId),
          eq(checklistTemplateItems.templateId, templateId),
        ),
      )
    if (!items.length) return
    await tx.insert(checklistTemplateItems).values(
      items.map((item, order) => ({
        id: uuidv7(),
        workspaceId,
        templateId,
        title: item.title,
        description: item.description ?? null,
        assignee: item.assignee,
        assigneePersonId: item.assignee === 'specific' ? (item.assigneePersonId ?? null) : null,
        dueOffsetDays: item.dueOffsetDays,
        order,
      })),
    )
  }

  /** One default per kind: the previous one loses the flag in the same transaction. */
  private async clearDefault(
    tx: Tx,
    workspaceId: string,
    kind: string,
    except: string | null,
  ): Promise<void> {
    const where = [
      eq(checklistTemplates.workspaceId, workspaceId),
      eq(checklistTemplates.kind, kind),
      eq(checklistTemplates.isDefault, true),
    ]
    if (except) where.push(sql`${checklistTemplates.id} <> ${except}`)
    await tx
      .update(checklistTemplates)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(...where))
  }

  async createTemplate(
    tx: Tx,
    workspaceId: string,
    input: ChecklistTemplateInput,
  ): Promise<ChecklistTemplate> {
    ChecklistService.checkItems(input.items)
    await this.requirePeople(
      tx,
      workspaceId,
      input.items.flatMap((i) => (i.assigneePersonId ? [i.assigneePersonId] : [])),
    )
    if (input.isDefault) await this.clearDefault(tx, workspaceId, input.kind, null)
    const [row] = await tx
      .insert(checklistTemplates)
      .values({ id: uuidv7(), workspaceId, name: input.name, kind: input.kind, isDefault: input.isDefault })
      .returning()
    await this.writeItems(tx, workspaceId, row!.id, input.items)
    return this.getTemplate(tx, workspaceId, row!.id)
  }

  async updateTemplate(
    tx: Tx,
    workspaceId: string,
    templateId: string,
    patch: Partial<ChecklistTemplateInput>,
  ): Promise<ChecklistTemplate> {
    const previous = await this.getTemplate(tx, workspaceId, templateId)
    const kind = patch.kind ?? previous.kind
    if (patch.items) {
      ChecklistService.checkItems(patch.items)
      await this.requirePeople(
        tx,
        workspaceId,
        patch.items.flatMap((i) => (i.assigneePersonId ? [i.assigneePersonId] : [])),
      )
    }
    const isDefault = patch.isDefault ?? previous.isDefault
    // An archived template cannot be the default of anything: the index says so, and a request
    // that asks for it is refused with a sentence rather than a 23505.
    if (isDefault && previous.archivedAt)
      throw KernError.conflict(
        'An archived template cannot be the default. Restore it first.',
        'hr.checklist.template_archived',
      )
    if (isDefault) await this.clearDefault(tx, workspaceId, kind, templateId)
    await tx
      .update(checklistTemplates)
      .set({ name: patch.name ?? previous.name, kind, isDefault, updatedAt: new Date() })
      .where(and(eq(checklistTemplates.workspaceId, workspaceId), eq(checklistTemplates.id, templateId)))
    if (patch.items) await this.writeItems(tx, workspaceId, templateId, patch.items)
    return this.getTemplate(tx, workspaceId, templateId)
  }

  /** Archiving takes the default flag with it; nothing auto-starts from a template nobody can see. */
  async archiveTemplate(
    tx: Tx,
    workspaceId: string,
    templateId: string,
    archived: boolean,
  ): Promise<ChecklistTemplate> {
    await this.getTemplate(tx, workspaceId, templateId)
    await tx
      .update(checklistTemplates)
      .set({
        archivedAt: archived ? new Date() : null,
        ...(archived ? { isDefault: false } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(checklistTemplates.workspaceId, workspaceId), eq(checklistTemplates.id, templateId)))
    return this.getTemplate(tx, workspaceId, templateId)
  }

  // ------------------------------------------------------------------------------ checklists

  static toItem(row: ItemRow): ChecklistItem {
    return {
      id: row.id,
      workspaceId: row.workspaceId as ChecklistItem['workspaceId'],
      checklistId: row.checklistId,
      title: row.title,
      description: row.description,
      assigneePersonId: row.assigneePersonId,
      dueOn: row.dueOn ?? null,
      order: row.order,
      doneAt: row.doneAt?.toISOString() ?? null,
      doneBy: row.doneBy,
      note: row.note,
    }
  }

  static toSummary(row: ChecklistRow, done: number, total: number): ChecklistSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId as ChecklistSummary['workspaceId'],
      personId: row.personId,
      templateId: row.templateId,
      name: row.name,
      kind: row.kind as ChecklistKind,
      anchorDate: row.anchorDate,
      status: row.status as ChecklistStatus,
      startedBy: row.startedBy,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      progress: { done, total },
    }
  }

  /**
   * The rows a viewer may see: everything for a manager, and for anybody else the checklists about
   * them or with an item assigned to them. Expressed as a predicate so `list` and `get` cannot
   * disagree about it.
   */
  private static visibleTo(viewer: ChecklistViewer) {
    if (viewer.manage) return sql`true`
    if (!viewer.personId) return sql`false`
    return or(
      eq(checklists.personId, viewer.personId),
      exists(
        sql`(select 1 from ${checklistItems} where ${checklistItems.checklistId} = ${checklists.id} and ${checklistItems.assigneePersonId} = ${viewer.personId})`,
      ),
    )!
  }

  async list(
    tx: Tx,
    workspaceId: string,
    viewer: ChecklistViewer,
    filter: {
      personId?: string
      status?: ChecklistStatus
      kind?: ChecklistKind
      mine: boolean
      limit: number
    },
  ): Promise<ChecklistSummary[]> {
    const where = [eq(checklists.workspaceId, workspaceId), ChecklistService.visibleTo(viewer)]
    if (filter.personId) where.push(eq(checklists.personId, filter.personId))
    if (filter.status) where.push(eq(checklists.status, filter.status))
    if (filter.kind) where.push(eq(checklists.kind, filter.kind))
    // `mine` is the self-service view, and it is the same predicate a non-manager already gets.
    if (filter.mine) where.push(ChecklistService.visibleTo({ personId: viewer.personId, manage: false }))
    const rows = await tx
      .select()
      .from(checklists)
      .where(and(...where))
      .orderBy(desc(checklists.startedAt))
      .limit(filter.limit)
    if (!rows.length) return []
    const counts = await tx
      .select({
        checklistId: checklistItems.checklistId,
        total: sql<number>`count(*)`.mapWith(Number),
        done: sql<number>`count(*) filter (where ${checklistItems.doneAt} is not null)`.mapWith(Number),
      })
      .from(checklistItems)
      .where(
        and(
          eq(checklistItems.workspaceId, workspaceId),
          inArray(
            checklistItems.checklistId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .groupBy(checklistItems.checklistId)
    const byId = new Map(counts.map((c) => [c.checklistId, c]))
    return rows.map((row) =>
      ChecklistService.toSummary(row, byId.get(row.id)?.done ?? 0, byId.get(row.id)?.total ?? 0),
    )
  }

  async get(tx: Tx, workspaceId: string, checklistId: string, viewer: ChecklistViewer): Promise<Checklist> {
    const [row] = await tx
      .select()
      .from(checklists)
      .where(
        and(
          eq(checklists.workspaceId, workspaceId),
          eq(checklists.id, checklistId),
          ChecklistService.visibleTo(viewer),
        ),
      )
      .limit(1)
    if (!row) throw KernError.notFound('Checklist')
    return this.assemble(tx, row)
  }

  private async assemble(tx: Tx, row: ChecklistRow): Promise<Checklist> {
    const items = await tx
      .select()
      .from(checklistItems)
      .where(and(eq(checklistItems.workspaceId, row.workspaceId), eq(checklistItems.checklistId, row.id)))
      .orderBy(asc(checklistItems.order), asc(checklistItems.createdAt))
    const done = items.filter((i) => i.doneAt).length
    return {
      ...ChecklistService.toSummary(row, done, items.length),
      items: items.map(ChecklistService.toItem),
    }
  }

  /**
   * The anchor a checklist counts from: the hire date for onboarding, the leaving date for
   * offboarding, today when the record has neither. Passed explicitly by the hooks that already
   * know the date they just wrote, so a checklist started from `people.offboard` counts from the
   * `on` the request carried rather than from a row read a moment earlier.
   */
  private async defaultAnchor(
    tx: Tx,
    workspaceId: string,
    personId: string,
    kind: ChecklistKind,
  ): Promise<string> {
    const [person] = await tx
      .select({ hiredOn: people.hiredOn, terminatedOn: people.terminatedOn })
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), eq(people.id, personId)))
      .limit(1)
    if (!person) throw KernError.notFound('Person')
    const anchor = kind === 'onboarding' ? person.hiredOn : person.terminatedOn
    return anchor ?? todayIso()
  }

  async start(
    tx: Tx,
    workspaceId: string,
    input: { personId: string; templateId: string; anchorDate?: string; actorUserId: string | null },
  ): Promise<Started> {
    const template = await this.getTemplate(tx, workspaceId, input.templateId)
    if (template.archivedAt)
      throw KernError.conflict(
        'This template is archived. Restore it before starting a checklist from it.',
        'hr.checklist.template_archived',
      )
    const anchor =
      input.anchorDate ?? (await this.defaultAnchor(tx, workspaceId, input.personId, template.kind))
    // The manager as of the anchor — for onboarding the employment in force on day one, for
    // offboarding the one in force on the last day. Both are the manager somebody would expect.
    const resolution = await this.resolve.forPeople(tx, workspaceId, [input.personId], anchor)
    const managerId = resolution.get(input.personId)?.managerPersonId ?? null

    const [row] = await tx
      .insert(checklists)
      .values({
        id: uuidv7(),
        workspaceId,
        personId: input.personId,
        templateId: template.id,
        name: template.name,
        kind: template.kind,
        anchorDate: anchor,
        status: template.items.length ? 'open' : 'done',
        startedBy: input.actorUserId,
        completedAt: template.items.length ? null : new Date(),
      })
      .returning()
    if (template.items.length)
      await tx.insert(checklistItems).values(
        template.items.map((item) => ({
          id: uuidv7(),
          workspaceId,
          checklistId: row!.id,
          title: item.title,
          description: item.description,
          assigneePersonId:
            item.assignee === 'person'
              ? input.personId
              : item.assignee === 'manager'
                ? managerId
                : item.assignee === 'specific'
                  ? item.assigneePersonId
                  : null,
          dueOn: shiftDays(anchor, item.dueOffsetDays),
          order: item.order,
        })),
      )
    const checklist = await this.assemble(tx, row!)
    const assigneePersonIds = [
      ...new Set(
        checklist.items
          .map((i) => i.assigneePersonId)
          .filter((id): id is string => Boolean(id) && id !== input.personId),
      ),
    ]
    return { checklist, assigneePersonIds }
  }

  /**
   * The automatic start: the default template of a kind, for a person who does not already have an
   * open checklist of that kind. Null when there is no default, or when one is already running —
   * moving somebody to `offboarding` and then offboarding them is one leaver, not two lists.
   */
  async startDefault(
    tx: Tx,
    workspaceId: string,
    input: { personId: string; kind: ChecklistKind; anchorDate: string; actorUserId: string | null },
  ): Promise<Started | null> {
    const [template] = await tx
      .select({ id: checklistTemplates.id })
      .from(checklistTemplates)
      .where(
        and(
          eq(checklistTemplates.workspaceId, workspaceId),
          eq(checklistTemplates.kind, input.kind),
          eq(checklistTemplates.isDefault, true),
          isNull(checklistTemplates.archivedAt),
        ),
      )
      .limit(1)
    if (!template) return null
    const [running] = await tx
      .select({ id: checklists.id })
      .from(checklists)
      .where(
        and(
          eq(checklists.workspaceId, workspaceId),
          eq(checklists.personId, input.personId),
          eq(checklists.kind, input.kind),
          eq(checklists.status, 'open'),
        ),
      )
      .limit(1)
    if (running) return null
    return this.start(tx, workspaceId, {
      personId: input.personId,
      templateId: template.id,
      anchorDate: input.anchorDate,
      actorUserId: input.actorUserId,
    })
  }

  private async loadOpen(tx: Tx, workspaceId: string, checklistId: string): Promise<ChecklistRow> {
    const [row] = await tx
      .select()
      .from(checklists)
      .where(and(eq(checklists.workspaceId, workspaceId), eq(checklists.id, checklistId)))
      .for('update')
    if (!row) throw KernError.notFound('Checklist')
    if (row.status === 'cancelled')
      throw KernError.conflict(
        'This checklist was cancelled; nothing on it can change.',
        'hr.checklist.cancelled',
      )
    return row
  }

  async cancel(tx: Tx, workspaceId: string, checklistId: string): Promise<Checklist> {
    const row = await this.loadOpen(tx, workspaceId, checklistId)
    const [updated] = await tx
      .update(checklists)
      .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(checklists.id, row.id))
      .returning()
    return this.assemble(tx, updated!)
  }

  /** The item, its checklist locked, and the refusal a non-assignee earns. */
  private async loadItem(
    tx: Tx,
    workspaceId: string,
    itemId: string,
    viewer: ChecklistViewer,
  ): Promise<{ item: ItemRow; checklist: ChecklistRow }> {
    const [item] = await tx
      .select()
      .from(checklistItems)
      .where(and(eq(checklistItems.workspaceId, workspaceId), eq(checklistItems.id, itemId)))
      .limit(1)
    // 404 for an item the viewer may not see, for the reason `get` gives.
    if (!item) throw KernError.notFound('Checklist item')
    const checklist = await this.loadOpen(tx, workspaceId, item.checklistId)
    const mine = viewer.personId !== null && item.assigneePersonId === viewer.personId
    const about = viewer.personId !== null && checklist.personId === viewer.personId
    if (!viewer.manage && !mine && !about) throw KernError.notFound('Checklist item')
    return { item, checklist }
  }

  /**
   * Tick it. The assignee, or a manager — and the person the list is about may tick an item in
   * HR's pool that is plainly theirs to do ("read the handbook" lands in the pool when nobody
   * thought to assign it), but never somebody else's item.
   */
  async complete(
    tx: Tx,
    workspaceId: string,
    itemId: string,
    note: string | null,
    viewer: ChecklistViewer,
    actorUserId: string | null,
  ): Promise<Ticked> {
    const { item, checklist } = await this.loadItem(tx, workspaceId, itemId, viewer)
    const mine = viewer.personId !== null && item.assigneePersonId === viewer.personId
    const pooled = item.assigneePersonId === null
    if (!viewer.manage && !mine && !pooled) throw KernError.forbidden('hr.checklist.manage')
    if (item.doneAt) throw KernError.conflict('This task is already done.', 'hr.checklist.already_done')
    await tx
      .update(checklistItems)
      .set({ doneAt: new Date(), doneBy: actorUserId, note: note ?? item.note })
      .where(eq(checklistItems.id, item.id))
    return this.settle(tx, checklist)
  }

  /**
   * Untick it — by whoever may tick it, which is the same rule `complete` applies: the assignee, a
   * manager, or the subject on a pooled item. A joiner who ticked "read the handbook" by mistake
   * has to be able to take it back without asking HR.
   */
  async reopen(tx: Tx, workspaceId: string, itemId: string, viewer: ChecklistViewer): Promise<Ticked> {
    const { item, checklist } = await this.loadItem(tx, workspaceId, itemId, viewer)
    const mine = viewer.personId !== null && item.assigneePersonId === viewer.personId
    const pooled = item.assigneePersonId === null
    if (!viewer.manage && !mine && !pooled) throw KernError.forbidden('hr.checklist.manage')
    if (!item.doneAt) throw KernError.conflict('This task is not done yet.', 'hr.checklist.not_done')
    await tx
      .update(checklistItems)
      .set({ doneAt: null, doneBy: null, overdueNotifiedAt: null })
      .where(eq(checklistItems.id, item.id))
    return this.settle(tx, checklist)
  }

  /**
   * The list's own status follows its items: every one done closes it, any one reopened reopens
   * it. Decided after every tick under the row lock `loadOpen` took, so two people ticking the last
   * two items at once cannot each see one open item and leave the list open.
   */
  private async settle(tx: Tx, checklist: ChecklistRow): Promise<Ticked> {
    const [counts] = await tx
      .select({
        total: sql<number>`count(*)`.mapWith(Number),
        open: sql<number>`count(*) filter (where ${checklistItems.doneAt} is null)`.mapWith(Number),
      })
      .from(checklistItems)
      .where(
        and(
          eq(checklistItems.workspaceId, checklist.workspaceId),
          eq(checklistItems.checklistId, checklist.id),
        ),
      )
    const allDone = (counts?.open ?? 0) === 0
    const status: ChecklistStatus = allDone ? 'done' : 'open'
    const completedNow = allDone && checklist.status !== 'done'
    const [updated] = await tx
      .update(checklists)
      .set({
        status,
        completedAt: allDone ? (checklist.completedAt ?? new Date()) : null,
        updatedAt: new Date(),
      })
      .where(eq(checklists.id, checklist.id))
      .returning()
    return { checklist: await this.assemble(tx, updated!), completedNow }
  }

  async assign(
    tx: Tx,
    workspaceId: string,
    itemId: string,
    assigneePersonId: string | null,
  ): Promise<{ checklist: Checklist; notifyPersonId: string | null }> {
    const { item, checklist } = await this.loadItem(tx, workspaceId, itemId, { personId: null, manage: true })
    if (assigneePersonId) await this.requirePeople(tx, workspaceId, [assigneePersonId])
    await tx
      .update(checklistItems)
      .set({ assigneePersonId, overdueNotifiedAt: null })
      .where(eq(checklistItems.id, item.id))
    return {
      checklist: await this.assemble(tx, checklist),
      notifyPersonId:
        assigneePersonId && assigneePersonId !== item.assigneePersonId ? assigneePersonId : null,
    }
  }

  async addItem(
    tx: Tx,
    workspaceId: string,
    checklistId: string,
    input: ChecklistItemInput,
  ): Promise<{ checklist: Checklist; notifyPersonId: string | null }> {
    const checklist = await this.loadOpen(tx, workspaceId, checklistId)
    if (input.assigneePersonId) await this.requirePeople(tx, workspaceId, [input.assigneePersonId])
    const [last] = await tx
      .select({ order: sql<number>`coalesce(max(${checklistItems.order}), -1)`.mapWith(Number) })
      .from(checklistItems)
      .where(and(eq(checklistItems.workspaceId, workspaceId), eq(checklistItems.checklistId, checklistId)))
    await tx.insert(checklistItems).values({
      id: uuidv7(),
      workspaceId,
      checklistId,
      title: input.title,
      description: input.description ?? null,
      assigneePersonId: input.assigneePersonId ?? null,
      dueOn: input.dueOn ?? null,
      order: (last?.order ?? -1) + 1,
    })
    // A finished list that gains a task is open again; `settle` says so.
    const { checklist: assembled } = await this.settle(tx, checklist)
    return { checklist: assembled, notifyPersonId: input.assigneePersonId ?? null }
  }

  async removeItem(tx: Tx, workspaceId: string, itemId: string): Promise<Checklist> {
    const { item, checklist } = await this.loadItem(tx, workspaceId, itemId, { personId: null, manage: true })
    await tx.delete(checklistItems).where(eq(checklistItems.id, item.id))
    return (await this.settle(tx, checklist)).checklist
  }

  // ---------------------------------------------------------------------------- notifications

  /** The accounts behind these people, for whoever has one. */
  private async userIdsFor(workspaceId: string, personIds: string[]): Promise<Map<string, string>> {
    if (!personIds.length) return new Map()
    const rows = await this.kernel.database.withWorkspace(workspaceId, (tx) =>
      tx
        .select({ id: people.id, userId: people.userId })
        .from(people)
        .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, personIds))),
    )
    return new Map(rows.flatMap((r) => (r.userId ? [[r.id, r.userId] as const] : [])))
  }

  /**
   * Tell the people a checklist just gave something to do. After the commit, never inside it, and
   * a failure is logged rather than thrown — by the time this runs the checklist exists, and what
   * a person would lose is a card where a throw would cost them the list.
   *
   * The English here is the fallback the notification centre shows when no renderer knows the
   * type; `data` carries what a localised renderer needs to write the sentence itself.
   */
  async notifyAssigned(
    workspaceId: string,
    checklist: ChecklistSummary,
    personIds: string[],
    actorUserId: string | null,
  ): Promise<void> {
    const users = await this.userIdsFor(workspaceId, personIds)
    for (const [personId, userId] of users) {
      if (userId === actorUserId) continue
      try {
        await this.kernel.call(
          'core.notifications.create',
          {
            userId,
            workspaceId,
            module: MODULE_ID,
            type: 'hr.checklist.item_assigned',
            title: `You have tasks on “${checklist.name}”`,
            body: null,
            object: { module: MODULE_ID, type: 'person', id: checklist.personId },
            url: `/hr/checklists?checklist=${checklist.id}`,
            data: {
              checklistId: checklist.id,
              personId: checklist.personId,
              kind: checklist.kind,
              assigneePersonId: personId,
            },
            groupKey: `hr.checklist:${checklist.id}`,
            actorId: actorUserId,
          },
          this.kernel.system,
        )
      } catch (err) {
        this.kernel.log.warn(
          { module: MODULE_ID, workspaceId, checklistId: checklist.id, err: (err as Error).message },
          'checklist assignment notification not delivered',
        )
      }
    }
  }

  /** The person who started it hears that it finished — unless they are the one who ticked the last box. */
  async notifyCompleted(
    workspaceId: string,
    checklist: ChecklistSummary,
    actorUserId: string | null,
  ): Promise<void> {
    if (!checklist.startedBy || checklist.startedBy === actorUserId) return
    try {
      await this.kernel.call(
        'core.notifications.create',
        {
          userId: checklist.startedBy,
          workspaceId,
          module: MODULE_ID,
          type: 'hr.checklist.completed',
          title: `“${checklist.name}” is complete`,
          body: null,
          object: { module: MODULE_ID, type: 'person', id: checklist.personId },
          url: `/hr/checklists?checklist=${checklist.id}`,
          data: { checklistId: checklist.id, personId: checklist.personId, kind: checklist.kind },
          groupKey: `hr.checklist:${checklist.id}`,
          actorId: actorUserId,
        },
        this.kernel.system,
      )
    } catch (err) {
      this.kernel.log.warn(
        { module: MODULE_ID, workspaceId, checklistId: checklist.id, err: (err as Error).message },
        'checklist completion notification not delivered',
      )
    }
  }
}
