<script lang="ts">
import {
  Badge,
  type BadgeTone,
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  formatCount,
  formatDate,
  IconButton,
  Input,
  type MenuItem,
  navigation,
  SectionLabel,
  Select,
  SettingsPage,
  SettingsSection,
  Skeleton,
  StatTile,
  Switch,
  session,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
// The client barrel re-exports the models it has needed so far, and the day *kind* was not one of
// them. Straight from the contract rather than widening a barrel another screen shares.
import type { CalendarDayKind } from '../../contract/models.js'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Calendar, ResolvedCalendarDay, WorkingWeek } from '../index.js'
import { canHr } from '../permissions.js'
import { hrKeys, isoDate } from '../query.js'

/**
 * The days this company does not work.
 *
 * Two things justify the screen, and everything on it serves one of them.
 *
 * **HR keeps their own days.** A country pack knows about national holidays and nothing else — it
 * has never heard of the week the factory shuts, the bridge Friday, or the national holiday this
 * company works through. So the composed list labels every day with where it came from: a day from
 * the pack is somebody else's decision, a day added here is this company's, and the difference is
 * the difference between "I can change this" and "I daren't touch it".
 *
 * **A pack upgrade must not eat those days.** Removing a pack day does not delete it — the server
 * writes a suppressing row over it, because deleting it would only bring it back next year — so
 * such a day is drawn struck through and still present rather than gone, and the menu on it offers
 * to restore the pack's version instead of a second delete. `pack.apply` is never reachable
 * without `pack.preview`: the dialog names what would be added, changed and dropped, and says out
 * loud that the days added here are untouched, because that is the sentence somebody needs before
 * they press a button that rewrites a year.
 *
 * The year is the unit throughout — packs are published per year, and a holiday list read a month
 * at a time answers nothing.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/** Viewing is granted to everyone by default; changing anything is an administrator's. */
const manage = $derived(canHr('calendarManage'))

type CalendarRow = Calendar & { officeIds: string[] }
type WeekdayKey = keyof WorkingWeek

/** 2024-01-01 was a Monday, so these seven dates name the weekdays in the reader's own language. */
const WEEKDAYS: { key: WeekdayKey; iso: string }[] = [
  { key: 'mon', iso: '2024-01-01' },
  { key: 'tue', iso: '2024-01-02' },
  { key: 'wed', iso: '2024-01-03' },
  { key: 'thu', iso: '2024-01-04' },
  { key: 'fri', iso: '2024-01-05' },
  { key: 'sat', iso: '2024-01-06' },
  { key: 'sun', iso: '2024-01-07' },
]

const DEFAULT_WEEK: WorkingWeek = { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 }

const DAY_KINDS: CalendarDayKind[] = [
  'public_holiday',
  'religious',
  'company_closure',
  'half_day',
  'working_override',
  'bridge',
]

/**
 * What each kind normally costs, applied when the kind changes.
 *
 * A half day that counts as a whole one is a data-entry mistake nobody would notice until a leave
 * balance came out wrong, so picking the kind fills in the obvious answer — and the field stays
 * editable, because a country's public holiday genuinely is a half day in some companies.
 */
const KIND_FRACTION: Record<CalendarDayKind, number> = {
  public_holiday: 0,
  religious: 0,
  company_closure: 0,
  half_day: 0.5,
  working_override: 1,
  bridge: 0,
}

const kindLabel = (kind: CalendarDayKind): string =>
  kind === 'public_holiday'
    ? t('cal_kind_public_holiday')
    : kind === 'religious'
      ? t('cal_kind_religious')
      : kind === 'company_closure'
        ? t('cal_kind_company_closure')
        : kind === 'half_day'
          ? t('cal_kind_half_day')
          : kind === 'working_override'
            ? t('cal_kind_working_override')
            : t('cal_kind_bridge')

// ---------------------------------------------------------------- what is on screen

let picked = $state('')
let year = $state(new Date().getFullYear())

const calendarsQuery = createQuery(() => ({
  queryKey: hrKeys.calendars(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.calendars.list({ workspaceId, includeArchived: false }),
}))
const calendars = $derived((calendarsQuery.data ?? []) as CalendarRow[])

/**
 * Falling back to the first calendar rather than storing a default keeps the selection honest after
 * an archive: the id somebody picked can stop existing, and a screen pointing at it would show an
 * empty year instead of a calendar.
 */
const selectedId = $derived(calendars.some((c) => c.id === picked) ? picked : (calendars[0]?.id ?? ''))
const selected = $derived(calendars.find((c) => c.id === selectedId) ?? null)

/**
 * The calendar this one extends, fetched rather than looked up in the list.
 *
 * A country pack is not one of the workspace's own calendars — it is the shared thing they build
 * on — so `calendars.list` need not contain it, and its name and pack key are only available by
 * asking for it.
 */
const extendsId = $derived(selected?.extendsId ?? '')
const baseQuery = createQuery(() => ({
  queryKey: ['hr', 'calendar', workspaceId, extendsId] as const,
  enabled: Boolean(workspaceId && extendsId),
  queryFn: () => api.calendars.get({ workspaceId, calendarId: extendsId }),
}))

const from = $derived(`${year}-01-01`)
const to = $derived(`${year}-12-31`)
/** The Gregorian year, in the reader's digits: a Persian interface must not print 2026 in Latin. */
const yearLabel = $derived(formatDate(from, { year: 'numeric', calendar: 'gregory' }))

const daysQuery = createQuery(() => ({
  queryKey: hrKeys.calendarDays(workspaceId, selectedId, from, to),
  enabled: Boolean(workspaceId && selectedId),
  queryFn: () => api.calendars.days.list({ workspaceId, calendarId: selectedId, from, to }),
}))
const days = $derived(daysQuery.data ?? [])

/**
 * The number the whole calendar exists to produce. Leave, attendance and reporting all count
 * against it, so showing it here is what makes a working-week or holiday edit verifiable.
 */
const workingDaysQuery = createQuery(() => ({
  queryKey: ['hr', 'calendar-working-days', workspaceId, selectedId, from, to] as const,
  enabled: Boolean(workspaceId && selectedId),
  queryFn: () => api.calendars.workingDays({ workspaceId, calendarId: selectedId, from, to }),
}))

const stats = $derived({
  off: days.filter((d) => d.workingFraction < 1).length,
  pack: days.filter((d) => d.source === 'pack').length,
  own: days.filter((d) => d.source === 'custom').length,
})

/** Where the pack days would come from: this calendar's own, its base's, or the country code. */
/**
 * The pack this calendar would update from.
 *
 * Upper-cased, because `COUNTRY_PACKS` is keyed by the ISO code as ISO writes it — `TR`, not `tr`.
 * Lower-casing it here meant a calendar with a country and no pack key of its own proposed a key
 * nobody publishes, and the server answered that with a diff reading "remove every holiday". The
 * server refuses an unknown key now, so the worst case is a readable error rather than an empty
 * year; this keeps the common case from producing one at all.
 */
const packKey = $derived(
  selected?.packKey ?? baseQuery.data?.packKey ?? (selected?.country ?? '').toUpperCase(),
)

const baseLine = $derived(
  extendsId
    ? baseQuery.data
      ? t('cal_based_on_name', { name: baseQuery.data.name })
      : ''
    : t('cal_based_on_none'),
)

const shortDay = (iso: string) => formatDate(iso, { weekday: 'short' })

/** "Mon · Tue · Wed · Thu · Fri", with a half day marked rather than hidden. */
function weekSummary(week: WorkingWeek): string {
  const worked = WEEKDAYS.filter((d) => week[d.key] > 0)
  if (worked.length === 0) return t('cal_week_none')
  return worked.map((d) => `${shortDay(d.iso)}${week[d.key] < 1 ? ' ½' : ''}`).join(' · ')
}

/**
 * Where a composed day came from, as the reader needs it.
 *
 * The model says `source` and `overrides`; those two answer four different questions, and the one
 * that matters most is the fourth: a pack day this company masked is still in the list, and drawing
 * it as if it were simply gone would hide the mechanism that protects it from the next upgrade.
 */
type Origin = 'pack' | 'added' | 'changed' | 'masked'
function originOf(day: ResolvedCalendarDay): Origin {
  if (day.source === 'pack') return 'pack'
  if (!day.overrides) return 'added'
  return day.workingFraction >= 1 ? 'masked' : 'changed'
}
const ORIGIN_TONES: Record<Origin, BadgeTone> = {
  pack: 'grey',
  added: 'accent',
  changed: 'info',
  masked: 'warning',
}
const originLabel = (origin: Origin): string =>
  origin === 'pack'
    ? t('cal_origin_pack')
    : origin === 'added'
      ? t('cal_origin_added')
      : origin === 'changed'
        ? t('cal_origin_changed')
        : t('cal_origin_masked')

const effectLabel = (fraction: number): string =>
  fraction <= 0
    ? t('cal_effect_off')
    : fraction >= 1
      ? t('cal_effect_worked')
      : fraction === 0.5
        ? t('cal_effect_half')
        : t('cal_effect_part', { fraction })

/**
 * A day change moves more than this screen: working-day counts, leave balances and the attendance
 * day sheet are all computed from these rows, so the module's cache is dropped whole rather than
 * guessing which keys a recomputation touched.
 */
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: ['hr'] })
}

/**
 * One click, one write.
 *
 * `disabled={mutation.isPending}` reaches the button on the next render, and two quick clicks are
 * one render apart — which on this screen means two calendars, two holidays, or a pack applied
 * twice. The flag is set in the same tick as the click and cleared when the call settles.
 */
let firing = $state(false)
function once(run: () => void) {
  if (firing) return
  firing = true
  run()
}
const settled = () => {
  firing = false
}

// ---------------------------------------------------------------- the calendar form

let calDialog = $state<'create' | 'edit' | null>(null)
let calId = $state('')
let calName = $state('')
let calExtends = $state('')
let calCountry = $state('')
let calRegion = $state('')
let calWeek = $state<WorkingWeek>({ ...DEFAULT_WEEK })

const countryValid = $derived(calCountry === '' || /^[A-Z]{2}$/.test(calCountry))

function openCreate() {
  calDialog = 'create'
  calId = ''
  calName = ''
  calExtends = ''
  calCountry = ''
  calRegion = ''
  calWeek = { ...DEFAULT_WEEK }
}

function openEdit(cal: CalendarRow) {
  calDialog = 'edit'
  calId = cal.id
  calName = cal.name
  calExtends = cal.extendsId ?? ''
  calCountry = cal.country ?? ''
  calRegion = cal.region ?? ''
  calWeek = { ...cal.workingWeek }
}

function setWeekday(key: WeekdayKey, value: number) {
  calWeek = { ...calWeek, [key]: value }
}

const saveCalendar = createMutation(() => ({
  // `$state.snapshot` because the working week is a state proxy, and a proxy cannot be cloned on
  // its way into the request — the call throws instead of saving.
  mutationFn: () =>
    calDialog === 'edit'
      ? api.calendars.update({
          workspaceId,
          calendarId: calId,
          name: calName.trim(),
          extendsId: calExtends || null,
          workingWeek: $state.snapshot(calWeek),
        })
      : api.calendars.create({
          workspaceId,
          name: calName.trim(),
          extendsId: calExtends || null,
          country: calCountry || null,
          region: calRegion.trim() || null,
          workingWeek: $state.snapshot(calWeek),
        }),
  onSuccess: (cal: Calendar) => {
    toast.success(calDialog === 'edit' ? t('cal_saved') : t('cal_created', { name: cal.name }))
    // A new calendar is the one somebody wants to fill in, so the day list below switches to it.
    picked = cal.id
    calDialog = null
    refresh()
  },
  onError: (error: Error) => toast.error(error.message),
  onSettled: settled,
}))

let archiving = $state<CalendarRow | null>(null)

const archiveCalendar = createMutation(() => ({
  mutationFn: (cal: CalendarRow) => api.calendars.archive({ workspaceId, calendarId: cal.id }),
  onSuccess: (_ok, cal: CalendarRow) => {
    toast.success(t('cal_archived', { name: cal.name }))
    archiving = null
    refresh()
  },
  onError: (error: Error) => toast.error(error.message),
  onSettled: settled,
}))

function calendarMenu(cal: CalendarRow): MenuItem[] {
  const inUse = cal.officeIds.length > 0
  return [
    { label: t('common.edit'), icon: 'square-pen', onSelect: () => openEdit(cal) },
    { type: 'separator' },
    {
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      // An office resolves its holidays through this calendar; archiving it under their feet would
      // change everyone's working days silently. The office has to be moved first.
      disabled: inUse,
      hint: inUse ? t('cal_in_use', { count: cal.officeIds.length }) : undefined,
      onSelect: () => {
        archiving = cal
      },
    },
  ]
}

// ---------------------------------------------------------------- the day form

let dayDialog = $state<'add' | 'edit' | null>(null)
let dayId = $state('')
let dayDate = $state('')
let dayName = $state('')
let dayKind = $state<CalendarDayKind>('company_closure')
let dayEffect = $state('0')
let dayPaid = $state(true)
let dayNote = $state('')
let dayFromPack = $state(false)

const effectOptions = $derived(
  [
    { value: '0', label: t('cal_effect_off') },
    { value: '0.5', label: t('cal_effect_half') },
    { value: '1', label: t('cal_effect_worked') },
    // A pack can carry any fraction; without this its own value would vanish the moment somebody
    // opened the day to change its name.
    ...(['0', '0.5', '1'].includes(dayEffect)
      ? []
      : [{ value: dayEffect, label: t('cal_effect_part', { fraction: Number(dayEffect) }) }]),
  ].sort((a, b) => Number(a.value) - Number(b.value)),
)

function openAddDay() {
  dayDialog = 'add'
  dayId = ''
  // Today when today is in the year on screen; otherwise that year's first day, which is at least
  // inside the list the dialog was opened from.
  dayDate = year === new Date().getFullYear() ? isoDate() : `${year}-01-01`
  dayName = ''
  dayKind = 'company_closure'
  dayEffect = '0'
  dayPaid = true
  dayNote = ''
  dayFromPack = false
}

function openEditDay(day: ResolvedCalendarDay) {
  dayDialog = 'edit'
  dayId = day.id
  dayDate = day.date
  dayName = day.name
  dayKind = day.kind
  dayEffect = String(day.workingFraction)
  dayPaid = day.paid
  dayNote = day.note ?? ''
  dayFromPack = day.source === 'pack'
}

function pickKind(kind: string) {
  dayKind = kind as CalendarDayKind
  dayEffect = String(KIND_FRACTION[dayKind])
}

const canSaveDay = $derived(Boolean(dayDate && dayName.trim()) && manage)

const saveDay = createMutation(() => ({
  mutationFn: () =>
    dayDialog === 'edit'
      ? api.calendars.days.update({
          workspaceId,
          calendarId: selectedId,
          dayId,
          name: dayName.trim(),
          kind: dayKind,
          workingFraction: Number(dayEffect),
          paid: dayPaid,
          note: dayNote.trim() || null,
        })
      : api.calendars.days.add({
          workspaceId,
          calendarId: selectedId,
          date: dayDate,
          name: dayName.trim(),
          kind: dayKind,
          workingFraction: Number(dayEffect),
          paid: dayPaid,
          note: dayNote.trim() || null,
        }),
  onSuccess: (day: ResolvedCalendarDay) => {
    toast.success(dayDialog === 'edit' ? t('cal_saved') : t('cal_day_added', { name: day.name }))
    dayDialog = null
    // The year on screen need not contain the day just added.
    year = Number(day.date.slice(0, 4))
    refresh()
  },
  onError: (error: Error) => toast.error(error.message),
  onSettled: settled,
}))

let removing = $state<ResolvedCalendarDay | null>(null)

/**
 * Three different things wear the same button.
 *
 * Deleting a day this company added removes it. "Removing" a pack day cannot delete anything — the
 * server masks it — and removing a row that already masks or changes a pack day gives the pack's
 * own version back. Each says what it does, because the outcomes are not the same and the middle
 * one is the whole reason this screen is safe to use.
 */
const removeMode = $derived(
  !removing ? 'delete' : removing.source === 'pack' ? 'mask' : removing.overrides ? 'restore' : 'delete',
)

const removeDay = createMutation(() => ({
  mutationFn: (day: ResolvedCalendarDay) =>
    api.calendars.days.remove({ workspaceId, calendarId: selectedId, dayId: day.id }),
  onSuccess: (result: { ok: true; suppressed: boolean }, day: ResolvedCalendarDay) => {
    toast.success(
      result.suppressed
        ? t('cal_masked', { name: day.name })
        : removeMode === 'restore'
          ? t('cal_restored', { name: day.name })
          : t('cal_removed', { name: day.name }),
    )
    removing = null
    refresh()
  },
  onError: (error: Error) => toast.error(error.message),
  onSettled: settled,
}))

function dayMenu(day: ResolvedCalendarDay): MenuItem[] {
  const origin = originOf(day)
  const restores = origin === 'masked' || origin === 'changed'
  return [
    { label: t('common.edit'), icon: 'square-pen', onSelect: () => openEditDay(day) },
    { type: 'separator' },
    {
      label: restores ? t('cal_restore') : t('common.remove'),
      icon: restores ? 'rotate-ccw' : 'trash-2',
      // Giving the pack's day back is not destructive — it puts a day off back on the calendar.
      danger: !restores,
      onSelect: () => {
        removing = day
      },
    },
  ]
}

// ---------------------------------------------------------------- the pack

let packOpen = $state(false)
let packInput = $state('')

function openPack() {
  packInput = packKey
  packOpen = true
}

const previewQuery = createQuery(() => ({
  queryKey: ['hr', 'calendar-pack-preview', workspaceId, selectedId, packInput, year] as const,
  enabled: Boolean(packOpen && workspaceId && selectedId && packInput),
  // A pack key that does not exist is a typo, not a network blip: answer at once instead of
  // retrying three times behind a spinner.
  retry: false,
  queryFn: () =>
    api.calendars.pack.preview({ workspaceId, calendarId: selectedId, packKey: packInput, year }),
}))
const preview = $derived(previewQuery.data)
const packChanges = $derived(
  preview ? preview.added.length + preview.changed.length + preview.removed.length : 0,
)

const applyPack = createMutation(() => ({
  mutationFn: () =>
    api.calendars.pack.apply({ workspaceId, calendarId: selectedId, packKey: packInput, year }),
  onSuccess: (result: { added: number; changed: number; removed: number }) => {
    toast.success(
      t('cal_pack_applied', {
        added: result.added,
        changed: result.changed,
        removed: result.removed,
      }),
    )
    packOpen = false
    refresh()
  },
  onError: (error: Error) => toast.error(error.message),
  onSettled: settled,
}))

/** Long lists are for reading, not for scrolling past — the tail is counted instead. */
const HEAD = 8

/**
 * The four things a pack update would do, in the order somebody worries about them — and the fourth
 * is the one that matters: the days added here are listed precisely so the dialog can say they are
 * left alone.
 */
type PackRow = { date: string; name: string; was?: string }
const packGroups = $derived<{ key: string; label: string; rows: PackRow[] }[]>(
  preview
    ? [
        { key: 'added', label: t('cal_pack_added'), rows: preview.added },
        { key: 'changed', label: t('cal_pack_changed'), rows: preview.changed },
        { key: 'removed', label: t('cal_pack_removed'), rows: preview.removed },
        { key: 'kept', label: t('cal_pack_kept'), rows: preview.keptCustom },
      ]
    : [],
)
</script>

<SettingsPage title={t('settings_calendars')} description={t('cal_desc')}>
  {#snippet actions()}
    {#if manage}
      <Button size="sm" icon="plus" onclick={openCreate}>{t('cal_new')}</Button>
    {/if}
  {/snippet}

  <SettingsSection title={t('cal_section')} description={t('cal_section_desc')}>
    {#if calendarsQuery.isLoading}
      <div class="rows">
        {#each [1, 2, 3] as n (n)}<Skeleton height="44px" />{/each}
      </div>
    {:else if calendarsQuery.isError}
      <EmptyState icon="triangle-alert" title={t('cal_error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void calendarsQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if calendars.length === 0}
      <EmptyState icon="calendar" title={t('cal_none')} description={t('cal_none_desc')}>
        {#snippet actions()}
          {#if manage}<Button icon="plus" onclick={openCreate}>{t('cal_new')}</Button>{/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table cals" role="table" aria-label={t('cal_section')}>
        <div class="thead" role="row">
          <span role="columnheader">{t('cal_name')}</span>
          <span role="columnheader">{t('offices_title')}</span>
          <span role="columnheader">{t('cal_working_week')}</span>
          <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
        </div>
        {#each calendars as cal (cal.id)}
          <div
            class="trow"
            class:on={cal.id === selectedId}
            role="row"
            aria-current={cal.id === selectedId ? 'true' : undefined}
          >
            <span class="cell" role="cell">
              <button
                type="button"
                class="pick"
                onclick={() => (picked = cal.id)}
                aria-label={t('cal_show', { name: cal.name })}
              >
                <span class="strong">{cal.name}</span>
                {#if cal.source === 'pack'}
                  <Badge tone="grey">{t('cal_origin_pack')}</Badge>
                {/if}
              </button>
            </span>
            <span class="cell num" role="cell">{formatCount(cal.officeIds.length, 999)}</span>
            <span class="cell muted" role="cell">{weekSummary(cal.workingWeek)}</span>
            <span class="cell actions" role="cell">
              {#if manage}
                <DropdownMenu items={calendarMenu(cal)}>
                  {#snippet trigger(props)}
                    <IconButton
                      icon="ellipsis"
                      label={t('cal_actions_for', { name: cal.name })}
                      size={28}
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
  </SettingsSection>

  {#if selected}
    <SettingsSection title={selected.name} description={baseLine}>
      {#snippet action()}
        <div class="years" role="group" aria-label={t('cal_year')}>
          <IconButton
            icon="chevron-left"
            class="flip"
            label={t('cal_year_prev')}
            size={28}
            variant="outline"
            onclick={() => year--}
          />
          <span class="year">{yearLabel}</span>
          <IconButton
            icon="chevron-right"
            class="flip"
            label={t('cal_year_next')}
            size={28}
            variant="outline"
            onclick={() => year++}
          />
        </div>
      {/snippet}

      {#if daysQuery.isLoading}
        <div class="tiles">
          {#each [1, 2, 3, 4] as n (n)}<Skeleton height="76px" />{/each}
        </div>
      {:else if !daysQuery.isError}
        <div class="tiles">
          <StatTile
            size="md"
            label={t('cal_working_days')}
            value={workingDaysQuery.data ? formatCount(workingDaysQuery.data.days, 9999) : '—'}
          />
          <StatTile size="md" label={t('cal_days_off')} value={formatCount(stats.off, 999)} />
          <StatTile size="md" label={t('cal_from_pack')} value={formatCount(stats.pack, 999)} />
          <StatTile size="md" label={t('cal_added_here')} value={formatCount(stats.own, 999)} />
        </div>
      {/if}

      <SectionLabel label={t('cal_days_title')} count={days.length}>
        {#snippet trailing()}
          {#if manage}
            <Button
              size="sm"
              variant="secondary"
              icon="download"
              disabled={!packKey}
              onclick={openPack}
            >
              {t('cal_pack_update')}
            </Button>
            <Button size="sm" icon="plus" onclick={openAddDay}>{t('cal_add_day')}</Button>
          {/if}
        {/snippet}
      </SectionLabel>

      {#if manage && !packKey}
        <!-- Disabled with the reason beside it: the pack is found by country, and this one has none. -->
        <p class="hint">{t('cal_pack_needs_country')}</p>
      {/if}

      {#if daysQuery.isLoading}
        <div class="rows">
          {#each [1, 2, 3, 4, 5] as n (n)}<Skeleton height="44px" />{/each}
        </div>
      {:else if daysQuery.isError}
        <EmptyState icon="triangle-alert" title={t('cal_days_error')}>
          {#snippet actions()}
            <Button variant="secondary" onclick={() => void daysQuery.refetch()}>{t('retry')}</Button>
          {/snippet}
        </EmptyState>
      {:else if days.length === 0}
        <EmptyState
          icon="calendar-days"
          title={t('cal_days_none', { year: yearLabel })}
          description={t('cal_days_none_desc')}
        >
          {#snippet actions()}
            {#if manage}
              <Button icon="plus" onclick={openAddDay}>{t('cal_add_day')}</Button>
              {#if packKey}
                <Button variant="secondary" icon="download" onclick={openPack}>
                  {t('cal_pack_update')}
                </Button>
              {/if}
            {/if}
          {/snippet}
        </EmptyState>
      {:else}
        <div class="table days" role="table" aria-label={t('cal_days_title')}>
          <div class="thead" role="row">
            <span role="columnheader">{t('cal_date')}</span>
            <span role="columnheader">{t('cal_name')}</span>
            <span role="columnheader">{t('cal_effect')}</span>
            <span role="columnheader">{t('cal_origin')}</span>
            <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
          </div>
          {#each days as day (day.id)}
            {@const origin = originOf(day)}
            <div class="trow" role="row">
              <span class="cell muted num" role="cell">
                {formatDate(day.date, { weekday: 'short', day: 'numeric', month: 'short' })}
              </span>
              <span class="cell what" role="cell">
                <!-- A masked pack day is struck through rather than removed: it is still there, and
                     that is exactly what stops the next upgrade bringing it back. -->
                <span class="strong" class:struck={origin === 'masked'}>{day.name}</span>
                <span class="chips">
                  <Badge tone="grey">{kindLabel(day.kind)}</Badge>
                  <span class="only-narrow">
                    <Badge tone={ORIGIN_TONES[origin]}>{originLabel(origin)}</Badge>
                  </span>
                </span>
              </span>
              <span class="cell muted" role="cell">{effectLabel(day.workingFraction)}</span>
              <span class="cell" role="cell">
                <Badge
                  tone={ORIGIN_TONES[origin]}
                  title={origin === 'pack' ? t('cal_origin_from', { name: day.fromCalendarName }) : undefined}
                >
                  {originLabel(origin)}
                </Badge>
              </span>
              <span class="cell actions" role="cell">
                {#if manage}
                  <DropdownMenu items={dayMenu(day)}>
                    {#snippet trigger(props)}
                      <IconButton
                        icon="ellipsis"
                        label={t('cal_actions_for', { name: day.name })}
                        size={28}
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
    </SettingsSection>
  {/if}
</SettingsPage>

<!-- ---------------------------------------------------------------- calendar form -->
<Dialog
  open={calDialog !== null}
  title={calDialog === 'edit' ? t('cal_edit_title') : t('cal_create_title')}
  onOpenChange={(o) => {
    if (!o) calDialog = null
  }}
>
  <div class="form">
    <Field label={t('cal_name')} hint={t('cal_name_hint')} required>
      {#snippet children(id)}
        <Input {id} bind:value={calName} maxlength={160} />
      {/snippet}
    </Field>

    <Field label={t('cal_base')} hint={t('cal_base_hint')}>
      {#snippet children(id)}
        <Select
          {id}
          value={calExtends}
          onValueChange={(v) => (calExtends = v)}
          placeholder={t('cal_base_none')}
          options={[
            { value: '', label: t('cal_base_none') },
            ...calendars
              .filter((c) => c.id !== calId)
              .map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
      {/snippet}
    </Field>

    {#if calDialog === 'create'}
      <div class="pair">
        <Field
          label={t('cal_country')}
          hint={t('cal_country_hint')}
          error={countryValid ? null : t('cal_country_invalid')}
        >
          {#snippet children(id)}
            <Input
              {id}
              mono
              value={calCountry}
              maxlength={2}
              oninput={(e) => (calCountry = e.currentTarget.value.toUpperCase())}
            />
          {/snippet}
        </Field>
        <Field label={t('cal_region')} hint={t('cal_region_hint')}>
          {#snippet children(id)}
            <Input {id} mono bind:value={calRegion} maxlength={8} />
          {/snippet}
        </Field>
      </div>
    {/if}

    <div class="week">
      <span class="week-label">{t('cal_working_week')}</span>
      <p class="hint">{t('cal_week_hint')}</p>
      <div class="week-grid">
        {#each WEEKDAYS as d (d.key)}
          <Field label={formatDate(d.iso, { weekday: 'long' })}>
            {#snippet children(id)}
              <Select
                {id}
                size="sm"
                value={String(calWeek[d.key])}
                onValueChange={(v) => setWeekday(d.key, Number(v))}
                options={[
                  { value: '1', label: t('cal_day_full') },
                  { value: '0.5', label: t('cal_day_half') },
                  { value: '0', label: t('cal_day_off') },
                ]}
              />
            {/snippet}
          </Field>
        {/each}
      </div>
    </div>
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (calDialog = null)} disabled={saveCalendar.isPending}>
      {t('cancel')}
    </Button>
    <Button
      loading={saveCalendar.isPending}
      disabled={!calName.trim() || !countryValid || !manage}
      onclick={() => once(() => saveCalendar.mutate())}
    >
      {calDialog === 'edit' ? t('common.save') : t('common.create')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- archive a calendar -->
<Dialog
  open={archiving !== null}
  size="sm"
  title={archiving ? t('cal_archive_title', { name: archiving.name }) : ''}
  description={t('cal_archive_body')}
  onOpenChange={(o) => {
    if (!o) archiving = null
  }}
>
  <p class="body">{t('cal_archive_keeps')}</p>

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (archiving = null)} disabled={archiveCalendar.isPending}>
      {t('cancel')}
    </Button>
    <Button
      variant="danger"
      loading={archiveCalendar.isPending}
      onclick={() => {
        if (archiving) once(() => archiving && archiveCalendar.mutate(archiving))
      }}
    >
      {t('common.archive')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- day form -->
<Dialog
  open={dayDialog !== null}
  title={dayDialog === 'edit' ? t('cal_day_edit_title') : t('cal_day_add_title')}
  onOpenChange={(o) => {
    if (!o) dayDialog = null
  }}
>
  <div class="form">
    {#if dayFromPack}
      <!-- Editing a pack day does not touch the pack: the change is kept as this company's own row
           on top of it, which is why the next upgrade cannot undo it. -->
      <p class="note">{t('cal_edit_pack_day')}</p>
    {/if}

    <div class="pair">
      <Field label={t('cal_date')} required>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={dayDate} disabled={dayDialog === 'edit'} />
        {/snippet}
      </Field>
      <Field label={t('cal_kind')}>
        {#snippet children(id)}
          <Select
            {id}
            value={dayKind}
            onValueChange={pickKind}
            options={DAY_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
          />
        {/snippet}
      </Field>
    </div>

    <Field label={t('cal_name')} hint={t('cal_day_name_hint')} required>
      {#snippet children(id)}
        <Input {id} bind:value={dayName} maxlength={160} />
      {/snippet}
    </Field>

    <div class="pair">
      <Field label={t('cal_effect')} hint={t('cal_effect_hint')}>
        {#snippet children(id)}
          <Select {id} value={dayEffect} onValueChange={(v) => (dayEffect = v)} options={effectOptions} />
        {/snippet}
      </Field>
      <div class="paid">
        <Switch
          checked={dayPaid}
          onCheckedChange={(v) => (dayPaid = v)}
          label={t('cal_paid')}
          description={t('cal_paid_hint')}
        />
      </div>
    </div>

    <Field label={t('cal_note')} hint={t('cal_note_hint')}>
      {#snippet children(id)}
        <Textarea {id} bind:value={dayNote} rows={2} maxlength={500} />
      {/snippet}
    </Field>
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (dayDialog = null)} disabled={saveDay.isPending}>
      {t('cancel')}
    </Button>
    <Button loading={saveDay.isPending} disabled={!canSaveDay} onclick={() => once(() => saveDay.mutate())}>
      {dayDialog === 'edit' ? t('common.save') : t('common.add')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- remove, mask or restore -->
<Dialog
  open={removing !== null}
  size="sm"
  title={removing
    ? removeMode === 'restore'
      ? t('cal_restore_title', { name: removing.name })
      : t('cal_remove_title', { name: removing.name })
    : ''}
  description={removeMode === 'mask'
    ? t('cal_remove_pack_body')
    : removeMode === 'restore'
      ? t('cal_restore_body')
      : t('cal_remove_custom_body')}
  onOpenChange={(o) => {
    if (!o) removing = null
  }}
>
  {#if removing}
    <p class="body">
      <span class="strong">{removing.name}</span>
      <span class="muted">
        &nbsp;— {formatDate(removing.date, { dateStyle: 'medium' })}
      </span>
    </p>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (removing = null)} disabled={removeDay.isPending}>
      {t('cancel')}
    </Button>
    <Button
      variant={removeMode === 'restore' ? 'primary' : 'danger'}
      loading={removeDay.isPending}
      onclick={() => {
        if (removing) once(() => removing && removeDay.mutate(removing))
      }}
    >
      {removeMode === 'restore'
        ? t('cal_restore')
        : removeMode === 'mask'
          ? t('cal_mask')
          : t('common.remove')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- pack preview, then apply -->
<Dialog
  bind:open={packOpen}
  size="lg"
  title={t('cal_pack_title')}
  description={t('cal_pack_desc', { year: yearLabel })}
  onOpenChange={(o) => {
    if (!o) packOpen = false
  }}
>
  <div class="form">
    <Field label={t('cal_pack_key')} hint={t('cal_pack_key_hint')}>
      {#snippet children(id)}
        <Input {id} mono bind:value={packInput} maxlength={32} />
      {/snippet}
    </Field>

    {#if previewQuery.isLoading || previewQuery.isFetching}
      <div class="rows">
        {#each [1, 2, 3] as n (n)}<Skeleton height="40px" />{/each}
      </div>
    {:else if previewQuery.isError}
      <EmptyState icon="triangle-alert" title={t('cal_pack_error')} description={t('cal_pack_error_desc')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void previewQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if preview}
      {#if packChanges === 0}
        <EmptyState
          icon="check-check"
          title={t('cal_pack_current')}
          description={t('cal_pack_current_desc', { pack: preview.packKey, year: yearLabel })}
        />
      {:else}
        <p class="note">{t('cal_pack_preview_desc')}</p>
      {/if}

      <div class="groups">
        {#each packGroups as group (group.key)}
          {#if group.rows.length > 0}
            <div class="group">
              <SectionLabel label={group.label} count={group.rows.length} sub />
              <ul class="plist">
                {#each group.rows.slice(0, HEAD) as row (row.date + row.name)}
                  <li>
                    <span class="pdate">{formatDate(row.date, { day: 'numeric', month: 'short' })}</span>
                    <span class="pname">{row.name}</span>
                    {#if row.was}
                      <span class="muted">{t('cal_pack_was', { name: row.was })}</span>
                    {/if}
                  </li>
                {/each}
                {#if group.rows.length > HEAD}
                  <li class="muted">{t('cal_pack_more', { count: group.rows.length - HEAD })}</li>
                {/if}
              </ul>
              {#if group.key === 'kept'}
                <p class="hint">{t('cal_pack_kept_desc')}</p>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (packOpen = false)} disabled={applyPack.isPending}>
      {t('cancel')}
    </Button>
    <Button
      loading={applyPack.isPending}
      disabled={!manage || !preview || packChanges === 0}
      onclick={() => once(() => applyPack.mutate())}
    >
      {t('cal_pack_apply')}
    </Button>
  {/snippet}
</Dialog>

<style>
.rows {
  display: grid;
  gap: 4px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-block-end: 18px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  width: 100%;
}
.cals {
  --hr-cal-cols: minmax(150px, 1fr) 72px minmax(130px, 1.1fr) 32px;
}
.days {
  --hr-cal-cols: 132px minmax(140px, 1fr) 92px 128px 32px;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-cal-cols);
  gap: 10px;
  align-items: center;
  padding-inline: 10px;
  border-inline-start: 2px solid transparent;
}
.thead {
  height: 32px;
  border-block-end: 1px solid var(--kern-border);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.trow {
  min-height: 44px;
  border-block-end: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-md);
}
.trow:hover {
  background: var(--kern-surface-raised);
}
/* The calendar the year below belongs to. A border rather than a colour alone, so it survives a
   theme where the tint is nearly the surface it sits on. */
.cals .trow.on {
  border-inline-start-color: var(--kern-accent);
  background: var(--kern-surface-active);
}
.cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pick {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
  padding-block: 6px;
  text-align: start;
}
.strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13.5px;
  font-weight: 500;
}
.struck {
  text-decoration: line-through;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-500);
}
.what {
  display: flex;
  align-items: center;
  gap: 8px;
}
.chips {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.muted {
  font-size: 13px;
  color: var(--kern-ink-500);
}
.num {
  font-variant-numeric: tabular-nums;
}
.actions {
  display: flex;
  justify-content: flex-end;
  overflow: visible;
}
.only-narrow {
  display: none;
}

.years {
  display: flex;
  align-items: center;
  gap: 6px;
}
.year {
  min-width: 52px;
  text-align: center;
  font-size: 13.5px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
/* "Previous" points the other way in Persian and Arabic. */
:global([dir='rtl']) .years :global(.flip) {
  transform: scaleX(-1);
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.note {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--kern-r-md2);
  background: var(--kern-info-tint);
  color: var(--kern-ink-700);
  font-size: 12.5px;
  line-height: 1.5;
}
.body {
  margin: 0 0 4px;
  font-size: 13.5px;
}

.form {
  display: grid;
  gap: 14px;
}
.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}
.paid {
  padding-block-start: 22px;
}
.week {
  display: grid;
  gap: 6px;
}
.week-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--kern-ink-800);
}
.week-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
  margin-block-start: 4px;
}

.groups {
  display: grid;
  gap: 14px;
}
.group {
  display: grid;
  gap: 2px;
}
.plist {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.plist li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  font-size: 13px;
}
.pdate {
  min-width: 76px;
  color: var(--kern-ink-500);
  font-variant-numeric: tabular-nums;
}
.pname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .cals {
    --hr-cal-cols: minmax(130px, 1fr) minmax(110px, 1fr) 32px;
  }
  .days {
    --hr-cal-cols: 108px minmax(120px, 1fr) 32px;
  }
  /* The office count and the two right-hand day columns go; provenance is the one thing that
     cannot, so it moves into the name cell rather than disappearing with them. */
  .cals .thead > :nth-child(2),
  .cals .trow > :nth-child(2),
  .days .thead > :nth-child(3),
  .days .trow > :nth-child(3),
  .days .thead > :nth-child(4),
  .days .trow > :nth-child(4) {
    display: none;
  }
  .only-narrow {
    display: inline-flex;
  }
  .pair,
  .week-grid {
    grid-template-columns: 1fr;
  }
  .paid {
    padding-block-start: 0;
  }
}
</style>
