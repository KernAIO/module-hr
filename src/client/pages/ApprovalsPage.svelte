<script lang="ts">
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  formatCount,
  formatDateTime,
  navigation,
  Page,
  PageHeader,
  SectionLabel,
  SegmentedControl,
  Skeleton,
  session,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import DecisionDialog from '../components/DecisionDialog.svelte'
import DelegationDialog from '../components/DelegationDialog.svelte'
import { t } from '../i18n.js'
import type { ApprovalRequest } from '../index.js'
import { canHr, HR_CAPABILITIES } from '../permissions.js'
import { hrKeys } from '../query.js'
import { summarise } from '../summary.js'

/**
 * Everything waiting on me, across every kind of request.
 *
 * One inbox rather than one per feature, because the approval engine is keyed by subject type — a
 * leave request and an attendance correction arrive here the same way, and so will overtime and
 * timesheets when they exist.
 *
 * No permission gate on the list: an inbox of what *you* must decide is yours by definition, and the
 * server only ever lists steps you are named on. Delegation is gated, because letting somebody else
 * decide in your place is a claim about them as well as about you.
 *
 * Who signs what is not set here — `approvals.chains.*` is a workspace policy and lives in settings.
 * `approvals.get` is not called either: the inbox already returns each request with its steps and
 * decisions, so a detail fetch would re-ask a question this page has the answer to.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

let tab = $state('waiting')
const includeDecided = $derived(tab === 'decided')

let deciding = $state<{ request: ApprovalRequest; decision: 'approve' | 'reject' } | null>(null)
let delegating = $state(false)
let decideError = $state<string | null>(null)

/**
 * `submitting` rather than `decide.isPending`: the disabled attribute only reaches the confirm
 * button on the next render, so two quick clicks both fire and one request is decided twice. This
 * is set in the same tick as the click.
 */
let submitting = $state(false)

/**
 * Delegation is two questions, and the button was only asking one.
 *
 * `hr.approval.delegate` defaults to owner, admin and member, so every member saw the button — and
 * `DelegationDialog` then calls `approvals.delegations`, which sits behind the `approvals`
 * capability. That capability is off by default, so in a fresh workspace the dialog opened and
 * 404'd on its first query. A capability that is off has no surface at all, not a surface that
 * fails when you touch it.
 */
const hasChains = $derived(session.hasCapability('hr', HR_CAPABILITIES.approvals))
const showDelegation = $derived(hasChains && canHr('approvalDelegate'))

const inboxQuery = createQuery(() => ({
  queryKey: hrKeys.approvalInbox(workspaceId, includeDecided),
  enabled: Boolean(workspaceId),
  queryFn: () => api.approvals.inbox({ workspaceId, limit: 50, includeDecided }),
}))
const items = $derived(inboxQuery.data?.items ?? [])

const decide = createMutation(() => ({
  mutationFn: (vars: { requestId: string; decision: 'approve' | 'reject'; comment: string }) =>
    api.approvals.decide({
      workspaceId,
      requestId: vars.requestId,
      decision: vars.decision,
      comment: vars.comment.trim() || null,
    }),
  onSuccess: () => {
    deciding = null
    decideError = null
    // Deciding changes a balance and a day sheet as well as the inbox, so the whole module's cache
    // is invalidated rather than guessing which keys moved.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error) => {
    decideError = decideFailure(error)
    // A refusal is the server saying its inbox is not the one on screen, so the row behind the
    // dialog is stale as well as the decision. Re-read all of HR exactly as a decision that landed
    // does — without this the same dead row sits in the table and every retry earns the same
    // sentence.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onSettled: () => {
    submitting = false
  },
}))

/**
 * The decision refusals this module has its own sentence for, keyed by the `reason` the router
 * sends beside the refusal — never by the sentence, because a list of sentences is a list somebody
 * has to keep in sync and the day it drifts the reader is told nothing.
 *
 * Empty on purpose. `approvals.decide` refuses through `KernError.conflict`, whose reason argument
 * is kept on the server and never serialised, so every refusal arrives today as the sentence the
 * router wrote for a person. The day `decide()` sends a reason, its string lands here and nothing
 * else has to change.
 */
const decideRefusalMessages: Record<string, string> = {}

/**
 * What a refused decision says to the person who made it.
 *
 * A decision is refused when the request is no longer theirs to decide — somebody else approved it,
 * the requester cancelled it, or a delegation moved the step — and the router's sentence is the
 * only thing that says which of those happened. It used to be thrown away here for a flat "The
 * decision could not be recorded", which tells a manager staring at a live-looking row nothing at
 * all. Everything else that can fail carries machine text in English, so it falls back to this
 * module's own string.
 *
 * The test is the transport's `code`, never the sentence: `KernError.conflict` is what arrives as
 * CONFLICT, so a refusal added to `decide()` later reaches the reader without anyone editing this
 * file. The same shape as `ClockControls.svelte` and the approvals widget.
 */
function decideFailure(error: unknown): string {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (failure.code !== 'CONFLICT') return t('decide_error')
  const reason = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason ? decideRefusalMessages[reason] : undefined
  // `t()` answers a key it has no string for with the key itself, so both ways of not having one —
  // a reason no key covers, and a key whose string has not been merged — land on the router's
  // sentence rather than putting `hr.decide_refused_…` in front of somebody.
  const translated = key ? t(key) : undefined
  return (translated && translated !== key ? translated : failure.message) || t('decide_error')
}

const ask = (request: ApprovalRequest, decision: 'approve' | 'reject') => {
  decideError = null
  deciding = { request, decision }
}

const confirmDecision = (comment: string) => {
  if (!deciding || submitting) return
  submitting = true
  decide.mutate({ requestId: deciding.request.id, decision: deciding.decision, comment })
}

const SUBJECT_LABELS: Record<string, () => string> = {
  leave: () => t('leave_title'),
  regularization: () => t('attendance_title'),
  overtime: () => t('att_overtime'),
  timesheet: () => t('approval_subject_timesheet'),
  shift_swap: () => t('approval_subject_shift_swap'),
}
const subjectLabel = (subjectType: string) => SUBJECT_LABELS[subjectType]?.() ?? subjectType

const STATUS_TONES: Record<string, BadgeTone> = {
  pending: 'upcoming',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'grey',
}
const STATUS_LABELS: Record<string, () => string> = {
  pending: () => t('approval_status_pending'),
  approved: () => t('approval_status_approved'),
  rejected: () => t('approval_status_rejected'),
  cancelled: () => t('approval_status_cancelled'),
}

const stepOf = (request: ApprovalRequest) =>
  t('approvals_step_of', { n: String(request.currentStep + 1), total: String(request.steps.length) })
</script>

<PageHeader
  crumbs={[{ label: workspace?.name ?? '' }, { label: t('approvals_title') }]}
  title={t('approvals_title')}
>
  {#snippet actions()}
    {#if showDelegation}
      <Button size="sm" variant="secondary" icon="users" onclick={() => (delegating = true)}>
        {t('delegate')}
      </Button>
    {/if}
  {/snippet}
</PageHeader>

<Page>
  <div class="filters">
    <SegmentedControl
      size="sm"
      label={t('approvals_title')}
      bind:value={tab}
      items={[
        { value: 'waiting', label: t('approvals_waiting') },
        { value: 'decided', label: t('approvals_decided') },
      ]}
    />
  </div>

  <SectionLabel
    label={includeDecided ? t('approvals_decided') : t('approvals_waiting')}
    count={formatCount(items.length, 999)}
  />

  <!--
    Held rows outrank the error. Every decision taken here invalidates all of `['hr']`, so a failed
    background refetch leaves TanStack in `error` with the last good inbox still in `data` — an
    error branch above this one would blank a working table, and take its approve buttons with it,
    on a transient failure. The error is the whole page only when there is nothing else to draw.
  -->
  {#if inboxQuery.isLoading}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="56px" />{/each}
    </div>
  {:else if items.length > 0}
    <div class="table" role="table" aria-label={t('approvals_title')}>
      <div class="thead" role="row">
        <span role="columnheader">{t('approvals_request')}</span>
        <span role="columnheader">{t('approvals_requested_by')}</span>
        <span role="columnheader">{t('approvals_requested')}</span>
        <span role="columnheader">{includeDecided ? t('status') : t('approvals_step')}</span>
        <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
      </div>
      {#each items as item (item.id)}
        <div class="trow" role="row">
          <span class="cell what" role="cell">
            <Badge tone="grey">{subjectLabel(item.subjectType)}</Badge>
            <span class="summary">{summarise(item)}</span>
          </span>
          <span class="cell muted" role="cell">{item.requesterName ?? '—'}</span>
          <span class="cell muted" role="cell">{formatDateTime(item.requestedAt)}</span>
          <span class="cell" role="cell">
            {#if includeDecided}
              <Badge tone={STATUS_TONES[item.status] ?? 'grey'}>
                {STATUS_LABELS[item.status]?.() ?? item.status}
              </Badge>
            {:else if item.steps.length > 1}
              <span class="muted">{stepOf(item)}</span>
            {/if}
          </span>
          <span class="cell actions" role="cell">
            {#if item.status === 'pending'}
              <Button size="sm" variant="secondary" onclick={() => ask(item, 'reject')}>
                {t('reject')}
              </Button>
              <Button size="sm" onclick={() => ask(item, 'approve')}>{t('approve')}</Button>
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {:else if inboxQuery.isError}
    <EmptyState icon="triangle-alert" title={t('approvals_error')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void inboxQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <EmptyState
      icon="check-check"
      title={includeDecided ? t('approvals_decided_none') : t('approvals_none')}
      description={includeDecided ? t('approvals_decided_none_desc') : t('approvals_none_desc')}
    />
  {/if}

  <!--
    Only where the workspace has chains. With the capability off there is no chain to configure —
    the requester's manager approves, implicitly — so this line sent a reader to a settings screen
    that is not there.
  -->
  {#if hasChains}
    <p class="hint">{t('approvals_chains_hint')}</p>
  {/if}
</Page>

<DecisionDialog
  request={deciding?.request ?? null}
  decision={deciding?.decision ?? 'approve'}
  pending={submitting}
  error={decideError}
  onConfirm={confirmDecision}
  onCancel={() => {
    deciding = null
    decideError = null
  }}
/>

<!-- Only where the workspace has approval chains: every procedure inside it is behind that one. -->
{#if showDelegation}
  <DelegationDialog open={delegating} {workspaceId} onClose={() => (delegating = false)} />
{/if}

<style>
.filters {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-block-end: 8px;
}
.rows {
  display: grid;
  gap: 4px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  --hr-approval-cols: minmax(220px, 1.6fr) minmax(120px, 0.7fr) 170px 150px max-content;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-approval-cols);
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
.summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13.5px;
  font-weight: 500;
}
.muted {
  font-size: 13px;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-500);
}
.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  overflow: visible;
}
.hint {
  margin-block-start: 16px;
  font-size: 12px;
  color: var(--kern-ink-500);
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
    --hr-approval-cols: minmax(160px, 1.6fr) minmax(100px, 0.7fr) max-content;
  }
  /* Requested-at and step survive on the row's second line rather than squeezing five columns. */
  .thead > :nth-child(3),
  .trow > :nth-child(3),
  .thead > :nth-child(4),
  .trow > :nth-child(4) {
    display: none;
  }
}
</style>
