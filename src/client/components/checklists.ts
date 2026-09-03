import type { Checklist, ChecklistItem } from '../../contract/checklists.js'

/**
 * The rules a checklist screen has to know without asking the server, kept in one place so the
 * page, the panel section and the widget cannot disagree about who may tick what.
 *
 * Imports nothing from `@kernhq/ui`, so it can be unit-tested — a `.ts` module that reaches `t()`
 * pulls in Svelte components this package's test setup cannot transform.
 */

/** Who is asking, as far as a checklist cares — the same shape `ChecklistService` reads. */
export interface ChecklistViewer {
  personId: string | null
  manage: boolean
}

/**
 * Whether the viewer may tick this item, mirroring `ChecklistService.complete`: the assignee, or
 * anybody who manages checklists — and the person the list is about may tick an item in HR's pool,
 * because "read the handbook" lands there when nobody thought to assign it. Never somebody else's.
 *
 * The server decides again regardless; this is about not drawing a checkbox that can only refuse.
 */
export function mayTick(
  item: ChecklistItem,
  checklist: Pick<Checklist, 'personId' | 'status'>,
  viewer: ChecklistViewer,
): boolean {
  if (checklist.status === 'cancelled') return false
  if (viewer.manage) return true
  if (!viewer.personId) return false
  if (item.assigneePersonId === viewer.personId) return true
  return item.assigneePersonId === null && checklist.personId === viewer.personId
}

/** Reopening is narrower than ticking: the assignee or a manager, and never the pool. */
export function mayReopen(
  item: ChecklistItem,
  checklist: Pick<Checklist, 'status'>,
  viewer: ChecklistViewer,
): boolean {
  if (checklist.status === 'cancelled') return false
  if (viewer.manage) return true
  return viewer.personId !== null && item.assigneePersonId === viewer.personId
}

export type DueState = 'overdue' | 'today' | 'later' | 'none'

/** Where a due date stands against today — both `YYYY-MM-DD`, so the comparison is lexical. */
export function dueState(dueOn: string | null, today: string): DueState {
  if (!dueOn) return 'none'
  if (dueOn < today) return 'overdue'
  if (dueOn === today) return 'today'
  return 'later'
}

/**
 * The open items the viewer has to do, across several lists, soonest due first.
 *
 * "Has to do" is the same predicate the server's `mine` filter answers with lists: assigned to the
 * viewer, or in the pool on a list about the viewer. A manager's own tasks are still only these —
 * the widget is a to-do list, not the whole company's.
 */
export function myOpenItems(
  checklists: Checklist[],
  personId: string | null,
): Array<{ item: ChecklistItem; checklist: Checklist }> {
  if (!personId) return []
  const out: Array<{ item: ChecklistItem; checklist: Checklist }> = []
  for (const checklist of checklists) {
    if (checklist.status !== 'open') continue
    for (const item of checklist.items) {
      if (item.doneAt) continue
      const mine =
        item.assigneePersonId === personId ||
        (item.assigneePersonId === null && checklist.personId === personId)
      if (mine) out.push({ item, checklist })
    }
  }
  return out.sort(compareDue)
}

/** Dated before undated, earlier before later, then the list's own order. */
export function compareDue(
  a: { item: ChecklistItem; checklist: Checklist },
  b: { item: ChecklistItem; checklist: Checklist },
): number {
  if (a.item.dueOn && b.item.dueOn && a.item.dueOn !== b.item.dueOn)
    return a.item.dueOn < b.item.dueOn ? -1 : 1
  if (a.item.dueOn && !b.item.dueOn) return -1
  if (!a.item.dueOn && b.item.dueOn) return 1
  if (a.checklist.id !== b.checklist.id) return a.checklist.startedAt < b.checklist.startedAt ? -1 : 1
  return a.item.order - b.item.order
}

/**
 * The refusals this module has its own sentence for, keyed by the `reason` the router sends beside
 * the refusal — never by the sentence, because a list of sentences is a list somebody has to keep in
 * sync and the day it drifts the reader is told nothing.
 *
 * Every one is a `KernError.conflict`, whose reason `kernErrorToORPC` serialises as `data.reason`.
 */
export const CHECKLIST_REFUSAL_KEYS: Record<string, string> = {
  'hr.checklist.cancelled': 'checklist_refused_cancelled',
  'hr.checklist.already_done': 'checklist_refused_already_done',
  'hr.checklist.not_done': 'checklist_refused_not_done',
  // The settings screen has its own sentence for this reason, about the default flag; on this
  // side the template was archived between the picker being drawn and the click.
  'hr.checklist.template_archived': 'checklist_refused_start_archived',
}

/**
 * The message key for a refusal, or the router's own sentence when it carries one this module has
 * no key for, or null for anything else — machine text in English, which no toast should repeat.
 */
export function checklistRefusal(error: unknown): { key: string } | { sentence: string } | null {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (failure.code !== 'CONFLICT' && failure.code !== 'BAD_REQUEST') return null
  const reason = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason ? CHECKLIST_REFUSAL_KEYS[reason] : undefined
  if (key) return { key }
  return failure.message ? { sentence: failure.message } : null
}
