<script lang="ts">
import { Badge, Button, EmptyState, Skeleton, type WidgetProps } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { hrKeys } from '../query.js'

/**
 * Requests waiting on me, decidable from the card.
 *
 * Acting on a row rather than linking away from it: the whole value of this card is approving three
 * leave requests without leaving the dashboard, and a card that only counts them is a link with
 * extra steps.
 */
const { workspaceId, editing }: WidgetProps = $props()
const api = getHrApi()
const queryClient = useQueryClient()

const inboxQuery = createQuery(() => ({
  queryKey: hrKeys.approvalInbox(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.approvals.inbox({ workspaceId, limit: 5, includeDecided: false }),
}))
const items = $derived(inboxQuery.data?.items ?? [])

const decide = createMutation(() => ({
  mutationFn: (vars: { requestId: string; decision: 'approve' | 'reject' }) =>
    api.approvals.decide({ workspaceId, ...vars }),
  onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['hr'] }),
}))
</script>

{#if inboxQuery.isLoading}
  <Skeleton height="96px" />
{:else if items.length === 0}
  <EmptyState bare compact icon="check-check" title={t('approvals_none')} />
{:else}
  <ul>
    {#each items as item (item.id)}
      <li>
        <span class="summary">{item.summary}</span>
        <!-- Row actions go while the grid is being rearranged: the data stays, the buttons do not. -->
        {#if editing}
          <Badge tone="upcoming">{t('leave_pending')}</Badge>
        {:else}
          <Button
            size="sm"
            variant="ghost"
            disabled={decide.isPending}
            onclick={() => decide.mutate({ requestId: item.id, decision: 'reject' })}
            >{t('reject')}</Button
          >
          <Button
            size="sm"
            disabled={decide.isPending}
            onclick={() => decide.mutate({ requestId: item.id, decision: 'approve' })}
            >{t('approve')}</Button
          >
        {/if}
      </li>
    {/each}
  </ul>
{/if}

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
}
.summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
</style>
