<script lang="ts">
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  formatDateRange,
  Icon,
  messageLocale,
  navigation,
  Page,
  PageHeader,
  Skeleton,
  StatTile,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import LeaveLedgerPanel from '../components/LeaveLedgerPanel.svelte'
import LeaveRequestDialog from '../components/LeaveRequestDialog.svelte'
import { t } from '../i18n.js'
import type { LeaveRequest } from '../index.js'
import { canHr } from '../permissions.js'
import { formatDays, hrKeys } from '../query.js'

/**
 * My time off: what is left, and what is booked.
 *
 * Balance first, then the requests, because "how much do I have" is the question somebody opens
 * this page with — and the number they need before deciding anything is `available`, not `balance`.
 * Pending requests are already spoken for; showing the raw balance is how somebody books a week
 * they do not have and finds out at approval.
 *
 * Neither half may fail quietly. A refused balance used to take the strip off the page with no
 * message and leave "No time off booked" underneath it, which reads as a person with nothing —
 * no days left and none booked — rather than as a screen that never loaded.
 *
 * A tile is also the way in to the movements behind it. "How much do I have" and "why is it that"
 * are the same question one step apart, and the second one had no answer on any screen: the ledger
 * was readable over the API and nowhere else, so `hr.leave.view_ledger` gated nothing.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')
const requesting = $derived(navigation.search.new === '1')

const balanceQuery = createQuery(() => ({
  queryKey: hrKeys.leaveBalance(workspaceId, undefined),
  enabled: Boolean(workspaceId),
  queryFn: () => api.leave.balance.get({ workspaceId }),
}))
const balances = $derived(balanceQuery.data ?? [])

const requestsQuery = createQuery(() => ({
  queryKey: hrKeys.leaveRequests(workspaceId, undefined),
  enabled: Boolean(workspaceId),
  queryFn: () => api.leave.requests.list({ workspaceId, limit: 50 }),
}))
const requests = $derived(requestsQuery.data?.items ?? [])

/**
 * A disabled query is `pending` and not fetching, so it is not "loading" — without the workspace
 * test the first frame of this page shows the empty state of both halves to somebody who has
 * twenty days left.
 */
const balanceLoading = $derived(!workspaceId || balanceQuery.isLoading)
const requestsLoading = $derived(!workspaceId || requestsQuery.isLoading)

/**
 * A failed refetch that still has an answer to show.
 *
 * Everything here is invalidated by a cancellation and by any decision an approver makes, so a
 * refetch failing while the last good balance is still in `data` is the ordinary case — an error
 * branch above the data would blank a working page for as long as core takes to come back. One
 * strip for both queries rather than two: when core is unreachable both fail, and two identical
 * warnings stacked on one page is noise.
 */
const stale = $derived(
  (balanceQuery.isError && balances.length > 0) || (requestsQuery.isError && requests.length > 0),
)
const refetchAll = () => {
  void balanceQuery.refetch()
  void requestsQuery.refetch()
}

const days = (n: number) => formatDays(n, messageLocale())

/**
 * The unit a type is counted in decides the word beside the number. A type counted in hours read
 * "7 days available" on this strip until the ledger needed the distinction anyway; half-days are
 * still days.
 */
const unitWord = (unit: string, count: number) => t(unit === 'hour' ? 'hours' : 'days', { count })

// ---------------------------------------------------------------- the ledger behind a tile

const canLedger = $derived(canHr('leaveViewLedger'))
/**
 * The type whose ledger is open, rather than the row itself: held by id, the panel keeps reading the
 * live query row, so an adjustment made inside it moves the figure at the top of the panel as soon
 * as the invalidation lands. A captured copy would sit there stating the old number.
 */
let ledgerTypeId = $state<string | null>(null)
const ledgerBalance = $derived(balances.find((b) => b.leaveTypeId === ledgerTypeId) ?? null)

/**
 * The request waiting on a confirmation, and what the last attempt said.
 *
 * `cancelInFlight` rather than `cancel.isPending`: the disabled attribute only reaches the button
 * on the next render, so two quick clicks both fire — and the second one arrives at a request the
 * first has already cancelled, which the server answers with a refusal the person did nothing to
 * deserve.
 */
let cancelling = $state<LeaveRequest | null>(null)
let cancelInFlight = $state(false)
let cancelError = $state<string | null>(null)

const cancel = createMutation(() => ({
  mutationFn: (requestId: string) => api.leave.requests.cancel({ workspaceId, requestId }),
  onSuccess: () => {
    cancelling = null
    cancelError = null
    toast.success(t('leave_cancelled_toast'))
    // Cancelling moves a balance and the team calendar as well as this list, so the whole module's
    // cache is invalidated rather than guessing which keys moved.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error) => {
    cancelError = cancelFailure(error)
    // A refusal is the server saying its picture of this request is not the one on screen — most
    // often because somebody decided it, or it was already cancelled from another device. Re-read
    // all of HR exactly as a cancellation that landed does; without this the same dead row sits in
    // the list and every retry earns the same sentence.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onSettled: () => {
    cancelInFlight = false
  },
}))

/**
 * The cancellation refusals this module has its own sentence for, keyed by the `reason` the router
 * sends beside the refusal — never by the sentence, because a list of sentences is a list somebody
 * has to keep in sync and the day it drifts the reader is told nothing.
 *
 * Empty on purpose. `leave.requests.cancel` refuses through `KernError.conflict`, whose reason
 * argument reaches the client as `data.reason` — `kernErrorToORPC` serialises it — so a refusal
 * names itself in a form this module can translate. Anything the router refuses without one still
 * arrives as its own sentence, which is the fallback below and not a failure.
 */
const cancelRefusalMessages: Record<string, string> = {
  'hr.leave.already_cancelled': 'leave_cancel_refused_cancelled',
  'hr.leave.already_withdrawn': 'leave_cancel_refused_withdrawn',
}

/**
 * What a refused cancellation says to the person who asked for it.
 *
 * A cancellation is refused when the request is no longer theirs to cancel — it is already
 * cancelled, or withdrawn — and the router's sentence is the only thing that says which. It used to
 * be `error.message` for everything, which puts a gateway's English at somebody who reads Persian
 * and cannot act on it either way. Everything else that can fail here carries machine text, so it
 * falls back to this module's own string.
 *
 * The test is the transport's `code`, never the sentence: `KernError.conflict` is what arrives as
 * CONFLICT, so a refusal added to `cancel()` later reaches the reader without anyone editing this
 * file. The same shape as `ClockControls.svelte` and the approvals inbox.
 */
function cancelFailure(error: unknown): string {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (failure.code !== 'CONFLICT') return t('leave_cancel_error')
  const reason = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason ? cancelRefusalMessages[reason] : undefined
  // `t()` answers a key it has no string for with the key itself, so both ways of not having one —
  // a reason no key covers, and a key whose string has not been merged — land on the router's
  // sentence rather than putting `hr.leave_cancel_refused_…` in front of somebody.
  const translated = key ? t(key) : undefined
  return (translated && translated !== key ? translated : failure.message) || t('leave_cancel_error')
}

const confirmCancel = () => {
  if (!cancelling || cancelInFlight) return
  cancelInFlight = true
  cancelError = null
  cancel.mutate(cancelling.id)
}

const closeCancel = () => {
  if (cancelInFlight) return
  cancelling = null
  cancelError = null
}

const statusLabel = (s: string) =>
  s === 'pending'
    ? t('leave_pending')
    : s === 'approved'
      ? t('leave_approved')
      : s === 'rejected'
        ? t('leave_rejected')
        : s === 'withdrawn'
          ? t('leave_withdrawn')
          : t('leave_cancelled')

const statusTone = (s: string) =>
  s === 'approved' ? 'done' : s === 'pending' ? 'upcoming' : s === 'rejected' ? 'declined' : 'grey'

/**
 * `formatDateRange` rather than `Intl` directly: it formats in the reader's *interface* language,
 * which is the one the rest of the row is written in, and it uses `formatRange` — a hand-built range
 * reads backwards under `dir="rtl"`, with the earlier date on the right.
 */
const dateRange = (from: string, to: string) => formatDateRange(`${from}T00:00:00`, `${to}T00:00:00`)

/**
 * An approved request can still be cancelled: the server reverses the ledger rather than deleting
 * it, so the balance goes back up and the history still says what happened. What it must not be is
 * one click away — see the dialog at the bottom of this file.
 */
const canCancel = (status: string) => canHr('leaveRequest') && (status === 'pending' || status === 'approved')
</script>

<PageHeader
  crumbs={[{ label: workspace?.name ?? '' }, { label: t('leave_title') }]}
  title={t('leave_title')}
>
  {#snippet actions()}
    {#if canHr('leaveRequest')}
      <Button size="sm" href={`/${workspaceSlug}/hr/leave?new=1`}>{t('request_leave')}</Button>
    {/if}
  {/snippet}
</PageHeader>

<Page>
  {#if stale}
    <p class="stale" role="status">
      <span>{t('leave_stale')}</span>
      <Button size="sm" variant="ghost" onclick={refetchAll}>{t('retry')}</Button>
    </p>
  {/if}

  {#if balanceLoading}
    <div class="tiles">
      {#each [1, 2, 3] as n (n)}<Skeleton height="96px" />{/each}
    </div>
  {:else if balances.length}
    <div class="tiles">
      {#each balances as balance (balance.leaveTypeId)}
        {#if canLedger}
          <!--
            The whole tile is the control, so the target is the size of the thing somebody is
            looking at rather than a link tucked in a corner. `aria-label` names the action, which
            is what stops a screen reader reading the number twice and the verb never.
          -->
          <button
            type="button"
            class="tile-button"
            aria-label={t('leave_ledger_open', { name: balance.leaveTypeName })}
            onclick={() => (ledgerTypeId = balance.leaveTypeId)}
          >
            <StatTile
              class="ledger-tile"
              label={balance.leaveTypeName}
              value={days(balance.available)}
              note={`${t('available')} · ${unitWord(balance.unit, balance.available)}`}
            >
              <span class="cue">
                <Icon name="scroll-text" size={13} strokeWidth={1.7} />
                {t('leave_ledger')}
              </span>
            </StatTile>
          </button>
        {:else}
          <StatTile
            label={balance.leaveTypeName}
            value={days(balance.available)}
            note={`${t('available')} · ${unitWord(balance.unit, balance.available)}`}
          />
        {/if}
      {/each}
    </div>
  {:else if balanceQuery.isError}
    <div class="tiles-slot">
      <EmptyState icon="triangle-alert" title={t('balance_error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void balanceQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <!--
      No balances means no leave types: the server returns one row per type, so an empty answer is a
      workspace nobody has configured yet rather than a person with nothing left. The way out is
      only offered to somebody who has it — a member cannot create a leave type, and a button that
      404s is worse than none.
    -->
    <div class="tiles-slot">
      <EmptyState
        icon="tree-palm"
        compact
        title={t('leave_types_none')}
        description={canHr('leaveManage') ? t('leave_types_none_desc') : undefined}
      >
        {#snippet actions()}
          {#if canHr('leaveManage')}
            <Button
              size="sm"
              variant="secondary"
              icon="settings"
              href={`/${workspaceSlug}/settings/hr/leave`}
            >
              {t('leave_types')}
            </Button>
          {/if}
        {/snippet}
      </EmptyState>
    </div>
  {/if}

  <h2>{t('leave_title')}</h2>
  {#if requestsLoading}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="58px" />{/each}
    </div>
  {:else if requests.length}
    <ul>
      {#each requests as request (request.id)}
        <li>
          <Card>
            <div class="row">
              <span class="dates">{dateRange(request.startsOn, request.endsOn)}</span>
              <span class="meta">{days(request.workingDays)} {t('days', { count: request.workingDays })}</span>
              <Badge tone={statusTone(request.status)}>{statusLabel(request.status)}</Badge>
              {#if canCancel(request.status)}
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => {
                    cancelError = null
                    cancelling = request
                  }}>{t('cancel_request')}</Button
                >
              {/if}
            </div>
          </Card>
        </li>
      {/each}
    </ul>
  {:else if requestsQuery.isError}
    <EmptyState icon="triangle-alert" title={t('leave_requests_error')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void requestsQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <EmptyState icon="tree-palm" title={t('leave_none')} description={t('leave_none_desc')} />
  {/if}
</Page>

<LeaveRequestDialog open={requesting} {workspaceId} {workspaceSlug} />

<LeaveLedgerPanel
  balance={ledgerBalance}
  {workspaceId}
  personName={session.user?.name ?? ''}
  onClose={() => (ledgerTypeId = null)}
/>

<!--
  Cancelling is not undoing, and the person clicking has to know what it costs before it happens: a
  small ghost button beside a status badge was wired straight to the mutation, so one misclick threw
  away a granted week. The body names the dates, the days that come back and the fact that the team
  stops seeing the absence — an approved request also says so in its own line, because those are the
  days colleagues have already planned around.
-->
<Dialog
  open={cancelling !== null}
  size="sm"
  title={t('leave_cancel_title')}
  onOpenChange={(next) => {
    if (!next) closeCancel()
  }}
>
  {#if cancelling}
    <p class="body">
      {t('leave_cancel_body', {
        count: cancelling.workingDays,
        range: dateRange(cancelling.startsOn, cancelling.endsOn),
      })}
    </p>
    {#if cancelling.status === 'approved'}
      <p class="body note">{t('leave_cancel_approved')}</p>
    {/if}
  {/if}
  {#if cancelError}
    <p class="body failed" role="alert">{cancelError}</p>
  {/if}

  {#snippet footer()}
    <!--
      Secondary, as in `DecisionDialog`: on a destructive confirmation the way *out* must not be the
      faintest control on it. And it says "Keep it booked" rather than `cancel` — the shared string
      every other dialog here uses — because "Cancel" beside "Cancel request" asks somebody to work
      out which of two identical words abandons the booking and which destroys it.
    -->
    <Button variant="secondary" onclick={closeCancel} disabled={cancelInFlight}>
      {t('leave_cancel_keep')}
    </Button>
    <Button variant="danger" loading={cancelInFlight} onclick={confirmCancel}>{t('cancel_request')}</Button>
  {/snippet}
</Dialog>

<style>
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
  margin-block-end: 20px;
}
/*
 * The tile is a button, so it needs the button reset undone: the global one strips background,
 * border and padding, and the tile inside paints its own.
 */
.tile-button {
  display: block;
  width: 100%;
  text-align: start;
  font: inherit;
  color: inherit;
  border-radius: var(--kern-r-2xl);
}
.tile-button:hover :global(.ledger-tile) {
  background: var(--kern-surface-card-hover);
}
.cue {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-block-start: 10px;
  font-size: 12px;
  /* A colour, not opacity: 6.74:1 on the tile in light, 6.12:1 in dark. */
  color: var(--kern-ink-500);
}
/* Keeps an error or empty balance on the same rhythm as the tiles it stands in for. */
.tiles-slot {
  margin-block-end: 20px;
}
.rows {
  display: grid;
  gap: 8px;
}
/*
 * The warning ink is 4.37:1 on `--kern-canvas`, which is what this page sits on — under the 4.5 a
 * 12.5px line has to clear. On its own tint it is 4.58:1 in light and 5.28:1 in dark, and the tint
 * is what makes the strip read as a notice rather than as another row.
 */
.stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-block: 0 12px;
  padding-block: 6px;
  padding-inline: 12px 8px;
  border-radius: var(--kern-r-md);
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
  font-size: 12.5px;
}
h2 {
  font-size: 13.5px;
  margin: 0 0 12px;
}
ul {
  display: grid;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dates {
  flex: 1;
  font-weight: 500;
}
.meta {
  color: var(--kern-ink-500);
  font-size: 12px;
}
.body {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kern-ink-700);
}
/* A colour, not opacity: opacity fades the text against the dialog whatever token it names. */
.note {
  margin-block-start: 8px;
  color: var(--kern-ink-500);
}
/* A dialog body sits on --kern-surface-raised, not the page: 6.33:1 there in light, 5.04:1 in dark. */
.failed {
  margin-block-start: 8px;
  color: var(--kern-danger);
}
</style>
