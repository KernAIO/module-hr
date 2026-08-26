<script lang="ts">
import {
  Avatar,
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  formatCount,
  formatDate,
  Input,
  messageLocale,
  navigation,
  Page,
  PageHeader,
  SectionLabel,
  Skeleton,
  StatTile,
  session,
  Tabs,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import DecisionDialog from '../components/DecisionDialog.svelte'
import PersonFormDialog from '../components/PersonFormDialog.svelte'
import PersonPanel from '../components/PersonPanel.svelte'
import { t } from '../i18n.js'
import type { ApprovalRequest } from '../index.js'
import { canHr, HR_CAPABILITIES } from '../permissions.js'
import { formatDays, hrKeys } from '../query.js'
import { summarise } from '../summary.js'

/**
 * The people view, laid out to DESIGN.md §3.12.
 *
 * A row of stat tiles, then `minmax(0,1fr) 320px`: a real table on the left — name, role, office,
 * started, status on one grid so the columns line up down the page — and the things that need a
 * decision on the right. A flat list of names would be a directory; this is the screen somebody
 * actually opens in the morning, which is why what is waiting on them sits beside it.
 *
 * Each row carries the person's **local time**, because the directory of a company with more than
 * one office is also the answer to "can I call them now".
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

let search = $state('')
let officeTab = $state('all')
const selected = $derived(navigation.search.person)
const creating = $derived(navigation.search.new === '1')

const showOffices = $derived(session.hasCapability('hr', HR_CAPABILITIES.offices))
/**
 * Leave is a capability, and a workspace that never switched it on has no balance to show.
 *
 * Without this the main HR screen fired `leave.balance.get` on every load of a directory-only
 * workspace and got a 404 back — the honest answer for a feature nobody enabled — leaving an
 * "Available days" tile reading zero for ever beside three tiles that meant something.
 */
const showLeave = $derived(session.hasCapability('hr', HR_CAPABILITIES.leave))
/**
 * And the tile needs the permission as well as the capability: `leave.balance.get` is behind
 * `hr.leave.view`, and a tile reading "0" because the request was refused is a worse answer than
 * no tile.
 */
const showBalance = $derived(showLeave && canHr('leaveView'))

/** Debounced: every keystroke would otherwise be a request, and the term is part of the cache key. */
let debounced = $state('')
$effect(() => {
  const term = search
  const handle = setTimeout(() => {
    debounced = term
  }, 250)
  return () => clearTimeout(handle)
})

const officesQuery = createQuery(() => ({
  queryKey: hrKeys.offices(workspaceId),
  enabled: Boolean(workspaceId) && showOffices && canHr('officeView'),
  queryFn: () => api.offices.list({ workspaceId, includeArchived: false }),
}))
const offices = $derived(officesQuery.data ?? [])

const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { q: debounced, officeId: officeTab }),
  enabled: Boolean(workspaceId),
  queryFn: () =>
    api.people.list({
      workspaceId,
      limit: 100,
      ...(debounced ? { q: debounced } : {}),
      ...(officeTab !== 'all' ? { officeId: officeTab } : {}),
    }),
}))
const people = $derived(peopleQuery.data?.items ?? [])

/** Office tabs only once there is more than one place of work — otherwise they say nothing. */
const tabs = $derived([
  { value: 'all', label: t('title') },
  ...offices.map((o) => ({ value: o.id, label: o.name })),
])

const balancesQuery = createQuery(() => ({
  queryKey: hrKeys.leaveBalance(workspaceId, undefined),
  enabled: Boolean(workspaceId) && showBalance,
  queryFn: () => api.leave.balance.get({ workspaceId }),
}))

const inboxQuery = createQuery(() => ({
  queryKey: hrKeys.approvalInbox(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.approvals.inbox({ workspaceId, limit: 6, includeDecided: false }),
}))
const waiting = $derived(inboxQuery.data?.items ?? [])

let deciding = $state<{ request: ApprovalRequest; decision: 'approve' | 'reject' } | null>(null)
let decideError = $state<string | null>(null)

/**
 * `submitting` rather than `decide.isPending`: the disabled attribute only reaches the confirm
 * button on the next render, so two quick clicks both fire and one request is decided twice. This
 * is set in the same tick as the click.
 */
let submitting = $state(false)

/**
 * The decision refusals this module has its own sentence for, keyed by the `reason` the router
 * sends beside the refusal. The same shape as `ClockControls.svelte`, and empty for the same reason
 * the widget's is: `approvals.decide` refuses through `KernError.conflict`, whose reason argument
 * stays on the server, so a refusal arrives today as the sentence the router wrote for a reader.
 */
const decideRefusalMessages: Record<string, string> = {}

/**
 * What a refused decision says to the person who made it.
 *
 * A decision is refused when the request is no longer theirs to decide — somebody else approved it,
 * the requester cancelled it, a delegation moved the step — and that sentence is the only thing
 * saying which. Everything else that can fail carries machine text in English, so it falls back to
 * this module's own string. The test is the transport's `code`, never the sentence.
 */
function decideFailure(error: unknown): string {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (failure.code !== 'CONFLICT') return t('decide_error')
  const reason = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason ? decideRefusalMessages[reason] : undefined
  // `t()` answers a key it has no string for with the key itself, so a reason nothing is written
  // for lands on the router's sentence rather than putting `hr.decide_refused_…` in front of a
  // person.
  const translated = key ? t(key) : undefined
  return (translated && translated !== key ? translated : failure.message) || t('decide_error')
}

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
    // Deciding moves a balance and a day sheet as well as the inbox, so the whole module's cache is
    // invalidated rather than guessing which keys moved.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error) => {
    decideError = decideFailure(error)
    // A refusal is the server saying its inbox is not the one on screen, so the row behind the
    // dialog is stale as well as the decision. Re-read all of HR exactly as a decision that landed
    // does — without this the same dead row sits here and every retry earns the same sentence.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onSettled: () => {
    submitting = false
  },
}))

const ask = (request: ApprovalRequest, decision: 'approve' | 'reject') => {
  decideError = null
  deciding = { request, decision }
}

const confirmDecision = (comment: string) => {
  if (!deciding || submitting) return
  submitting = true
  decide.mutate({ requestId: deciding.request.id, decision: deciding.decision, comment })
}

/** The same map as the approvals inbox: a card labelled "Leave" over an overtime request lies. */
const SUBJECT_LABELS: Record<string, () => string> = {
  leave: () => t('leave_title'),
  regularization: () => t('attendance_title'),
  overtime: () => t('att_overtime'),
  timesheet: () => t('approval_subject_timesheet'),
  shift_swap: () => t('approval_subject_shift_swap'),
}
const subjectLabel = (subjectType: string) => SUBJECT_LABELS[subjectType]?.() ?? subjectType

const stats = $derived({
  headcount: peopleQuery.data?.total ?? people.length,
  offices: offices.length,
  away: people.filter((p) => p.status === 'on_leave').length,
  balance: balancesQuery.data?.[0]?.available ?? 0,
})

const statusLabel = (s: string) =>
  s === 'active'
    ? t('status_active')
    : s === 'onboarding'
      ? t('status_onboarding')
      : s === 'on_leave'
        ? t('status_on_leave')
        : s === 'offboarding'
          ? t('status_offboarding')
          : t('status_terminated')

/** The design system already has tones for these exact states — §1.1 semantic chips. */
const statusTone = (s: string): BadgeTone =>
  s === 'active'
    ? 'active'
    : s === 'on_leave'
      ? 'on-leave'
      : s === 'onboarding'
        ? 'onboarding'
        : s === 'terminated'
          ? 'grey'
          : 'upcoming'

/** Re-renders the clocks once a minute; a directory showing a stale time is worse than none. */
let tick = $state(0)
$effect(() => {
  const handle = setInterval(() => {
    tick++
  }, 60_000)
  return () => clearInterval(handle)
})

/**
 * `messageLocale()`, never the runtime default: a Persian reader gets Persian digits from `t()` in
 * the same row, and a clock in Latin ones beside them is the one number nobody translated.
 */
function localTime(timezone: string | null, _tick: number): string | null {
  void _tick
  if (!timezone) return null
  try {
    return new Intl.DateTimeFormat(messageLocale(), {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date())
  } catch {
    // An unknown zone must not take the directory down with it.
    return null
  }
}

const started = (iso: string | null) =>
  iso ? formatDate(`${iso}T00:00:00`, { month: 'short', year: 'numeric' }) : '—'

/** `formatCount` caps at 99 for badges. A headcount is a real number and must not read "99+". */
const count = (n: number) => formatCount(n, Number.MAX_SAFE_INTEGER)
</script>

<PageHeader
  crumbs={[{ label: workspace?.name ?? '' }, { label: t('title') }]}
  title={t('title')}
  subtitle={t('subtitle')}
>
  {#snippet actions()}
    {#if canHr('personManage')}
      <Button size="sm" href={`/${workspaceSlug}/hr?new=1`}>{t('add_person')}</Button>
    {/if}
  {/snippet}
</PageHeader>

<Page>
  <div class="tiles">
    <StatTile size="md" label={t('widget_headcount_title')} value={count(stats.headcount)} />
    <!--
      Only where the workspace has offices. It rendered unconditionally and read "Offices 0" on a
      single-site workspace — a tile counting a feature nobody switched on, sitting beside three
      that mean something. A capability that is off has no surface at all, tiles included.
    -->
    {#if showOffices}
      <StatTile size="md" label={t('offices_title')} value={count(stats.offices)} />
    {/if}
    <StatTile size="md" label={t('status_on_leave')} value={count(stats.away)} />
    <!-- Same rule for leave: the balance tile is the surface of a capability, so it goes with it. -->
    {#if showBalance}
      <StatTile
        size="md"
        label={t('available')}
        value={formatDays(stats.balance, messageLocale())}
        note={t('days', { count: stats.balance })}
      />
    {/if}
  </div>

  <div class="split">
    <section>
      <SectionLabel label={t('title')} count={count(people.length)} />

      <div class="filters">
        {#if tabs.length > 1}
          <Tabs items={tabs} value={officeTab} variant="pill" onValueChange={(v) => (officeTab = v)} />
        {/if}
        <div class="search">
          <Input bind:value={search} placeholder={t('search_people')} type="search" size="sm" />
        </div>
      </div>

      <!--
        Held rows outrank the error. Every decision taken on this page invalidates all of `['hr']`,
        so a failed background refetch leaves TanStack in `error` with the last good directory still
        in `data` — an error branch above this one would blank a working table on a transient
        failure. The error is the whole section only when there is nothing else to draw.
      -->
      {#if peopleQuery.isLoading}
        <div class="rows">
          {#each [1, 2, 3, 4, 5] as n (n)}<Skeleton height="48px" />{/each}
        </div>
      {:else if people.length > 0}
        <div class="table" role="table" aria-label={t('title')}>
          <div class="thead" role="row">
            <span role="columnheader">{t('title')}</span>
            <span role="columnheader">{t('employee_no')}</span>
            <span role="columnheader">{t('office')}</span>
            <span role="columnheader">{t('started')}</span>
            <span role="columnheader">{t('local_time')}</span>
            <span role="columnheader">{t('status')}</span>
          </div>
          {#each people as person (person.id)}
            {@const time = localTime(person.timezone, tick)}
            <a class="trow" role="row" href={`/${workspaceSlug}/hr?person=${person.id}`}>
              <span class="cell who" role="cell">
                <Avatar name={person.displayName} id={person.id} size={28} />
                <span class="stack">
                  <span class="name">{person.displayName}</span>
                  {#if person.workEmail}<span class="sub">{person.workEmail}</span>{/if}
                </span>
              </span>
              <span class="cell role" role="cell">{person.employeeNo ?? '—'}</span>
              <span class="cell muted" role="cell">{person.officeName ?? '—'}</span>
              <span class="cell muted" role="cell">{started(person.hiredOn)}</span>
              <span class="cell num" role="cell" title={person.timezone ?? ''}>{time ?? '—'}</span>
              <span class="cell" role="cell">
                <Badge tone={statusTone(person.status)}>{statusLabel(person.status)}</Badge>
              </span>
            </a>
          {/each}
        </div>
      {:else if peopleQuery.isError}
        <EmptyState icon="triangle-alert" title={t('people_error')}>
          {#snippet actions()}
            <Button variant="secondary" onclick={() => void peopleQuery.refetch()}>{t('retry')}</Button>
          {/snippet}
        </EmptyState>
      {:else}
        <EmptyState icon="users" title={t('no_people')} description={t('no_people_desc')} />
      {/if}
    </section>

    <aside>
      <SectionLabel label={t('approvals_title')} count={formatCount(waiting.length)} />
      <!-- Held cards outrank the error here too, and for the same reason: see the table above. -->
      {#if inboxQuery.isLoading}
        <Skeleton height="120px" />
      {:else if waiting.length > 0}
        <div class="cards">
          {#each waiting as item (item.id)}
            <Card>
              <div class="cardhead">
                <Badge tone="grey">{subjectLabel(item.subjectType)}</Badge>
              </div>
              <p class="summary">{summarise(item)}</p>
              <div class="cardactions">
                <Button size="sm" variant="secondary" onclick={() => ask(item, 'reject')}>{t('reject')}</Button>
                <Button size="sm" onclick={() => ask(item, 'approve')}>{t('approve')}</Button>
              </div>
            </Card>
          {/each}
        </div>
      {:else if inboxQuery.isError}
        <!--
          Without this the empty state below told somebody "Nothing waiting on you" when their inbox
          had simply failed to load — the one sentence on this page nobody would think to check.
        -->
        <EmptyState bare compact icon="triangle-alert" title={t('approvals_error')}>
          {#snippet actions()}
            <Button size="sm" variant="secondary" onclick={() => void inboxQuery.refetch()}>
              {t('retry')}
            </Button>
          {/snippet}
        </EmptyState>
      {:else}
        <EmptyState bare compact icon="check-check" title={t('approvals_none')} />
      {/if}
    </aside>
  </div>
</Page>

{#if selected}
  <PersonPanel personId={selected} {workspaceId} {workspaceSlug} />
{/if}

<!--
  The same dialog the approvals inbox uses. Rejecting somebody's leave is irreversible from the
  interface and notifies them, so it is never one click from a sidebar card — and the confirmation
  says what the decision does, per subject type and per position in the chain.
-->
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

<PersonFormDialog
  open={creating}
  {workspaceId}
  {workspaceSlug}
  {offices}
  showOffice={showOffices}
/>

<style>
/* §3.12: a row of stat tiles, then a 1fr / 320px split, gap 20. */
.tiles {
  display: grid;
  /* Not `repeat(4, …)`: the offices tile is only there when the capability is on, and a fixed
     four-column track left a hole in the row where it used to be. */
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  grid-auto-flow: column;
  gap: 12px;
  margin-block-end: 20px;
}
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 20px;
  align-items: start;
}
/* Tabs on the start edge, search on the end — logical properties so it flips under dir="rtl". */
.filters {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-block: 4px 8px;
}
.search {
  margin-inline-start: auto;
  width: min(260px, 40%);
}
.rows {
  display: grid;
  gap: 4px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  --hr-cols: minmax(180px, 1.1fr) minmax(80px, 0.5fr) minmax(90px, 0.6fr) 110px 96px 104px;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-cols);
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
  color: var(--kern-ink-400);
}
.trow {
  height: 48px;
  border-block-end: 1px solid var(--kern-border-hairline);
  text-decoration: none;
  color: inherit;
  border-radius: 6px;
}
.trow:hover {
  background: var(--kern-surface-raised, #fff);
}
.cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.who {
  display: flex;
  align-items: center;
  gap: 10px;
}
.stack {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.name {
  font-size: 13.5px;
  font-weight: 500;
}
.sub,
.muted {
  font-size: 12px;
  color: var(--kern-ink-500);
}
.role {
  font-size: 13px;
}
.num {
  font-size: 13px;
  color: var(--kern-ink-500);
  font-variant-numeric: tabular-nums;
}
.cards {
  display: grid;
  gap: 8px;
}
.cardhead {
  display: flex;
  align-items: center;
  gap: 8px;
}
.summary {
  font-size: 13.5px;
  margin: 7px 0 0;
}
.cardactions {
  display: flex;
  gap: 6px;
  margin-block-start: 11px;
}

/* Below 1024 the right column stacks under the table rather than squeezing it. */
@media (max-width: 1024px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
