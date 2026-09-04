<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  formatCount,
  IconButton,
  Input,
  type MenuItem,
  navigation,
  SectionLabel,
  Select,
  type SelectOption,
  SettingsPage,
  SettingsSection,
  Skeleton,
  Switch,
  session,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { tick } from 'svelte'
// Straight from the contract rather than through the client barrel, for the reason
// `ApprovalsSettings` gives: the template, item and assignee shapes are only ever assembled here.
import {
  type ChecklistAssignee,
  type ChecklistKind,
  type ChecklistTemplate,
  type ChecklistTemplateItemInput,
  MAX_CHECKLIST_ITEMS,
  MAX_DUE_OFFSET_DAYS,
} from '../../contract/checklists.js'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { hrKeys } from '../query.js'

/**
 * The onboarding and offboarding templates: what a company does around somebody joining or leaving,
 * written once and started for each person.
 *
 * Three facts about the server decide what this page says, and each is said where it matters:
 *
 * **A template is copied when a checklist starts, and never read again.** Editing one changes what
 * the next joiner gets and touches nothing already running — stated at the top of the editor, and
 * again in the archive confirmation, because an admin who suspects archiving might strand somebody's
 * half-done first week simply will not archive.
 *
 * **Only the default starts by itself.** A hire starts the onboarding default and an offboarding
 * starts the other; every other template is started by hand from a person's record. So each group
 * says plainly when it has no default, rather than implying five templates all do something.
 *
 * **A due date is an offset from an anchor**, and the anchor depends on the kind: the first day for
 * onboarding, the last day for offboarding. The contract stores a signed number of days; this screen
 * asks for "before / on / after" and a count, and reads the sentence back — "3 days before the last
 * day" — because nobody types −3 and means it.
 *
 * The permission is `hr.checklist.manage`, which gates every template procedure on the server,
 * `list` included. There is no read-only audience: the settings entry declares the permission, so
 * somebody without it never sees the page.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/** Checked here as well as on the server, because a button that is going to be refused should not be offered. */
const manage = $derived(canHr('checklistManage'))

// ---------------------------------------------------------------- vocabulary

const KINDS: ChecklistKind[] = ['onboarding', 'offboarding']

const kindLabel = (kind: ChecklistKind): string =>
  kind === 'onboarding' ? t('checklist_kind_onboarding') : t('checklist_kind_offboarding')

const ASSIGNEES: ChecklistAssignee[] = ['person', 'manager', 'hr', 'specific']

const assigneeLabel = (who: ChecklistAssignee): string =>
  who === 'person'
    ? t('checklist_who_person')
    : who === 'manager'
      ? t('checklist_who_manager')
      : who === 'hr'
        ? t('checklist_who_hr')
        : t('checklist_who_specific')

const assigneeOptions: SelectOption[] = ASSIGNEES.map((who) => ({ value: who, label: assigneeLabel(who) }))

/** Which side of the anchor a task falls on. The contract's sign, as a word. */
type DueSide = 'before' | 'on' | 'after'

/**
 * "Before the first day", "On the last day" — six strings rather than a phrase with the anchor
 * substituted, because the anchor noun takes a different case after "before" and "on" in German
 * and Turkish, and a template that reads wrong in the language of the person filling it is not
 * localised.
 */
const dueSideLabel = (kind: ChecklistKind, side: DueSide): string =>
  kind === 'onboarding'
    ? side === 'before'
      ? t('checklist_due_before_first')
      : side === 'on'
        ? t('checklist_due_on_first')
        : t('checklist_due_after_first')
    : side === 'before'
      ? t('checklist_due_before_last')
      : side === 'on'
        ? t('checklist_due_on_last')
        : t('checklist_due_after_last')

const dueSideOptions = (kind: ChecklistKind): SelectOption[] =>
  (['before', 'on', 'after'] as DueSide[]).map((side) => ({ value: side, label: dueSideLabel(kind, side) }))

/** The sentence a stored offset reads as: "3 days before the last day", "On the first day". */
function dueSentence(kind: ChecklistKind, offset: number): string {
  if (offset === 0) return dueSideLabel(kind, 'on')
  const count = Math.abs(offset)
  if (kind === 'onboarding')
    return offset < 0
      ? t('checklist_due_days_before_first', { count })
      : t('checklist_due_days_after_first', { count })
  return offset < 0
    ? t('checklist_due_days_before_last', { count })
    : t('checklist_due_days_after_last', { count })
}

// ---------------------------------------------------------------- what is on screen

/**
 * The draft is declared above the queries on purpose: `createQuery` reads its options as it is
 * created, and the directory query's `enabled` asks whether the editor is open. A `let draft`
 * below it is still in its temporal dead zone at that first read, and the whole screen dies on
 * "Cannot access 'draft' before initialization" — at runtime, on first render, which nothing here
 * type-checks. `ApprovalsSettings` learned this the hard way.
 */

/** `key` is for `{#each}` alone: two identical tasks must not share an identity while being edited. */
interface ItemDraft {
  key: string
  title: string
  description: string
  assignee: ChecklistAssignee
  /** Only read when `assignee` is `specific`. */
  personId: string
  dueSide: DueSide
  /** A count, as typed; the sign comes from `dueSide`. Ignored when the side is `on`. */
  dueDays: string
}
interface Draft {
  /** `null` while creating. The two procedures take different inputs, so this decides which. */
  id: string | null
  /** Fixed after creation: the due dates would count from a different day. */
  kind: ChecklistKind
  name: string
  isDefault: boolean
  archived: boolean
  items: ItemDraft[]
}

let draft = $state<Draft | null>(null)
let formError = $state<string | null>(null)
let showArchived = $state(false)

/**
 * Archived rows come with the rest and are hidden here, so one request answers both views. The
 * key is spelt `checklist_template` because that is the entity `router.ts` announces on every
 * write, and the realtime client invalidates by the `[module, entity]` prefix — a key spelt any
 * other way would never be refetched when another administrator saved.
 */
const templatesKey = (ws: string) => ['hr', 'checklist_template', ws] as const

const templatesQuery = createQuery(() => ({
  queryKey: templatesKey(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.checklists.templates.list({ workspaceId, includeArchived: true }),
}))
const allTemplates = $derived((templatesQuery.data ?? []) as ChecklistTemplate[])
const archivedCount = $derived(allTemplates.filter((x) => x.archivedAt !== null).length)

const templatesOf = (kind: ChecklistKind): ChecklistTemplate[] =>
  allTemplates.filter((x) => x.kind === kind && (showArchived || x.archivedAt === null))
const defaultOf = (kind: ChecklistKind): ChecklistTemplate | null =>
  allTemplates.find((x) => x.kind === kind && x.isDefault && x.archivedAt === null) ?? null

/**
 * The directory, for "a specific person". Everybody rather than only the active, because a
 * template saved last year may name somebody who has since left, and a row that cannot say who
 * it names is a row nobody can read. Only while the editor is open: a settings page nobody has
 * opened a dialog on has no reason to pull two hundred people.
 *
 * Its own marker, because this is the one asker that fetches *unfiltered*. `ChecklistsPage`,
 * `StartChecklistDialog` and `ChecklistItems` all ask for `status: ['active', 'onboarding',
 * 'offboarding']`, and a shared key is one cache entry: whichever mounted first would decide what
 * the others were served — this directory losing the departed people it exists to name, or those
 * three pickers offering somebody who has left as the person to hand a task to.
 */
const directoryQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forChecklistsAll: true }),
  enabled: Boolean(workspaceId) && draft !== null,
  queryFn: () => api.people.list({ workspaceId, limit: 200 }),
}))
const directory = $derived(directoryQuery.data?.items ?? [])
const personOptions = $derived<SelectOption[]>(
  directory.filter((p) => p.status === 'active').map((p) => ({ value: p.id, label: p.displayName })),
)

/**
 * The choices for one task: the active people, plus whoever the task already names when they are
 * not among them. Without that an item naming somebody who left would render as an empty select,
 * and saving would quietly hand the task to the first person in the list.
 */
function personOptionsFor(current: string): SelectOption[] {
  if (!current || personOptions.some((o) => o.value === current)) return personOptions
  const named = directory.find((p) => p.id === current)
  return [...personOptions, { value: current, label: named?.displayName ?? t('roster_person_unknown') }]
}

/**
 * One click, one write. `disabled={mutation.isPending}` reaches the button on the next render, and
 * two quick clicks are one render apart — which here means two templates, or one archived twice.
 */
let firing = $state(false)
function once(run: () => void) {
  if (firing) return
  firing = true
  run()
}
const settled = () => {
  firing = false
}

/** A template change moves the checklists page and every person panel, so the module's cache goes whole. */
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: ['hr'] })
}

/**
 * What a refused write says to the person who made it.
 *
 * The transport's `code` and `data.reason` are what is tested, never the sentence. `NOT_FOUND` is
 * the one that happens without anybody doing anything wrong: two administrators in one settings
 * screen, or a task naming somebody erased from the directory since the editor opened. The same
 * shape as `ApprovalsSettings`; do not invent a third.
 */
const refusalMessages: Record<string, string> = {
  'hr.checklist.assignee_missing': 'checklist_refused_assignee_missing',
  'hr.checklist.assignee_unexpected': 'checklist_refused_assignee_unexpected',
  'hr.checklist.template_archived': 'checklist_refused_template_archived',
}

function templateFailure(error: unknown, fallback: string): string {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (failure.code === 'NOT_FOUND') return t('checklist_gone')
  const reason = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason ? refusalMessages[reason] : undefined
  // `t()` answers a key it has no string for with the key itself, so a reason no key covers lands
  // on the server's own sentence rather than on `hr.checklist_refused_…`.
  const translated = key ? t(key) : undefined
  return (translated && translated !== key ? translated : failure.message) || fallback
}

// ---------------------------------------------------------------- the draft

let nextKey = 0
const freshKey = () => `k${nextKey++}`

const newItem = (): ItemDraft => ({
  key: freshKey(),
  title: '',
  description: '',
  assignee: 'hr',
  personId: '',
  dueSide: 'on',
  dueDays: '',
})

/** A stored offset, as the two controls show it. */
function fromOffset(offset: number): Pick<ItemDraft, 'dueSide' | 'dueDays'> {
  if (offset === 0) return { dueSide: 'on', dueDays: '' }
  return { dueSide: offset < 0 ? 'before' : 'after', dueDays: String(Math.abs(offset)) }
}

/** The two controls, as the contract wants them. Only called on a draft `blocked` has passed. */
function toOffset(item: ItemDraft): number {
  if (item.dueSide === 'on') return 0
  const days = Math.trunc(Number(item.dueDays))
  return item.dueSide === 'before' ? -days : days
}

/** Whether the count is a whole number of days the contract accepts. */
const daysValid = (item: ItemDraft): boolean => {
  if (item.dueSide === 'on') return true
  const days = Number(item.dueDays)
  return Number.isInteger(days) && days >= 1 && days <= MAX_DUE_OFFSET_DAYS
}

function openCreate(kind: ChecklistKind) {
  formError = null
  draft = {
    id: null,
    kind,
    name: '',
    // A workspace with no default for this kind almost certainly wants the one it is building to
    // be the one that starts by itself; a second template does nothing until somebody makes it
    // the default, so it does not steal the flag from the one already in use.
    isDefault: defaultOf(kind) === null,
    archived: false,
    items: [newItem()],
  }
}

function openEdit(template: ChecklistTemplate) {
  formError = null
  draft = {
    id: template.id,
    kind: template.kind,
    name: template.name,
    isDefault: template.isDefault,
    archived: template.archivedAt !== null,
    items: template.items.map((item) => ({
      key: freshKey(),
      title: item.title,
      description: item.description ?? '',
      assignee: item.assignee,
      personId: item.assigneePersonId ?? '',
      ...fromOffset(item.dueOffsetDays),
    })),
  }
}

/** The template this draft would take the flag from, if it is not the draft itself. */
const replacedDefault = $derived(
  draft?.isDefault ? ((d) => (d && d.id !== draft?.id ? d : null))(defaultOf(draft.kind)) : null,
)

// ---------------------------------------------------------------- editing the tasks

function addItem() {
  if (!draft || draft.items.length >= MAX_CHECKLIST_ITEMS) return
  draft.items = [...draft.items, newItem()]
}

function removeItem(index: number) {
  if (!draft) return
  draft.items = draft.items.filter((_, i) => i !== index)
}

function moveItem(index: number, by: number) {
  if (!draft) return
  const to = index + by
  if (to < 0 || to >= draft.items.length) return
  const items = [...draft.items]
  const [moved] = items.splice(index, 1)
  if (moved) items.splice(to, 0, moved)
  draft.items = items
}

/**
 * Reorder, and keep the keyboard somewhere.
 *
 * The `{#each}` is keyed, so the pressed button moves with its task and holds focus — right up
 * until the task reaches an end and the button disables itself. The browser blurs a focused
 * element the moment it becomes disabled and hands focus nowhere, so somebody reordering by
 * keyboard would be dropped back to the top of the page on the last press. Focus goes to the arrow
 * pointing the other way, which is the one they can still use.
 */
async function moveFrom(event: Event, index: number, by: number) {
  const pressed = event.currentTarget
  moveItem(index, by)
  await tick()
  if (!(pressed instanceof HTMLButtonElement) || !pressed.disabled) return
  const other = by < 0 ? pressed.nextElementSibling : pressed.previousElementSibling
  if (other instanceof HTMLButtonElement && !other.disabled) other.focus()
}

/** Changing who drops the person with it: a name only means something under `specific`. */
function setAssignee(item: ItemDraft, who: string) {
  item.assignee = who as ChecklistAssignee
  if (item.assignee !== 'specific') item.personId = ''
}

// ---------------------------------------------------------------- validating and saving

/**
 * The first thing that stops this being saved, as a sentence.
 *
 * One message rather than a per-field error set: the Save button states why it is disabled, and a
 * disabled control with no explanation is a defect.
 */
const blocked = $derived.by<string | null>(() => {
  if (!draft) return null
  if (!draft.name.trim()) return t('checklist_needs_name')
  if (draft.items.length === 0) return t('checklist_needs_task')
  if (draft.items.length > MAX_CHECKLIST_ITEMS)
    return t('checklist_too_many', { max: formatCount(MAX_CHECKLIST_ITEMS) })
  for (const [index, item] of draft.items.entries()) {
    const n = formatCount(index + 1)
    if (!item.title.trim()) return t('checklist_needs_title', { n })
    if (item.assignee === 'specific' && !item.personId) return t('checklist_needs_person', { n })
    if (!daysValid(item)) return t('checklist_needs_days', { n, max: formatCount(MAX_DUE_OFFSET_DAYS) })
  }
  return null
})

/** The tasks as the contract wants them: no ids, in order, `order` being the position. */
const toItems = (items: ItemDraft[]): ChecklistTemplateItemInput[] =>
  items.map((item) => ({
    title: item.title.trim(),
    description: item.description.trim() || null,
    assignee: item.assignee,
    assigneePersonId: item.assignee === 'specific' ? item.personId : null,
    dueOffsetDays: toOffset(item),
  }))

const save = createMutation(() => ({
  // `$state.snapshot` because the draft is a state proxy, and a proxy cannot be cloned on its way
  // into the request — the call throws instead of saving.
  mutationFn: (input: Draft) =>
    input.id === null
      ? api.checklists.templates.create({
          workspaceId,
          name: input.name.trim(),
          kind: input.kind,
          isDefault: input.isDefault,
          items: toItems(input.items),
        })
      : api.checklists.templates.update({
          workspaceId,
          templateId: input.id,
          name: input.name.trim(),
          isDefault: input.isDefault,
          items: toItems(input.items),
        }),
  onSuccess: (template, input) => {
    toast.success(input.id === null ? t('checklist_created', { name: template.name }) : t('checklist_saved'))
    draft = null
    formError = null
    refresh()
  },
  onError: (error: unknown) => {
    formError = templateFailure(error, t('checklist_save_error'))
  },
  onSettled: settled,
}))

function submit() {
  if (!draft || blocked || firing) return
  formError = null
  const input = $state.snapshot(draft) as Draft
  once(() => save.mutate(input))
}

// ---------------------------------------------------------------- default, archive, restore

/**
 * Making a template the default is reversible in one click and states its consequence in the
 * toast, so it is not confirmed. Archiving is confirmed, because the thing somebody fears — a
 * checklist already running losing its tasks — is exactly what does not happen, and the dialog is
 * where that gets said.
 */
const setDefault = createMutation(() => ({
  mutationFn: (input: { template: ChecklistTemplate; isDefault: boolean }) =>
    api.checklists.templates.update({
      workspaceId,
      templateId: input.template.id,
      isDefault: input.isDefault,
    }),
  onSuccess: (_template, input) => {
    toast.success(
      input.isDefault
        ? t('checklist_default_toast', { name: input.template.name })
        : t('checklist_default_cleared_toast', { name: input.template.name }),
    )
    refresh()
  },
  onError: (error: unknown) => {
    toast.error(templateFailure(error, t('checklist_action_error')))
  },
  onSettled: settled,
}))

let archivingId = $state<string | null>(null)
let actionError = $state<string | null>(null)
/** The live row, not a snapshot: a name edited in another tab must not be confirmed under the old one. */
const archiving = $derived(allTemplates.find((x) => x.id === archivingId) ?? null)

const setArchived = createMutation(() => ({
  mutationFn: (input: { template: ChecklistTemplate; archived: boolean }) =>
    api.checklists.templates.archive({
      workspaceId,
      templateId: input.template.id,
      archived: input.archived,
    }),
  onSuccess: (_template, input) => {
    toast.success(
      input.archived
        ? t('checklist_archived_toast', { name: input.template.name })
        : t('checklist_restored_toast', { name: input.template.name }),
    )
    archivingId = null
    actionError = null
    refresh()
  },
  onError: (error: unknown) => {
    const message = templateFailure(error, t('checklist_action_error'))
    if (archivingId) actionError = message
    else toast.error(message)
  },
  onSettled: settled,
}))

function templateMenu(template: ChecklistTemplate): MenuItem[] {
  const archived = template.archivedAt !== null
  if (archived)
    return [
      { label: t('common.edit'), icon: 'square-pen', onSelect: () => openEdit(template) },
      {
        label: t('checklist_restore'),
        icon: 'rotate-ccw',
        onSelect: () => once(() => setArchived.mutate({ template, archived: false })),
      },
    ]
  return [
    { label: t('common.edit'), icon: 'square-pen', onSelect: () => openEdit(template) },
    template.isDefault
      ? {
          label: t('checklist_unset_default'),
          icon: 'undo-2',
          onSelect: () => once(() => setDefault.mutate({ template, isDefault: false })),
        }
      : {
          label: t('checklist_make_default'),
          icon: 'star',
          onSelect: () => once(() => setDefault.mutate({ template, isDefault: true })),
        },
    { type: 'separator' },
    {
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      onSelect: () => {
        actionError = null
        archivingId = template.id
      },
    },
  ]
}

/** "Collect the laptop · Revoke access · Exit interview" — the tasks, in the order they run. */
const itemTitles = (template: ChecklistTemplate) => template.items.map((i) => i.title).join(' · ')
</script>

<SettingsPage title={t('settings_checklists')} description={t('checklists_desc')}>
  {#snippet actions()}
    {#if archivedCount > 0}
      <Switch
        size="sm"
        checked={showArchived}
        onCheckedChange={(on) => (showArchived = on)}
        label={t('roster_show_archived')}
      />
    {/if}
  {/snippet}

  {#each KINDS as kind (kind)}
    {@const rows = templatesOf(kind)}
    <SettingsSection
      title={kindLabel(kind)}
      description={kind === 'onboarding' ? t('checklist_onboarding_desc') : t('checklist_offboarding_desc')}
    >
      {#snippet action()}
        {#if manage}
          <Button size="sm" variant="secondary" icon="plus" onclick={() => openCreate(kind)}>
            {t('checklist_new')}
          </Button>
        {/if}
      {/snippet}

      <!--
        Held rows outrank the error. Every write here invalidates all of `['hr']`, so a failed
        background refetch leaves TanStack in `error` with the last good list still in `data` — an
        error branch above this one would blank a working table and take its menus with it.
      -->
      {#if templatesQuery.isLoading || !workspaceId}
        <div class="rows">
          {#each [1, 2] as n (n)}<Skeleton height="48px" />{/each}
        </div>
      {:else if rows.length > 0}
        <div class="table" role="table" aria-label={kindLabel(kind)}>
          <div class="thead" role="row">
            <span role="columnheader">{t('checklist_col_name')}</span>
            <span class="num" role="columnheader">{t('checklist_col_tasks')}</span>
            <span role="columnheader">{t('checklist_col_preview')}</span>
            <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
          </div>
          {#each rows as template (template.id)}
            <div class="trow" class:on={template.isDefault} class:gone={template.archivedAt !== null} role="row">
              <span class="cell what" role="cell">
                <span class="strong">{template.name}</span>
                {#if template.isDefault}
                  <Badge tone="accent">{t('checklist_default')}</Badge>
                {/if}
                {#if template.archivedAt !== null}
                  <Badge tone="grey">{t('checklist_archived')}</Badge>
                {/if}
              </span>
              <span class="cell muted num" role="cell">{formatCount(template.items.length)}</span>
              <span class="cell muted" role="cell">{itemTitles(template)}</span>
              <span class="cell actions" role="cell">
                {#if manage}
                  <DropdownMenu items={templateMenu(template)}>
                    {#snippet trigger(props)}
                      <IconButton
                        icon="ellipsis"
                        label={t('checklist_actions_for', { name: template.name })}
                        size={28}
                        {...props}
                      />
                    {/snippet}
                  </DropdownMenu>
                {/if}
              </span>
            </div>
          {/each}
        </div>

        {#if defaultOf(kind) === null}
          <!-- The truth from `startDefault`: with no default, a hire or an offboarding starts nothing. -->
          <p class="note warn">
            {kind === 'onboarding' ? t('checklist_no_default_onboarding') : t('checklist_no_default_offboarding')}
          </p>
        {/if}
      {:else if templatesQuery.isError}
        <EmptyState icon="triangle-alert" title={t('checklist_error')}>
          {#snippet actions()}
            <Button variant="secondary" onclick={() => void templatesQuery.refetch()}>{t('retry')}</Button>
          {/snippet}
        </EmptyState>
      {:else}
        <EmptyState
          icon="clipboard-list"
          title={kind === 'onboarding' ? t('checklist_none_onboarding') : t('checklist_none_offboarding')}
          description={t('checklist_none_desc')}
        >
          {#snippet actions()}
            {#if manage}<Button icon="plus" onclick={() => openCreate(kind)}>{t('checklist_new')}</Button>{/if}
          {/snippet}
        </EmptyState>
      {/if}
    </SettingsSection>
  {/each}
</SettingsPage>

<!-- ---------------------------------------------------------------- the template editor -->
<Dialog
  open={draft !== null}
  size="lg"
  title={draft?.id ? t('checklist_edit_title') : t('checklist_new')}
  onOpenChange={(o) => {
    if (!o) draft = null
  }}
>
  {#if draft}
    <div class="form">
      <!-- The thing nobody expects: editing this cannot reach a checklist that has already started. -->
      <p class="note">{t('checklist_copied_note')}</p>

      <div class="pair">
        <Field label={t('checklist_name')} required>
          {#snippet children(id)}
            <Input {id} bind:value={draft!.name} maxlength={120} placeholder={t('checklist_name_placeholder')} />
          {/snippet}
        </Field>
        <Field label={t('checklist_kind')} hint={draft.id ? t('checklist_kind_locked') : t('checklist_kind_hint')}>
          {#snippet children(id)}
            <Select
              {id}
              value={draft!.kind}
              disabled={draft!.id !== null}
              onValueChange={(v) => draft && (draft.kind = v as ChecklistKind)}
              options={KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
            />
          {/snippet}
        </Field>
      </div>

      <!-- An archived template cannot hold the flag — the server refuses with a sentence, and the
           same sentence sits under the switch so nobody has to find out by saving. -->
      <Switch
        checked={draft.isDefault}
        disabled={draft.archived}
        onCheckedChange={(v) => draft && (draft.isDefault = v)}
        label={draft.kind === 'onboarding'
          ? t('checklist_default_switch_onboarding')
          : t('checklist_default_switch_offboarding')}
        description={draft.archived
          ? t('checklist_refused_template_archived')
          : draft.kind === 'onboarding'
            ? t('checklist_default_hint_onboarding')
            : t('checklist_default_hint_offboarding')}
      />
      {#if replacedDefault}
        <p class="hint">{t('checklist_default_replaces', { name: replacedDefault.name })}</p>
      {/if}

      <SectionLabel label={t('checklist_tasks')} count={draft.items.length} sub>
        {#snippet trailing()}
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            disabled={draft!.items.length >= MAX_CHECKLIST_ITEMS}
            title={draft!.items.length >= MAX_CHECKLIST_ITEMS
              ? t('checklist_too_many', { max: formatCount(MAX_CHECKLIST_ITEMS) })
              : undefined}
            onclick={addItem}
          >
            {t('checklist_add_task')}
          </Button>
        {/snippet}
      </SectionLabel>

      <div class="items">
        {#each draft.items as item, index (item.key)}
          <div class="item">
            <div class="item-head">
              <span class="item-n">{t('checklist_task_n', { n: formatCount(index + 1) })}</span>
              <span class="grow"></span>
              <IconButton
                icon="chevron-up"
                size={26}
                label={t('checklist_move_up', { n: formatCount(index + 1) })}
                disabled={index === 0}
                onclick={(event) => void moveFrom(event, index, -1)}
              />
              <IconButton
                icon="chevron-down"
                size={26}
                label={t('checklist_move_down', { n: formatCount(index + 1) })}
                disabled={index === draft.items.length - 1}
                onclick={(event) => void moveFrom(event, index, 1)}
              />
              <IconButton
                icon="trash-2"
                size={26}
                label={t('checklist_remove_task', { n: formatCount(index + 1) })}
                onclick={() => removeItem(index)}
              />
            </div>

            <Field label={t('checklist_task_title')} required>
              {#snippet children(id)}
                <Input
                  {id}
                  size="sm"
                  bind:value={item.title}
                  maxlength={200}
                  placeholder={t('checklist_task_title_placeholder')}
                />
              {/snippet}
            </Field>

            <Field label={t('checklist_task_desc')} hint={t('checklist_task_desc_hint')}>
              {#snippet children(id)}
                <Textarea {id} bind:value={item.description} rows={2} maxlength={2000} />
              {/snippet}
            </Field>

            <div class="pair">
              <Field label={t('checklist_who')}>
                {#snippet children(id)}
                  <div class="who">
                    <Select
                      {id}
                      size="sm"
                      value={item.assignee}
                      onValueChange={(v) => setAssignee(item, v)}
                      options={assigneeOptions}
                    />
                    {#if item.assignee === 'specific'}
                      <Select
                        size="sm"
                        value={item.personId}
                        ariaLabel={t('checklist_who_which')}
                        placeholder={directoryQuery.isLoading
                          ? t('common.loading')
                          : personOptions.length === 0
                            ? t('no_people')
                            : t('choose')}
                        onValueChange={(v) => (item.personId = v)}
                        options={personOptionsFor(item.personId)}
                      />
                    {:else if item.assignee === 'manager'}
                      <span class="resolved">{t('checklist_who_manager_hint')}</span>
                    {/if}
                  </div>
                {/snippet}
              </Field>

              <Field label={t('checklist_due')}>
                {#snippet children(id)}
                  <div class="due" class:counted={item.dueSide !== 'on'}>
                    <Select
                      {id}
                      size="sm"
                      value={item.dueSide}
                      onValueChange={(v) => (item.dueSide = v as DueSide)}
                      options={dueSideOptions(draft!.kind)}
                    />
                    {#if item.dueSide !== 'on'}
                      <Input
                        size="sm"
                        type="number"
                        min={1}
                        max={MAX_DUE_OFFSET_DAYS}
                        aria-label={t('checklist_due_days')}
                        bind:value={item.dueDays}
                      />
                    {/if}
                  </div>
                  {#if daysValid(item) && (item.dueSide === 'on' || item.dueDays.trim() !== '')}
                    <!-- The stored number read back as a sentence, so "before, 3" is checked against
                         what it will mean rather than against what it looks like. -->
                    <span class="resolved">{dueSentence(draft!.kind, toOffset(item))}</span>
                  {/if}
                {/snippet}
              </Field>
            </div>
          </div>
        {/each}
      </div>

      {#if formError}
        <p class="err" role="alert">{formError}</p>
      {:else if blocked}
        <p class="hint">{blocked}</p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (draft = null)} disabled={save.isPending}>
      {t('cancel')}
    </Button>
    <Button loading={save.isPending} disabled={!manage || blocked !== null} onclick={submit}>
      {draft?.id ? t('common.save') : t('common.create')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- archive -->
<Dialog
  open={archiving !== null}
  size="sm"
  title={archiving ? t('checklist_archive_title', { name: archiving.name }) : ''}
  onOpenChange={(o) => {
    if (!o) archivingId = null
  }}
>
  {#if archiving}
    <!--
      The sentence this dialog exists for. A checklist copies its template when it starts, so
      archiving cannot take a task away from somebody's first week — and an admin who suspects it
      might will leave a template nobody uses in the list for ever.
    -->
    <p class="body">{t('checklist_archive_body')}</p>
    {#if archiving.isDefault}
      <p class="note warn">
        {archiving.kind === 'onboarding'
          ? t('checklist_archive_default_onboarding')
          : t('checklist_archive_default_offboarding')}
      </p>
    {/if}
    {#if actionError}
      <p class="err" role="alert">{actionError}</p>
    {/if}
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (archivingId = null)} disabled={setArchived.isPending}>
      {t('cancel')}
    </Button>
    <Button
      variant="danger"
      loading={setArchived.isPending}
      onclick={() => {
        if (archiving) once(() => archiving && setArchived.mutate({ template: archiving, archived: true }))
      }}
    >
      {t('common.archive')}
    </Button>
  {/snippet}
</Dialog>

<style>
.rows {
  display: grid;
  gap: 4px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  --hr-tpl-cols: minmax(150px, 1.2fr) 62px minmax(150px, 1.6fr) 32px;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-tpl-cols);
  gap: 10px;
  align-items: center;
  padding-inline: 10px;
  border-inline-start: 2px solid transparent;
}
.thead {
  height: 32px;
  border-block-end: 1px solid var(--kern-border);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.trow {
  min-height: 48px;
  border-block-end: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-md);
}
.trow:hover {
  background: var(--kern-surface-raised);
}
/* The one template that actually starts by itself. A border as well as a tint, so it survives a
   theme where the tint is nearly the surface it sits on. */
.trow.on {
  border-inline-start-color: var(--kern-accent);
  background: var(--kern-surface-active);
}
/* A colour, never opacity: an archived template is still a row somebody reads. */
.trow.gone .strong {
  color: var(--kern-ink-500);
  font-weight: 400;
}
.cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.what {
  display: flex;
  align-items: center;
  gap: 8px;
}
.strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13.5px;
  font-weight: 500;
}
.muted {
  font-size: 13px;
  color: var(--kern-ink-500);
}
.num {
  font-variant-numeric: tabular-nums;
}
.actions {
  display: flex;
  justify-content: flex-end;
  overflow: visible;
}

.form {
  display: grid;
  gap: 14px;
}
.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}

.items {
  display: grid;
  gap: 12px;
}
.item {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md2);
  background: var(--kern-surface);
}
.item-head {
  display: flex;
  align-items: center;
  gap: 4px;
}
.item-n {
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.grow {
  flex: 1;
}

.who,
.due {
  display: grid;
  gap: 6px;
}
/* The side and the count on one line once there is a count: "Before the last day · 3". */
.due.counted {
  grid-template-columns: minmax(0, 1fr) 84px;
}
.resolved {
  display: block;
  margin-block-start: 4px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--kern-ink-500);
}

.note {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--kern-r-md2);
  background: var(--kern-info-tint);
  color: var(--kern-ink-700);
  font-size: 12.5px;
  line-height: 1.5;
}
.note.warn {
  background: var(--kern-warning-tint);
}
.body {
  margin: 0 0 8px;
  font-size: 13.5px;
  line-height: 1.5;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.err {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .table {
    --hr-tpl-cols: minmax(130px, 1fr) 52px 32px;
  }
  /* The task titles go; the count and the badges are what cannot. */
  .thead > :nth-child(3),
  .trow > :nth-child(3) {
    display: none;
  }
  .pair {
    grid-template-columns: 1fr;
  }
}
</style>
