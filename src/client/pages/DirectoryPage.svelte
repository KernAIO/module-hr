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
  Icon,
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
import { personnelWithheld } from '../components/redaction.js'
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

/**
 * A query parameter is whatever somebody pasted into the address bar, and the contract types both
 * filters as uuids — so a truncated or hand-edited link would be refused by the server and this
 * screen would draw a red error where a filter was meant. Anything that is not a uuid is no filter.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const asId = (value: string | undefined): string | null => (value && UUID.test(value) ? value : null)

let search = $state('')
/**
 * The filter the directory was opened with.
 *
 * Both are links from somewhere else — an office row on the offices screen, "See the people" on a
 * department — and until this read the query string they landed on the unfiltered company
 * directory, which reads as the link being broken rather than as a filter that never applied.
 *
 * Seeded here rather than in the `$effect` below, and that is load-bearing: an effect runs after
 * the first render, so `people.list` would fetch and draw the whole company for a beat before
 * narrowing to the office somebody actually clicked.
 */
let officeTab = $state(asId(navigation.search.officeId) ?? 'all')
let orgUnitId = $state<string | null>(asId(navigation.search.orgUnit))
const selected = $derived(navigation.search.person)
const creating = $derived(navigation.search.new === '1')

/**
 * The URL keeps seeding the filter after that first render: arriving from the offices screen while
 * the directory is already mounted changes the query string without remounting anything, and the
 * back button is a filter change too. It only ever writes what it does not read, so there is no loop.
 */
$effect(() => {
  officeTab = asId(navigation.search.officeId) ?? 'all'
  orgUnitId = asId(navigation.search.orgUnit)
})

/**
 * A filter change is written to the URL as well as to state, so the address bar always describes
 * what is on screen: a reload, a shared link and the back button all land on the same directory.
 * `person` and `new` are carried through rather than rebuilt, or switching office would close a
 * panel somebody has open.
 *
 * `replaceState` because a filter is not a place — the way back from a filtered directory is the
 * screen that linked into it, not one history entry per pill.
 */
function writeFilter(patch: { officeId?: string | null; orgUnit?: string | null }) {
  const params = new URLSearchParams(navigation.search)
  for (const [key, value] of Object.entries(patch)) {
    if (value) params.set(key, value)
    else params.delete(key)
  }
  const query = params.toString()
  navigation.go(`/${workspaceSlug}/hr${query ? `?${query}` : ''}`, {
    replaceState: true,
    keepFocus: true,
    noScroll: true,
  })
}

/** State first, URL second: the shell's router is asynchronous and the pills must not lag a click. */
function chooseOffice(value: string) {
  officeTab = value
  writeFilter({ officeId: value === 'all' ? null : value })
}

/**
 * Clears the search along with the office and the department.
 *
 * The empty state that offers this button is reached when a filter is on, which includes the case
 * where a *search* inside that filter is what found nobody. Clearing only the filter there leaves
 * the term in the box, so the table can still be empty after the click — a button that visibly does
 * nothing, on the one screen where the reader has already failed to find someone.
 */
function clearFilters() {
  officeTab = 'all'
  orgUnitId = null
  search = ''
  debounced = ''
  writeFilter({ officeId: null, orgUnit: null })
}

/**
 * A row link carries the filter it was opened from.
 *
 * Now that the filter is in the query string, a bare `?person=…` is also a request to show the
 * whole company — so opening somebody from an office directory would quietly re-fetch and redraw
 * every person in the workspace behind the panel. `new` is dropped rather than kept: two dialogs
 * over one directory is not a state anything should be able to link to.
 */
function personHref(personId: string): string {
  const params = new URLSearchParams(navigation.search)
  params.delete('new')
  params.set('person', personId)
  return `/${workspaceSlug}/hr?${params.toString()}`
}

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

/**
 * What the filter asks the server for, shared by the table and the counts above it.
 *
 * `includeDescendants` is passed rather than left to the contract's default: the number on the
 * "See the people" button that links here is the department's *subtree* total, and a directory
 * holding fewer people than the link promised is the same defect one layer down.
 */
const scopeArgs = $derived({
  ...(officeTab !== 'all' ? { officeId: officeTab } : {}),
  ...(orgUnitId ? { orgUnitId, includeDescendants: true } : {}),
})
/**
 * The same filter as a cache key. `'all'` is spelled out rather than left absent, so that no two
 * scopes ever hash alike and the cache cannot answer a filtered directory with the whole company.
 */
const scopeKey = $derived({ officeId: officeTab, orgUnitId: orgUnitId ?? 'all' })

const officesQuery = createQuery(() => ({
  queryKey: hrKeys.offices(workspaceId),
  enabled: Boolean(workspaceId) && showOffices && canHr('officeView'),
  queryFn: () => api.offices.list({ workspaceId, includeArchived: false }),
}))
const offices = $derived(officesQuery.data ?? [])

const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { ...scopeKey, q: debounced }),
  enabled: Boolean(workspaceId),
  queryFn: () =>
    api.people.list({
      workspaceId,
      limit: 100,
      ...(debounced ? { q: debounced } : {}),
      ...scopeArgs,
    }),
}))
const people = $derived(peopleQuery.data?.items ?? [])

/**
 * The tiles count the company, not the page.
 *
 * `people.list` returns a `total` for the whole filter, so both numbers are asked of the server
 * with `limit: 1` rather than counted off the rows on screen. Counting the rows made "On leave"
 * fall as somebody typed a name — the table narrows on every keystroke and stops at a hundred rows
 * either way — which is a tile reporting the search box while wearing the label of a company fact.
 *
 * The search is deliberately not part of these: a tile describes the scope the directory is
 * showing, and finding one person inside it does not change how many of them are away. The filter
 * *is* part of them, so an office's directory shows that office's numbers.
 */
const headcountQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { ...scopeKey, count: 'headcount' }),
  enabled: Boolean(workspaceId),
  queryFn: () => api.people.list({ workspaceId, limit: 1, ...scopeArgs }),
}))

const onLeaveQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { ...scopeKey, count: 'on_leave' }),
  enabled: Boolean(workspaceId),
  queryFn: () => api.people.list({ workspaceId, limit: 1, status: ['on_leave'], ...scopeArgs }),
}))

/**
 * Only to name the department in the filter chip, so it is asked for only when there is one to
 * name. It shares `hrKeys.orgUnits` with the org chart, which is where "See the people" is clicked
 * — so arriving from there costs no request at all.
 */
const orgUnitsQuery = createQuery(() => ({
  queryKey: hrKeys.orgUnits(workspaceId),
  enabled: Boolean(workspaceId) && orgUnitId !== null && canHr('orgView'),
  queryFn: () => api.org.units.tree({ workspaceId, includeArchived: false }),
}))
const orgUnitName = $derived(orgUnitsQuery.data?.find((u) => u.id === orgUnitId)?.name ?? null)

/** Office tabs only once there is more than one place of work — otherwise they say nothing. */
const tabs = $derived([
  { value: 'all', label: t('title') },
  ...offices.map((o) => ({ value: o.id, label: o.name })),
])

/**
 * Whether the office filter has to be said in words.
 *
 * A selected pill already says it, so this is for what the tabs cannot cover: a workspace with one
 * office (no tabs at all), a viewer without `hr.office.view`, and an id that is not in the list any
 * more — an archived office whose link somebody kept. There is no name to give in any of those
 * cases, which is why the chip's wording does not promise one.
 *
 * While the offices are still loading there is nothing to say yet and the table is drawing
 * skeletons, so it waits rather than flashing a sentence a pill is about to replace.
 */
const officeNeedsChip = $derived(
  officeTab !== 'all' && !officesQuery.isLoading && !tabs.some((tab) => tab.value === officeTab),
)
/** Any filter at all — what decides whether an empty table is "nobody yet" or "nobody here". */
const filtered = $derived(officeTab !== 'all' || orgUnitId !== null)

const balancesQuery = createQuery(() => ({
  queryKey: hrKeys.leaveBalance(workspaceId, undefined),
  enabled: Boolean(workspaceId) && showBalance,
  queryFn: () => api.leave.balance.get({ workspaceId }),
}))

const inboxQuery = createQuery(() => ({
  queryKey: hrKeys.approvalInbox(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.approvals.inbox({ workspaceId, limit: 6, status: 'pending' }),
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
  headcount: headcountQuery.data?.total ?? null,
  offices: offices.length,
  away: onLeaveQuery.data?.total ?? null,
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

/**
 * Whether this row's start date is blank because the server withheld it.
 *
 * The hire date is one of the four fields `HrAccessService` nulls for a reader outside its scope,
 * and it arrives here as a null like any other — so the em dash this column drew for it said
 * "never started", about everybody in the company, to every colleague without a widening key.
 *
 * The record says which it is — `personnelHidden`, set at the one place that does the nulling — so
 * a row is marked only when the server actually withheld it, and a genuinely empty hire date keeps
 * its dash. Marked once, under the table, rather than per row.
 *
 * The `!person.hiredOn` half stays deliberately: the mark only ever goes over a value that is
 * absent, so a stale or unrecognised payload can never paint "Hidden" across data on screen.
 */
const startWithheld = (person: { hiredOn: string | null; personnelHidden?: boolean }) =>
  !person.hiredOn && personnelWithheld(person)

/** Whether anything on the page is actually marked — the sentence must not outlive the marks. */
const anyWithheld = $derived(people.some(startWithheld))

/** `formatCount` caps at 99 for badges. A headcount is a real number and must not read "99+". */
const count = (n: number) => formatCount(n, Number.MAX_SAFE_INTEGER)

/**
 * A count nobody has yet is an em dash, never a zero.
 *
 * "0 on leave" is a fact about the company, and a tile stating it while the request is still in
 * flight — or after it failed — is the same lie the tile was counting rows to tell.
 */
const tileCount = (n: number | null) => (n === null ? '—' : count(n))
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
    <StatTile size="md" label={t('widget_headcount_title')} value={tileCount(stats.headcount)} />
    <!--
      Only where the workspace has offices. It rendered unconditionally and read "Offices 0" on a
      single-site workspace — a tile counting a feature nobody switched on, sitting beside three
      that mean something. A capability that is off has no surface at all, tiles included.
    -->
    {#if showOffices}
      <StatTile size="md" label={t('offices_title')} value={count(stats.offices)} />
    {/if}
    <!--
      The number comes from the server, and the note says which number it is: "On leave" over a
      figure could as easily mean this week or this month, and it means neither.
    -->
    <StatTile size="md" label={t('status_on_leave')} value={tileCount(stats.away)} note={t('on_leave_note')} />
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
          <Tabs items={tabs} value={officeTab} variant="pill" label={t('office')} onValueChange={chooseOffice} />
        {/if}
        <!--
          What the pills cannot say. A directory that opened filtered and says nothing about it is
          indistinguishable from a directory that lost half the company, so anything the tabs are not
          already showing gets a chip — and one control puts every filter back at once.
        -->
        {#if officeNeedsChip || orgUnitId}
          <div class="active">
            {#if officeNeedsChip}
              <span class="chip">
                <Icon name="building" size={12} strokeWidth={1.8} />{t('filter_office_unnamed')}
              </span>
            {/if}
            {#if orgUnitId}
              <span class="chip">
                <Icon name="git-branch" size={12} strokeWidth={1.8} />
                {orgUnitName ? t('filter_department', { name: orgUnitName }) : t('filter_department_unnamed')}
              </span>
            {/if}
            <Button size="xs" variant="ghost" onclick={clearFilters}>{t('filter_clear')}</Button>
          </div>
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
            <a class="trow" role="row" href={personHref(person.id)}>
              <span class="cell who" role="cell">
                <Avatar name={person.displayName} id={person.id} size={28} />
                <span class="stack">
                  <span class="name">{person.displayName}</span>
                  {#if person.workEmail}<span class="sub">{person.workEmail}</span>{/if}
                </span>
              </span>
              <span class="cell role" role="cell">{person.employeeNo ?? '—'}</span>
              <span class="cell muted" role="cell">{person.officeName ?? '—'}</span>
              <span class="cell muted" role="cell">
                {#if startWithheld(person)}
                  <span class="withheld"><Icon name="eye-off" size={12} strokeWidth={1.8} />{t('person_hidden')}</span>
                {:else}{started(person.hiredOn)}{/if}
              </span>
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
      <!--
        "Nobody here yet — add the first person" is the right sentence for an empty company and the
        wrong one for an office with nobody in it: it invites somebody to create a second record for
        a person the filter is simply hiding. A filtered miss offers the way out instead.
      -->
      {:else if filtered}
        <EmptyState icon="search" title={t('no_people_match')} description={t('no_people_match_filtered')}>
          {#snippet actions()}
            <Button variant="secondary" onclick={clearFilters}>{t('filter_clear')}</Button>
          {/snippet}
        </EmptyState>
      {:else if debounced}
        <EmptyState icon="search" title={t('no_people_match')} description={t('no_people_match_search')} />
      {:else}
        <EmptyState icon="users" title={t('no_people')} description={t('no_people_desc')} />
      {/if}

      <!--
        Once for the table, not once per row. A marked cell says which fact is missing and this says
        why it is missing — a column of "Hidden" with nothing accounting for it reads as a fault.
      -->
      {#if anyWithheld}
        <p class="hint">{t('person_hidden_hint')}</p>
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
  /* A department name is as long as somebody named it, and Persian and German run longer than the
     English it was laid out in. The row wraps rather than crushing the search box. */
  flex-wrap: wrap;
  margin-block: 4px 8px;
}
.search {
  margin-inline-start: auto;
  inline-size: min(260px, 40%);
}
.active {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-inline-size: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding-inline: 9px;
  block-size: 24px;
  border-radius: var(--kern-r-full);
  background: var(--kern-surface-chip);
  font-size: 12px;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-700);
  white-space: nowrap;
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
/* A colour, never opacity, for the same reason `.sub` and `.muted` above use one. */
.withheld {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-inline-size: 0;
}
.hint {
  margin: 10px 0 0;
  max-inline-size: 68ch;
  font-size: 12px;
  line-height: 1.45;
  color: var(--kern-ink-500);
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
