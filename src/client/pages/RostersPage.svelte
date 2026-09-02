<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  formatDate,
  formatDateRange,
  IconButton,
  Input,
  messageLocale,
  navigation,
  Page,
  PageHeader,
  Select,
  Skeleton,
  session,
  Tabs,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import {
  MAX_COVERAGE_DAYS,
  MAX_ROSTER_DAYS,
  type RosterCoverageDay,
  type RosterDay,
  type RosterShift,
} from '../../contract/rosters.js'
import { getHrApi } from '../api-instance.js'
import { explainRefusal } from '../components/refusal.js'
import { anchorDay, crossesMidnight } from '../components/roster-shifts.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { addDays, daysInclusive, hrKeys, isoDate, monthRange } from '../query.js'

/**
 * The roster, read two ways.
 *
 * **Coverage** is the question a roster exists to answer — who is on Early on Tuesday — asked of
 * an office-day rather than of a person, which is exactly the question a set of weekly schedules
 * cannot be asked. Days across, shifts down, people in the cells. Under the shifts is the row the
 * contract calls `off`: the people a rotation covers on that date and does not put on a shift,
 * which is the answer to "who could I call in" and the second thing anybody looking at a grid
 * wants.
 *
 * **People** is one person's calendar over a range, rotation and overrides already resolved by the
 * server. Three sources reach the screen and they are drawn three ways, because the contract says
 * why they must be: a `pattern` day with no shifts is a *planned* rest day; an `override` is
 * somebody's decision about one day, and carries their note; `none` means nothing rosters this
 * person on this date at all. A screen that rendered `none` like a rest day would be telling
 * somebody their absence was intended.
 *
 * **Two permissions, not one.** `rosters.coverage` and the person picker cost
 * `hr.attendance.view_team`; reading your own roster costs `hr.attendance.view`, which is what
 * opens this route. So a person on a rotation sees this page with one view — their own — and the
 * coverage tab is not disabled-with-a-reason but absent, because a permission is not a state.
 *
 * **The range refusals are made here, in the reader's language.** The server refuses a reversed
 * range and one longer than the cap with an English sentence and no reason token; both are
 * arithmetic this page can do before asking, so it does, and never sends a request it knows the
 * answer to. What it cannot predict — the person-day ceiling on a coverage grid, which depends on
 * the population of the office — still shows the server's own sentence.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const viewTeam = $derived(canHr('attendanceViewTeam'))
const manage = $derived(canHr('attendanceManage'))

const number = (n: number) => new Intl.NumberFormat(messageLocale()).format(n)

const shiftRange = (shift: Pick<RosterShift, 'start' | 'end'>) =>
  formatDateRange(
    `${anchorDay(0)}T${shift.start}:00`,
    `${anchorDay(crossesMidnight(shift) ? 1 : 0)}T${shift.end}:00`,
    { hour: '2-digit', minute: '2-digit' },
  )

/** `formatDate` follows the interface language, which is what the rest of the row is written in. */
const dayLabel = (iso: string) =>
  formatDate(`${iso}T00:00:00`, { weekday: 'short', day: 'numeric', month: 'short' })
const weekdayLabel = (iso: string) => formatDate(`${iso}T00:00:00`, { weekday: 'short' })
const dayOfMonth = (iso: string) => formatDate(`${iso}T00:00:00`, { day: 'numeric' })

const today = isoDate()

// ---------------------------------------------------------------- the two views

/** The first view somebody without team rights can use is the only one they get. */
let view = $state<'coverage' | 'people'>('coverage')
$effect(() => {
  if (!viewTeam) view = 'people'
})
const tabs = $derived([
  ...(viewTeam ? [{ value: 'coverage', label: t('roster_view_coverage'), icon: 'layout-grid' }] : []),
  { value: 'people', label: viewTeam ? t('roster_view_people') : t('roster_view_mine'), icon: 'user' },
])

// ---------------------------------------------------------------- coverage

/** Monday to Sunday of the week `iso` falls in, the week a rota is read by. */
function weekOf(iso: string): { from: string; to: string } {
  const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay() // 0 is Sunday
  const monday = addDays(iso, weekday === 0 ? -6 : 1 - weekday)
  return { from: monday, to: addDays(monday, 6) }
}

let coverageFrom = $state(weekOf(isoDate()).from)
let coverageTo = $state(weekOf(isoDate()).to)
let officeId = $state('')

const officesQuery = createQuery(() => ({
  queryKey: hrKeys.offices(workspaceId),
  enabled: Boolean(workspaceId) && viewTeam,
  queryFn: () => api.offices.list({ workspaceId, includeArchived: false }),
}))
const officeOptions = $derived([
  { value: '', label: t('roster_office_all') },
  ...(officesQuery.data ?? []).map((o) => ({ value: o.id, label: o.name })),
])

/**
 * Why a range is refused before it is asked. Null when it is fine.
 *
 * The same two checks `rosterRefusal` makes on the server, so the sentence somebody reads is in
 * their language and arrives without a round trip.
 */
function rangeProblem(from: string, to: string, max: number, key: string): string | null {
  if (!from || !to) return null
  if (to < from) return t('roster_range_reversed')
  const days = daysInclusive(from, to)
  if (days > max) return t(key, { count: number(days), max: number(max) })
  return null
}
const coverageProblem = $derived(
  rangeProblem(coverageFrom, coverageTo, MAX_COVERAGE_DAYS, 'roster_range_too_long'),
)
const coverageReady = $derived(
  Boolean(workspaceId) && viewTeam && Boolean(coverageFrom) && Boolean(coverageTo) && !coverageProblem,
)

const coverageQuery = createQuery(() => ({
  queryKey: hrKeys.rosterCoverage(workspaceId, coverageFrom, coverageTo, officeId || undefined),
  enabled: coverageReady,
  queryFn: () =>
    api.rosters.coverage({
      workspaceId,
      from: coverageFrom,
      to: coverageTo,
      officeId: officeId || undefined,
    }),
}))
const coverage = $derived<RosterCoverageDay[]>(coverageQuery.data ?? [])

/**
 * The rows of the grid: every shift that appears on any day in the range, in start order, so a
 * shift nobody works on Tuesday still has its row and the eye can run along it.
 */
const coverageShifts = $derived.by(() => {
  const seen = new Map<string, RosterShift>()
  for (const day of coverage) for (const slot of day.slots) seen.set(slot.shift.id, slot.shift)
  return [...seen.values()].sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name))
})
const anybodyRostered = $derived(coverage.some((d) => d.slots.length > 0 || d.off.length > 0))
const peopleOn = (day: RosterCoverageDay, shiftId: string) =>
  day.slots.find((s) => s.shift.id === shiftId)?.people ?? []

function shiftWeek(delta: number) {
  coverageFrom = addDays(coverageFrom, delta * 7)
  coverageTo = addDays(coverageTo, delta * 7)
}
function thisWeek() {
  const week = weekOf(today)
  coverageFrom = week.from
  coverageTo = week.to
}

// ---------------------------------------------------------------- people

/** `'me'` is the caller; the server resolves it and never needs the id. */
let personChoice = $state('me')
const personId = $derived(personChoice === 'me' ? undefined : personChoice)

const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forRosterPage: true }),
  enabled: Boolean(workspaceId) && viewTeam,
  queryFn: () => api.people.list({ workspaceId, limit: 200, status: ['active'] }),
}))
const people = $derived(peopleQuery.data?.items ?? [])
const personOptions = $derived([
  { value: 'me', label: t('roster_me') },
  ...people.map((p) => ({ value: p.id, label: p.displayName })),
])
const personLabel = $derived(
  personChoice === 'me' ? t('roster_me') : (people.find((p) => p.id === personId)?.displayName ?? ''),
)

const thisMonth = monthRange()
let daysFrom = $state(thisMonth.from)
let daysTo = $state(thisMonth.to)
const daysProblem = $derived(rangeProblem(daysFrom, daysTo, MAX_ROSTER_DAYS, 'roster_range_too_long_person'))
const daysReady = $derived(Boolean(workspaceId) && Boolean(daysFrom) && Boolean(daysTo) && !daysProblem)

const daysQuery = createQuery(() => ({
  queryKey: hrKeys.rosterDays(workspaceId, personId, daysFrom, daysTo),
  enabled: daysReady,
  queryFn: () => api.rosters.days({ workspaceId, personId, from: daysFrom, to: daysTo }),
}))
const days = $derived<RosterDay[]>(daysQuery.data ?? [])

/**
 * The one refusal a person with no employee record meets: `rosters.days` for "me" answers
 * NOT_FOUND. That is not a failed load and must not offer "try again" — the answer is a sentence.
 */
const noRecord = $derived(
  daysQuery.isError && personChoice === 'me' && (daysQuery.error as { code?: unknown })?.code === 'NOT_FOUND',
)

function shiftMonth(delta: number) {
  const first = new Date(`${daysFrom}T00:00:00Z`)
  const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + delta, 1))
  const range = monthRange(new Date(next.getUTCFullYear(), next.getUTCMonth(), 1))
  daysFrom = range.from
  daysTo = range.to
}
function thisMonthAgain() {
  const range = monthRange()
  daysFrom = range.from
  daysTo = range.to
}

/** Whether a day is one somebody decided, one the rotation planned, or one nothing covers. */
const dayKind = (day: RosterDay): 'override' | 'rest' | 'none' | 'work' =>
  day.source === 'override'
    ? 'override'
    : day.source === 'none'
      ? 'none'
      : day.shifts.length
        ? 'work'
        : 'rest'

// ---------------------------------------------------------------- changing a day

/** The live shifts, for the override dialog. Fetched once somebody opens it. */
const shiftsQuery = createQuery(() => ({
  queryKey: hrKeys.rosterShifts(workspaceId),
  enabled: Boolean(workspaceId) && manage,
  queryFn: () => api.rosters.shifts.list({ workspaceId, includeArchived: false }),
}))
const liveShifts = $derived(shiftsQuery.data ?? [])

const MAX_SHIFTS_PER_DAY = 4

let overriding = $state<RosterDay | null>(null)
let overrideShiftIds = $state<string[]>([])
let overrideNote = $state('')
let overrideError = $state<string | null>(null)
let overrideBusy = $state(false)

function openOverride(day: RosterDay) {
  overriding = day
  overrideShiftIds = day.shifts.map((s) => s.id)
  overrideNote = day.note ?? ''
  overrideError = null
}
function toggleOverrideShift(shiftId: string, on: boolean) {
  const next = on
    ? [...overrideShiftIds.filter((id) => id !== shiftId), shiftId]
    : overrideShiftIds.filter((id) => id !== shiftId)
  if (next.length > MAX_SHIFTS_PER_DAY) return
  overrideShiftIds = next
}
/** The shifts the dialog offers: the live ones plus any archived one already on this day. */
const overrideShifts = $derived.by(() => {
  const onDay = overriding?.shifts ?? []
  const live = new Set(liveShifts.map((s) => s.id))
  return [...liveShifts, ...onDay.filter((s) => !live.has(s.id))]
})

const overrideBlocked = $derived(!manage ? t('rosters_readonly') : null)

const setDay = createMutation(() => ({
  mutationFn: () =>
    api.rosters.set({
      workspaceId,
      personId: overriding?.personId ?? '',
      businessDate: overriding?.businessDate ?? '',
      shiftIds: $state.snapshot(overrideShiftIds),
      note: overrideNote.trim() || null,
    }),
  onSuccess: (day) => {
    toast.success(t('roster_override_saved', { date: formatDate(day.businessDate) }))
    overriding = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error) => {
    overrideError = explainRefusal(error, t('roster_override_error'))
  },
  onSettled: () => {
    overrideBusy = false
  },
}))
function submitOverride() {
  // A flag set in the same tick as the click, so a double-click files one change.
  if (overrideBusy || overrideBlocked) return
  overrideBusy = true
  overrideError = null
  setDay.mutate()
}

let clearing = $state<RosterDay | null>(null)
let clearError = $state<string | null>(null)
let clearBusy = $state(false)
const clearDay = createMutation(() => ({
  mutationFn: () =>
    api.rosters.clear({
      workspaceId,
      personId: clearing?.personId ?? '',
      businessDate: clearing?.businessDate ?? '',
    }),
  onSuccess: () => {
    toast.success(t('roster_cleared', { date: formatDate(clearing?.businessDate ?? '') }))
    clearing = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error) => {
    clearError = explainRefusal(error, t('roster_clear_error'))
  },
  onSettled: () => {
    clearBusy = false
  },
}))
function submitClear() {
  if (clearBusy) return
  clearBusy = true
  clearError = null
  clearDay.mutate()
}
</script>

<PageHeader crumbs={[{ label: workspace?.name ?? '' }, { label: t('rosters_title') }]} title={t('rosters_title')}>
  {#snippet actions()}
    {#if manage}
      <Button size="sm" variant="secondary" icon="settings" href={`/${workspaceSlug}/settings/hr/rosters`}>
        {t('rosters_manage')}
      </Button>
    {/if}
  {/snippet}
</PageHeader>

<Page>
  {#if viewTeam}
    <div class="tabs">
      <Tabs items={tabs} value={view} onValueChange={(v) => (view = v === 'people' ? 'people' : 'coverage')} label={t('rosters_title')} />
    </div>
  {/if}

  {#if view === 'coverage' && viewTeam}
    <!-- ------------------------------------------------------------ coverage -->
    <div class="toolbar">
      <div class="range">
        <Field label={t('roster_from')}>
          {#snippet children(id)}
            <Input {id} size="sm" type="date" bind:value={coverageFrom} />
          {/snippet}
        </Field>
        <Field label={t('roster_to')}>
          {#snippet children(id)}
            <Input {id} size="sm" type="date" bind:value={coverageTo} min={coverageFrom} />
          {/snippet}
        </Field>
        <Field label={t('roster_office')}>
          {#snippet children(id)}
            <Select {id} size="sm" bind:value={officeId} options={officeOptions} ariaLabel={t('roster_office')} />
          {/snippet}
        </Field>
      </div>
      <div class="quick">
        <IconButton icon="chevron-left" label={t('roster_prev_week')} size={28} variant="outline" onclick={() => shiftWeek(-1)} />
        <Button size="sm" variant="secondary" onclick={thisWeek}>{t('roster_this_week')}</Button>
        <IconButton icon="chevron-right" label={t('roster_next_week')} size={28} variant="outline" onclick={() => shiftWeek(1)} />
      </div>
    </div>

    {#if coverageProblem}
      <p class="err" role="alert">{coverageProblem}</p>
    {:else if !workspaceId || coverageQuery.isLoading}
      <div class="rows">
        {#each [1, 2, 3, 4] as n (n)}<Skeleton height="44px" />{/each}
      </div>
    {:else if coverageQuery.isError}
      <EmptyState icon="triangle-alert" title={explainRefusal(coverageQuery.error, t('roster_coverage_error'))}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void coverageQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if !anybodyRostered}
      <EmptyState icon="layout-grid" title={t('roster_coverage_none')} description={t('roster_coverage_none_desc')}>
        {#snippet actions()}
          {#if manage}
            <Button size="sm" variant="secondary" href={`/${workspaceSlug}/settings/hr/rosters`}>{t('rosters_manage')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <!--
        A real table: a coverage grid is read by row *and* by column, which is what a table is for
        and what a stack of divs cannot tell a screen reader. It scrolls inside its own box — a
        six-week range is 42 columns, and the page must never scroll sideways.
      -->
      <div class="gridwrap">
        <table class="grid">
          <caption class="sr-only">{t('roster_grid_label')}</caption>
          <thead>
            <tr>
              <th scope="col" class="shiftcol">{t('roster_col_shift')}</th>
              {#each coverage as day (day.businessDate)}
                <th scope="col" class="daycol" class:today={day.businessDate === today} aria-label={dayLabel(day.businessDate)}>
                  <span class="wd">{weekdayLabel(day.businessDate)}</span>
                  <span class="dm">{dayOfMonth(day.businessDate)}</span>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each coverageShifts as shift (shift.id)}
              <tr>
                <th scope="row" class="shiftcol">
                  <span class="shifthead" style:--hr-shift-color={shift.color ?? 'var(--kern-ink-500)'}>
                    <span class="dot"></span>
                    <span class="shiftname">{shift.name}</span>
                    <span class="shifttime">{shiftRange(shift)}</span>
                  </span>
                </th>
                {#each coverage as day (day.businessDate)}
                  {@const who = peopleOn(day, shift.id)}
                  <td class:today={day.businessDate === today}>
                    {#if who.length}
                      <ul class="names">
                        {#each who as person (person.personId)}<li>{person.displayName}</li>{/each}
                      </ul>
                    {:else}
                      <span class="nobody" aria-label={t('roster_nobody')}>—</span>
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
            <!-- Who a rotation covers and does not put on a shift: who you could call in. -->
            <tr class="offrow">
              <th scope="row" class="shiftcol">
                <span class="shifthead">
                  <span class="shiftname">{t('roster_off_row')}</span>
                  <span class="shifttime">{t('roster_off_row_hint')}</span>
                </span>
              </th>
              {#each coverage as day (day.businessDate)}
                <td class:today={day.businessDate === today}>
                  {#if day.off.length}
                    <ul class="names off">
                      {#each day.off as person (person.personId)}<li>{person.displayName}</li>{/each}
                    </ul>
                  {:else}
                    <span class="nobody" aria-label={t('roster_nobody')}>—</span>
                  {/if}
                </td>
              {/each}
            </tr>
          </tbody>
        </table>
      </div>
    {/if}
  {:else}
    <!-- ------------------------------------------------------------ people -->
    <div class="toolbar">
      <div class="range">
        {#if viewTeam}
          <Field label={t('roster_person')}>
            {#snippet children(id)}
              <Select {id} size="sm" bind:value={personChoice} options={personOptions} ariaLabel={t('roster_person')} />
            {/snippet}
          </Field>
        {/if}
        <Field label={t('roster_from')}>
          {#snippet children(id)}
            <Input {id} size="sm" type="date" bind:value={daysFrom} />
          {/snippet}
        </Field>
        <Field label={t('roster_to')}>
          {#snippet children(id)}
            <Input {id} size="sm" type="date" bind:value={daysTo} min={daysFrom} />
          {/snippet}
        </Field>
      </div>
      <div class="quick">
        <IconButton icon="chevron-left" label={t('roster_prev_month')} size={28} variant="outline" onclick={() => shiftMonth(-1)} />
        <Button size="sm" variant="secondary" onclick={thisMonthAgain}>{t('roster_this_month')}</Button>
        <IconButton icon="chevron-right" label={t('roster_next_month')} size={28} variant="outline" onclick={() => shiftMonth(1)} />
      </div>
    </div>

    {#if daysProblem}
      <p class="err" role="alert">{daysProblem}</p>
    {:else if !workspaceId || daysQuery.isLoading}
      <div class="rows">
        {#each [1, 2, 3, 4, 5] as n (n)}<Skeleton height="40px" />{/each}
      </div>
    {:else if noRecord}
      <EmptyState icon="user" title={t('roster_me_no_record')} />
    {:else if daysQuery.isError}
      <EmptyState icon="triangle-alert" title={explainRefusal(daysQuery.error, t('roster_days_error'))}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void daysQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if days.every((d) => d.source === 'none')}
      <EmptyState icon="user" title={t('roster_days_none')} description={t('roster_days_none_desc')}>
        {#snippet actions()}
          {#if manage}
            <Button size="sm" variant="secondary" href={`/${workspaceSlug}/settings/hr/rosters`}>{t('rosters_manage')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <ul class="daylist" aria-label={personLabel}>
        {#each days as day (day.businessDate)}
          {@const kind = dayKind(day)}
          <li class="dayrow" class:today={day.businessDate === today} class:none={kind === 'none'} class:rest={kind === 'rest'}>
            <span class="date">{dayLabel(day.businessDate)}</span>
            <span class="what">
              {#if kind === 'none'}
                <!-- Drawn as an absence of an answer, never as a planned day off. -->
                <span class="nonetext">{t('roster_source_none')}</span>
              {:else if day.shifts.length === 0}
                <span class="resttext">{t('roster_rest_day')}</span>
              {:else}
                <span class="shiftchips">
                  {#each day.shifts as shift (shift.id)}
                    <span class="shiftchip" style:--hr-shift-color={shift.color ?? 'var(--kern-ink-500)'} title={shiftRange(shift)}>
                      <span class="dot"></span>
                      <span class="chipname">{shift.name}</span>
                      <span class="chiptime">{shiftRange(shift)}</span>
                    </span>
                  {/each}
                </span>
              {/if}
              {#if kind === 'override'}
                <Badge tone="warning">{t('roster_source_override')}</Badge>
                {#if day.note}<span class="notetext">{day.note}</span>{/if}
              {/if}
            </span>
            <span class="rowactions">
              {#if manage}
                <DropdownMenu
                  items={[
                    { label: t('roster_change_day'), icon: 'pencil', onSelect: () => openOverride(day) },
                    ...(kind === 'override'
                      ? [
                          { type: 'separator' as const },
                          {
                            label: t('roster_clear_day'),
                            icon: 'rotate-ccw',
                            danger: true,
                            onSelect: () => {
                              clearError = null
                              clearing = day
                            },
                          },
                        ]
                      : []),
                  ]}
                >
                  {#snippet trigger(props)}
                    <IconButton icon="ellipsis" label={t('roster_day_actions_for', { date: dayLabel(day.businessDate) })} size={26} {...props} />
                  {/snippet}
                </DropdownMenu>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</Page>

<!-- ------------------------------------------------------------------ change a day -->

<Dialog
  open={overriding !== null}
  size="md"
  title={t('roster_override_title', { name: personLabel, date: formatDate(overriding?.businessDate ?? '') })}
  description={t('roster_override_desc')}
  onOpenChange={(open) => {
    if (!open) overriding = null
  }}
>
  <div class="form">
    {#if shiftsQuery.isLoading}
      <Skeleton height="60px" />
    {:else if shiftsQuery.isError}
      <EmptyState compact icon="triangle-alert" title={t('roster_shifts_error')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void shiftsQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else}
      <fieldset class="shiftbox">
        <legend class="rolabel">{t('roster_override_shifts')}</legend>
        <div class="toggles" role="group" aria-label={t('roster_override_shifts')}>
          {#each overrideShifts as shift (shift.id)}
            {@const on = overrideShiftIds.includes(shift.id)}
            {@const full = !on && overrideShiftIds.length >= MAX_SHIFTS_PER_DAY}
            <button
              type="button"
              class="toggle"
              class:on
              aria-pressed={on}
              aria-disabled={full}
              title={full ? t('roster_pattern_max_shifts', { max: number(MAX_SHIFTS_PER_DAY) }) : shiftRange(shift)}
              style:--hr-shift-color={shift.color ?? 'var(--kern-ink-500)'}
              onclick={() => {
                if (!full) toggleOverrideShift(shift.id, !on)
              }}
            >
              <span class="dot"></span>
              <span>{shift.name}</span>
              <span class="chiptime">{shiftRange(shift)}</span>
            </button>
          {/each}
        </div>
        <p class="note">
          {overrideShiftIds.length === 0 ? t('roster_override_off') : t('roster_override_on_count', { count: overrideShiftIds.length })}
        </p>
      </fieldset>
    {/if}

    <Field label={t('roster_override_note')} hint={t('roster_override_note_hint')}>
      {#snippet children(id)}
        <Textarea {id} bind:value={overrideNote} rows={2} maxlength={500} placeholder={t('roster_override_note_placeholder')} />
      {/snippet}
    </Field>

    {#if overrideError}<p class="err" role="alert">{overrideError}</p>{/if}
    {#if overrideBlocked}<p class="note">{overrideBlocked}</p>{/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (overriding = null)} disabled={overrideBusy}>{t('cancel')}</Button>
    <Button onclick={submitOverride} disabled={Boolean(overrideBlocked) || shiftsQuery.isLoading} loading={overrideBusy}>
      {t('common.save')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ undo a change -->

<Dialog
  open={clearing !== null}
  size="sm"
  title={t('roster_clear_title', { date: formatDate(clearing?.businessDate ?? '') })}
  description={t('roster_clear_body')}
  onOpenChange={(open) => {
    if (!open) clearing = null
  }}
>
  {#if clearing?.note}<p class="note">{clearing.note}</p>{/if}
  {#if clearError}<p class="err" role="alert">{clearError}</p>{/if}
  {#snippet footer()}
    <Button variant="secondary" onclick={() => (clearing = null)} disabled={clearBusy}>{t('cancel')}</Button>
    <Button variant="danger" onclick={submitClear} loading={clearBusy}>{t('roster_clear_day')}</Button>
  {/snippet}
</Dialog>

<style>
.tabs {
  margin-block-end: 16px;
}
.toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-block-end: 16px;
}
.range {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 10px;
}
.quick {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rows {
  display: grid;
  gap: 4px;
}
.err {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}
.note {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
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

/* ---- the grid ---- */
.gridwrap {
  overflow-x: auto;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-lg);
}
.grid {
  border-collapse: separate;
  border-spacing: 0;
  min-width: 100%;
  font-size: 12.5px;
}
.grid th,
.grid td {
  padding: 8px 10px;
  border-block-end: 1px solid var(--kern-border-hairline);
  vertical-align: top;
  text-align: start;
}
.grid thead th {
  position: sticky;
  top: 0;
  background: var(--kern-surface);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
/* The first column stays put while forty-two days scroll under it. */
.shiftcol {
  position: sticky;
  inset-inline-start: 0;
  z-index: 1;
  min-width: 160px;
  background: var(--kern-surface);
  border-inline-end: 1px solid var(--kern-border);
}
.grid thead .shiftcol {
  z-index: 2;
}
.daycol {
  min-width: 120px;
}
.daycol .wd {
  display: block;
}
.daycol .dm {
  display: block;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  color: var(--kern-ink-900);
}
.grid .today {
  background: var(--kern-accent-tint);
}
.shifthead {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 6px;
  align-items: center;
}
.shifthead .dot {
  grid-row: 1 / span 2;
}
.shiftname {
  font-size: 13px;
  font-weight: 500;
  color: var(--kern-ink-900);
}
.shifttime {
  grid-column: 2;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--kern-ink-500);
  text-transform: none;
  letter-spacing: 0;
  white-space: normal;
}
.offrow th,
.offrow td {
  background: var(--kern-surface-raised);
  border-block-start: 1px solid var(--kern-border);
}
.names {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.names li {
  white-space: nowrap;
}
.names.off li {
  color: var(--kern-ink-700);
}
.nobody {
  color: var(--kern-ink-450);
}
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--hr-shift-color, var(--kern-ink-500));
}

/* ---- the person's days ---- */
.daylist {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dayrow {
  display: grid;
  grid-template-columns: 120px 1fr max-content;
  gap: 12px;
  align-items: center;
  min-height: 40px;
  padding: 6px 12px;
  border-block-end: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-md);
}
.dayrow.today {
  background: var(--kern-accent-tint);
}
.date {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}
/* Colours, never opacity: a day nobody rostered is still a line somebody reads. */
.dayrow.rest .date,
.dayrow.none .date {
  font-weight: 400;
  color: var(--kern-ink-500);
}
.what {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.resttext {
  font-size: 12.5px;
  color: var(--kern-ink-500);
}
.nonetext {
  font-size: 12.5px;
  font-style: italic;
  color: var(--kern-ink-450);
}
.notetext {
  font-size: 12.5px;
  color: var(--kern-ink-700);
}
.shiftchips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.shiftchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding-inline: 8px;
  border: 1px solid var(--hr-shift-color);
  border-radius: var(--kern-r-md);
  font-size: 12.5px;
  color: var(--kern-ink-900);
}
.chiptime {
  font-size: 11.5px;
  color: var(--kern-ink-500);
  font-variant-numeric: tabular-nums;
}
.rowactions {
  display: flex;
  justify-content: flex-end;
}

/* ---- dialogs ---- */
.form {
  display: grid;
  gap: 14px;
}
.rolabel {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--kern-ink-700);
}
.shiftbox {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding-inline: 10px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: transparent;
  color: var(--kern-ink-700);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
}
.toggle:hover {
  background: var(--kern-surface-hover);
}
.toggle.on {
  border-color: var(--hr-shift-color);
  background: var(--kern-accent-tint);
  color: var(--kern-ink-900);
}
.toggle[aria-disabled='true'] {
  cursor: not-allowed;
  color: var(--kern-ink-500);
}
.toggle:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--kern-ring);
}

@media (max-width: 620px) {
  .dayrow {
    grid-template-columns: 1fr max-content;
  }
  .what {
    grid-column: 1 / -1;
  }
  /* The name is what a day is; the hours are on the shift and in the title. */
  .shiftchip .chiptime {
    display: none;
  }
}
</style>
