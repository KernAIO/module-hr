<script lang="ts">
import {
  Badge,
  Button,
  Checkbox,
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
import type { RosterAssignment, RosterPattern, RosterShift } from '../../contract/rosters.js'
import { getHrApi } from '../api-instance.js'
import { explainRefusal } from '../components/refusal.js'
import {
  anchorDay,
  crossesMidnight,
  ROSTER_COLORS,
  rosterColorKey,
  shiftCode,
  shiftNetMinutes,
  WALL_CLOCK,
} from '../components/roster-shifts.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { formatDuration, hrKeys, isoDate } from '../query.js'

/**
 * Where a roster is set up: the shifts, the rotations built out of them, and who is on which.
 *
 * Three sections on one page rather than three pages, because they are one thing read top to
 * bottom — a rotation is a cycle *of shifts*, and an assignment puts somebody *on a rotation* — and
 * the editor for each needs the section above it to have something in it. A rotation editor with
 * no shifts to pick from says so and points up the page.
 *
 * **The rotation is arithmetic, and the screen says so where it matters.** Nothing here generates a
 * day; a pattern is a cycle plus the date day 1 falls on, and the contract's docblock explains why.
 * Two consequences land on this screen. Editing a rotation moves every crew on it on every date at
 * once, so the editor says that above the cycle when it is an existing one. And `cycleOffset` is
 * how two crews share one rotation out of phase, so the assign dialog offers it as "starts on day
 * *n* of the cycle" with a sentence about crew B — offered as a bare integer, nobody would set it.
 *
 * **Refusals the server makes are made here first, in the reader's language.** The router's
 * sentences are English — "Ada already starts a rotation on 2026-10-01" — and the module has no
 * reason tokens for rosters, so the one honest way to put a translated sentence in front of
 * somebody is to notice the same thing the server would before asking it: a range reversed, a cycle
 * longer than 56 days, a person who already has a later assignment. Whatever this screen cannot
 * predict still shows the server's own sentence through `explainRefusal`, which is more than a
 * generic "could not be saved" says.
 *
 * Archive, never delete, in both sections: a stored override and a rotation both point at a shift
 * by id, and an assignment points at a rotation, so a delete would empty out rostered days that
 * have already been worked. Each confirmation says exactly what stays.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/** Declared with this permission, but a read-only view of what is set up is useful in its own right. */
const manage = $derived(canHr('attendanceManage'))

const MAX_CYCLE_DAYS = 56
const MAX_SHIFTS_PER_DAY = 4

const DURATION_WORDS = {
  hours: (n: string) => t('hours_short', { n }),
  minutes: (n: string) => t('minutes_short', { n }),
}
const duration = (minutes: number) => formatDuration(minutes, DURATION_WORDS, messageLocale())
const number = (n: number) => new Intl.NumberFormat(messageLocale()).format(n)

/**
 * A shift as a range, in the reader's order.
 *
 * A shift that crosses midnight is two clock times, not two dates: `formatRange` given an end on
 * the next day prints both dates in full — "1/1/2024, 10:00 PM – 1/2/2024, 6:00 AM", with the
 * anchor day showing as if it meant something — so the two ends are formatted on their own and
 * the "+1" beside the range says which day the second one is.
 */
const shiftRange = (shift: Pick<RosterShift, 'start' | 'end'>) => {
  const time = { hour: '2-digit', minute: '2-digit' } as const
  if (!crossesMidnight(shift))
    return formatDateRange(`${anchorDay(0)}T${shift.start}:00`, `${anchorDay(0)}T${shift.end}:00`, time)
  const clock = new Intl.DateTimeFormat(messageLocale(), time)
  return `${clock.format(new Date(`${anchorDay(0)}T${shift.start}:00`))} – ${clock.format(new Date(`${anchorDay(1)}T${shift.end}:00`))}`
}

const colorName = (hex: string | null) => {
  const key = rosterColorKey(hex)
  return key ? t(`roster_color_${key}`) : (hex ?? t('roster_color_none'))
}

// ---------------------------------------------------------------- the lists

/** Archived rows come with the rest and are hidden here, so one request answers both views. */
const shiftsQuery = createQuery(() => ({
  queryKey: hrKeys.rosterShifts(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.rosters.shifts.list({ workspaceId, includeArchived: true }),
}))
let showArchivedShifts = $state(false)
const allShifts = $derived(shiftsQuery.data ?? [])
const liveShifts = $derived(allShifts.filter((s) => !s.archivedAt))
const archivedShiftCount = $derived(allShifts.length - liveShifts.length)
const shifts = $derived(showArchivedShifts ? allShifts : liveShifts)
const shiftById = $derived(new Map(allShifts.map((s) => [s.id, s])))

const patternsQuery = createQuery(() => ({
  queryKey: hrKeys.rosterPatterns(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.rosters.patterns.list({ workspaceId, includeArchived: true }),
}))
let showArchivedPatterns = $state(false)
const allPatterns = $derived(patternsQuery.data ?? [])
const livePatterns = $derived(allPatterns.filter((p) => !p.archivedAt))
const archivedPatternCount = $derived(allPatterns.length - livePatterns.length)
const patterns = $derived(showArchivedPatterns ? allPatterns : livePatterns)
const patternById = $derived(new Map(allPatterns.map((p) => [p.id, p])))

const assignmentsQuery = createQuery(() => ({
  queryKey: hrKeys.rosterAssignments(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.rosters.assignments({ workspaceId }),
}))
const assignments = $derived(assignmentsQuery.data ?? [])

/**
 * Everybody, not only the active: an assignment that ended last year names somebody who may have
 * left, and a row that cannot say who it was about is a row nobody can read. The picker below
 * narrows to the active ones itself.
 */
const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forRosters: true }),
  enabled: Boolean(workspaceId),
  queryFn: () => api.people.list({ workspaceId, limit: 200 }),
}))
const people = $derived(peopleQuery.data?.items ?? [])
const activePeople = $derived(people.filter((p) => p.status === 'active'))
const personName = (personId: string) =>
  people.find((p) => p.id === personId)?.displayName ?? t('roster_person_unknown')
const patternName = (patternId: string) => patternById.get(patternId)?.name ?? t('roster_pattern_unknown')

const today = isoDate()

/** Why every list on this page refetches together: a shift edit changes what a rotation shows. */
const refresh = () => void queryClient.invalidateQueries({ queryKey: ['hr'] })

// ---------------------------------------------------------------- shift editor

let editingShift = $state<{ shift: RosterShift | null } | null>(null)
let shiftName = $state('')
let shiftCodeValue = $state('')
let shiftStart = $state('06:00')
let shiftEnd = $state('14:00')
let shiftBreak = $state('0')
let shiftGraceIn = $state('0')
let shiftGraceOut = $state('0')
let shiftColor = $state<string | null>(null)
let shiftError = $state<string | null>(null)
let shiftSaving = $state(false)

function openShift(shift: RosterShift | null) {
  editingShift = { shift }
  shiftError = null
  shiftName = shift?.name ?? ''
  shiftCodeValue = shift?.code ?? ''
  shiftStart = shift?.start ?? '06:00'
  shiftEnd = shift?.end ?? '14:00'
  shiftBreak = String(shift?.breakMinutes ?? 0)
  shiftGraceIn = String(shift?.graceInMinutes ?? 0)
  shiftGraceOut = String(shift?.graceOutMinutes ?? 0)
  shiftColor = shift?.color ?? null
}
const shiftIsNew = $derived(editingShift?.shift == null)

const clamp = (value: string, min: number, max: number) =>
  Math.min(Math.max(Math.round(Number(value) || 0), min), max)

/** A break somebody typed into the API keeps its place in the list. */
const breakOptions = (current: number) =>
  [...new Set([0, 15, 30, 45, 60, 90, current])]
    .sort((a, b) => a - b)
    .map((minutes) => ({
      value: String(minutes),
      label: minutes === 0 ? t('schedule_break_none') : duration(minutes),
    }))

const shiftDraft = $derived({ start: shiftStart, end: shiftEnd, breakMinutes: clamp(shiftBreak, 0, 480) })
const shiftTimesComplete = $derived(WALL_CLOCK.test(shiftStart) && WALL_CLOCK.test(shiftEnd))
const shiftBlocked = $derived(
  !manage
    ? t('rosters_readonly')
    : !shiftName.trim()
      ? t('roster_shift_name_required')
      : !shiftTimesComplete
        ? t('roster_shift_time_missing')
        : null,
)

const saveShift = createMutation(() => ({
  mutationFn: () => {
    const current = editingShift?.shift ?? null
    const common = {
      workspaceId,
      name: shiftName.trim(),
      code: shiftCodeValue.trim() || null,
      start: shiftStart,
      end: shiftEnd,
      breakMinutes: clamp(shiftBreak, 0, 480),
      graceInMinutes: clamp(shiftGraceIn, 0, 240),
      graceOutMinutes: clamp(shiftGraceOut, 0, 240),
      color: shiftColor,
    }
    return current
      ? api.rosters.shifts.update({ ...common, shiftId: current.id })
      : api.rosters.shifts.create(common)
  },
  onSuccess: (shift) => {
    toast.success(shiftIsNew ? t('roster_shift_created', { name: shift.name }) : t('roster_shift_saved'))
    editingShift = null
    refresh()
  },
  onError: (error) => {
    shiftError = explainRefusal(error, t('roster_shift_save_error'))
  },
  onSettled: () => {
    shiftSaving = false
  },
}))

function submitShift() {
  // The guard is a flag set in the same tick as the click: `disabled` lands a render later, and
  // two quick clicks are one render apart.
  if (shiftSaving || shiftBlocked) return
  shiftSaving = true
  shiftError = null
  saveShift.mutate()
}

let archivingShift = $state<RosterShift | null>(null)
let archiveShiftError = $state<string | null>(null)
let archiveShiftBusy = $state(false)
const archiveShift = createMutation(() => ({
  mutationFn: () => api.rosters.shifts.archive({ workspaceId, shiftId: archivingShift?.id ?? '' }),
  onSuccess: () => {
    toast.success(t('roster_shift_archived_toast', { name: archivingShift?.name ?? '' }))
    archivingShift = null
    refresh()
  },
  onError: (error) => {
    archiveShiftError = explainRefusal(error, t('roster_shift_archive_error'))
  },
  onSettled: () => {
    archiveShiftBusy = false
  },
}))
function submitArchiveShift() {
  if (archiveShiftBusy) return
  archiveShiftBusy = true
  archiveShiftError = null
  archiveShift.mutate()
}

// ---------------------------------------------------------------- rotation editor

let editingPattern = $state<{ pattern: RosterPattern | null } | null>(null)
let patternNameValue = $state('')
let patternAnchor = $state(today)
/** The cycle: one entry per day, each the shift ids worked. `[]` is a rest day. */
let cycle = $state<string[][]>([])
let patternError = $state<string | null>(null)
let patternSaving = $state(false)

/** Four on, four off — the rotation this whole feature exists for, and a better blank than nothing. */
const defaultCycle = (): string[][] => {
  const first = liveShifts[0]?.id
  return first ? [[first], [first], [first], [first], [], [], [], []] : [[], [], [], [], [], [], [], []]
}

function openPattern(pattern: RosterPattern | null) {
  editingPattern = { pattern }
  patternError = null
  patternNameValue = pattern?.name ?? ''
  patternAnchor = pattern?.anchorDate ?? today
  cycle = pattern ? pattern.days.map((d) => [...d]) : defaultCycle()
}
const patternIsNew = $derived(editingPattern?.pattern == null)

function toggleShiftOnDay(dayIndex: number, shiftId: string, on: boolean) {
  const current = cycle[dayIndex] ?? []
  const next = on
    ? [...current.filter((id) => id !== shiftId), shiftId]
    : current.filter((id) => id !== shiftId)
  if (next.length > MAX_SHIFTS_PER_DAY) return
  cycle = cycle.map((d, i) => (i === dayIndex ? next : d))
}
function addCycleDay() {
  if (cycle.length >= MAX_CYCLE_DAYS) return
  cycle = [...cycle, []]
}
function removeCycleDay(dayIndex: number) {
  if (cycle.length <= 1) return
  cycle = cycle.filter((_, i) => i !== dayIndex)
}

/**
 * The shifts a cycle editor offers: the live ones, plus any archived one this rotation still names,
 * so opening an old rotation does not silently drop a shift the server would keep.
 */
const editorShifts = $derived.by(() => {
  const named = new Set(cycle.flat())
  return allShifts.filter((s) => !s.archivedAt || named.has(s.id))
})

const patternBlocked = $derived(
  !manage
    ? t('rosters_readonly')
    : liveShifts.length === 0 && patternIsNew
      ? t('roster_pattern_no_shifts')
      : !patternNameValue.trim()
        ? t('roster_pattern_name_required')
        : !patternAnchor
          ? t('roster_pattern_anchor_required')
          : cycle.length === 0
            ? t('roster_pattern_add_day')
            : null,
)

const savePattern = createMutation(() => ({
  mutationFn: () => {
    const current = editingPattern?.pattern ?? null
    // A plain array, not the `$state` proxy: the API layer clones what it sends.
    const days = $state.snapshot(cycle)
    const common = { workspaceId, name: patternNameValue.trim(), anchorDate: patternAnchor, days }
    return current
      ? api.rosters.patterns.update({ ...common, patternId: current.id })
      : api.rosters.patterns.create(common)
  },
  onSuccess: (pattern) => {
    toast.success(
      patternIsNew ? t('roster_pattern_created', { name: pattern.name }) : t('roster_pattern_saved'),
    )
    editingPattern = null
    refresh()
  },
  onError: (error) => {
    patternError = explainRefusal(error, t('roster_pattern_save_error'))
  },
  onSettled: () => {
    patternSaving = false
  },
}))
function submitPattern() {
  if (patternSaving || patternBlocked) return
  patternSaving = true
  patternError = null
  savePattern.mutate()
}

let archivingPattern = $state<RosterPattern | null>(null)
let archivePatternError = $state<string | null>(null)
let archivePatternBusy = $state(false)
const archivePattern = createMutation(() => ({
  mutationFn: () => api.rosters.patterns.archive({ workspaceId, patternId: archivingPattern?.id ?? '' }),
  onSuccess: () => {
    toast.success(t('roster_pattern_archived_toast', { name: archivingPattern?.name ?? '' }))
    archivingPattern = null
    refresh()
  },
  onError: (error) => {
    archivePatternError = explainRefusal(error, t('roster_pattern_archive_error'))
  },
  onSettled: () => {
    archivePatternBusy = false
  },
}))
function submitArchivePattern() {
  if (archivePatternBusy) return
  archivePatternBusy = true
  archivePatternError = null
  archivePattern.mutate()
}

/** How many of a rotation's people are still on it today, for the archive dialog to say so. */
const onPatternNow = (patternId: string) =>
  assignments.filter(
    (a) =>
      a.patternId === patternId &&
      a.effectiveFrom <= today &&
      (a.effectiveTo === null || a.effectiveTo >= today),
  ).length

const workingDays = (pattern: RosterPattern) => pattern.days.filter((d) => d.length > 0).length

// ---------------------------------------------------------------- assigning

let assigning = $state(false)
let assignPatternId = $state('')
let assignPeople = $state<Set<string>>(new Set())
let assignFrom = $state(today)
let assignTo = $state('')
let assignOffset = $state('0')
let assignError = $state<string | null>(null)
let assignBusy = $state(false)

function openAssign(pattern: RosterPattern | null) {
  assigning = true
  assignPatternId = pattern?.id ?? livePatterns[0]?.id ?? ''
  assignPeople = new Set()
  assignFrom = today
  assignTo = ''
  assignOffset = '0'
  assignError = null
}
function togglePerson(personId: string, on: boolean) {
  const next = new Set(assignPeople)
  if (on) next.add(personId)
  else next.delete(personId)
  assignPeople = next
}

const assignPattern = $derived(patternById.get(assignPatternId) ?? null)
const patternOptions = $derived(livePatterns.map((p) => ({ value: p.id, label: p.name })))
/** "Day n of the cycle", one option per position, so an offset is chosen as a day and not typed. */
const offsetOptions = $derived(
  Array.from({ length: assignPattern?.days.length ?? 1 }, (_, i) => ({
    value: String(i),
    label: t('roster_assign_offset_day', { n: number(i + 1) }),
  })),
)
$effect(() => {
  // A rotation with a shorter cycle than the offset already chosen would send an offset the
  // server accepts and nobody meant.
  if (Number(assignOffset) >= (assignPattern?.days.length ?? 1)) assignOffset = '0'
})

const assignDatesInvalid = $derived(Boolean(assignTo) && assignTo < assignFrom)

/**
 * The refusal the server would make, made here in the reader's language.
 *
 * `assign` closes an assignment already *running* on the start date and refuses one that starts
 * later — trimming that backwards would delete somebody's plan. The same rows are on this page, so
 * the sentence can name the person and the date before anything is sent.
 */
const assignClash = $derived.by(() => {
  for (const personId of assignPeople) {
    const later = assignments
      .filter(
        (a) =>
          a.personId === personId &&
          a.effectiveFrom >= assignFrom &&
          (!assignTo || a.effectiveFrom <= assignTo),
      )
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0]
    if (later)
      return t('roster_assign_clash', { name: personName(personId), date: formatDate(later.effectiveFrom) })
  }
  return null
})

const assignBlocked = $derived(
  !manage
    ? t('rosters_readonly')
    : !assignPatternId || assignPeople.size === 0
      ? t('roster_assign_required')
      : !assignFrom
        ? t('roster_assign_required')
        : assignDatesInvalid
          ? t('roster_assign_dates_invalid')
          : assignClash,
)

const assign = createMutation(() => ({
  mutationFn: () =>
    api.rosters.assign({
      workspaceId,
      patternId: assignPatternId,
      personIds: [...assignPeople],
      effectiveFrom: assignFrom,
      effectiveTo: assignTo || null,
      cycleOffset: Number(assignOffset),
    }),
  onSuccess: () => {
    toast.success(
      t('roster_assigned', {
        count: assignPeople.size,
        pattern: assignPattern?.name ?? '',
        date: formatDate(assignFrom),
      }),
    )
    assigning = false
    refresh()
  },
  onError: (error) => {
    assignError = explainRefusal(error, t('roster_assign_error'))
  },
  onSettled: () => {
    assignBusy = false
  },
}))
function submitAssign() {
  if (assignBusy || assignBlocked) return
  assignBusy = true
  assignError = null
  assign.mutate()
}

// ---------------------------------------------------------------- ending an assignment

let ending = $state<RosterAssignment | null>(null)
let endOn = $state(today)
let endError = $state<string | null>(null)
let endBusy = $state(false)

function openEnd(assignment: RosterAssignment) {
  ending = assignment
  // Today, unless the assignment starts later — the earliest day it can end on is its first.
  endOn = assignment.effectiveFrom > today ? assignment.effectiveFrom : today
  endError = null
}

/**
 * `unassign` only closes assignments that have started by the date given; one ended before its
 * first day is left exactly as it was, and reports `closed: 0`. Rather than let somebody pick a
 * date and be told nothing happened, the earliest day offered is the assignment's own first day.
 */
const endTooEarly = $derived(Boolean(ending) && Boolean(endOn) && endOn < (ending?.effectiveFrom ?? ''))
const endBlocked = $derived(
  !manage
    ? t('rosters_readonly')
    : !endOn
      ? t('roster_unassign_last_day')
      : endTooEarly
        ? t('roster_unassign_before_start', { date: formatDate(ending?.effectiveFrom ?? '') })
        : null,
)

const unassign = createMutation(() => ({
  mutationFn: () =>
    api.rosters.unassign({ workspaceId, personIds: [ending?.personId ?? ''], effectiveTo: endOn }),
  onSuccess: ({ closed }) => {
    if (closed === 0) toast.info(t('roster_unassign_nothing'))
    else
      toast.success(
        t('roster_unassigned', { name: personName(ending?.personId ?? ''), date: formatDate(endOn) }),
      )
    ending = null
    refresh()
  },
  onError: (error) => {
    endError = explainRefusal(error, t('roster_unassign_error'))
  },
  onSettled: () => {
    endBusy = false
  },
}))
function submitEnd() {
  if (endBusy || endBlocked) return
  endBusy = true
  endError = null
  unassign.mutate()
}

/** An assignment's place in time, for the badge beside its period. */
const periodState = (a: RosterAssignment): 'ended' | 'upcoming' | 'current' =>
  a.effectiveTo !== null && a.effectiveTo < today ? 'ended' : a.effectiveFrom > today ? 'upcoming' : 'current'
</script>

<SettingsPage title={t('settings_rosters')} description={t('rosters_desc')}>
  {#snippet actions()}
    {#if manage}
      <Button size="sm" icon="plus" onclick={() => openShift(null)}>{t('roster_shift_new')}</Button>
    {/if}
  {/snippet}

  <!-- ------------------------------------------------------------ shifts -->

  <SectionLabel label={t('roster_shifts')} count={formatCount(shifts.length)}>
    {#snippet trailing()}
      {#if archivedShiftCount > 0}
        <Switch
          size="sm"
          checked={showArchivedShifts}
          onCheckedChange={(on) => (showArchivedShifts = on)}
          label={t('roster_show_archived')}
        />
      {/if}
    {/snippet}
  </SectionLabel>

  {#if shiftsQuery.isLoading || !workspaceId}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="52px" />{/each}
    </div>
  {:else if shiftsQuery.isError}
    <EmptyState icon="triangle-alert" title={t('roster_shifts_error')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void shiftsQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if shifts.length === 0}
    <EmptyState icon="clock" title={t('roster_shifts_none')} description={t('roster_shifts_none_desc')}>
      {#snippet actions()}
        {#if manage}
          <Button size="sm" icon="plus" onclick={() => openShift(null)}>{t('roster_shift_new')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <div class="table shifts" role="table" aria-label={t('roster_shifts')}>
      <div class="thead" role="row">
        <span role="columnheader">{t('roster_shift_name')}</span>
        <span role="columnheader">{t('roster_shift_hours')}</span>
        <span role="columnheader">{t('schedule_break')}</span>
        <span role="columnheader">{t('roster_shift_grace')}</span>
        <span role="columnheader">{t('schedule_net')}</span>
        <span class="sr-only" role="columnheader">{t('schedule_actions')}</span>
      </div>
      {#each shifts as shift (shift.id)}
        <div class="trow" role="row">
          <span class="cell title" role="cell">
            <!-- The swatch is a picture; the name it stands for is read out by the code chip's label. -->
            <span class="swatch" style:background={shift.color ?? 'transparent'} class:empty={!shift.color}></span>
            <span class="code" aria-label={t('roster_shift_code')}>{shiftCode(shift)}</span>
            <span class="name">{shift.name}</span>
            {#if shift.archivedAt}<Badge tone="grey">{t('schedule_archived')}</Badge>{/if}
          </span>
          <span class="cell num" role="cell">
            {shiftRange(shift)}
            {#if crossesMidnight(shift)}
              <span class="overnight" aria-hidden="true">+1</span>
              <span class="sr-only">{t('schedule_overnight')}</span>
            {/if}
          </span>
          <span class="cell num" role="cell">
            {shift.breakMinutes ? duration(shift.breakMinutes) : t('schedule_break_none')}
          </span>
          <span class="cell num" role="cell">
            {t('roster_shift_grace_pair', { in: number(shift.graceInMinutes), out: number(shift.graceOutMinutes) })}
          </span>
          <span class="cell num" role="cell">{duration(shiftNetMinutes(shift))}</span>
          <span class="cell actions" role="cell">
            {#if manage && !shift.archivedAt}
              <DropdownMenu
                items={[
                  { label: t('common.edit'), icon: 'pencil', onSelect: () => openShift(shift) },
                  { type: 'separator' },
                  {
                    label: t('common.archive'),
                    icon: 'archive',
                    danger: true,
                    onSelect: () => {
                      archiveShiftError = null
                      archivingShift = shift
                    },
                  },
                ]}
              >
                {#snippet trigger(props)}
                  <IconButton icon="ellipsis" label={t('roster_actions_for', { name: shift.name })} size={26} {...props} />
                {/snippet}
              </DropdownMenu>
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}

  <!-- ------------------------------------------------------------ rotations -->

  <div class="section">
    <SectionLabel label={t('roster_patterns')} count={formatCount(patterns.length)}>
      {#snippet trailing()}
        <span class="trailing">
          {#if archivedPatternCount > 0}
            <Switch
              size="sm"
              checked={showArchivedPatterns}
              onCheckedChange={(on) => (showArchivedPatterns = on)}
              label={t('roster_show_archived')}
            />
          {/if}
          {#if manage && liveShifts.length > 0}
            <Button size="xs" variant="ghost" icon="plus" onclick={() => openPattern(null)}>
              {t('roster_pattern_new')}
            </Button>
          {/if}
        </span>
      {/snippet}
    </SectionLabel>

    {#if patternsQuery.isLoading || !workspaceId}
      <div class="rows">
        {#each [1, 2] as n (n)}<Skeleton height="52px" />{/each}
      </div>
    {:else if patternsQuery.isError}
      <EmptyState icon="triangle-alert" title={t('roster_patterns_error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void patternsQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if patterns.length === 0}
      <EmptyState icon="refresh-cw" title={t('roster_patterns_none')} description={t('roster_patterns_none_desc')}>
        {#snippet actions()}
          {#if manage && liveShifts.length > 0}
            <Button size="sm" icon="plus" onclick={() => openPattern(null)}>{t('roster_pattern_new')}</Button>
          {:else if manage}
            <p class="note">{t('roster_pattern_no_shifts')}</p>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table patterns" role="table" aria-label={t('roster_patterns')}>
        <div class="thead" role="row">
          <span role="columnheader">{t('roster_pattern_name')}</span>
          <span role="columnheader">{t('roster_pattern_anchor')}</span>
          <span role="columnheader">{t('roster_pattern_cycle')}</span>
          <span class="sr-only" role="columnheader">{t('schedule_actions')}</span>
        </div>
        {#each patterns as pattern (pattern.id)}
          <div class="trow" role="row">
            <span class="cell title" role="cell">
              <span class="name">{pattern.name}</span>
              {#if pattern.archivedAt}<Badge tone="grey">{t('schedule_archived')}</Badge>{/if}
            </span>
            <span class="cell num" role="cell">{formatDate(pattern.anchorDate)}</span>
            <span
              class="cell cycle"
              role="cell"
              aria-label={`${t('roster_pattern_cycle_length', { count: pattern.days.length })} · ${t('roster_pattern_working_days', { count: workingDays(pattern) })}`}
            >
              <span class="cyclelen">{t('roster_pattern_cycle_length', { count: pattern.days.length })}</span>
              <!-- The cycle as chips, one per day — the picture of a rotation is its rhythm. -->
              <span class="chips" aria-hidden="true">
                {#each pattern.days as dayShifts, index (index)}
                  <span class="chip" class:on={dayShifts.length > 0}>
                    {dayShifts.length ? dayShifts.map((id) => shiftById.get(id) ? shiftCode(shiftById.get(id)!) : '?').join('+') : '·'}
                  </span>
                {/each}
              </span>
            </span>
            <span class="cell actions" role="cell">
              {#if manage && !pattern.archivedAt}
                <DropdownMenu
                  items={[
                    { label: t('common.edit'), icon: 'pencil', onSelect: () => openPattern(pattern) },
                    { label: t('roster_assign'), icon: 'user-plus', onSelect: () => openAssign(pattern) },
                    { type: 'separator' },
                    {
                      label: t('common.archive'),
                      icon: 'archive',
                      danger: true,
                      onSelect: () => {
                        archivePatternError = null
                        archivingPattern = pattern
                      },
                    },
                  ]}
                >
                  {#snippet trigger(props)}
                    <IconButton icon="ellipsis" label={t('roster_actions_for', { name: pattern.name })} size={26} {...props} />
                  {/snippet}
                </DropdownMenu>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- ------------------------------------------------------------ assignments -->

  <div class="section">
    <SectionLabel label={t('roster_assignments')} count={formatCount(assignments.length)}>
      {#snippet trailing()}
        {#if manage && livePatterns.length > 0}
          <Button size="xs" variant="ghost" icon="user-plus" onclick={() => openAssign(null)}>
            {t('roster_assign')}
          </Button>
        {/if}
      {/snippet}
    </SectionLabel>

    {#if assignmentsQuery.isLoading || !workspaceId}
      <div class="rows">
        {#each [1, 2] as n (n)}<Skeleton height="52px" />{/each}
      </div>
    {:else if assignmentsQuery.isError}
      <EmptyState icon="triangle-alert" title={t('roster_assignments_error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void assignmentsQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if assignments.length === 0}
      <EmptyState icon="users" title={t('roster_assignments_none')} description={t('roster_assignments_none_desc')}>
        {#snippet actions()}
          {#if manage && livePatterns.length > 0}
            <Button size="sm" icon="user-plus" onclick={() => openAssign(null)}>{t('roster_assign')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table assignments" role="table" aria-label={t('roster_assignments')}>
        <div class="thead" role="row">
          <span role="columnheader">{t('roster_col_person')}</span>
          <span role="columnheader">{t('roster_col_pattern')}</span>
          <span role="columnheader">{t('roster_col_period')}</span>
          <span role="columnheader">{t('roster_col_offset')}</span>
          <span class="sr-only" role="columnheader">{t('schedule_actions')}</span>
        </div>
        {#each assignments as a (a.id)}
          {@const where = periodState(a)}
          <div class="trow" role="row" class:muted={where === 'ended'}>
            <span class="cell title" role="cell">
              <span class="name">{personName(a.personId)}</span>
            </span>
            <span class="cell" role="cell">{patternName(a.patternId)}</span>
            <span class="cell period" role="cell">
              <span class="num">
                {a.effectiveTo ? formatDateRange(a.effectiveFrom, a.effectiveTo) : t('roster_open_ended', { date: formatDate(a.effectiveFrom) })}
              </span>
              {#if where === 'ended'}<Badge tone="grey">{t('roster_ended')}</Badge>
              {:else if where === 'upcoming'}<Badge tone="info">{t('roster_upcoming')}</Badge>{/if}
            </span>
            <span class="cell num" role="cell">{t('roster_assign_offset_day', { n: number(a.cycleOffset + 1) })}</span>
            <span class="cell actions" role="cell">
              {#if manage && a.effectiveTo === null}
                <DropdownMenu
                  items={[
                    {
                      label: t('roster_unassign'),
                      icon: 'circle-x',
                      danger: true,
                      onSelect: () => openEnd(a),
                    },
                  ]}
                >
                  {#snippet trigger(props)}
                    <IconButton
                      icon="ellipsis"
                      label={t('roster_actions_for', { name: personName(a.personId) })}
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
  </div>

  <p class="hint">{manage ? t('rosters_hint') : t('rosters_readonly')}</p>
</SettingsPage>

<!-- ------------------------------------------------------------------ shift editor -->

<Dialog
  open={editingShift !== null}
  size="lg"
  title={shiftIsNew ? t('roster_shift_new') : t('roster_shift_edit_title')}
  description={shiftIsNew ? t('roster_shift_new_desc') : t('roster_shift_edit_desc')}
  onOpenChange={(open) => {
    if (!open) editingShift = null
  }}
>
  <div class="form">
    <div class="pair">
      <Field label={t('roster_shift_name')} required>
        {#snippet children(id)}
          <Input {id} bind:value={shiftName} placeholder={t('roster_shift_name_placeholder')} />
        {/snippet}
      </Field>
      <Field label={t('roster_shift_code')} hint={t('roster_shift_code_hint')}>
        {#snippet children(id)}
          <Input {id} bind:value={shiftCodeValue} maxlength={8} />
        {/snippet}
      </Field>
    </div>

    <div class="triple">
      <Field label={t('schedule_start')} required>
        {#snippet children(id)}
          <Input {id} type="time" bind:value={shiftStart} />
        {/snippet}
      </Field>
      <Field label={t('schedule_end')} required>
        {#snippet children(id)}
          <Input {id} type="time" bind:value={shiftEnd} />
        {/snippet}
      </Field>
      <Field label={t('schedule_break')}>
        {#snippet children(id)}
          <Select {id} bind:value={shiftBreak} options={breakOptions(Number(shiftBreak) || 0)} />
        {/snippet}
      </Field>
    </div>
    <p class="note">
      {#if shiftTimesComplete}
        {t('roster_shift_net_line', { net: duration(shiftNetMinutes(shiftDraft)) })}
        {#if crossesMidnight(shiftDraft)}· {t('schedule_overnight')}{/if}
      {:else}
        {t('roster_shift_time_missing')}
      {/if}
    </p>

    <div class="pair">
      <Field label={t('schedule_grace_in')}>
        {#snippet children(id)}
          <Input {id} type="number" min={0} max={240} bind:value={shiftGraceIn} />
        {/snippet}
      </Field>
      <Field label={t('schedule_grace_out')}>
        {#snippet children(id)}
          <Input {id} type="number" min={0} max={240} bind:value={shiftGraceOut} />
        {/snippet}
      </Field>
    </div>
    <p class="note">{t('roster_shift_grace_hint')}</p>

    <!--
      A radio group of swatches, because a colour is chosen by looking and named by a label.
      `aria-label` on each carries the palette name; the checked one is announced as such.
    -->
    <fieldset class="colors">
      <legend class="rolabel">{t('roster_shift_color')}</legend>
      <div class="swatches" role="radiogroup" aria-label={t('roster_shift_color')}>
        <button
          type="button"
          role="radio"
          class="pick none"
          aria-checked={shiftColor === null}
          aria-label={t('roster_color_none')}
          onclick={() => (shiftColor = null)}
        ></button>
        {#each ROSTER_COLORS as color (color.key)}
          <button
            type="button"
            role="radio"
            class="pick"
            style:background={color.hex}
            aria-checked={shiftColor?.toLowerCase() === color.hex.toLowerCase()}
            aria-label={t(`roster_color_${color.key}`)}
            onclick={() => (shiftColor = color.hex)}
          ></button>
        {/each}
      </div>
      <p class="note">{colorName(shiftColor)}</p>
    </fieldset>

    {#if shiftError}<p class="err" role="alert">{shiftError}</p>{/if}
    {#if shiftBlocked}<p class="note blocked">{shiftBlocked}</p>{/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editingShift = null)} disabled={shiftSaving}>{t('cancel')}</Button>
    <Button onclick={submitShift} disabled={Boolean(shiftBlocked)} loading={shiftSaving}>
      {shiftIsNew ? t('common.create') : t('common.save')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ shift archive -->

<Dialog
  open={archivingShift !== null}
  size="sm"
  title={t('roster_shift_archive_title', { name: archivingShift?.name ?? '' })}
  description={t('roster_shift_archive_body')}
  onOpenChange={(open) => {
    if (!open) archivingShift = null
  }}
>
  {#if archiveShiftError}<p class="err" role="alert">{archiveShiftError}</p>{/if}
  {#snippet footer()}
    <Button variant="secondary" onclick={() => (archivingShift = null)} disabled={archiveShiftBusy}>
      {t('cancel')}
    </Button>
    <Button variant="danger" onclick={submitArchiveShift} loading={archiveShiftBusy}>{t('common.archive')}</Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ rotation editor -->

<Dialog
  open={editingPattern !== null}
  size="xl"
  title={patternIsNew ? t('roster_pattern_new') : t('roster_pattern_edit_title')}
  description={t('roster_pattern_edit_desc')}
  onOpenChange={(open) => {
    if (!open) editingPattern = null
  }}
>
  <div class="form">
    <div class="pair">
      <Field label={t('roster_pattern_name')} required>
        {#snippet children(id)}
          <Input {id} bind:value={patternNameValue} placeholder={t('roster_pattern_name_placeholder')} />
        {/snippet}
      </Field>
      <Field label={t('roster_pattern_anchor')} required hint={t('roster_pattern_anchor_hint')}>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={patternAnchor} />
        {/snippet}
      </Field>
    </div>

    {#if !patternIsNew}
      <!-- Said above the cycle, on the screen that does it: this edit moves every crew at once. -->
      <p class="warn" role="note">{t('roster_pattern_edit_warning')}</p>
    {/if}

    <!--
      The cycle, one row per day, the shifts as toggles across it.

      Rows rather than a strip of columns for the same reason the schedule editor lays the week out
      down the dialog: fifty-six columns do not fit anywhere, and a column of days survives
      `dir="rtl"` without a single `left` or `right`. A toggle rather than a select per slot, because
      a split shift is two toggles on and a rest day is none — the model's "empty array is a rest
      day" made visible.
    -->
    <section class="cycleblock" aria-labelledby="hr-cycle-label">
      <div class="cyclehead">
        <span class="kern-section-label" id="hr-cycle-label">{t('roster_pattern_cycle')}</span>
        <span class="total">{t('roster_pattern_cycle_length', { count: cycle.length })}</span>
      </div>

      {#if editorShifts.length === 0}
        <p class="note">{t('roster_pattern_no_shifts')}</p>
      {:else}
        <div class="cycle" role="list">
          {#each cycle as dayShifts, index (index)}
            <div class="cday" role="listitem" class:rest={dayShifts.length === 0}>
              <span class="dayno">{t('roster_pattern_day_n', { n: number(index + 1) })}</span>
              <span class="toggles" role="group" aria-label={t('roster_pattern_day_n', { n: number(index + 1) })}>
                {#each editorShifts as shift (shift.id)}
                  {@const on = dayShifts.includes(shift.id)}
                  {@const full = !on && dayShifts.length >= MAX_SHIFTS_PER_DAY}
                  <button
                    type="button"
                    class="toggle"
                    class:on
                    aria-pressed={on}
                    aria-disabled={full}
                    aria-label={t('roster_pattern_shift_on_day', { shift: shift.name, n: number(index + 1) })}
                    title={full ? t('roster_pattern_max_shifts', { max: number(MAX_SHIFTS_PER_DAY) }) : shiftRange(shift)}
                    style:--hr-shift-color={shift.color ?? 'var(--kern-ink-500)'}
                    onclick={() => {
                      if (!full) toggleShiftOnDay(index, shift.id, !on)
                    }}
                  >
                    <span class="dot"></span>
                    {shiftCode(shift)}
                  </button>
                {/each}
                {#if dayShifts.length === 0}
                  <span class="restlabel">{t('roster_pattern_rest')}</span>
                {/if}
              </span>
              <!-- Disabled with its reason in the tooltip: a cycle cannot lose its only day. -->
              <IconButton
                icon="x"
                size={26}
                variant="ghost"
                label={t('roster_pattern_remove_day', { n: number(index + 1) })}
                title={cycle.length <= 1 ? t('roster_pattern_min_days') : undefined}
                disabled={cycle.length <= 1}
                onclick={() => removeCycleDay(index)}
              />
            </div>
          {/each}
        </div>
      {/if}

      <div class="cyclefoot">
        {#if cycle.length >= MAX_CYCLE_DAYS}
          <p class="note">{t('roster_pattern_max_days', { max: number(MAX_CYCLE_DAYS) })}</p>
        {:else}
          <Button size="xs" variant="ghost" icon="plus" onclick={addCycleDay}>{t('roster_pattern_add_day')}</Button>
        {/if}
      </div>
    </section>

    {#if patternError}<p class="err" role="alert">{patternError}</p>{/if}
    {#if patternBlocked}<p class="note blocked">{patternBlocked}</p>{/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editingPattern = null)} disabled={patternSaving}>{t('cancel')}</Button>
    <Button onclick={submitPattern} disabled={Boolean(patternBlocked)} loading={patternSaving}>
      {patternIsNew ? t('common.create') : t('common.save')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ rotation archive -->

<Dialog
  open={archivingPattern !== null}
  size="sm"
  title={t('roster_pattern_archive_title', { name: archivingPattern?.name ?? '' })}
  description={t('roster_pattern_archive_body')}
  onOpenChange={(open) => {
    if (!open) archivingPattern = null
  }}
>
  {#if archivingPattern && onPatternNow(archivingPattern.id) > 0}
    <p class="note">{t('roster_pattern_archive_people', { count: onPatternNow(archivingPattern.id) })}</p>
  {/if}
  {#if archivePatternError}<p class="err" role="alert">{archivePatternError}</p>{/if}
  {#snippet footer()}
    <Button variant="secondary" onclick={() => (archivingPattern = null)} disabled={archivePatternBusy}>
      {t('cancel')}
    </Button>
    <Button variant="danger" onclick={submitArchivePattern} loading={archivePatternBusy}>{t('common.archive')}</Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ assign -->

<Dialog
  open={assigning}
  size="lg"
  title={t('roster_assign_title')}
  description={t('roster_assign_desc')}
  onOpenChange={(open) => {
    if (!open) assigning = false
  }}
>
  {#if peopleQuery.isLoading}
    <Skeleton height="160px" />
  {:else if peopleQuery.isError}
    <EmptyState compact icon="triangle-alert" title={t('people_error')}>
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={() => void peopleQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if activePeople.length === 0}
    <EmptyState compact icon="user" title={t('no_people')} description={t('no_people_desc')} />
  {:else}
    <div class="form">
      <div class="pair">
        <Field label={t('roster_assign_pattern')} required>
          {#snippet children(id)}
            <Select {id} bind:value={assignPatternId} options={patternOptions} placeholder={t('roster_assign_pattern_pick')} />
          {/snippet}
        </Field>
        <Field label={t('roster_assign_offset')} hint={t('roster_assign_offset_hint')}>
          {#snippet children(id)}
            <Select {id} bind:value={assignOffset} options={offsetOptions} />
          {/snippet}
        </Field>
      </div>

      <div class="pair">
        <Field label={t('schedule_effective_from')} required>
          {#snippet children(id)}
            <Input {id} type="date" bind:value={assignFrom} />
          {/snippet}
        </Field>
        <Field
          label={t('roster_assign_to')}
          hint={t('roster_assign_to_hint')}
          error={assignDatesInvalid ? t('roster_assign_dates_invalid') : null}
        >
          {#snippet children(id)}
            <Input {id} type="date" bind:value={assignTo} min={assignFrom} />
          {/snippet}
        </Field>
      </div>

      <fieldset class="peoplebox">
        <legend class="rolabel">
          {t('roster_assign_people')}
          <span class="count">· {t('roster_assign_people_count', { count: assignPeople.size })}</span>
        </legend>
        <ul class="peoplelist">
          {#each activePeople as person (person.id)}
            <li>
              <Checkbox
                checked={assignPeople.has(person.id)}
                onCheckedChange={(on) => togglePerson(person.id, on)}
                label={person.displayName}
              />
            </li>
          {/each}
        </ul>
      </fieldset>

      {#if assignError}<p class="err" role="alert">{assignError}</p>{/if}
      {#if assignBlocked}<p class="note blocked">{assignBlocked}</p>{/if}
    </div>
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (assigning = false)} disabled={assignBusy}>{t('cancel')}</Button>
    <Button onclick={submitAssign} disabled={Boolean(assignBlocked) || activePeople.length === 0} loading={assignBusy}>
      {t('roster_assign')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ end an assignment -->

<Dialog
  open={ending !== null}
  size="sm"
  title={t('roster_unassign_title', {
    name: personName(ending?.personId ?? ''),
    pattern: patternName(ending?.patternId ?? ''),
  })}
  description={t('roster_unassign_desc')}
  onOpenChange={(open) => {
    if (!open) ending = null
  }}
>
  <div class="form">
    <Field label={t('roster_unassign_last_day')} required error={endTooEarly ? endBlocked : null}>
      {#snippet children(id)}
        <Input {id} type="date" bind:value={endOn} min={ending?.effectiveFrom} />
      {/snippet}
    </Field>
    {#if endError}<p class="err" role="alert">{endError}</p>{/if}
  </div>
  {#snippet footer()}
    <Button variant="secondary" onclick={() => (ending = null)} disabled={endBusy}>{t('cancel')}</Button>
    <Button variant="danger" onclick={submitEnd} disabled={Boolean(endBlocked)} loading={endBusy}>
      {t('roster_unassign')}
    </Button>
  {/snippet}
</Dialog>

<style>
.rows {
  display: grid;
  gap: 4px;
}
.section {
  margin-block-start: 28px;
}
.trailing {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  width: 100%;
}
.shifts {
  --hr-cols: minmax(150px, 1.4fr) minmax(130px, auto) 84px 96px 72px max-content;
}
.patterns {
  --hr-cols: minmax(150px, 1fr) 110px minmax(220px, 2fr) max-content;
}
.assignments {
  --hr-cols: minmax(140px, 1fr) minmax(120px, 1fr) minmax(200px, 1.4fr) 130px max-content;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-cols);
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
/* A colour, never opacity: an ended assignment is still a row somebody reads. */
.trow.muted .name,
.trow.muted .cell {
  color: var(--kern-ink-500);
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
.period {
  display: flex;
  align-items: center;
  gap: 8px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  overflow: visible;
}
.swatch {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.swatch.empty {
  border: 1px solid var(--kern-border-strong);
}
.code {
  flex: none;
  min-width: 22px;
  padding-inline: 4px;
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface-hover);
  font-family: var(--kern-font-mono);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  color: var(--kern-ink-700);
}
.overnight {
  margin-inline-start: 4px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--kern-accent-text);
}

/* The cycle at a glance: worked days filled, rest days outlined. */
.cycle {
  display: grid;
  gap: 2px;
}
.cyclelen {
  display: block;
  font-size: 12.5px;
  color: var(--kern-ink-700);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-block-start: 3px;
}
.chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 18px;
  padding-inline: 4px;
  border-radius: var(--kern-r-sm);
  border: 1px solid var(--kern-border);
  color: var(--kern-ink-500);
  font-family: var(--kern-font-mono);
  font-size: 10px;
  font-weight: 600;
}
.chip.on {
  border-color: transparent;
  background: var(--kern-accent-tint);
  color: var(--kern-accent-text);
}
.cell.cycle {
  white-space: normal;
  overflow: visible;
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
.triple {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 14px;
}
.rolabel {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--kern-ink-700);
}
.count {
  font-weight: 400;
  color: var(--kern-ink-500);
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
/* Same arithmetic as AttendancePage's `.stale`: the warning ink clears 4.5:1 on its own tint. */
.warn {
  margin: 0;
  padding-block: 6px;
  padding-inline: 12px;
  border-radius: var(--kern-r-md);
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
  font-size: 12.5px;
  line-height: 1.5;
}

.colors {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.pick {
  width: 26px;
  height: 26px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
}
.pick.none {
  background: transparent;
  border-color: var(--kern-border-strong);
}
.pick[aria-checked='true'] {
  box-shadow: 0 0 0 2px var(--kern-surface), 0 0 0 4px var(--kern-ink-900);
}
.pick:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--kern-ring);
}

.cycleblock {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-2xl);
  background: var(--kern-surface);
}
.cyclehead {
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
.cday {
  display: grid;
  grid-template-columns: 72px 1fr max-content;
  gap: 10px;
  align-items: center;
  min-height: 40px;
  padding-block: 2px;
  border-block-start: 1px solid var(--kern-border-hairline);
}
.dayno {
  font-size: 13px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.cday.rest .dayno {
  font-weight: 400;
  color: var(--kern-ink-500);
}
.toggles {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding-inline: 9px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: transparent;
  color: var(--kern-ink-700);
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  font-weight: 600;
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
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--hr-shift-color);
}
.restlabel {
  font-size: 12.5px;
  color: var(--kern-ink-500);
}
.cyclefoot {
  display: flex;
  justify-content: flex-start;
}

.peoplebox {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.peoplelist {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 4px 12px;
  max-height: 240px;
  overflow-y: auto;
  margin: 0;
  padding: 10px;
  list-style: none;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-lg);
}

@media (max-width: 760px) {
  .shifts {
    --hr-cols: minmax(130px, 1.4fr) minmax(120px, auto) 72px max-content;
  }
  /* Grace and net are the columns a narrow screen can lose: the hours are what a shift is. */
  .shifts .thead > :nth-child(4),
  .shifts .trow > :nth-child(4),
  .shifts .thead > :nth-child(5),
  .shifts .trow > :nth-child(5) {
    display: none;
  }
  .assignments {
    --hr-cols: minmax(120px, 1fr) minmax(100px, 1fr) minmax(160px, 1.4fr) max-content;
  }
  .assignments .thead > :nth-child(4),
  .assignments .trow > :nth-child(4) {
    display: none;
  }
}

@media (max-width: 620px) {
  .cday {
    grid-template-columns: 1fr max-content;
    padding-block: 8px;
  }
  .toggles {
    grid-column: 1 / -1;
  }
}
</style>
