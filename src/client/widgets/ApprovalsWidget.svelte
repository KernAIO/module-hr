<script lang="ts">
import { Badge, Button, EmptyState, Skeleton, type WidgetProps } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import DecisionDialog from '../components/DecisionDialog.svelte'
import { t } from '../i18n.js'
import type { ApprovalRequest } from '../index.js'
import { hrKeys } from '../query.js'
import { summarise } from '../summary.js'

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

let asked = $state<{ request: ApprovalRequest; decision: 'approve' | 'reject' } | null>(null)
let decideError = $state<string | null>(null)

/**
 * `deciding` rather than `decide.isPending`: the disabled attribute only reaches the button on the
 * next render, so two quick clicks both fire and the same request is decided twice. This is set in
 * the same tick as the first click.
 */
let deciding = $state(false)

const decide = createMutation(() => ({
  mutationFn: (vars: { requestId: string; decision: 'approve' | 'reject'; comment: string }) =>
    api.approvals.decide({
      workspaceId,
      requestId: vars.requestId,
      decision: vars.decision,
      comment: vars.comment.trim() || null,
    }),
  onSuccess: () => {
    asked = null
    decideError = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error) => {
    decideError = decideFailure(error)
    // A refusal means the server's inbox is not the one on screen, so the row that was just clicked
    // is stale as well as the decision. Re-read all of HR exactly as a decision that landed does —
    // without this, a request somebody else already approved sits on the card for ever and every
    // retry earns the same sentence.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onSettled: () => {
    deciding = false
  },
}))

/**
 * The decision refusals this module has its own sentence for, keyed by the `reason` the router
 * sends beside the refusal. Empty because `approvals.decide` refuses through `KernError.conflict`,
 * whose reason argument stays on the server — see `ApprovalsPage.svelte`, which carries the whole
 * note and the same shape.
 */
const decideRefusalMessages: Record<string, string> = {}

/**
 * What a refused decision says to the person who made it.
 *
 * The commonest failure here is that the request is no longer yours to decide — somebody else
 * approved it, the person cancelled it, or a delegation moved the step — and the router refuses
 * that with a sentence it wrote for a reader. That sentence is the only thing that says which of
 * those happened, so it is repeated verbatim. Everything else that can fail carries machine text in
 * English, so it falls back to this module's own string. The test is the transport's `code`, never
 * the sentence.
 */
function decideFailure(error: unknown): string {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (failure.code !== 'CONFLICT') return t('decide_error')
  const reason = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason ? decideRefusalMessages[reason] : undefined
  const translated = key ? t(key) : undefined
  return (translated && translated !== key ? translated : failure.message) || t('decide_error')
}

const ask = (request: ApprovalRequest, decision: 'approve' | 'reject') => {
  decideError = null
  asked = { request, decision }
}

const confirmDecision = (comment: string) => {
  if (!asked || deciding) return
  deciding = true
  decide.mutate({ requestId: asked.request.id, decision: asked.decision, comment })
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
        <span class="summary">{summarise(item)}</span>
        <!-- Row actions go while the grid is being rearranged: the data stays, the buttons do not. -->
        {#if editing}
          <Badge tone="upcoming">{t('leave_pending')}</Badge>
        {:else}
          <!--
            Never straight to `decide.mutate`: rejecting somebody's leave is irreversible from the
            interface and notifies them, and a dashboard card is the easiest place in the product to
            hit the wrong button. The dialog says what the decision does and to whom.
          -->
          <Button size="sm" variant="ghost" onclick={() => ask(item, 'reject')}>{t('reject')}</Button>
          <Button size="sm" onclick={() => ask(item, 'approve')}>{t('approve')}</Button>
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

<!-- Portalled, so it is a dialog over the dashboard rather than something inside an 84px card. -->
<DecisionDialog
  request={asked?.request ?? null}
  decision={asked?.decision ?? 'approve'}
  pending={deciding}
  error={decideError}
  onConfirm={confirmDecision}
  onCancel={() => {
    asked = null
    decideError = null
  }}
/>

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
