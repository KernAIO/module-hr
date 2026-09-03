<script lang="ts">
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DropdownMenu,
  Field,
  formatDate,
  Icon,
  IconButton,
  type MenuItem,
  Select,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { Checklist, ChecklistItem } from '../../contract/checklists.js'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { hrKeys, isoDate } from '../query.js'
import { explainChecklistRefusal } from './checklist-refusal.js'
import { dueState, mayReopen, mayTick } from './checklists.js'
import PersonInline from './PersonInline.svelte'

/**
 * The tasks on one checklist, and everything anybody does to them.
 *
 * One component for the page, the person panel and the dashboard widget, because ticking is the
 * whole feature and three copies of "who may tick this" would be three ways to disagree with the
 * server. The list it draws can be a subset — My tasks hands it the reader's items only — but every
 * write goes through the same four mutations and lands on the same cache entries.
 *
 * What a row offers is decided per row from `mayTick` / `mayReopen`: a checkbox for a task the
 * reader may act on, a plain mark for one they may only read. The manager's tools — assign, remove —
 * sit in an overflow menu so an ordinary assignee's row is a checkbox and a title and nothing else.
 */
interface Props {
  checklist: Checklist
  workspaceId: string
  /** The rows to draw; every item when omitted. */
  items?: ChecklistItem[]
  /** Who owns each task. Off where every row is already the reader's. */
  showAssignee?: boolean
  /** A tighter row, for a panel or a card. */
  compact?: boolean
}
const { checklist, workspaceId, items, showAssignee = true, compact = false }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

const rows = $derived(items ?? checklist.items)
const manage = $derived(canHr('checklistManage'))

/**
 * Which employee the reader is. No permission: `people.me` is the caller's own record, and an
 * account with none — an administrator, say — still manages checklists through `manage` alone.
 */
const meQuery = createQuery(() => ({
  queryKey: hrKeys.me(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.people.me({ workspaceId }),
}))
const viewer = $derived({ personId: meQuery.data?.id ?? null, manage })

const today = isoDate()

/**
 * `busy` rather than `mutation.isPending`: the disabled attribute only reaches a control on the next
 * render, so two quick clicks both fire — and on a tick the second one earns "already done". Set in
 * the same tick as the click, per item, so ticking one task does not freeze the others.
 */
let busy = $state<Record<string, boolean>>({})
/** Bumped on a refused tick, so the checkbox that flipped optimistically snaps back. */
let tickVersion = $state(0)

const settle = (updated: Checklist) => {
  queryClient.setQueryData(hrKeys.checklist(workspaceId, updated.id), updated)
  void queryClient.invalidateQueries({ queryKey: ['hr', 'checklist'] })
}
const refused = (error: unknown, fallback: string) => {
  toast.error(explainChecklistRefusal(error, fallback))
  // A refusal is the server saying the list on screen is not the one it has, so re-read it.
  tickVersion += 1
  void queryClient.invalidateQueries({ queryKey: ['hr', 'checklist'] })
}

const complete = createMutation(() => ({
  mutationFn: (vars: { itemId: string; note: string | null }) =>
    api.checklists.items.complete({ workspaceId, itemId: vars.itemId, note: vars.note }),
  onSuccess: (updated) => {
    settle(updated)
    noting = null
    if (updated.status === 'done') toast.success(t('checklist_completed_toast', { name: updated.name }))
  },
  onError: (error) => refused(error, t('checklist_tick_error')),
  onSettled: (_data, _error, vars) => {
    busy[vars.itemId] = false
  },
}))

const reopen = createMutation(() => ({
  mutationFn: (vars: { itemId: string }) => api.checklists.items.reopen({ workspaceId, itemId: vars.itemId }),
  onSuccess: settle,
  onError: (error) => refused(error, t('checklist_tick_error')),
  onSettled: (_data, _error, vars) => {
    busy[vars.itemId] = false
  },
}))

const assign = createMutation(() => ({
  mutationFn: (vars: { itemId: string; assigneePersonId: string | null }) =>
    api.checklists.items.assign({
      workspaceId,
      itemId: vars.itemId,
      assigneePersonId: vars.assigneePersonId,
    }),
  onSuccess: (updated) => {
    settle(updated)
    assigning = null
  },
  onError: (error) => {
    assignError = explainChecklistRefusal(error, t('checklist_assign_error'))
  },
  onSettled: (_data, _error, vars) => {
    busy[vars.itemId] = false
  },
}))

const remove = createMutation(() => ({
  mutationFn: (vars: { itemId: string }) => api.checklists.items.remove({ workspaceId, itemId: vars.itemId }),
  onSuccess: (updated) => {
    settle(updated)
    removing = null
  },
  onError: (error) => {
    removeError = explainChecklistRefusal(error, t('checklist_remove_error'))
  },
  onSettled: (_data, _error, vars) => {
    busy[vars.itemId] = false
  },
}))

function tick(item: ChecklistItem, note: string | null = null) {
  if (busy[item.id]) return
  busy[item.id] = true
  complete.mutate({ itemId: item.id, note })
}
function untick(item: ChecklistItem) {
  if (busy[item.id]) return
  busy[item.id] = true
  reopen.mutate({ itemId: item.id })
}

// ---------------------------------------------------------------- complete with a note

let noting = $state<ChecklistItem | null>(null)
let note = $state('')
const openNote = (item: ChecklistItem) => {
  note = ''
  noting = item
}
const confirmNote = () => {
  if (!noting) return
  tick(noting, note.trim() || null)
}

// ---------------------------------------------------------------- assign

let assigning = $state<ChecklistItem | null>(null)
let assignee = $state('')
let assignError = $state<string | null>(null)

/**
 * The people a task can be handed to, fetched only once a manager opens the dialog: the list is
 * drawn for every reader and almost none of them will ever assign anything.
 */
const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forChecklists: true }),
  enabled: Boolean(workspaceId) && assigning !== null,
  queryFn: () =>
    api.people.list({ workspaceId, limit: 200, status: ['active', 'onboarding', 'offboarding'] }),
}))
const people = $derived(peopleQuery.data?.items ?? [])

const openAssign = (item: ChecklistItem) => {
  assignee = item.assigneePersonId ?? ''
  assignError = null
  assigning = item
}
const confirmAssign = () => {
  if (!assigning || busy[assigning.id]) return
  busy[assigning.id] = true
  assign.mutate({ itemId: assigning.id, assigneePersonId: assignee || null })
}

// ---------------------------------------------------------------- remove

let removing = $state<ChecklistItem | null>(null)
let removeError = $state<string | null>(null)
const confirmRemove = () => {
  if (!removing || busy[removing.id]) return
  busy[removing.id] = true
  remove.mutate({ itemId: removing.id })
}

/** The overflow menu for a row, or nothing when there is nothing to put in it. */
function menuFor(item: ChecklistItem): MenuItem[] {
  const entries: MenuItem[] = []
  if (!item.doneAt && mayTick(item, checklist, viewer))
    entries.push({ label: t('checklist_note_action'), icon: 'sticky-note', onSelect: () => openNote(item) })
  if (manage && checklist.status !== 'cancelled') {
    entries.push({ label: t('checklist_assign'), icon: 'user-plus', onSelect: () => openAssign(item) })
    entries.push({ type: 'separator' })
    entries.push({
      label: t('checklist_remove'),
      icon: 'trash',
      danger: true,
      onSelect: () => {
        removeError = null
        removing = item
      },
    })
  }
  return entries
}

/**
 * A calendar date, read in the reader's language. The `T00:00:00` is not decoration:
 * `new Date('2026-03-01')` is parsed as UTC midnight, so west of Greenwich the row would print the
 * day before the one the task is due.
 */
const dateLabel = (iso: string) => formatDate(`${iso}T00:00:00`)
</script>

{#if rows.length === 0}
  <p class="none">{t('checklist_items_none')}</p>
{:else}
  <ul class="items" class:compact>
    {#each rows as item (item.id)}
      {@const done = Boolean(item.doneAt)}
      {@const due = done ? 'none' : dueState(item.dueOn, today)}
      {@const actionable = done ? mayReopen(item, checklist, viewer) : mayTick(item, checklist, viewer)}
      {@const menu = menuFor(item)}
      <li class:done class:overdue={due === 'overdue'} aria-busy={busy[item.id] ? 'true' : undefined}>
        <span class="tick">
          {#if actionable}
            <!--
              Keyed on the version, so a tick the server refused snaps the box back: the control
              flips optimistically the moment it is pressed, and nothing else would unflip it.
            -->
            {#key tickVersion}
              <Checkbox
                checked={done}
                ariaLabel={done ? t('checklist_untick', { title: item.title }) : t('checklist_tick', { title: item.title })}
                onCheckedChange={(on) => (on ? tick(item) : untick(item))}
              />
            {/key}
          {:else}
            <!-- Somebody else's task: shown, never offered. -->
            <span class="mark" aria-hidden="true">
              <Icon name={done ? 'circle-check' : 'circle'} size={16} strokeWidth={1.6} />
            </span>
          {/if}
        </span>
        <span class="body">
          <span class="title">{item.title}</span>
          {#if item.description && !compact}<span class="desc">{item.description}</span>{/if}
          <span class="meta">
            {#if showAssignee}
              {#if item.assigneePersonId}
                <PersonInline id={item.assigneePersonId} {workspaceId} />
              {:else}
                <span class="pool"><Icon name="users" size={12} strokeWidth={1.8} />{t('checklist_pool')}</span>
              {/if}
            {/if}
            {#if done && item.doneAt}
              <span>{t('checklist_done_at', { date: formatDate(item.doneAt) })}</span>
            {:else if due === 'overdue' && item.dueOn}
              <Badge tone="danger">{t('checklist_overdue')}</Badge>
              <span>{dateLabel(item.dueOn)}</span>
            {:else if due === 'today'}
              <Badge tone="upcoming">{t('checklist_due_today')}</Badge>
            {:else if item.dueOn}
              <span>{t('checklist_due_on', { date: dateLabel(item.dueOn) })}</span>
            {/if}
            {#if item.note}<span class="note">{item.note}</span>{/if}
          </span>
        </span>
        {#if menu.length > 0}
          <span class="menu">
            <DropdownMenu items={menu}>
              {#snippet trigger(props)}
                <IconButton icon="ellipsis" label={t('checklist_item_actions', { title: item.title })} size={26} {...props} />
              {/snippet}
            </DropdownMenu>
          </span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<!-- Portalled, so each is a dialog over the page rather than something inside a 300px card. -->
<Dialog
  open={noting !== null}
  size="sm"
  title={t('checklist_note_title', { title: noting?.title ?? '' })}
  description={t('checklist_note_hint')}
  onOpenChange={(o) => {
    if (!o) noting = null
  }}
>
  <Field label={t('checklist_note')} id="hr-checklist-note" hint={t('common.optional')}>
    {#snippet children(id)}
      <Textarea {id} bind:value={note} rows={3} maxlength={1000} />
    {/snippet}
  </Field>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (noting = null)}>{t('common.cancel')}</Button>
    <Button onclick={confirmNote} loading={complete.isPending}>{t('checklist_complete')}</Button>
  {/snippet}
</Dialog>

<Dialog
  open={assigning !== null}
  size="sm"
  title={t('checklist_assign_title', { title: assigning?.title ?? '' })}
  onOpenChange={(o) => {
    if (!o) assigning = null
  }}
>
  <Field label={t('checklist_assign_to')} id="hr-checklist-assignee" error={assignError}>
    {#snippet children(id)}
      <Select
        {id}
        bind:value={assignee}
        disabled={peopleQuery.isLoading}
        options={[
          { value: '', label: t('checklist_assign_pool') },
          ...people.map((p) => ({ value: p.id, label: p.displayName })),
        ]}
      />
    {/snippet}
  </Field>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (assigning = null)}>{t('common.cancel')}</Button>
    <Button onclick={confirmAssign} loading={assign.isPending}>{t('checklist_assign_confirm')}</Button>
  {/snippet}
</Dialog>

<Dialog
  open={removing !== null}
  size="sm"
  title={t('checklist_remove_title', { title: removing?.title ?? '' })}
  description={t('checklist_remove_body')}
  onOpenChange={(o) => {
    if (!o) removing = null
  }}
>
  {#if removeError}<p class="error" role="alert">{removeError}</p>{/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (removing = null)}>{t('common.cancel')}</Button>
    <Button variant="danger" onclick={confirmRemove} loading={remove.isPending}>{t('checklist_remove')}</Button>
  {/snippet}
</Dialog>

<style>
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--kern-r-md);
  border: 1px solid var(--kern-border-hairline);
  background: var(--kern-surface);
}
.compact li {
  padding: 6px 8px;
  gap: 8px;
}
li:hover {
  background: var(--kern-surface-raised);
}
/* Marked with a border rather than a tint alone, so it survives a theme where the tint is nearly
   the surface it sits on. */
li.overdue {
  border-inline-start: 2px solid var(--kern-danger);
}
.tick {
  display: flex;
  align-items: center;
  min-height: 22px;
}
.mark {
  display: inline-flex;
  color: var(--kern-ink-350);
}
li.done .mark {
  color: var(--kern-success-chip);
}
.body {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.title {
  font-size: 13.5px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
/* A colour, not opacity: a struck title still has to be readable. */
li.done .title {
  color: var(--kern-ink-500);
  text-decoration: line-through;
  text-decoration-color: var(--kern-ink-350);
}
.desc {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--kern-ink-500);
  white-space: pre-line;
}
.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.pool {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.note {
  font-style: italic;
}
.menu {
  display: flex;
  align-items: center;
  min-height: 22px;
}
.none {
  margin: 8px 0;
  font-size: 12.5px;
  color: var(--kern-ink-500);
}
.error {
  margin: 0;
  font-size: 13px;
  color: var(--kern-danger);
}
</style>
