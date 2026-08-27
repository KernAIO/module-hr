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
 *
 * **A button here only where the decision is certainly the reader's own.** `approvals.inbox` also
 * returns rows the reader may decide *as somebody's delegate*, and rows resting on a step further
 * down a chain they are named on. `approvals.decide` refuses both when the decision is filed as the
 * reader — which is what every approve button on this card did to them — so neither gets one. Which
 * of the two a row is, and whose name the decision would carry, is what the approvals page has the
 * queries and the room to say; this card sends the reader there rather than guessing. See
 * `actionFor`.
 */
const { workspaceId, workspaceSlug, editing }: WidgetProps = $props()
const api = getHrApi()
const queryClient = useQueryClient()

const inboxQuery = createQuery(() => ({
  queryKey: hrKeys.approvalInbox(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.approvals.inbox({ workspaceId, limit: 5, status: 'pending' }),
}))
const items = $derived(inboxQuery.data?.items ?? [])

/**
 * Which employee the reader is — the one fact that separates a row this card may decide from one it
 * may only point at.
 *
 * No permission: `people.me` is the caller's own record, and somebody with none gets an empty inbox
 * from the server anyway. The same key the approvals page fills, so opening one warms the other.
 */
const meQuery = createQuery(() => ({
  queryKey: hrKeys.me(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.people.me({ workspaceId }),
}))
const myPersonId = $derived(meQuery.data?.id ?? null)

/** What this card may offer on a row. */
type RowAction =
  /** The reader's own decision, on the step the request has reached. */
  | 'decide'
  /** Theirs, and already made — a step still collecting its other approvers. */
  | 'decided'
  /** Not the reader's own: whose it is, and whether it can be filed at all, belongs to the page. */
  | 'elsewhere'

/**
 * Whether this card may file the decision on a row, and never as whom.
 *
 * A reduced form of `describe()` in `pages/ApprovalsPage.svelte`, which stays the authority: that
 * one derives every identity the reader may file as — themselves, and each colleague who delegated
 * to them — out of `people.me`, the live delegations and the step's `approverIds`, and hands them to
 * `DecisionDialog` to be stated or chosen. This asks only the half a dashboard card can answer
 * honestly on one line: **is this decision the reader's own?**
 *
 * The other half is deliberately not asked here. Naming a delegator needs the delegations list —
 * behind the `approvals` capability *and* `hr.approval.delegate`, so a reader holding a delegation
 * but not that key would learn nothing and be offered a decision as themselves, which is the refusal
 * this file exists to stop — plus a directory read for the name, and then a second line to print it
 * on, in a card whose smallest size is one 43px row. A decision filed under a person the reader was
 * never shown is the worst thing this module can do, so a row this card cannot name is a link.
 *
 * The fallback is the page's, for the same reason: with no `myPersonId` yet, or against a server
 * whose steps carry no `approverIds`, nothing is claimed and the card offers exactly what it offered
 * before — the reader's own decision, with the server as the authority.
 */
function actionFor(request: ApprovalRequest): RowAction {
  const step = request.steps.find((s) => s.stepIndex === request.currentStep) ?? null
  const approvers = step?.approverIds ?? []
  if (!myPersonId || approvers.length === 0) return 'decide'
  if (!approvers.includes(myPersonId)) return 'elsewhere'
  // The unique index on `(step_id, approver_id)` refuses a second decision from the same person, so
  // an approve button on a step this reader has already settled is one that can only fail. It is a
  // real row: an `all` step stays pending until everybody named on it has answered.
  return (step?.decisions ?? []).some((d) => d.approverId === myPersonId) ? 'decided' : 'decide'
}

const rows = $derived(items.map((item) => ({ item, action: actionFor(item) })))

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
      // Stated rather than left out. The field is nullish, so both reach the server the same way —
      // but this card offers no other identity, and `null` is that promise written where the call
      // is made rather than inferred from the absence of a line.
      onBehalfOfId: null,
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
 *
 * FORBIDDEN has its own, because this card no longer offers a decision that earns one by design:
 * `actionFor` keeps the buttons on the steps the reader is named on, so a refusal means the step
 * moved between the card being drawn and the click. The router's words for it — "You are not an
 * approver on this step" — are machine text in English, and the only other FORBIDDEN `decide` can
 * raise is for a caller with no employee record, whose inbox is empty and who therefore has nothing
 * on this card to click.
 */
function decideFailure(error: unknown): string {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (failure.code === 'FORBIDDEN') return t('decide_moved_error')
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

  `people.me` is waited for alongside the inbox, though. It decides which rows get buttons, and
  drawing an approve button on a colleague's row for one frame and then taking it away is worse than
  a skeleton that lasts as long — the two queries go out together, so it costs nothing. A `me` that
  *fails* leaves `myPersonId` null, which is the fallback `actionFor` documents rather than a card
  stuck loading.
-->
{#if inboxQuery.isLoading || meQuery.isLoading}
  <Skeleton height="96px" />
{:else if rows.length > 0}
  <ul>
    {#each rows as row (row.item.id)}
      <li>
        <span class="summary">{summarise(row.item)}</span>
        <!-- Row actions go while the grid is being rearranged: the data stays, the buttons do not. -->
        {#if editing}
          <Badge tone="upcoming">{t('leave_pending')}</Badge>
        {:else if row.action === 'decide'}
          <!--
            Never straight to `decide.mutate`: rejecting somebody's leave is irreversible from the
            interface and notifies them, and a dashboard card is the easiest place in the product to
            hit the wrong button. The dialog says what the decision does and to whom.
          -->
          <Button size="sm" variant="ghost" onclick={() => ask(row.item, 'reject')}>{t('reject')}</Button>
          <Button size="sm" onclick={() => ask(row.item, 'approve')}>{t('approve')}</Button>
        {:else if row.action === 'decided'}
          <span class="note">{t('approvals_you_decided')}</span>
        {:else}
          <!--
            A link, not a button. This row is either a colleague's decision the reader holds by
            delegation or a step the request has not reached them on, and the card cannot tell which
            without the queries the approvals page makes — so it offers the one thing that is true
            either way. The label carries it: an icon-only arrow here would be a control a screen
            reader announces as "link" and nothing more.
          -->
          <Button
            size="sm"
            variant="ghost"
            href={`/${workspaceSlug}/hr/approvals`}
            title={t('approvals_open_hint')}
          >
            {t('approvals_open')}
          </Button>
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
/*
  Where a row's buttons would have been. `--kern-ink-600` rather than the `--kern-ink-500` the
  approvals page mutes with: this sits on the card surface, which is the pair already measured for
  `.msg` below — 9.86:1 in light, 8.96:1 in dark. Nowrap because the row is one line at every size
  the card declares, and a wrapped word here is what pushes an `s` card past its 43px body.
*/
.note {
  font-size: 12px;
  white-space: nowrap;
  color: var(--kern-ink-600);
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
