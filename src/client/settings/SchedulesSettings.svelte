<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  formatCount,
  formatDate,
  formatDateRange,
  IconButton,
  Input,
  messageLocale,
  navigation,
  SectionLabel,
  Select,
  SettingsPage,
  Skeleton,
  Switch,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Schedule } from '../index.js'
import { canHr } from '../permissions.js'
import { formatDuration, hrKeys, isoDate } from '../query.js'

/**
 * The week the day sheet is measured against.
 *
 * Everything attendance computes — scheduled minutes, lateness, early leaving, overtime, the
 * automatic close of a forgotten shift — is read off a schedule and the person's assignment to it.
 * Until this screen existed there was no way to make one, so every "Scheduled" and "Overtime" tile
 * in the product was zero by construction rather than by fact.
 *
 * **The week is the screen.** `week` is per-weekday start, end and break kept as local wall-clock
 * readings — `09:00` means nine o'clock wherever the person is, not an instant — so a four-day week
 * or a half-day Thursday is an ordinary thing to set up, and a form of scalar fields cannot show
 * it. The editor lays the seven days out as rows, which is also what makes it survive `dir="rtl"`:
 * the week runs down the dialog rather than across it, and the label column lands on whichever side
 * the reader's language starts from without a single `left` or `right` in the stylesheet.
 *
 * No stat tiles. Every number worth one here — how many schedules, how long each week is — is
 * already a column of the table below, and OfficesPage learned the hard way that a tile restating
 * the list is noise. The one figure that would earn a tile, how many people are on no schedule at
 * all, is not answerable: `attendance.schedules.list` returns no assignment count, the way
 * `offices.list` returns `headcount`, and there is no procedure that lists assignments.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/**
 * The settings page is declared with this permission, so the shell only offers it to somebody who
 * has it — but the module cannot assume the shell is the only thing that ever mounts it, and a
 * read-only view of what the workspace has set up is useful in its own right.
 */
const manage = $derived(canHr('attendanceManage'))

// ---------------------------------------------------------------- the week, as data

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
type DayKey = (typeof DAY_KEYS)[number]
type Shift = { start: string; end: string; breakMinutes: number }
type Week = Record<DayKey, Shift | null>

const DEFAULT_SHIFT: Shift = { start: '09:00', end: '18:00', breakMinutes: 60 }

const defaultWeek = (): Week => ({
  mon: { ...DEFAULT_SHIFT },
  tue: { ...DEFAULT_SHIFT },
  wed: { ...DEFAULT_SHIFT },
  thu: { ...DEFAULT_SHIFT },
  fri: { ...DEFAULT_SHIFT },
  sat: null,
  sun: null,
})

/**
 * Weekday names come from the reader's calendar rather than seven message keys per locale.
 *
 * 2024-01-01 was a Monday, so the first seven days of that January are Monday to Sunday in order.
 * The anchor carries a midday time on purpose: `2024-01-01` alone parses as UTC midnight, which is
 * still 31 December in every zone west of Greenwich — and the column would be headed "Sunday".
 */
const anchorDay = (index: number) => `2024-01-0${index + 1}`
const dayName = (index: number, weekday: 'long' | 'short') =>
  formatDate(`${anchorDay(index)}T12:00:00`, { weekday })

const wallToMinutes = (wall: string) => {
  const [h, m] = wall.split(':')
  return Number(h) * 60 + Number(m)
}

/**
 * `working-time.ts` calls a shift overnight when its end is at or before its start, so 22:00–06:00
 * is eight hours and 09:00–09:00 is a full twenty-four. This screen has to agree with it exactly,
 * or the hours it promises are not the hours payroll gets.
 */
const crossesMidnight = (shift: Shift) => wallToMinutes(shift.end) <= wallToMinutes(shift.start)

const netMinutes = (shift: Shift) => {
  const raw = wallToMinutes(shift.end) - wallToMinutes(shift.start)
  return Math.max((raw > 0 ? raw : raw + 1440) - shift.breakMinutes, 0)
}

const weekMinutes = (week: Week) =>
  DAY_KEYS.reduce((sum, key) => {
    const shift = week[key]
    return sum + (shift ? netMinutes(shift) : 0)
  }, 0)

const WALL_CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
const shiftComplete = (shift: Shift) => WALL_CLOCK.test(shift.start) && WALL_CLOCK.test(shift.end)

/** Durations go through the module's own formatter so the digits match the language around them. */
const DURATION_WORDS = {
  hours: (n: string) => t('hours_short', { n }),
  minutes: (n: string) => t('minutes_short', { n }),
}
const duration = (minutes: number) => formatDuration(minutes, DURATION_WORDS, messageLocale())

/**
 * A shift as a range rather than two times and a dash.
 *
 * `formatRange` keeps the earlier reading first in Persian and Arabic; a hand-built `09:00–18:00`
 * reads back to front there. The end is anchored to the next day when the shift crosses midnight,
 * which is what the range actually is.
 */
const shiftRange = (shift: Shift) =>
  formatDateRange(
    `${anchorDay(0)}T${shift.start}:00`,
    `${anchorDay(crossesMidnight(shift) ? 1 : 0)}T${shift.end}:00`,
    { hour: '2-digit', minute: '2-digit' },
  )

/** Reading a schedule from the server, which may leave a weekday out entirely. */
const readWeek = (week: Schedule['week']): Week => {
  const out = {} as Week
  for (const key of DAY_KEYS) {
    const shift = week[key] ?? null
    out[key] = shift ? { start: shift.start, end: shift.end, breakMinutes: shift.breakMinutes } : null
  }
  return out
}

// ---------------------------------------------------------------- the list

/**
 * Archived rows are fetched with the rest and hidden here.
 *
 * A workspace has a handful of schedules, so one request answers both views — and the toggle can
 * say whether there is anything archived to look at, which a second query keyed on the flag could
 * not do without asking twice.
 */
const schedulesQuery = createQuery(() => ({
  queryKey: hrKeys.schedules(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.attendance.schedules.list({ workspaceId, includeArchived: true }),
}))

let showArchived = $state(false)
const allSchedules = $derived(schedulesQuery.data ?? [])
const archivedCount = $derived(allSchedules.filter((s) => s.archivedAt).length)
const schedules = $derived(showArchived ? allSchedules : allSchedules.filter((s) => !s.archivedAt))

const KIND_LABELS: Record<string, () => string> = {
  fixed: () => t('schedule_kind_fixed'),
  flexible: () => t('schedule_kind_flexible'),
  shift: () => t('schedule_kind_shift'),
}
const kindLabel = (kind: string) => KIND_LABELS[kind]?.() ?? kind

/**
 * The chips are a picture, so the cell carries the sentence.
 *
 * `title` is not an accessible name a screen reader can rely on, and seven two-letter abbreviations
 * read aloud one after another are noise — the cell says which days are worked and the chips are
 * hidden from the reader that already heard it.
 */
const workingDaysLabel = (week: Week) => {
  const names = DAY_KEYS.map((key, index) => (week[key] ? dayName(index, 'long') : null)).filter(
    (n): n is string => n !== null,
  )
  return names.length ? names.join(', ') : t('schedule_week_empty')
}

// ---------------------------------------------------------------- the editor

/** `null` while closed; `{ schedule: null }` is a new one. */
let editing = $state<{ schedule: Schedule | null } | null>(null)

let name = $state('')
let kind = $state('fixed')
let week = $state<Week>(defaultWeek())
let tzMode = $state('office')
let tz = $state('')
let graceIn = $state('0')
let graceOut = $state('0')
let roundingStep = $state('0')
let roundingDirection = $state('nearest')
let autoClockOut = $state('')
let formError = $state<string | null>(null)
let saving = $state(false)

function openEditor(schedule: Schedule | null) {
  editing = { schedule }
  formError = null
  name = schedule?.name ?? ''
  kind = schedule?.kind ?? 'fixed'
  week = schedule ? readWeek(schedule.week) : defaultWeek()
  tzMode = schedule?.tzMode ?? 'office'
  tz = schedule?.tz ?? ''
  graceIn = String(schedule?.graceInMinutes ?? 0)
  graceOut = String(schedule?.graceOutMinutes ?? 0)
  roundingStep = String(schedule?.roundingStepMinutes ?? 0)
  roundingDirection = schedule?.roundingDirection ?? 'nearest'
  autoClockOut = schedule?.autoClockOutAfterMinutes ? String(schedule.autoClockOutAfterMinutes) : ''
}

const isNew = $derived(editing?.schedule == null)

function setDay(key: DayKey, on: boolean) {
  // A day switched back on takes the hours of the first day already working, so turning Saturday
  // on in a Monday-to-Friday week does not make somebody retype 09:00 for the sixth time.
  const template = DAY_KEYS.map((k) => week[k]).find((shift) => shift !== null)
  week = { ...week, [key]: on ? { ...(template ?? DEFAULT_SHIFT) } : null }
}

function setShift(key: DayKey, patch: Partial<Shift>) {
  const current = week[key]
  if (!current) return
  week = { ...week, [key]: { ...current, ...patch } }
}

const workingDays = $derived(DAY_KEYS.filter((key) => week[key] !== null))

function copyFirstDay() {
  const first = workingDays[0]
  if (!first) return
  const template = week[first]
  if (!template) return
  const next = { ...week }
  for (const key of workingDays) next[key] = { ...template }
  week = next
}

const clamp = (value: string, min: number, max: number) =>
  Math.min(Math.max(Math.round(Number(value) || 0), min), max)

const timesMissing = $derived(
  workingDays.some((key) => {
    const shift = week[key]
    return shift ? !shiftComplete(shift) : false
  }),
)
const noWorkingDays = $derived(workingDays.length === 0)
const zoneMissing = $derived(tzMode === 'fixed' && !tz)

const weekError = $derived(
  noWorkingDays ? t('schedule_week_empty') : timesMissing ? t('schedule_time_missing') : null,
)
const canSave = $derived(manage && name.trim().length > 0 && !weekError && !zoneMissing)

/** Why Save is off, in the order somebody would fix them. Null when nothing is blocking. */
const blockedReason = $derived(
  canSave
    ? null
    : !manage
      ? t('schedules_readonly')
      : !name.trim()
        ? t('schedule_name_required')
        : (weekError ?? (zoneMissing ? t('schedule_tz_required') : null)),
)

const save = createMutation(() => ({
  mutationFn: () => {
    const current = editing?.schedule ?? null
    const common = {
      workspaceId,
      name: name.trim(),
      week,
      graceInMinutes: clamp(graceIn, 0, 240),
      graceOutMinutes: clamp(graceOut, 0, 240),
      roundingStepMinutes: clamp(roundingStep, 0, 60),
      roundingDirection: roundingDirection as Schedule['roundingDirection'],
      autoClockOutAfterMinutes: autoClockOut ? Number(autoClockOut) : null,
    }
    // Kind and time zone are create-only in the contract, and deliberately: the days already
    // computed were measured with them, so changing one would rewrite history rather than the rule.
    return current
      ? api.attendance.schedules.update({ ...common, scheduleId: current.id })
      : api.attendance.schedules.create({
          ...common,
          kind: kind as Schedule['kind'],
          tzMode: tzMode as Schedule['tzMode'],
          tz: tzMode === 'fixed' ? tz : null,
        })
  },
  onSuccess: (schedule) => {
    toast.success(isNew ? t('schedule_created', { name: schedule.name }) : t('schedule_saved'))
    editing = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: () => {
    formError = t('schedule_save_error')
  },
  onSettled: () => {
    saving = false
  },
}))

function submit() {
  // The disabled attribute lands a render after the click, and two quick clicks are one render
  // apart — so the guard is a flag set in the same tick, not the mutation's own pending state.
  if (saving || !canSave) return
  saving = true
  formError = null
  save.mutate()
}

// ---------------------------------------------------------------- assigning

let assigning = $state<Schedule | null>(null)
let assignPersonId = $state('')
let assignFrom = $state(isoDate())
let assignError = $state<string | null>(null)
let assignBusy = $state(false)

const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forSchedule: true }),
  enabled: Boolean(assigning) && Boolean(workspaceId),
  queryFn: () => api.people.list({ workspaceId, limit: 200, status: ['active'] }),
}))
const people = $derived(peopleQuery.data?.items ?? [])
const personOptions = $derived(people.map((person) => ({ value: person.id, label: person.displayName })))

function openAssign(schedule: Schedule) {
  assigning = schedule
  assignPersonId = ''
  assignFrom = isoDate()
  assignError = null
}

const assign = createMutation(() => ({
  mutationFn: () =>
    api.attendance.schedules.assign({
      workspaceId,
      scheduleId: assigning?.id ?? '',
      personId: assignPersonId,
      effectiveFrom: assignFrom,
    }),
  onSuccess: () => {
    const person = people.find((p) => p.id === assignPersonId)
    toast.success(
      t('schedule_assigned', {
        name: person?.displayName ?? '',
        date: formatDate(assignFrom),
      }),
    )
    assigning = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: () => {
    assignError = t('schedule_assign_error')
  },
  onSettled: () => {
    assignBusy = false
  },
}))

function submitAssign() {
  if (assignBusy || !assignPersonId || !assignFrom) return
  assignBusy = true
  assignError = null
  assign.mutate()
}

// ---------------------------------------------------------------- archiving

let archiving = $state<Schedule | null>(null)
let archiveError = $state<string | null>(null)
let archiveBusy = $state(false)

const archive = createMutation(() => ({
  mutationFn: () => api.attendance.schedules.archive({ workspaceId, scheduleId: archiving?.id ?? '' }),
  onSuccess: () => {
    toast.success(t('schedule_archived_toast', { name: archiving?.name ?? '' }))
    archiving = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: () => {
    archiveError = t('schedule_archive_error')
  },
  onSettled: () => {
    archiveBusy = false
  },
}))

function submitArchive() {
  if (archiveBusy) return
  archiveBusy = true
  archiveError = null
  archive.mutate()
}

// ---------------------------------------------------------------- option sets

const kindOptions = $derived([
  { value: 'fixed', label: t('schedule_kind_fixed'), description: t('schedule_kind_fixed_desc') },
  { value: 'flexible', label: t('schedule_kind_flexible'), description: t('schedule_kind_flexible_desc') },
  { value: 'shift', label: t('schedule_kind_shift'), description: t('schedule_kind_shift_desc') },
])

const tzModeOptions = $derived([
  { value: 'office', label: t('schedule_tz_office') },
  { value: 'person', label: t('schedule_tz_person') },
  { value: 'fixed', label: t('schedule_tz_fixed') },
])

/**
 * Every zone the runtime knows, grouped by area.
 *
 * `supportedValuesOf` is the only complete list available to a browser; where it is missing there
 * is exactly one zone worth offering, the one this machine is in. Reading it is not formatting, so
 * it does not go through the shared formatters.
 */
const ZONES: string[] = (() => {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    const list = supported?.call(Intl, 'timeZone') ?? []
    return list.length ? list : [Intl.DateTimeFormat().resolvedOptions().timeZone]
  } catch {
    return [Intl.DateTimeFormat().resolvedOptions().timeZone]
  }
})()
const zoneOptions = ZONES.map((zone) => ({
  value: zone,
  label: zone.split('/').slice(1).join(' / ').replace(/_/g, ' ') || zone,
  group: zone.split('/')[0]?.replace(/_/g, ' ') ?? '',
}))

/** A break somebody actually typed into the database keeps its place in the list. */
const breakOptions = (current: number) =>
  [...new Set([0, 15, 30, 45, 60, 90, current])]
    .sort((a, b) => a - b)
    .map((minutes) => ({
      value: String(minutes),
      label: minutes === 0 ? t('schedule_break_none') : duration(minutes),
    }))

const roundingStepOptions = $derived([
  { value: '0', label: t('schedule_rounding_off') },
  ...[5, 6, 10, 15, 30, 60].map((n) => ({ value: String(n), label: duration(n) })),
])

const roundingDirectionOptions = $derived([
  { value: 'nearest', label: t('schedule_rounding_nearest') },
  { value: 'employee', label: t('schedule_rounding_employee') },
  { value: 'employer', label: t('schedule_rounding_employer') },
])

const autoClockOutOptions = $derived([
  { value: '', label: t('schedule_auto_out_off') },
  ...[480, 600, 720, 960, 1440].map((n) => ({ value: String(n), label: duration(n) })),
])
</script>

<SettingsPage title={t('settings_schedules')} description={t('schedules_desc')}>
  {#snippet actions()}
    {#if manage}
      <Button size="sm" icon="plus" onclick={() => openEditor(null)}>{t('schedule_new')}</Button>
    {/if}
  {/snippet}

  <SectionLabel label={t('settings_schedules')} count={formatCount(schedules.length)}>
    {#snippet trailing()}
      {#if archivedCount > 0}
        <Switch
          size="sm"
          checked={showArchived}
          onCheckedChange={(on) => (showArchived = on)}
          label={t('schedules_show_archived')}
        />
      {/if}
    {/snippet}
  </SectionLabel>

  {#if schedulesQuery.isLoading}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="52px" />{/each}
    </div>
  {:else if schedulesQuery.isError}
    <EmptyState icon="triangle-alert" title={t('schedules_error')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void schedulesQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if schedules.length === 0}
    <EmptyState icon="clock" title={t('schedules_none')} description={t('schedules_none_desc')}>
      {#snippet actions()}
        {#if manage}
          <Button size="sm" icon="plus" onclick={() => openEditor(null)}>{t('schedule_new')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <div class="table" role="table" aria-label={t('settings_schedules')}>
      <div class="thead" role="row">
        <span role="columnheader">{t('schedule_name')}</span>
        <span role="columnheader">{t('schedule_kind')}</span>
        <span role="columnheader">{t('schedule_week')}</span>
        <span role="columnheader">{t('schedule_weekly')}</span>
        <span class="sr-only" role="columnheader">{t('schedule_actions')}</span>
      </div>
      {#each schedules as schedule (schedule.id)}
        {@const days = readWeek(schedule.week)}
        <div class="trow" role="row">
          <span class="cell title" role="cell">
            <span class="name">{schedule.name}</span>
            {#if schedule.archivedAt}<Badge tone="grey">{t('schedule_archived')}</Badge>{/if}
          </span>
          <span class="cell" role="cell">
            <Badge tone={schedule.kind === 'fixed' ? 'grey' : 'info'}>{kindLabel(schedule.kind)}</Badge>
          </span>
          <span class="cell" role="cell" aria-label={workingDaysLabel(days)}>
            <!-- Seven chips rather than a sentence: which days are worked is the one thing you
                 scan a schedule list for, and the row order flips with the language for free. -->
            <span class="chips" aria-hidden="true">
              {#each DAY_KEYS as key, index (key)}
                {@const shift = days[key]}
                <span
                  class="chip"
                  class:on={shift !== null}
                  title={shift
                    ? `${dayName(index, 'long')} · ${shiftRange(shift)}`
                    : `${dayName(index, 'long')} · ${t('schedule_day_off')}`}
                >
                  {dayName(index, 'short')}
                </span>
              {/each}
            </span>
          </span>
          <span class="cell num" role="cell">{duration(weekMinutes(days))}</span>
          <span class="cell actions" role="cell">
            {#if manage && !schedule.archivedAt}
              <DropdownMenu
                items={[
                  { label: t('common.edit'), icon: 'pencil', onSelect: () => openEditor(schedule) },
                  { label: t('schedule_assign'), icon: 'user-plus', onSelect: () => openAssign(schedule) },
                  { type: 'separator' },
                  {
                    label: t('common.archive'),
                    icon: 'archive',
                    danger: true,
                    onSelect: () => {
                      archiveError = null
                      archiving = schedule
                    },
                  },
                ]}
              >
                {#snippet trigger(props)}
                  <IconButton
                    icon="ellipsis"
                    label={t('schedule_actions_for', { name: schedule.name })}
                    size={26}
                    {...props}
                  />
                {/snippet}
              </DropdownMenu>
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}

  <p class="hint">{manage ? t('schedules_hint') : t('schedules_readonly')}</p>
</SettingsPage>

<!-- ------------------------------------------------------------------ editor -->

<Dialog
  open={editing !== null}
  size="xl"
  title={isNew ? t('schedule_new') : t('schedule_edit_title')}
  description={t('schedule_edit_desc')}
  onOpenChange={(open) => {
    if (!open) editing = null
  }}
>
  <div class="form">
    <div class="pair">
      <Field label={t('display_name')} required hint={t('schedule_name_hint')}>
        {#snippet children(id)}
          <Input {id} bind:value={name} placeholder={t('schedule_name_placeholder')} />
        {/snippet}
      </Field>
      {#if isNew}
        <Field label={t('schedule_kind')} hint={t('schedule_kind_hint')}>
          {#snippet children(id)}
            <Select {id} bind:value={kind} options={kindOptions} />
          {/snippet}
        </Field>
      {:else}
        <!-- Not a `Field`: it writes a `<label for>`, and `for` pointing at a paragraph names
             nothing. A value nobody can change is a term and its definition. -->
        <div class="ro">
          <span class="rolabel">{t('schedule_kind')}</span>
          <p class="rovalue">{kindLabel(kind)}</p>
          <p class="note">{t('schedule_immutable_hint')}</p>
        </div>
      {/if}
    </div>

    <!--
      The week, as a week.

      Rows are weekdays and columns are the three readings a day is made of, so a four-day week and
      a short Friday are both visible at a glance instead of hidden in a field somebody has to open.
      A day that is off shows one line of text rather than three disabled controls: the switch
      beside it is the reason, and three greyed-out boxes only ask the reader to work that out.
    -->
    <section class="weekblock" aria-labelledby="hr-week-label">
      <div class="weekhead">
        <span class="kern-section-label" id="hr-week-label">{t('schedule_week')}</span>
        <span class="total">{t('schedule_week_total', { hours: duration(weekMinutes(week)) })}</span>
      </div>

      <div class="grid" role="table" aria-labelledby="hr-week-label">
        <div class="ghead" role="row">
          <span role="columnheader">{t('schedule_day')}</span>
          <span role="columnheader">{t('schedule_start')}</span>
          <span role="columnheader">{t('schedule_end')}</span>
          <span role="columnheader">{t('schedule_break')}</span>
          <span role="columnheader">{t('schedule_net')}</span>
        </div>

        {#each DAY_KEYS as key, index (key)}
          {@const shift = week[key]}
          <div class="grow" role="row" class:off={shift === null}>
            <span class="gcell day" role="cell">
              <Switch
                size="sm"
                checked={shift !== null}
                onCheckedChange={(on) => setDay(key, on)}
                ariaLabel={dayName(index, 'long')}
              />
              <span class="dayname">{dayName(index, 'long')}</span>
            </span>

            {#if shift}
              <span class="gcell" role="cell">
                <Input
                  size="sm"
                  type="time"
                  value={shift.start}
                  aria-label={`${dayName(index, 'long')} — ${t('schedule_start')}`}
                  oninput={(event) => setShift(key, { start: event.currentTarget.value })}
                />
              </span>
              <span class="gcell" role="cell">
                <Input
                  size="sm"
                  type="time"
                  value={shift.end}
                  aria-label={`${dayName(index, 'long')} — ${t('schedule_end')}`}
                  oninput={(event) => setShift(key, { end: event.currentTarget.value })}
                />
              </span>
              <span class="gcell" role="cell">
                <Select
                  size="sm"
                  value={String(shift.breakMinutes)}
                  options={breakOptions(shift.breakMinutes)}
                  placeholder={`${dayName(index, 'long')} — ${t('schedule_break')}`}
                  onValueChange={(value) => setShift(key, { breakMinutes: Number(value) })}
                />
              </span>
              <span class="gcell net" role="cell">
                {#if shiftComplete(shift)}
                  {duration(netMinutes(shift))}
                  {#if crossesMidnight(shift)}
                    <span class="overnight" title={t('schedule_overnight')} aria-hidden="true">+1</span>
                    <span class="sr-only">{t('schedule_overnight')}</span>
                  {/if}
                {:else}
                  —
                {/if}
              </span>
            {:else}
              <span class="gcell dayoff" role="cell">{t('schedule_day_off')}</span>
            {/if}
          </div>
        {/each}
      </div>

      <div class="weekfoot">
        {#if weekError}
          <p class="err" role="alert">{weekError}</p>
        {:else}
          <p class="note">{t('schedule_break_hint')}</p>
        {/if}
        {#if workingDays.length > 1}
          <Button size="xs" variant="ghost" icon="copy" onclick={copyFirstDay}>
            {t('schedule_copy_first')}
          </Button>
        {/if}
      </div>
    </section>

    <!-- Time zone -->
    {#if isNew}
      <div class="pair">
        <Field label={t('schedule_tz_mode')} hint={t('schedule_tz_hint')}>
          {#snippet children(id)}
            <Select {id} bind:value={tzMode} options={tzModeOptions} />
          {/snippet}
        </Field>
        {#if tzMode === 'fixed'}
          <Field
            label={t('schedule_tz_label')}
            required
            error={zoneMissing ? t('schedule_tz_required') : null}
          >
            {#snippet children(id)}
              <Select {id} bind:value={tz} options={zoneOptions} placeholder={t('schedule_tz_label')} />
            {/snippet}
          </Field>
        {/if}
      </div>
    {:else}
      <div class="ro">
        <span class="rolabel">{t('schedule_tz_mode')}</span>
        <p class="rovalue">
          {tzModeOptions.find((option) => option.value === tzMode)?.label ?? tzMode}{#if tz}&nbsp;· {tz}{/if}
        </p>
        <p class="note">{t('schedule_immutable_hint')}</p>
      </div>
    {/if}

    <!-- Grace -->
    <div class="pair">
      <Field label={t('schedule_grace_in')}>
        {#snippet children(id)}
          <Input {id} type="number" min={0} max={240} bind:value={graceIn} />
        {/snippet}
      </Field>
      <Field label={t('schedule_grace_out')}>
        {#snippet children(id)}
          <Input {id} type="number" min={0} max={240} bind:value={graceOut} />
        {/snippet}
      </Field>
    </div>
    <p class="note">{t('schedule_grace_hint')}</p>

    <!-- Rounding -->
    <div class="pair">
      <Field label={t('schedule_rounding_step')}>
        {#snippet children(id)}
          <Select {id} bind:value={roundingStep} options={roundingStepOptions} />
        {/snippet}
      </Field>
      {#if roundingStep !== '0'}
        <Field label={t('schedule_rounding_direction')}>
          {#snippet children(id)}
            <Select {id} bind:value={roundingDirection} options={roundingDirectionOptions} />
          {/snippet}
        </Field>
      {/if}
    </div>
    {#if roundingStep !== '0'}
      <p class="note">{t('schedule_rounding_hint')}</p>
    {/if}

    <!-- Automatic clock-out -->
    <Field label={t('schedule_auto_out')} hint={t('schedule_auto_out_hint')}>
      {#snippet children(id)}
        <Select {id} bind:value={autoClockOut} options={autoClockOutOptions} />
      {/snippet}
    </Field>

    {#if formError}<p class="err" role="alert">{formError}</p>{/if}
    <!-- A disabled control with no reason is a bug, so the reason sits next to the control. -->
    {#if blockedReason}<p class="note blocked">{blockedReason}</p>{/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editing = null)} disabled={saving}>{t('cancel')}</Button>
    <Button onclick={submit} disabled={!canSave} loading={saving}>
      {isNew ? t('common.create') : t('common.save')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ assign -->

<Dialog
  open={assigning !== null}
  size="md"
  title={t('schedule_assign_title', { name: assigning?.name ?? '' })}
  description={t('schedule_assign_desc')}
  onOpenChange={(open) => {
    if (!open) assigning = null
  }}
>
  {#if peopleQuery.isLoading}
    <Skeleton height="120px" />
  {:else if peopleQuery.isError}
    <EmptyState compact icon="triangle-alert" title={t('people_error')}>
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={() => void peopleQuery.refetch()}>
          {t('retry')}
        </Button>
      {/snippet}
    </EmptyState>
  {:else if personOptions.length === 0}
    <EmptyState compact icon="user" title={t('no_people')} description={t('no_people_desc')} />
  {:else}
    <div class="form">
      <Field label={t('schedule_assign_person')} required>
        {#snippet children(id)}
          <Select
            {id}
            bind:value={assignPersonId}
            options={personOptions}
            placeholder={t('schedule_assign_person')}
          />
        {/snippet}
      </Field>
      <Field
        label={t('schedule_effective_from')}
        hint={t('schedule_effective_hint')}
        error={assignError}
      >
        {#snippet children(id)}
          <Input {id} type="date" bind:value={assignFrom} />
        {/snippet}
      </Field>
      <!-- Same rule as the editor: the button is off, so it says why. -->
      {#if !assignPersonId}<p class="note">{t('schedule_assign_required')}</p>{/if}
    </div>
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (assigning = null)} disabled={assignBusy}>
      {t('cancel')}
    </Button>
    <Button
      onclick={submitAssign}
      disabled={!assignPersonId || !assignFrom || personOptions.length === 0}
      loading={assignBusy}
    >
      {t('schedule_assign')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ archive -->

<Dialog
  open={archiving !== null}
  size="sm"
  title={t('schedule_archive_title', { name: archiving?.name ?? '' })}
  description={t('schedule_archive_body')}
  onOpenChange={(open) => {
    if (!open) archiving = null
  }}
>
  <p class="note">{t('schedule_archive_people')}</p>
  {#if archiveError}<p class="err" role="alert">{archiveError}</p>{/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (archiving = null)} disabled={archiveBusy}>
      {t('cancel')}
    </Button>
    <Button variant="danger" onclick={submitArchive} loading={archiveBusy}>{t('common.archive')}</Button>
  {/snippet}
</Dialog>

<style>
.rows {
  display: grid;
  gap: 4px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  --hr-schedule-cols: minmax(150px, 1.3fr) 104px minmax(168px, auto) 84px max-content;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-schedule-cols);
  gap: 12px;
  align-items: center;
  padding-inline: 10px;
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
  min-height: 52px;
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
.title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13.5px;
  font-weight: 500;
}
.num {
  font-size: 13px;
  color: var(--kern-ink-500);
  font-variant-numeric: tabular-nums;
}
.actions {
  display: flex;
  justify-content: flex-end;
  overflow: visible;
}

/* The week at a glance: worked days filled, days off outlined. */
.chips {
  display: flex;
  gap: 3px;
}
.chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 20px;
  padding-inline: 5px;
  border-radius: var(--kern-r-sm);
  border: 1px solid var(--kern-border);
  background: transparent;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-500);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.chip.on {
  border-color: transparent;
  background: var(--kern-accent-tint);
  color: var(--kern-accent-text);
}

.hint {
  margin-block-start: 16px;
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

/* ---- dialogs ---- */
.form {
  display: grid;
  gap: 14px;
}
.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}
.ro {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.rolabel {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--kern-ink-700);
}
.rovalue {
  margin: 0;
  padding-block: 5px;
  font-size: 13.5px;
  color: var(--kern-ink-900);
}
.blocked {
  color: var(--kern-ink-700);
}
.note {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--kern-ink-500);
}
.err {
  margin: 0;
  font-size: 12px;
  color: var(--kern-danger);
}

.weekblock {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-2xl);
  background: var(--kern-surface);
}
.weekhead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.total {
  font-size: 13px;
  font-weight: 500;
  color: var(--kern-ink-700);
  font-variant-numeric: tabular-nums;
}
.grid {
  display: grid;
  gap: 2px;
}
.ghead,
.grow {
  display: grid;
  grid-template-columns: minmax(132px, 1.1fr) 118px 118px 118px 84px;
  gap: 8px;
  align-items: center;
}
.ghead {
  height: 26px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.grow {
  min-height: 40px;
  padding-block: 2px;
  border-block-start: 1px solid var(--kern-border-hairline);
}
.gcell {
  min-width: 0;
}
.day {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dayname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
}
.grow.off .dayname {
  font-weight: 400;
  color: var(--kern-ink-500);
}
.dayoff {
  grid-column: 2 / -1;
  font-size: 12.5px;
  color: var(--kern-ink-500);
}
.net {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 12.5px;
  color: var(--kern-ink-700);
  font-variant-numeric: tabular-nums;
}
.overnight {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--kern-accent-text);
}
.weekfoot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

@media (max-width: 760px) {
  .table {
    --hr-schedule-cols: minmax(120px, 1.3fr) minmax(168px, auto) 84px max-content;
  }
  /* Type is the column a narrow screen can lose: nearly every schedule is a fixed one. */
  .thead > :nth-child(2),
  .trow > :nth-child(2) {
    display: none;
  }
}

@media (max-width: 620px) {
  /* Two controls per line rather than five columns squeezed to nothing. The header row goes with
     them — every control keeps its own accessible name, which is what the header was standing in
     for. */
  .ghead {
    display: none;
  }
  .ghead,
  .grow {
    grid-template-columns: 1fr 1fr;
  }
  .grow {
    padding-block: 8px;
  }
  .day,
  .net,
  .dayoff {
    grid-column: 1 / -1;
  }
}
</style>
