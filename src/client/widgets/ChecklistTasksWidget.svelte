<script lang="ts">
import { Badge, Button, Checkbox, formatDate, toast, type WidgetProps, WidgetState } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { Checklist, ChecklistItem } from '../../contract/checklists.js'
import { getHrApi } from '../api-instance.js'
import { explainChecklistRefusal } from '../components/checklist-refusal.js'
import { dueState, myOpenItems } from '../components/checklists.js'
import { t } from '../i18n.js'
import { hrKeys, isoDate } from '../query.js'

/**
 * The onboarding and offboarding tasks with my name on them, soonest due first, ticked from the
 * card.
 *
 * Acting on a row rather than linking away from it: the value of this card is ticking "set up the
 * laptop" without leaving the dashboard. Every figure comes from `checklists.list({ mine })` and a
 * `get` per list — the same two calls the page's My tasks tab makes, on the same key, so opening
 * one warms the other. A row here is only ever the reader's own task (`myOpenItems`), which is what
 * makes a tick from a card without room for a name safe: nothing on it can be somebody else's.
 */
const { workspaceId, workspaceSlug, editing, size }: WidgetProps = $props()
const api = getHrApi()
const queryClient = useQueryClient()

const mineQuery = createQuery(() => ({
  queryKey: hrKeys.myChecklistTasks(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: async () => {
    const heads = await api.checklists.list({ workspaceId, mine: true, status: 'open', limit: 100 })
    return Promise.all(heads.map((head) => api.checklists.get({ workspaceId, checklistId: head.id })))
  },
}))

/** The same key the approvals card and the page fill, so the three cost one request between them. */
const meQuery = createQuery(() => ({
  queryKey: hrKeys.me(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.people.me({ workspaceId }),
}))
const myPersonId = $derived(meQuery.data?.id ?? null)

/** How many rows the card has room for — one line each, at the three sizes it declares. */
const limit = $derived(size === 's' ? 1 : size === 'm' ? 4 : 8)
const tasks = $derived(myOpenItems(mineQuery.data ?? [], myPersonId))
const shown = $derived(tasks.slice(0, limit))
const more = $derived(tasks.length - shown.length)

const today = isoDate()

/** Per item, and set in the same tick as the click — `isPending` reaches the box a render too late. */
let busy = $state<Record<string, boolean>>({})
let tickVersion = $state(0)

const complete = createMutation(() => ({
  mutationFn: (vars: { itemId: string }) =>
    api.checklists.items.complete({ workspaceId, itemId: vars.itemId }),
  onSuccess: (updated: Checklist) => {
    queryClient.setQueryData(hrKeys.checklist(workspaceId, updated.id), updated)
    void queryClient.invalidateQueries({ queryKey: ['hr', 'checklist'] })
  },
  onError: (error) => {
    toast.error(explainChecklistRefusal(error, t('checklist_tick_error')))
    // The list on the card is not the one the server has; snap the box back and re-read.
    tickVersion += 1
    void queryClient.invalidateQueries({ queryKey: ['hr', 'checklist'] })
  },
  onSettled: (_data, _error, vars) => {
    busy[vars.itemId] = false
  },
}))

function tick(item: ChecklistItem) {
  if (busy[item.id]) return
  busy[item.id] = true
  complete.mutate({ itemId: item.id })
}

const dateLabel = (iso: string) => formatDate(`${iso}T00:00:00`, { month: 'short', day: 'numeric' })
</script>

<!--
  `people.me` is waited for with the lists: it decides which items are the reader's, and drawing an
  empty card for a frame and then filling it is worse than a skeleton that lasts as long.
-->
<WidgetState
  pending={mineQuery.isLoading || meQuery.isLoading}
  error={mineQuery.error}
  empty={shown.length === 0}
  emptyTitle={t('checklist_tasks_none')}
  emptyIcon="check-check"
  rows={Math.min(limit, 4)}
  onRetry={() => void mineQuery.refetch()}
>
  <ul>
    {#each shown as row (row.item.id)}
      {@const due = dueState(row.item.dueOn, today)}
      <li aria-busy={busy[row.item.id] ? 'true' : undefined}>
        <!-- Row actions go while the grid is being rearranged: the data stays, the box does not. -->
        {#if editing}
          <span class="mark" aria-hidden="true"></span>
        {:else}
          {#key tickVersion}
            <Checkbox ariaLabel={t('checklist_tick', { title: row.item.title })} onCheckedChange={() => tick(row.item)} />
          {/key}
        {/if}
        <span class="title" title={row.checklist.name}>{row.item.title}</span>
        {#if due === 'overdue'}
          <Badge tone="danger">{t('checklist_overdue')}</Badge>
        {:else if due === 'today'}
          <Badge tone="upcoming">{t('checklist_due_today')}</Badge>
        {:else if row.item.dueOn}
          <span class="when">{dateLabel(row.item.dueOn)}</span>
        {/if}
      </li>
    {/each}
  </ul>
  {#if more > 0 && size !== 's'}
    <div class="foot">
      <Button size="xs" variant="ghost" href={`/${workspaceSlug}/hr/checklists`}>
        {t('checklist_widget_more', { count: more })}
      </Button>
    </div>
  {/if}
</WidgetState>

<style>
ul {
  display: grid;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
}
.mark {
  width: 16px;
  height: 16px;
  flex: none;
  border: 1.5px solid var(--kern-border-strong);
  border-radius: 4px;
}
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
/* Muted with a colour, never opacity: `--kern-ink-600` is the pair measured on the card surface. */
.when {
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  color: var(--kern-ink-600);
}
.foot {
  display: flex;
  justify-content: flex-end;
  margin-block-start: 8px;
}
</style>
