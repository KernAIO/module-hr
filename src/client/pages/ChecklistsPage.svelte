<script lang="ts">
import {
  Badge,
  type BadgeTone,
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  formatCount,
  formatDate,
  IconButton,
  Input,
  navigation,
  Page,
  PageHeader,
  ProgressBar,
  RightPanel,
  SectionLabel,
  SegmentedControl,
  Select,
  Skeleton,
  session,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { Checklist, ChecklistKind, ChecklistStatus } from '../../contract/checklists.js'
import { getHrApi } from '../api-instance.js'
import ChecklistItems from '../components/ChecklistItems.svelte'
import { explainChecklistRefusal } from '../components/checklist-refusal.js'
import { myOpenItems } from '../components/checklists.js'
import PersonInline from '../components/PersonInline.svelte'
import StartChecklistDialog from '../components/StartChecklistDialog.svelte'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { hrKeys } from '../query.js'

/**
 * Onboarding and offboarding checklists: what I have to do, and — for whoever manages them —
 * every list that is running.
 *
 * Two tabs because the two readers want opposite things. A manager wants the company's lists with
 * their progress, filtered by status and kind; everybody else wants the three tasks with their name
 * on them and nothing about anybody else. The second is the whole page for a reader without
 * `hr.checklist.manage`, so the tab control is not drawn for them at all.
 *
 * One list opens in a docked panel, addressed by `?checklist=<id>` — the URL a notification carries,
 * so "You have tasks on Onboarding" lands on the list rather than on a page the reader then has to
 * search. The panel is independent of the tab: a colleague following that link is not a manager and
 * still gets the list, because the server's `get` answers for anybody with an item on it.
 *
 * Every procedure under `checklists.*` except the template ones is reachable here; templates are
 * workspace configuration and live under Settings › Checklists.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const manage = $derived(canHr('checklistManage'))

let tab = $state('mine')
const showAll = $derived(manage && tab === 'all')

/** A uuid or nothing: a hand-edited link must not become a request the server refuses in red. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const selectedId = $derived.by(() => {
  const value = navigation.search.checklist
  return value && UUID.test(value) ? value : null
})

/** `?checklist=` written or cleared in place: opening a list is not a place the back button returns to. */
function select(checklistId: string | null) {
  const params = new URLSearchParams(navigation.search)
  if (checklistId) params.set('checklist', checklistId)
  else params.delete('checklist')
  const query = params.toString()
  navigation.go(`/${workspaceSlug}/hr/checklists${query ? `?${query}` : ''}`, {
    replaceState: true,
    keepFocus: true,
    noScroll: true,
  })
}
const hrefFor = (checklistId: string) =>
  `/${workspaceSlug}/hr/checklists?checklist=${encodeURIComponent(checklistId)}`

const meQuery = createQuery(() => ({
  queryKey: hrKeys.me(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.people.me({ workspaceId }),
}))
const myPersonId = $derived(meQuery.data?.id ?? null)

// ---------------------------------------------------------------- my tasks

/**
 * The open lists with something for me, items included.
 *
 * `list` answers headers only, so each is followed by a `get`; that is one round trip per list,
 * bounded by how many lists a person can be on at once, which is a handful. One query rather than
 * a list query and N detail queries, so the tab has one loading state and one error.
 */
const mineQuery = createQuery(() => ({
  queryKey: hrKeys.myChecklistTasks(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: async () => {
    const heads = await api.checklists.list({ workspaceId, mine: true, status: 'open', limit: 100 })
    return Promise.all(heads.map((head) => api.checklists.get({ workspaceId, checklistId: head.id })))
  },
}))
const myTasks = $derived(myOpenItems(mineQuery.data ?? [], myPersonId))

/** Grouped by list, in the order the soonest task on each puts them. */
const myGroups = $derived.by(() => {
  const groups = new Map<string, { checklist: Checklist; items: Checklist['items'] }>()
  for (const { item, checklist } of myTasks) {
    const group = groups.get(checklist.id) ?? { checklist, items: [] }
    group.items.push(item)
    groups.set(checklist.id, group)
  }
  return [...groups.values()]
})

// ---------------------------------------------------------------- all checklists

let status = $state<'' | ChecklistStatus>('open')
let kind = $state<'' | ChecklistKind>('')

const allQuery = createQuery(() => ({
  queryKey: hrKeys.checklists(workspaceId, { status: status || 'all', kind: kind || 'all' }),
  enabled: showAll && Boolean(workspaceId),
  queryFn: () =>
    api.checklists.list({
      workspaceId,
      status: status || undefined,
      kind: kind || undefined,
      limit: 200,
    }),
}))
const all = $derived(allQuery.data ?? [])
const filtered = $derived(status !== '' || kind !== '')

// ---------------------------------------------------------------- the open list

const detailQuery = createQuery(() => ({
  queryKey: hrKeys.checklist(workspaceId, selectedId ?? ''),
  enabled: Boolean(workspaceId && selectedId),
  queryFn: () => api.checklists.get({ workspaceId, checklistId: selectedId! }),
}))
const detail = $derived(detailQuery.data)

let starting = $state(false)

// ---- add a task
let adding = $state(false)
let newTitle = $state('')
let newDescription = $state('')
let newAssignee = $state('')
let newDueOn = $state('')
let addError = $state<string | null>(null)

const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forChecklists: true }),
  enabled: Boolean(workspaceId) && manage && adding,
  queryFn: () =>
    api.people.list({ workspaceId, limit: 200, status: ['active', 'onboarding', 'offboarding'] }),
}))
const people = $derived(peopleQuery.data?.items ?? [])

const openAdd = () => {
  newTitle = ''
  newDescription = ''
  newAssignee = ''
  newDueOn = ''
  addError = null
  adding = true
}

/** Set in the same tick as the click; `isPending` reaches the button one render too late. */
let submittingAdd = $state(false)
const add = createMutation(() => ({
  mutationFn: () =>
    api.checklists.items.add({
      workspaceId,
      checklistId: selectedId!,
      title: newTitle.trim(),
      description: newDescription.trim() || null,
      assigneePersonId: newAssignee || null,
      dueOn: newDueOn || null,
    }),
  onSuccess: (updated) => {
    queryClient.setQueryData(hrKeys.checklist(workspaceId, updated.id), updated)
    void queryClient.invalidateQueries({ queryKey: ['hr', 'checklist'] })
    adding = false
  },
  onError: (error) => {
    addError = explainChecklistRefusal(error, t('checklist_add_error'))
  },
  onSettled: () => {
    submittingAdd = false
  },
}))
const submitAdd = () => {
  if (!selectedId || !newTitle.trim() || submittingAdd) return
  submittingAdd = true
  add.mutate()
}

// ---- cancel a list
let cancelling = $state<{ id: string; name: string } | null>(null)
let cancelError = $state<string | null>(null)
let submittingCancel = $state(false)
const cancel = createMutation(() => ({
  mutationFn: (checklistId: string) => api.checklists.cancel({ workspaceId, checklistId }),
  onSuccess: (updated) => {
    queryClient.setQueryData(hrKeys.checklist(workspaceId, updated.id), updated)
    void queryClient.invalidateQueries({ queryKey: ['hr', 'checklist'] })
    toast.success(t('checklist_cancelled_toast', { name: updated.name }))
    cancelling = null
  },
  onError: (error) => {
    cancelError = explainChecklistRefusal(error, t('checklist_cancel_error'))
    void queryClient.invalidateQueries({ queryKey: ['hr', 'checklist'] })
  },
  onSettled: () => {
    submittingCancel = false
  },
}))
const askCancel = (row: { id: string; name: string }) => {
  cancelError = null
  cancelling = row
}
const confirmCancel = () => {
  if (!cancelling || submittingCancel) return
  submittingCancel = true
  cancel.mutate(cancelling.id)
}

// ---------------------------------------------------------------- words

const STATUS_TONES: Record<string, BadgeTone> = { open: 'upcoming', done: 'success', cancelled: 'grey' }
const statusLabel = (value: string) =>
  value === 'open'
    ? t('checklist_status_open')
    : value === 'done'
      ? t('checklist_status_done')
      : t('checklist_status_cancelled')
const kindLabel = (value: string) =>
  value === 'onboarding' ? t('checklist_kind_onboarding') : t('checklist_kind_offboarding')
const progressLabel = (progress: { done: number; total: number }) =>
  t('checklist_progress', { done: String(progress.done), total: String(progress.total) })
/** `T00:00:00`, so a calendar date is not read as UTC midnight and printed a day early. */
const dateLabel = (iso: string) => formatDate(`${iso}T00:00:00`)
</script>

<PageHeader
  crumbs={[{ label: workspace?.name ?? '' }, { label: t('checklists_title') }]}
  title={t('checklists_title')}
>
  {#snippet actions()}
    {#if manage}
      <Button size="sm" icon="plus" onclick={() => (starting = true)}>{t('checklist_start')}</Button>
    {/if}
  {/snippet}
</PageHeader>

<Page>
  {#if manage}
    <div class="filters">
      <SegmentedControl
        size="sm"
        label={t('checklists_title')}
        bind:value={tab}
        items={[
          { value: 'mine', label: t('checklist_tab_mine') },
          { value: 'all', label: t('checklist_tab_all') },
        ]}
      />
      {#if showAll}
        <span class="spacer"></span>
        <Select
          size="sm"
          bind:value={status}
          ariaLabel={t('checklist_filter_status')}
          options={[
            { value: '', label: t('checklist_filter_all_statuses') },
            { value: 'open', label: t('checklist_status_open') },
            { value: 'done', label: t('checklist_status_done') },
            { value: 'cancelled', label: t('checklist_status_cancelled') },
          ]}
        />
        <Select
          size="sm"
          bind:value={kind}
          ariaLabel={t('checklist_filter_kind')}
          options={[
            { value: '', label: t('checklist_filter_all_kinds') },
            { value: 'onboarding', label: t('checklist_kind_onboarding') },
            { value: 'offboarding', label: t('checklist_kind_offboarding') },
          ]}
        />
      {/if}
    </div>
  {/if}

  {#if showAll}
    <SectionLabel label={t('checklist_tab_all')} count={formatCount(all.length, 999)} />
    <!-- Held rows outrank the error: every tick invalidates the whole entity, and a failed
         background refetch must not blank a table that is on screen and correct. -->
    {#if allQuery.isLoading}
      <div class="rows">
        {#each [1, 2, 3] as n (n)}<Skeleton height="56px" />{/each}
      </div>
    {:else if all.length > 0}
      <div class="table" role="table" aria-label={t('checklist_tab_all')}>
        <div class="thead" role="row">
          <span role="columnheader">{t('checklist_person')}</span>
          <span role="columnheader">{t('checklists_col_name')}</span>
          <span role="columnheader">{t('checklist_col_progress')}</span>
          <span role="columnheader">{t('checklist_anchor')}</span>
          <span role="columnheader">{t('status')}</span>
          <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
        </div>
        {#each all as row (row.id)}
          <div class="trow" class:selected={row.id === selectedId} role="row">
            <span class="cell" role="cell"><PersonInline id={row.personId} {workspaceId} /></span>
            <span class="cell what" role="cell">
              <a class="name" href={hrefFor(row.id)}>{row.name}</a>
              <Badge tone="grey">{kindLabel(row.kind)}</Badge>
            </span>
            <span class="cell progress" role="cell">
              <ProgressBar
                value={row.progress.done}
                max={row.progress.total || 1}
                tone={row.status === 'done' ? 'success' : 'accent'}
                label={progressLabel(row.progress)}
              />
              <span class="muted num">{progressLabel(row.progress)}</span>
            </span>
            <span class="cell muted" role="cell">{dateLabel(row.anchorDate)}</span>
            <span class="cell" role="cell">
              <Badge tone={STATUS_TONES[row.status] ?? 'grey'}>{statusLabel(row.status)}</Badge>
            </span>
            <span class="cell actions" role="cell">
              <DropdownMenu
                items={[
                  { label: t('checklist_view'), icon: 'panel-right', onSelect: () => select(row.id) },
                  ...(row.status !== 'cancelled'
                    ? [
                        { type: 'separator' as const },
                        {
                          label: t('checklist_cancel'),
                          icon: 'circle-x',
                          danger: true,
                          onSelect: () => askCancel(row),
                        },
                      ]
                    : []),
                ]}
              >
                {#snippet trigger(props)}
                  <IconButton icon="ellipsis" label={t('checklist_row_actions', { name: row.name })} size={26} {...props} />
                {/snippet}
              </DropdownMenu>
            </span>
          </div>
        {/each}
      </div>
    {:else if allQuery.isError}
      <EmptyState icon="triangle-alert" title={t('checklists_error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void allQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if filtered}
      <EmptyState icon="list-checks" title={t('checklist_none_filtered')}>
        {#snippet actions()}
          <Button
            variant="secondary"
            onclick={() => {
              status = ''
              kind = ''
            }}
          >
            {t('checklist_clear_filters')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <EmptyState icon="list-checks" title={t('checklists_none')} description={t('checklists_none_desc')}>
        {#snippet actions()}
          <Button icon="plus" onclick={() => (starting = true)}>{t('checklist_start')}</Button>
        {/snippet}
      </EmptyState>
    {/if}
  {:else}
    <SectionLabel label={t('checklist_tab_mine')} count={formatCount(myTasks.length, 999)} />
    {#if mineQuery.isLoading || (mineQuery.isSuccess && meQuery.isLoading)}
      <div class="rows">
        {#each [1, 2, 3] as n (n)}<Skeleton height="48px" />{/each}
      </div>
    {:else if myGroups.length > 0}
      <div class="groups">
        {#each myGroups as group (group.checklist.id)}
          <section class="group">
            <header class="ghead">
              <span class="gtitle">
                <a class="name" href={hrefFor(group.checklist.id)}>{group.checklist.name}</a>
                <Badge tone="grey">{kindLabel(group.checklist.kind)}</Badge>
              </span>
              <span class="gfor"><PersonInline id={group.checklist.personId} {workspaceId} /></span>
            </header>
            <ChecklistItems checklist={group.checklist} items={group.items} {workspaceId} showAssignee={false} />
          </section>
        {/each}
      </div>
    {:else if mineQuery.isError}
      <EmptyState icon="triangle-alert" title={t('checklist_tasks_error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void mineQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else}
      <EmptyState icon="check-check" title={t('checklist_tasks_none')} description={t('checklist_tasks_none_desc')} />
    {/if}
  {/if}
</Page>

{#if selectedId}
  <RightPanel onClose={() => select(null)} title={detail?.name ?? t('checklists_title')}>
    {#if detailQuery.isLoading}
      <div class="pad">
        <Skeleton width="180px" height="14px" />
        <div class="rows">
          {#each [1, 2, 3] as n (n)}<Skeleton height="40px" />{/each}
        </div>
      </div>
    {:else if detail}
      <div class="pad">
        <div class="dhead">
          <PersonInline id={detail.personId} {workspaceId} />
          <span class="badges">
            <Badge tone="grey">{kindLabel(detail.kind)}</Badge>
            <Badge tone={STATUS_TONES[detail.status] ?? 'grey'}>{statusLabel(detail.status)}</Badge>
          </span>
        </div>
        <div class="dprogress">
          <ProgressBar
            value={detail.progress.done}
            max={detail.progress.total || 1}
            tone={detail.status === 'done' ? 'success' : 'accent'}
            label={progressLabel(detail.progress)}
          />
          <span class="muted num">
            {progressLabel(detail.progress)} · {t('checklist_anchor_short', { date: dateLabel(detail.anchorDate) })}
          </span>
        </div>
        {#if detail.status === 'cancelled'}
          <p class="hint">{t('checklist_cancelled_note')}</p>
        {:else if detail.status === 'done'}
          <p class="hint">{t('checklist_completed_note')}</p>
        {/if}
        <ChecklistItems checklist={detail} {workspaceId} />
      </div>
    {:else if detailQuery.isError}
      <div class="pad">
        <EmptyState compact icon="triangle-alert" title={t('checklist_detail_error')}>
          {#snippet actions()}
            <Button size="sm" variant="secondary" onclick={() => void detailQuery.refetch()}>{t('retry')}</Button>
          {/snippet}
        </EmptyState>
      </div>
    {/if}
    {#snippet footer()}
      {#if manage && detail && detail.status !== 'cancelled'}
        <div class="dactions">
          <Button size="sm" variant="danger" onclick={() => askCancel(detail)}>{t('checklist_cancel')}</Button>
          <Button size="sm" variant="secondary" icon="plus" onclick={openAdd}>{t('checklist_add_task')}</Button>
        </div>
      {/if}
    {/snippet}
  </RightPanel>
{/if}

{#if manage}
  <StartChecklistDialog
    open={starting}
    {workspaceId}
    onClose={() => (starting = false)}
    onStarted={(created) => select(created.id)}
  />

  <Dialog bind:open={adding} size="sm" title={t('checklist_add_title')} description={t('checklist_add_desc')}>
    <form
      class="form"
      onsubmit={(e) => {
        e.preventDefault()
        submitAdd()
      }}
    >
      <Field label={t('checklist_task_title')} id="hr-checklist-new-title" required error={addError}>
        {#snippet children(id)}
          <Input {id} bind:value={newTitle} maxlength={200} />
        {/snippet}
      </Field>
      <Field label={t('checklist_task_desc')} id="hr-checklist-new-desc" hint={t('common.optional')}>
        {#snippet children(id)}
          <Textarea {id} bind:value={newDescription} rows={2} maxlength={2000} />
        {/snippet}
      </Field>
      <Field label={t('checklist_assign_to')} id="hr-checklist-new-assignee">
        {#snippet children(id)}
          <Select
            {id}
            bind:value={newAssignee}
            disabled={peopleQuery.isLoading}
            options={[
              { value: '', label: t('checklist_assign_pool') },
              ...people.map((p) => ({ value: p.id, label: p.displayName })),
            ]}
          />
        {/snippet}
      </Field>
      <Field label={t('checklist_item_due')} id="hr-checklist-new-due" hint={t('common.optional')}>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={newDueOn} />
        {/snippet}
      </Field>
    </form>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (adding = false)}>{t('common.cancel')}</Button>
      <Button onclick={submitAdd} disabled={!newTitle.trim() || submittingAdd} loading={add.isPending}>
        {t('checklist_add_task')}
      </Button>
    {/snippet}
  </Dialog>

  <Dialog
    open={cancelling !== null}
    size="sm"
    title={t('checklist_cancel_title', { name: cancelling?.name ?? '' })}
    description={t('checklist_cancel_body')}
    onOpenChange={(o) => {
      if (!o) cancelling = null
    }}
  >
    {#if cancelError}<p class="error" role="alert">{cancelError}</p>{/if}
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (cancelling = null)}>{t('common.cancel')}</Button>
      <Button variant="danger" onclick={confirmCancel} disabled={submittingCancel} loading={cancel.isPending}>
        {t('checklist_cancel')}
      </Button>
    {/snippet}
  </Dialog>
{/if}

<style>
.filters {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-block-end: 8px;
}
.spacer {
  flex: 1;
}
.rows {
  display: grid;
  gap: 4px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  --hr-checklist-cols: minmax(140px, 0.9fr) minmax(200px, 1.4fr) minmax(140px, 0.8fr) 120px 110px max-content;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-checklist-cols);
  gap: 12px;
  align-items: center;
  padding-inline: 12px;
}
.thead {
  height: 34px;
  border-block-end: 1px solid var(--kern-border);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.trow {
  min-height: 56px;
  border-block-end: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-md);
}
.trow:hover {
  background: var(--kern-surface-raised);
}
.trow.selected {
  background: var(--kern-surface-active);
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
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13.5px;
  font-weight: 500;
  color: inherit;
  text-decoration: none;
}
.name:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.progress {
  display: grid;
  gap: 4px;
  overflow: visible;
}
.num {
  font-variant-numeric: tabular-nums;
}
/* A colour, not opacity: opacity fades text against the page whatever token it names. */
.muted {
  font-size: 12.5px;
  color: var(--kern-ink-500);
}
.actions {
  display: flex;
  justify-content: flex-end;
  overflow: visible;
}

.groups {
  display: grid;
  gap: 20px;
}
.group {
  display: grid;
  gap: 8px;
}
.ghead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.gtitle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.gfor {
  font-size: 13px;
  color: var(--kern-ink-500);
}

.pad {
  padding: 18px 20px;
  display: grid;
  gap: 12px;
}
.dhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.badges {
  display: inline-flex;
  gap: 6px;
}
.dprogress {
  display: grid;
  gap: 4px;
}
.hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--kern-ink-500);
}
.dactions {
  display: flex;
  gap: 8px;
  justify-content: end;
  width: 100%;
}
.form {
  display: grid;
  gap: 14px;
}
.error {
  margin: 0;
  font-size: 13px;
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

@media (max-width: 900px) {
  .table {
    --hr-checklist-cols: minmax(120px, 0.9fr) minmax(160px, 1.4fr) minmax(100px, 0.8fr) max-content;
  }
  /* The anchor date and status survive in the panel rather than squeezing six columns. */
  .thead > :nth-child(4),
  .trow > :nth-child(4),
  .thead > :nth-child(5),
  .trow > :nth-child(5) {
    display: none;
  }
}
</style>
