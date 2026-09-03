import { Timestamp, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import { IsoDate } from './models.js'

const ws = { workspaceId: WorkspaceId }

/**
 * Onboarding and offboarding checklists: the tasks a company performs around somebody joining or
 * leaving, as a list people tick rather than a wiki page somebody remembers to read.
 *
 * Three positions hold this file together:
 *
 * - **A template is copied, never referenced.** Starting a checklist writes its own item rows from
 *   the template as it stands *that day*; editing the template afterwards changes what the next
 *   joiner gets and leaves every checklist already running exactly as it was. A running list that
 *   changed under its owners because HR reworded the template is a list nobody trusts, and an
 *   item added to a template halfway through somebody's first week is a task nobody was told about.
 * - **An item is somebody's, or it is HR's.** `assignee` on a template item says who a task falls
 *   to *in the abstract* — the person themselves, their manager, HR, or one named person — and is
 *   resolved to a real person when the checklist starts. An item HR owns has no assignee and is
 *   done by anybody who may manage checklists. Nothing here auto-completes: a task is done when a
 *   person says so.
 * - **A due date is an offset from an anchor.** Onboarding counts from the hire date, offboarding
 *   from the leaving date, both in days, negative allowed — "collect the laptop" is due the day
 *   before somebody's last day. The anchor is a fact about the person, so the same template dates
 *   itself correctly for everybody it is started for.
 */

export const ChecklistKind = z.enum(['onboarding', 'offboarding'])
export type ChecklistKind = z.infer<typeof ChecklistKind>

/**
 * Who a template item falls to, before anybody in particular is known.
 *
 * `hr` is the pool: no assignee, done by anybody holding `hr.checklist.manage`. `manager` resolves
 * through the employment in force on the day the checklist starts; a person with no manager gets
 * the item unassigned rather than the checklist refused, because a first week does not wait on an
 * org chart.
 */
export const ChecklistAssignee = z.enum(['person', 'manager', 'hr', 'specific'])
export type ChecklistAssignee = z.infer<typeof ChecklistAssignee>

/** How many items one template may carry. A checklist longer than this is a project plan. */
export const MAX_CHECKLIST_ITEMS = 100

/** How far either side of the anchor an item may be due, in days. */
export const MAX_DUE_OFFSET_DAYS = 365

export const ChecklistTemplateItem = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  assignee: ChecklistAssignee,
  /** Set only when `assignee` is `specific`. */
  assigneePersonId: z.uuid().nullable(),
  /** Days from the anchor. Zero is the day itself; negative is before it. */
  dueOffsetDays: z.number().int().min(-MAX_DUE_OFFSET_DAYS).max(MAX_DUE_OFFSET_DAYS),
  order: z.number().int(),
})
export type ChecklistTemplateItem = z.infer<typeof ChecklistTemplateItem>

export const ChecklistTemplate = z.object({
  id: z.uuid(),
  ...ws,
  name: z.string().min(1).max(120),
  kind: ChecklistKind,
  /**
   * Started automatically when somebody is hired (onboarding) or offboarded (offboarding).
   *
   * At most one per kind per workspace: `templates.update` with `isDefault: true` clears the flag
   * on the previous default in the same transaction, so there is never a moment with two.
   */
  isDefault: z.boolean(),
  items: z.array(ChecklistTemplateItem),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type ChecklistTemplate = z.infer<typeof ChecklistTemplate>

/**
 * A template item as somebody writes it. No id: the list is replaced whole on every save, in the
 * order given, and `order` is the position in the array rather than a number anybody types.
 */
export const ChecklistTemplateItemInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullish(),
  assignee: ChecklistAssignee,
  assigneePersonId: z.uuid().nullish(),
  dueOffsetDays: z.number().int().min(-MAX_DUE_OFFSET_DAYS).max(MAX_DUE_OFFSET_DAYS).default(0),
})
export type ChecklistTemplateItemInput = z.infer<typeof ChecklistTemplateItemInput>

export const ChecklistTemplateInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: ChecklistKind,
  isDefault: z.boolean().default(false),
  items: z.array(ChecklistTemplateItemInput).max(MAX_CHECKLIST_ITEMS),
})
export type ChecklistTemplateInput = z.infer<typeof ChecklistTemplateInput>

export const ChecklistStatus = z.enum(['open', 'done', 'cancelled'])
export type ChecklistStatus = z.infer<typeof ChecklistStatus>

export const ChecklistItem = z.object({
  id: z.uuid(),
  ...ws,
  checklistId: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  /** Null is HR's pool — see `ChecklistAssignee`. */
  assigneePersonId: z.uuid().nullable(),
  dueOn: IsoDate.nullable(),
  order: z.number().int(),
  doneAt: Timestamp.nullable(),
  /** The account that ticked it, so a subject-access bundle can say who. */
  doneBy: z.uuid().nullable(),
  note: z.string().max(1000).nullable(),
})
export type ChecklistItem = z.infer<typeof ChecklistItem>

export const Checklist = z.object({
  id: z.uuid(),
  ...ws,
  personId: z.uuid(),
  /** Null for a checklist whose template has since been deleted — never happens today; templates archive. */
  templateId: z.uuid().nullable(),
  /** Copied at start, so a renamed template does not rename a list already running. */
  name: z.string(),
  kind: ChecklistKind,
  anchorDate: IsoDate,
  status: ChecklistStatus,
  startedBy: z.uuid().nullable(),
  startedAt: Timestamp,
  completedAt: Timestamp.nullable(),
  cancelledAt: Timestamp.nullable(),
  items: z.array(ChecklistItem),
  /** Done over total, so a list can draw a bar without counting. */
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
})
export type Checklist = z.infer<typeof Checklist>

/** `checklists.list` without the items — a page of headers, each with its progress. */
export const ChecklistSummary = Checklist.omit({ items: true })
export type ChecklistSummary = z.infer<typeof ChecklistSummary>

/** What `items.add` takes for a task that was never on the template. */
export const ChecklistItemInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullish(),
  assigneePersonId: z.uuid().nullish(),
  dueOn: IsoDate.nullish(),
})
export type ChecklistItemInput = z.infer<typeof ChecklistItemInput>
