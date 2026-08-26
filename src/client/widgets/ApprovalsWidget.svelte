<script lang="ts">
import { Badge, Button, EmptyState, Skeleton, toast, type WidgetProps } from '@kernhq/ui'
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

/**
 * `deciding` rather than `decide.isPending`: the disabled attribute only reaches the buttons on the
 * next render, so two quick clicks both fire and the same request is decided twice. This is set in
 * the same tick as the first click.
 */
let deciding = $state(false)

const decide = createMutation(() => ({
  mutationFn: (vars: { requestId: string; decision: 'approve' | 'reject' }) =>
    api.approvals.decide({ workspaceId, ...vars }),
  onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['hr'] }),
  onError: (error) => {
    // The commonest failure here is that the request is no longer yours to decide — somebody else
    // approved it, the person cancelled it, or a delegation moved the step — and the router refuses
    // that with a sentence it wrote for a person. That sentence is the only thing that says which
    // of those happened, so it is repeated verbatim. Everything else that can fail carries machine
    // text in English, so it falls back to this module's own string.
    //
    // The test is the transport's `code`, never the sentence: `KernError.conflict` is what arrives
    // as CONFLICT, so a refusal added to `decide()` later reaches the person without anyone editing
    // this file. A list of sentences to match on is a list somebody has to keep in sync.
    const refused = (error as { code?: unknown }).code === 'CONFLICT' && error.message
    toast.error(refused ? error.message : t('decide_error'))
    // A refusal means the server's inbox is not the one on screen, so the row that was just clicked
    // is stale as well as the decision. Re-read all of HR exactly as a decision that landed does —
    // without this, a request somebody else already approved sits on the card for ever and every
    // retry earns the same toast.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onSettled: () => {
    deciding = false
  },
}))

const act = (requestId: string, decision: 'approve' | 'reject') => {
  if (deciding) return
  deciding = true
  decide.mutate({ requestId, decision })
}
</script>

<!--
  Held rows outrank the error. `invalidateQueries({ queryKey: ['hr'] })` fires on every punch and
  every decision anywhere in the module, so a failed background refetch leaves TanStack in `error`
  while `data` is still the last good inbox — an error branch above this one would blank a working
  card, and take its approve buttons with it, on a transient failure. The error is only the whole
  card when there is nothing else to draw.
-->
{#if inboxQuery.isLoading}
  <Skeleton height="96px" />
{:else if items.length > 0}
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
            disabled={deciding}
            onclick={() => act(item.id, 'reject')}
            >{t('reject')}</Button
          >
          <Button size="sm" disabled={deciding} onclick={() => act(item.id, 'approve')}
            >{t('approve')}</Button
          >
        {/if}
      </li>
    {/each}
  </ul>
{:else if inboxQuery.isError}
  <!--
    One row, not an `EmptyState`. This card's smallest declared size is `s`, whose body is 43px —
    one grid row of 84px, less the frame's 41px header — and a compact `EmptyState` is 82px before
    it is given an action, so its retry button sat below a fold nobody scrolls in a card this size.
    Here the row lands where the first request would have been.

    Without this branch the empty state below claimed "Nothing waiting on you" to a manager whose
    inbox had simply failed to load, which is the one sentence on this card nobody would check.
  -->
  <div class="failed" role="alert">
    <span class="msg">{t('approvals_error')}</span>
    <Button size="xs" variant="ghost" onclick={() => void inboxQuery.refetch()}>{t('retry')}</Button>
  </div>
{:else}
  <EmptyState bare compact icon="check-check" title={t('approvals_none')} />
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
.failed {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-block: 8px;
  padding-inline: 14px;
}
/* Muted with a colour, never opacity: 9.86:1 on the card in light, 8.96:1 in dark. */
.msg {
  min-width: 0;
  font-size: 12.5px;
  color: var(--kern-ink-600);
}
</style>
