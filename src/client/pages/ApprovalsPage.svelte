<script lang="ts">
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
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
import { canHr } from '../permissions.js'
import { hrKeys } from '../query.js'
import { dateRange, day, summarise } from '../summary.js'

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
  onError: () => {
    decideError = t('decide_error')
  },
}))

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

const when = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))

const stepOf = (request: ApprovalRequest) =>
  t('approvals_step_of', { n: String(request.currentStep + 1), total: String(request.steps.length) })
</script>

<PageHeader
  crumbs={[{ label: workspace?.name ?? '' }, { label: t('approvals_title') }]}
  title={t('approvals_title')}
>
  {#snippet actions()}
    {#if canHr('approvalDelegate')}
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
    count={items.length}
  />

  {#if inboxQuery.isLoading}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="56px" />{/each}
    </div>
  {:else if inboxQuery.isError}
    <EmptyState icon="triangle-alert" title={t('approvals_error')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void inboxQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if items.length === 0}
    <EmptyState
      icon="check-check"
      title={includeDecided ? t('approvals_decided_none') : t('approvals_none')}
      description={includeDecided ? t('approvals_decided_none_desc') : t('approvals_none_desc')}
    />
  {:else}
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
          <span class="cell muted" role="cell">{when(item.requestedAt)}</span>
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
              <Button
                size="sm"
                variant="secondary"
                onclick={() => {
                  decideError = null
                  deciding = { request: item, decision: 'reject' }
                }}
              >
                {t('reject')}
              </Button>
              <Button
                size="sm"
                onclick={() => {
                  decideError = null
                  deciding = { request: item, decision: 'approve' }
                }}
              >
                {t('approve')}
              </Button>
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}

  <p class="hint">{t('approvals_chains_hint')}</p>
</Page>

<DecisionDialog
  request={deciding?.request ?? null}
  decision={deciding?.decision ?? 'approve'}
  pending={decide.isPending}
  error={decideError}
  onConfirm={(comment) => {
    if (deciding) decide.mutate({ requestId: deciding.request.id, decision: deciding.decision, comment })
  }}
  onCancel={() => {
    deciding = null
    decideError = null
  }}
/>

<DelegationDialog open={delegating} {workspaceId} onClose={() => (delegating = false)} />

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
