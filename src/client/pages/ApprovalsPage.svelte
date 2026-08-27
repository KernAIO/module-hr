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
import { hrKeys, isoDate } from '../query.js'
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
 *
 * **A delegate decides here too, and the row says whose decision it is.** `approvals.inbox` already
 * returns what somebody's delegate may act on — the engine matches a step against the reader *and*
 * everyone who has delegated to them — but the decision was always filed as the reader's own,
 * which the server then refused, because the reader is not on that step. Sending `onBehalfOfId` is
 * what makes those rows decidable, and it is the one input on this page where being wrong writes
 * the wrong name into an audit trail. So nothing is inferred that is not certain: see `describe`.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

let tab = $state('waiting')
const inboxStatus = $derived(tab === 'decided' ? ('decided' as const) : ('pending' as const))

let deciding = $state<{ request: ApprovalRequest; decision: 'approve' | 'reject' } | null>(null)
let delegating = $state(false)
let decideError = $state<string | null>(null)

/** One person this reader may file a decision as: themselves (`null`), or somebody who delegated. */
type Identity = { onBehalfOfId: string | null; label: string }

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
  queryKey: hrKeys.approvalInbox(workspaceId, inboxStatus),
  enabled: Boolean(workspaceId),
  queryFn: () => api.approvals.inbox({ workspaceId, limit: 50, status: inboxStatus }),
}))
const items = $derived(inboxQuery.data?.items ?? [])

/**
 * Which employee the reader is. No permission — `people.me` is the caller's own record, and a
 * member who has none gets an empty inbox from the server anyway.
 *
 * Without it a delegated row cannot be told from one that has not reached the reader's step yet,
 * which is why every claim below is conditional on it having arrived.
 */
const meQuery = createQuery(() => ({
  queryKey: hrKeys.me(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.people.me({ workspaceId }),
}))
const myPersonId = $derived(meQuery.data?.id ?? null)

/**
 * The delegations in play, from the same key `DelegationDialog` fills — revoking one there moves
 * this page without a second request.
 *
 * Both halves of `showDelegation` are load-bearing: the procedure sits behind the `approvals`
 * capability *and* `hr.approval.delegate`, and a delegation cannot exist without the capability, so
 * a workspace with it off has nothing here to miss.
 */
const delegationsQuery = createQuery(() => ({
  queryKey: hrKeys.delegations(workspaceId),
  enabled: showDelegation && Boolean(workspaceId),
  queryFn: () => api.approvals.delegations({ workspaceId }),
}))

/**
 * Delegations the reader holds *today*, in the reader's own zone.
 *
 * The server asks the same question in its zone, so the two disagree for a few hours at either end
 * of a delegation's last day. Erring towards offering it is the right way round: the server refuses
 * what it will not accept, and the refusal says so, whereas hiding the control leaves somebody
 * covering a colleague with no way to act and nothing on screen to explain it.
 */
const heldToday = $derived.by(() => {
  if (!myPersonId) return []
  const today = isoDate()
  return (delegationsQuery.data ?? []).filter(
    (d) => d.toPersonId === myPersonId && d.startsOn <= today && today <= d.endsOn,
  )
})

/** Only once the list has actually arrived is silence about a delegation evidence of anything. */
const knowsDelegations = $derived(showDelegation && delegationsQuery.isSuccess)

/**
 * Names for the people behind the ids, and only where a name is needed.
 *
 * Steps and decisions carry person ids alone — `hydrateApproval` resolves the requester and nobody
 * else — so a directory read is what turns "on behalf of 0192…" into a sentence. It is skipped
 * entirely in the ordinary case of a reader who holds no delegation and is looking at no delegated
 * decision, which is almost everybody, almost always.
 *
 * Not filtered to `active`: the colleague who handed their approvals over is exactly the one likely
 * to be on leave, and a status filter would drop the one name this page must be able to print.
 */
const hasDelegatedDecision = $derived(
  items.some((r) => r.steps.some((s) => (s.decisions ?? []).some((d) => d.onBehalfOfId))),
)
const needsNames = $derived(
  canHr('personView') && Boolean(workspaceId) && (heldToday.length > 0 || hasDelegatedDecision),
)
const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forApprovalNames: true }),
  enabled: needsNames,
  queryFn: () => api.people.list({ workspaceId, limit: 200 }),
}))
const peopleById = $derived(
  new Map((peopleQuery.data?.items ?? []).map((p) => [p.id, p.displayName] as const)),
)
/** A name, or an honest stand-in — never a raw id, which names nobody. */
const personName = (id: string) => peopleById.get(id) ?? t('approvals_behalf_someone')

/**
 * Who the reader may decide as on the step this request is actually on, and why they may not.
 *
 * The rule is that nothing is claimed without the facts a claim needs: the reader's own person id,
 * a delegation list that has arrived, and a step that came back with its approvers. Missing any of
 * them, the page offers exactly what it offered before delegation worked — one decision, the
 * reader's own — and lets the server be the authority. That fallback is also what keeps the mock
 * and any older server, whose steps carry no `approverIds`, working unchanged.
 *
 * Two things are deliberately excluded rather than offered and refused:
 * - an identity that has already decided on this step, which the unique index refuses;
 * - a delegation scoped to another subject type. The contract says `subjectType: null` delegates
 *   everything and a value delegates that one kind — **`ApprovalService.mayActFor` does not check
 *   it**, so a leave-only delegate can decide a correction today. This is the narrower of the two
 *   readings and the one the contract states; the server is where it has to be fixed.
 */
function describe(request: ApprovalRequest) {
  const step = request.steps.find((s) => s.stepIndex === request.currentStep) ?? null
  const approvers = step?.approverIds ?? []
  const decisions = step?.decisions ?? []
  const self: Identity = { onBehalfOfId: null, label: t('approvals_as_self') }

  let identities: Identity[]
  if (!myPersonId || !knowsDelegations || approvers.length === 0) identities = [self]
  else {
    const settled = new Set(decisions.map((d) => d.approverId))
    identities = approvers.includes(myPersonId) && !settled.has(myPersonId) ? [self] : []
    const delegators = new Set(
      heldToday
        .filter((d) => d.subjectType === null || d.subjectType === request.subjectType)
        .map((d) => d.fromPersonId),
    )
    for (const id of delegators)
      if (id !== myPersonId && approvers.includes(id) && !settled.has(id))
        identities.push({ onBehalfOfId: id, label: personName(id) })
  }

  const only = identities.length === 1 ? identities[0]! : null
  return {
    identities,
    /** The one delegation this row would be decided under, when there is exactly one and no choice. */
    behalf: only?.onBehalfOfId ? only : null,
    choice: identities.length > 1,
    /**
     * Why a pending row has no buttons. Both were an approve button that always failed: the server
     * refuses a second decision from the same approver, and refuses anybody who is not on the step
     * the request has reached.
     */
    waiting:
      request.status === 'pending' && identities.length === 0
        ? decisions.some((d) => d.approverId === myPersonId)
          ? ('decided' as const)
          : ('later' as const)
        : null,
    /**
     * Delegated decisions already recorded. `approverId` is whose decision it is and
     * `onBehalfOfId` is whose hands it was — the field is named for the *input* to `decide`, which
     * means the opposite thing, so read them from the schema rather than from the name.
     */
    recorded: request.steps.flatMap((s) =>
      (s.decisions ?? [])
        .filter((d) => d.onBehalfOfId)
        .map((d) => ({ actor: personName(d.onBehalfOfId as string), person: personName(d.approverId) })),
    ),
  }
}

const rows = $derived(items.map((item) => ({ item, ...describe(item) })))

/**
 * The open dialog's view of the request, from the live row where there still is one.
 *
 * Derived rather than captured at the click, so a name or a delegation arriving while the dialog is
 * open reaches it. It falls back to the snapshot the click carried because a refused decision
 * re-reads the inbox on purpose, and a row that came back decided by somebody else must not take
 * the refusal's sentence off the screen with it.
 */
const decidingView = $derived.by(() => {
  if (!deciding) return null
  const open = deciding.request
  return rows.find((r) => r.item.id === open.id) ?? describe(open)
})

const decide = createMutation(() => ({
  mutationFn: (vars: {
    requestId: string
    decision: 'approve' | 'reject'
    comment: string
    onBehalfOfId: string | null
  }) =>
    api.approvals.decide({
      workspaceId,
      requestId: vars.requestId,
      decision: vars.decision,
      comment: vars.comment.trim() || null,
      onBehalfOfId: vars.onBehalfOfId,
    }),
  onSuccess: () => {
    deciding = null
    decideError = null
    // Deciding changes a balance and a day sheet as well as the inbox, so the whole module's cache
    // is invalidated rather than guessing which keys moved.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error, vars) => {
    decideError = decideFailure(error, vars.onBehalfOfId !== null)
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
 *
 * A delegated decision has one refusal worth naming, and it is a FORBIDDEN rather than a conflict:
 * the delegation the reader was acting under is not one the server can see — usually because it
 * ended between the page loading and the click. `delegated` is what this client *sent*, not a
 * sentence parsed back out of the server, so the reader gets a translated instruction instead of
 * "The decision could not be recorded", which tells somebody covering a colleague nothing.
 */
function decideFailure(error: unknown, delegated: boolean): string {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (delegated && failure.code === 'FORBIDDEN') return t('decide_behalf_error')
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

/**
 * `onBehalfOfId` comes from the dialog, which will not confirm until it has one it can name. A
 * decision filed against the wrong person is the worst thing this screen can do, so the identity
 * travels with the click rather than being read back out of state here.
 */
const confirmDecision = (comment: string, onBehalfOfId: string | null) => {
  if (!deciding || submitting) return
  submitting = true
  decide.mutate({ requestId: deciding.request.id, decision: deciding.decision, comment, onBehalfOfId })
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
    label={inboxStatus === 'decided' ? t('approvals_decided') : t('approvals_waiting')}
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
        <span role="columnheader">{inboxStatus === 'decided' ? t('status') : t('approvals_step')}</span>
        <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
      </div>
      {#each rows as row (row.item.id)}
        <div class="trow" role="row">
          <span class="cell what" role="cell">
            <span class="line">
              <Badge tone="grey">{subjectLabel(row.item.subjectType)}</Badge>
              <span class="summary">{summarise(row.item)}</span>
            </span>
            <!--
              Whose decision this is, on the row rather than only in the dialog: somebody clearing an
              inbox of six rows should not have to open one to find out that two of them are a
              colleague's. A pending row says what the click would file; a decided one says what was
              filed, which is the other half of the same promise.
            -->
            {#if row.behalf}
              <Badge tone="info">{t('approvals_on_behalf', { name: row.behalf.label })}</Badge>
            {:else if row.choice}
              <Badge tone="info">{t('approvals_behalf_pick')}</Badge>
            {:else if row.recorded.length > 0}
              {#each row.recorded as entry, i (i)}
                <span class="behalf">
                  {t('approvals_decided_behalf', { actor: entry.actor, person: entry.person })}
                </span>
              {/each}
            {/if}
          </span>
          <span class="cell muted" role="cell">{row.item.requesterName ?? '—'}</span>
          <span class="cell muted" role="cell">{formatDateTime(row.item.requestedAt)}</span>
          <span class="cell" role="cell">
            {#if inboxStatus === 'decided'}
              <Badge tone={STATUS_TONES[row.item.status] ?? 'grey'}>
                {STATUS_LABELS[row.item.status]?.() ?? row.item.status}
              </Badge>
            {:else if row.item.steps.length > 1}
              <span class="muted">{stepOf(row.item)}</span>
            {/if}
          </span>
          <span class="cell actions" role="cell">
            {#if row.item.status === 'pending' && row.identities.length > 0}
              <Button size="sm" variant="secondary" onclick={() => ask(row.item, 'reject')}>
                {t('reject')}
              </Button>
              <Button size="sm" onclick={() => ask(row.item, 'approve')}>{t('approve')}</Button>
            {:else if row.waiting}
              <span class="muted">
                {row.waiting === 'decided' ? t('approvals_you_decided') : t('approvals_later_step')}
              </span>
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
      title={inboxStatus === 'decided' ? t('approvals_decided_none') : t('approvals_none')}
      description={inboxStatus === 'decided' ? t('approvals_decided_none_desc') : t('approvals_none_desc')}
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
  identities={decidingView?.identities ?? []}
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
/*
  A column, not a row: the subject and its sentence sit on one line and the delegation note under
  it, so a name long enough to matter cannot push the summary out of the cell.
*/
.what {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  gap: 4px;
}
.line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}
.behalf {
  font-size: 12px;
  /* A colour, not opacity — this line names a person and has to stay readable. */
  color: var(--kern-ink-500);
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
