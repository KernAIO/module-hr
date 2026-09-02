<script lang="ts">
import {
  Button,
  EmptyState,
  Field,
  formatDate,
  formatDateRange,
  Input,
  messageLocale,
  navigation,
  Page,
  PageHeader,
  Select,
  type SelectOption,
  Skeleton,
  session,
  type TabItem,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Tabs,
} from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import {
  MAX_REPORT_DAYS,
  MAX_SLICED_REPORT_DAYS,
  type ReportFinality,
  type ReportHeader,
  type ReportSliceBy,
} from '../../contract/reports.js'
import { getHrApi } from '../api-instance.js'
import { explainRefusal } from '../components/refusal.js'
import { t } from '../i18n.js'
import { HR_CAPABILITIES } from '../permissions.js'
import { daysInclusive, formatDays, formatDuration, hrKeys, isoDate, monthRange } from '../query.js'

/**
 * Four numbers a company acts on, each with its denominator printed above it.
 *
 * Every table here sits under one sentence — "12 of 38 people · 1–31 October · Istanbul" — because
 * a total without its population is not a fact, and under a finality line, because a range that
 * straddles a period lock mixes figures payroll has filed with figures tonight's reconcile will
 * move. Both come from the server's `header` and `finality` rather than being reconstructed here:
 * the report says what it counted, and this screen repeats it.
 *
 * **An em dash is an answer.** Every figure the server could not compute arrives as `null` — a
 * ratio for somebody with no schedule, expected days for an office with no calendar, minutes beyond
 * a ceiling that was never in force — and is drawn as "—", never as 0 or 0%. `rep_dash_note` under
 * each table says so, because a dash beside a column of numbers otherwise reads as a rendering bug.
 *
 * The caps are checked before asking. `MAX_REPORT_DAYS` and `MAX_SLICED_REPORT_DAYS` are the
 * contract's own constants, so a range the server would refuse earns a sentence under the controls
 * rather than a round trip and an error state; a refusal that does get through — the person-day
 * cap needs the population, which only the server knows — is shown in the server's words.
 *
 * Nothing here writes. There is no refresh and no recompute: a report over a filed month must not
 * be able to move it.
 */
const api = getHrApi()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/**
 * The route has no capability of its own, because the page is useful with either half. The three
 * day-sheet reports go with `attendance` and the balance report with `leave`; a workspace with
 * neither sees an empty state that names the two switches rather than a 404.
 */
const hasAttendance = $derived(session.hasCapability('hr', HR_CAPABILITIES.attendance))
const hasLeave = $derived(session.hasCapability('hr', HR_CAPABILITIES.leave))
const hasOffices = $derived(session.hasCapability('hr', HR_CAPABILITIES.offices))
const hasEntities = $derived(session.hasCapability('hr', HR_CAPABILITIES.legalEntities))

type Tab = 'attendance' | 'overtime' | 'absence' | 'balances'

const tabs = $derived.by((): TabItem[] => {
  const out: TabItem[] = []
  if (hasAttendance) {
    out.push(
      { value: 'attendance', label: t('rep_tab_attendance'), icon: 'timer' },
      { value: 'overtime', label: t('rep_tab_overtime'), icon: 'clock' },
      { value: 'absence', label: t('rep_tab_absence'), icon: 'calendar-days' },
    )
  }
  if (hasLeave) out.push({ value: 'balances', label: t('rep_tab_balances'), icon: 'tree-palm' })
  return out
})

/**
 * The tab somebody chose, held apart from the one shown: capabilities arrive after the first
 * render, so the shown tab falls back to the first available one until a choice is made — and a
 * choice that a capability later removes falls back the same way rather than showing nothing.
 */
let chosen = $state<string | null>(null)
const active = $derived(
  (chosen && tabs.some((i) => i.value === chosen) ? chosen : (tabs[0]?.value ?? '')) as Tab | '',
)

// ---------------------------------------------------------------- controls

const initial = monthRange()
let from = $state(initial.from)
let to = $state(initial.to)
/** The balance report is a position, not a span: one date decides who is in it. */
let asOf = $state(isoDate())
/** `workspace`, `office:<id>` or `legal_entity:<id>` — one control, whichever slices exist. */
let slice = $state('workspace')
let limit = $state('100')

const by = $derived<ReportSliceBy>(
  slice === 'workspace' ? 'workspace' : slice.startsWith('office:') ? 'office' : 'legal_entity',
)
const sliceId = $derived(slice.includes(':') ? slice.slice(slice.indexOf(':') + 1) : undefined)
const rows = $derived(Number(limit))

const officesQuery = createQuery(() => ({
  queryKey: hrKeys.offices(workspaceId),
  enabled: Boolean(workspaceId) && hasOffices,
  queryFn: () => api.offices.list({ workspaceId }),
}))
const entitiesQuery = createQuery(() => ({
  queryKey: hrKeys.entities(workspaceId),
  enabled: Boolean(workspaceId) && hasEntities,
  queryFn: () => api.entities.list({ workspaceId }),
}))

const sliceOptions = $derived.by((): SelectOption[] => {
  const out: SelectOption[] = [{ value: 'workspace', label: t('rep_slice_workspace') }]
  if (hasOffices) {
    for (const office of officesQuery.data ?? [])
      out.push({ value: `office:${office.id}`, label: office.name, group: t('rep_slice_offices') })
  }
  if (hasEntities) {
    for (const entity of entitiesQuery.data ?? [])
      out.push({ value: `legal_entity:${entity.id}`, label: entity.name, group: t('rep_slice_entities') })
  }
  return out
})

const limitOptions = $derived(
  [25, 50, 100, 250, 500, 1000].map((n) => ({ value: String(n), label: t('rep_limit_n', { count: n }) })),
)

/**
 * The sentence the server would answer with, said here first.
 *
 * Attendance and overtime are one grouped aggregate when unsliced and a per-day ladder walk when
 * sliced; absence walks per day whichever way it is asked. The advice differs — "drop the slice"
 * is only advice where dropping it changes the cap.
 */
const refusal = $derived.by((): string | null => {
  if (active === 'balances' || active === '') return null
  if (!from || !to) return t('rep_range_missing')
  // Inclusive, and reversed is zero or less — the same arithmetic the server refuses on.
  const days = daysInclusive(from, to)
  if (days <= 0) return t('rep_range_reversed')
  const perDay = active === 'absence' || by !== 'workspace'
  const max = perDay ? MAX_SLICED_REPORT_DAYS : MAX_REPORT_DAYS
  if (days <= max) return null
  if (active === 'absence') return t('rep_range_too_long_absence', { max, days })
  return perDay ? t('rep_range_too_long_sliced', { max, days }) : t('rep_range_too_long', { max, days })
})

// ---------------------------------------------------------------- the four reports

const rangeInput = $derived({ from, to, by, sliceId, limit: rows })
const ready = $derived(Boolean(workspaceId) && !refusal)

const attendanceQuery = createQuery(() => ({
  queryKey: hrKeys.reportAttendance(workspaceId, rangeInput),
  enabled: ready && active === 'attendance',
  queryFn: () => api.reports.attendance({ workspaceId, ...rangeInput }),
}))
const overtimeQuery = createQuery(() => ({
  queryKey: hrKeys.reportOvertime(workspaceId, rangeInput),
  enabled: ready && active === 'overtime',
  queryFn: () => api.reports.overtime({ workspaceId, ...rangeInput }),
}))
const absenceQuery = createQuery(() => ({
  queryKey: hrKeys.reportAbsence(workspaceId, rangeInput),
  enabled: ready && active === 'absence',
  queryFn: () => api.reports.absence({ workspaceId, ...rangeInput }),
}))
const balanceInput = $derived({ asOf, by, sliceId, limit: rows })
const balancesQuery = createQuery(() => ({
  queryKey: hrKeys.reportLeaveBalance(workspaceId, balanceInput),
  enabled: Boolean(workspaceId) && Boolean(asOf) && active === 'balances',
  queryFn: () => api.reports.leaveBalance({ workspaceId, ...balanceInput }),
}))

const current = $derived(
  active === 'attendance'
    ? attendanceQuery
    : active === 'overtime'
      ? overtimeQuery
      : active === 'absence'
        ? absenceQuery
        : balancesQuery,
)
/** A disabled query is `pending` and not fetching — so a refused range is not "loading". */
const loading = $derived(active !== '' && !refusal && (!workspaceId || current.isLoading))

// ---------------------------------------------------------------- rendering

/** The one spelling of "this figure does not exist". Never 0, never blank. */
const DASH = '—'

const words = {
  hours: (n: string) => t('hours_short', { n }),
  minutes: (n: string) => t('minutes_short', { n }),
}
const minutes = (m: number | null) => (m === null ? DASH : formatDuration(m, words, messageLocale()))
const count = (n: number | null) => (n === null ? DASH : new Intl.NumberFormat(messageLocale()).format(n))
const days = (n: number | null) => (n === null ? DASH : formatDays(n, messageLocale()))
const percent = (ratio: number | null) =>
  ratio === null
    ? DASH
    : new Intl.NumberFormat(messageLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(ratio)
const date = (iso: string) => formatDate(`${iso}T00:00:00`)
const dateRange = (a: string, b: string) => formatDateRange(`${a}T00:00:00`, `${b}T00:00:00`)

/** A row is the way in to the person it describes. */
const personHref = (personId: string) => `/${workspaceSlug}/hr?person=${encodeURIComponent(personId)}`

/**
 * "12 of 38 people · 1–31 October · Istanbul".
 *
 * The slice's name comes from the server where it resolved one; the picker's own label is the
 * fallback, so a sliced report never prints without saying which slice.
 */
const headline = (header: ReportHeader): string => {
  const population = t('rep_counted', { counted: count(header.counted), count: header.population })
  const when =
    header.attribution === 'as_of_date' && header.attributionOn
      ? date(header.attributionOn)
      : dateRange(header.from, header.to)
  const who =
    header.slice.by === 'workspace'
      ? t('rep_slice_workspace')
      : (header.slice.name ?? sliceOptions.find((o) => o.value === slice)?.label ?? '')
  return [population, when, who].filter(Boolean).join(' · ')
}

/**
 * Whether the figures can still move, in one line.
 *
 * Silent when nothing was locked and nothing is open: that is a range with no day sheet at all,
 * and the empty state underneath already says so. `final: false` with every day open is the
 * ordinary state of a workspace without payroll periods and is worded as a fact, not a warning.
 */
const finalityLine = (finality: ReportFinality): string | null => {
  if (finality.final)
    return t('rep_final', { date: finality.lastLockedDay ? date(finality.lastLockedDay) : '' })
  const parts: string[] = []
  if (finality.openDays > 0) {
    parts.push(
      t('rep_open_days', {
        count: finality.openDays,
        date: finality.firstOpenDay ? date(finality.firstOpenDay) : '',
      }),
    )
  }
  if (finality.lockedDays > 0) {
    parts.push(
      t('rep_locked_through', {
        count: finality.lockedDays,
        date: finality.lastLockedDay ? date(finality.lastLockedDay) : '',
      }),
    )
  }
  return parts.length ? parts.join(' ') : null
}

const basisLabel = (basis: string) =>
  basis === 'calendar'
    ? t('rep_basis_calendar')
    : basis === 'no_calendar'
      ? t('rep_basis_no_calendar')
      : t('rep_basis_no_schedule')

const unitLabel = (unit: string) =>
  unit === 'hour' ? t('rep_unit_hour') : unit === 'half_day' ? t('rep_unit_half_day') : t('rep_unit_day')

/**
 * Minutes in the leave type's own unit, the way the server's `toUnit` does it: hourly types by
 * the hour, everything else by the report's own `dayLengthMinutes` — which is why that figure is
 * printed above the table rather than assumed.
 */
const inUnit = (m: number, unit: string, dayLength: number) =>
  unit === 'hour' ? Math.round((m / 60) * 10) / 10 : Math.round((m / dayLength) * 100) / 100

const failure = (error: unknown) => explainRefusal(error, t('rep_error'))
</script>

<PageHeader crumbs={[{ label: workspace?.name ?? '' }, { label: t('reports_title') }]} title={t('reports_title')} />

{#snippet meta(header: ReportHeader, finality: ReportFinality | null, shown: number)}
  {@const line = finality ? finalityLine(finality) : null}
  <div class="meta">
    <p class="headline">{headline(header)}</p>
    {#if line}
      <p class="finality" class:final={finality?.final}>{line}</p>
    {/if}
    {#if header.truncated}
      <p class="note">{t('rep_truncated', { shown: count(shown), count: header.counted })}</p>
    {/if}
    {#if header.attribution === 'each_day'}
      <p class="note">{t('rep_attributed_each_day')}</p>
    {:else if header.attribution === 'as_of_date' && header.attributionOn}
      <p class="note">{t('rep_attributed_as_of', { date: date(header.attributionOn) })}</p>
    {/if}
    <p class="scope">{t('rep_scope', { keys: header.scope.permissions.join(', ') })}</p>
  </div>
{/snippet}

{#snippet skeleton()}
  <div class="rows" aria-busy="true">
    {#each [1, 2, 3, 4, 5, 6] as n (n)}<Skeleton height="40px" />{/each}
  </div>
{/snippet}

{#snippet failed(error: unknown, retry: () => void)}
  <EmptyState icon="triangle-alert" title={t('rep_error')} description={failure(error)}>
    {#snippet actions()}
      <Button variant="secondary" onclick={retry}>{t('retry')}</Button>
    {/snippet}
  </EmptyState>
{/snippet}

<Page>
  {#if tabs.length === 0}
    <EmptyState icon="chart-column" title={t('rep_none_enabled')} description={t('rep_none_enabled_desc')} />
  {:else}
    <Tabs items={tabs} value={active} onValueChange={(v) => (chosen = v)} label={t('reports_title')} />

    <div class="controls">
      {#if active === 'balances'}
        <Field label={t('rep_as_of')} class="ctl">
          {#snippet children(id)}
            <Input {id} type="date" size="sm" bind:value={asOf} />
          {/snippet}
        </Field>
      {:else}
        <Field label={t('rep_from')} class="ctl">
          {#snippet children(id)}
            <Input {id} type="date" size="sm" bind:value={from} />
          {/snippet}
        </Field>
        <Field label={t('rep_to')} class="ctl">
          {#snippet children(id)}
            <Input {id} type="date" size="sm" bind:value={to} min={from} />
          {/snippet}
        </Field>
      {/if}
      {#if hasOffices || hasEntities}
        <Field label={t('rep_slice')} class="ctl wide">
          {#snippet children(id)}
            <Select {id} size="sm" options={sliceOptions} bind:value={slice} ariaLabel={t('rep_slice')} />
          {/snippet}
        </Field>
      {/if}
      <Field label={t('rep_limit')} class="ctl">
        {#snippet children(id)}
          <Select {id} size="sm" options={limitOptions} bind:value={limit} ariaLabel={t('rep_limit')} />
        {/snippet}
      </Field>
    </div>

    {#if refusal}
      <!-- The server's own refusal, said before the request: the caps are the contract's constants. -->
      <p class="refusal" role="alert">{refusal}</p>
    {:else if loading}
      {@render skeleton()}
    {:else if active === 'attendance'}
      {#if attendanceQuery.data}
        {@const report = attendanceQuery.data}
        {@render meta(report.header, report.finality, report.rows.length)}
        {#if report.header.counted === 0}
          <EmptyState icon="timer" title={t('rep_empty')} />
        {:else}
          <div class="scroll" aria-busy={attendanceQuery.isFetching}>
            <Table
              dense
              columns="minmax(180px, 1.6fr) 64px 100px 100px 84px 84px 96px 96px 110px"
              ariaLabel={t('rep_tab_attendance')}
            >
              <TableHeader>
                <TableCell header>{t('rep_person')}</TableCell>
                <TableCell header end>{t('rep_days')}</TableCell>
                <TableCell header end>{t('rep_scheduled')}</TableCell>
                <TableCell header end>{t('rep_worked')}</TableCell>
                <TableCell header end>{t('rep_break')}</TableCell>
                <TableCell header end>{t('rep_late')}</TableCell>
                <TableCell header end>{t('rep_early_leave')}</TableCell>
                <TableCell header end>{t('rep_ratio')}</TableCell>
                <TableCell header end>{t('rep_unscheduled_days')}</TableCell>
              </TableHeader>
              {#each report.rows as row (row.personId)}
                <TableRow href={personHref(row.personId)}>
                  <TableCell class="name">{row.displayName}</TableCell>
                  <TableCell end class="num">{count(row.days)}</TableCell>
                  <TableCell end class="num">{minutes(row.scheduledMinutes)}</TableCell>
                  <TableCell end class="num">{minutes(row.workedMinutes)}</TableCell>
                  <TableCell end class="num">{minutes(row.breakMinutes)}</TableCell>
                  <TableCell end class="num">{minutes(row.lateMinutes)}</TableCell>
                  <TableCell end class="num">{minutes(row.earlyLeaveMinutes)}</TableCell>
                  <TableCell end class="num">{percent(row.workedRatio)}</TableCell>
                  <TableCell end class="num">{count(row.noScheduleDays)}</TableCell>
                </TableRow>
              {/each}
              <TableRow class="totals">
                <TableCell class="name">{t('rep_totals')}</TableCell>
                <TableCell end class="num">{count(report.totals.days)}</TableCell>
                <TableCell end class="num">{minutes(report.totals.scheduledMinutes)}</TableCell>
                <TableCell end class="num">{minutes(report.totals.workedMinutes)}</TableCell>
                <TableCell end class="num">{minutes(report.totals.breakMinutes)}</TableCell>
                <TableCell end class="num">{minutes(report.totals.lateMinutes)}</TableCell>
                <TableCell end class="num">{minutes(report.totals.earlyLeaveMinutes)}</TableCell>
                <TableCell end class="num">{percent(report.totals.workedRatio)}</TableCell>
                <TableCell end class="num">{count(report.totals.noScheduleDays)}</TableCell>
              </TableRow>
            </Table>
          </div>
          {#if report.totals.unknownScheduleDays > 0}
            <p class="note">{t('rep_unknown_days', { count: report.totals.unknownScheduleDays })}</p>
          {/if}
          <p class="note">{t('rep_dash_note')}</p>
        {/if}
      {:else if attendanceQuery.isError}
        {@render failed(attendanceQuery.error, () => void attendanceQuery.refetch())}
      {/if}
    {:else if active === 'overtime'}
      {#if overtimeQuery.data}
        {@const report = overtimeQuery.data}
        {@render meta(report.header, report.finality, report.rows.length)}
        {#if report.header.counted === 0}
          <EmptyState icon="clock" title={t('rep_empty')} />
        {:else}
          <div class="scroll" aria-busy={overtimeQuery.isFetching}>
            <Table
              dense
              columns="minmax(180px, 1.6fr) 64px 110px 120px 130px 130px"
              ariaLabel={t('rep_tab_overtime')}
            >
              <TableHeader>
                <TableCell header>{t('rep_person')}</TableCell>
                <TableCell header end>{t('rep_days')}</TableCell>
                <TableCell header end>{t('rep_overtime')}</TableCell>
                <TableCell header end>{t('rep_beyond_cap')}</TableCell>
                <TableCell header end>{t('rep_capped_days')}</TableCell>
                <TableCell header end>{t('rep_uncapped_days')}</TableCell>
              </TableHeader>
              {#each report.rows as row (row.personId)}
                <TableRow href={personHref(row.personId)}>
                  <TableCell class="name">{row.displayName}</TableCell>
                  <TableCell end class="num">{count(row.days)}</TableCell>
                  <TableCell end class="num">{minutes(row.overtimeMinutes)}</TableCell>
                  <TableCell end class="num">{minutes(row.beyondCapMinutes)}</TableCell>
                  <TableCell end class="num">{count(row.cappedDays)}</TableCell>
                  <TableCell end class="num">{count(row.uncappedDays)}</TableCell>
                </TableRow>
              {/each}
              <TableRow class="totals">
                <TableCell class="name">{t('rep_totals')}</TableCell>
                <TableCell end class="num">{count(report.totals.days)}</TableCell>
                <TableCell end class="num">{minutes(report.totals.overtimeMinutes)}</TableCell>
                <TableCell end class="num">{minutes(report.totals.beyondCapMinutes)}</TableCell>
                <TableCell end class="num">{count(report.totals.cappedDays)}</TableCell>
                <TableCell end class="num">{count(report.totals.uncappedDays)}</TableCell>
              </TableRow>
            </Table>
          </div>
          <p class="note">{t('rep_dash_note')}</p>
        {/if}
      {:else if overtimeQuery.isError}
        {@render failed(overtimeQuery.error, () => void overtimeQuery.refetch())}
      {/if}
    {:else if active === 'absence'}
      {#if absenceQuery.data}
        {@const report = absenceQuery.data}
        {@render meta(report.header, report.finality, report.rows.length)}
        <!--
          The two buckets held out of the denominator, named above the table rather than hidden
          in it: a manager reading "3% absent" has to know who that percentage is not about.
        -->
        <div class="meta">
          <p class="note">{t('rep_measured', { count: report.totals.measured })}</p>
          {#if report.excluded.noSchedule > 0}
            <p class="note">{t('rep_excluded_no_schedule', { count: report.excluded.noSchedule })}</p>
          {/if}
          {#if report.excluded.noCalendar > 0}
            <p class="note">{t('rep_excluded_no_calendar', { count: report.excluded.noCalendar })}</p>
          {/if}
          {#if !report.leaveCounted}
            <p class="finality">{t('rep_leave_not_counted')}</p>
          {/if}
        </div>
        {#if report.rows.length === 0}
          <EmptyState icon="calendar-days" title={t('rep_empty')} />
        {:else}
          <div class="scroll" aria-busy={absenceQuery.isFetching}>
            <Table
              dense
              columns="minmax(180px, 1.6fr) 120px 90px 90px 90px 90px 110px"
              ariaLabel={t('rep_tab_absence')}
            >
              <TableHeader>
                <TableCell header>{t('rep_person')}</TableCell>
                <TableCell header>{t('rep_basis')}</TableCell>
                <TableCell header end>{t('rep_expected')}</TableCell>
                <TableCell header end>{t('rep_worked')}</TableCell>
                <TableCell header end>{t('rep_leave')}</TableCell>
                <TableCell header end>{t('rep_absent')}</TableCell>
                <TableCell header end>{t('rep_absence_rate')}</TableCell>
              </TableHeader>
              {#each report.rows as row (row.personId)}
                <TableRow href={personHref(row.personId)} class={row.basis === 'calendar' ? undefined : 'excluded'}>
                  <TableCell class="name">{row.displayName}</TableCell>
                  <TableCell>{basisLabel(row.basis)}</TableCell>
                  <TableCell end class="num">{days(row.expectedDays)}</TableCell>
                  <TableCell end class="num">{days(row.workedDays)}</TableCell>
                  <TableCell end class="num">{days(row.leaveDays)}</TableCell>
                  <TableCell end class="num">{days(row.absentDays)}</TableCell>
                  <TableCell end class="num">{percent(row.absenceRate)}</TableCell>
                </TableRow>
              {/each}
              <TableRow class="totals">
                <TableCell class="name">{t('rep_totals')}</TableCell>
                <TableCell>{t('rep_basis_calendar')}</TableCell>
                <TableCell end class="num">{days(report.totals.expectedDays)}</TableCell>
                <TableCell end class="num">{days(report.totals.workedDays)}</TableCell>
                <TableCell end class="num">{days(report.totals.leaveDays)}</TableCell>
                <TableCell end class="num">{days(report.totals.absentDays)}</TableCell>
                <TableCell end class="num">{percent(report.totals.absenceRate)}</TableCell>
              </TableRow>
            </Table>
          </div>
          <p class="note">{t('rep_dash_note')}</p>
        {/if}
      {:else if absenceQuery.isError}
        {@render failed(absenceQuery.error, () => void absenceQuery.refetch())}
      {/if}
    {:else if active === 'balances'}
      {#if balancesQuery.data}
        {@const report = balancesQuery.data}
        {@const unique = new Set(report.rows.map((r) => r.personId)).size}
        {@render meta(report.header, null, unique)}
        <div class="meta">
          <p class="note">{t('rep_period_year', { year: String(report.periodYear) })}</p>
          <p class="note">{t('rep_day_length', { hours: report.dayLengthMinutes / 60 })}</p>
        </div>
        {#if report.rows.length === 0}
          <EmptyState icon="tree-palm" title={t('rep_empty_balances', { year: String(report.periodYear) })} />
        {:else}
          <h2>{t('rep_per_type')}</h2>
          <div class="scroll" aria-busy={balancesQuery.isFetching}>
            <Table dense columns="minmax(160px, 1.4fr) 90px 72px 100px 100px 100px 100px" ariaLabel={t('rep_per_type')}>
              <TableHeader>
                <TableCell header>{t('rep_leave_type')}</TableCell>
                <TableCell header>{t('rep_basis')}</TableCell>
                <TableCell header end>{t('rep_people')}</TableCell>
                <TableCell header end>{t('rep_balance')}</TableCell>
                <TableCell header end>{t('rep_booked')}</TableCell>
                <TableCell header end>{t('rep_pending')}</TableCell>
                <TableCell header end>{t('rep_available')}</TableCell>
              </TableHeader>
              {#each report.totals as total (total.leaveTypeId)}
                <TableRow>
                  <TableCell class="name">{total.leaveTypeName}</TableCell>
                  <TableCell>{unitLabel(total.unit)}</TableCell>
                  <TableCell end class="num">{count(total.people)}</TableCell>
                  <TableCell end class="num">
                    {days(inUnit(total.balanceMinutes, total.unit, report.dayLengthMinutes))}
                  </TableCell>
                  <TableCell end class="num">
                    {days(inUnit(total.bookedMinutes, total.unit, report.dayLengthMinutes))}
                  </TableCell>
                  <TableCell end class="num">
                    {days(inUnit(total.pendingMinutes, total.unit, report.dayLengthMinutes))}
                  </TableCell>
                  <TableCell end class="num">
                    {days(inUnit(total.availableMinutes, total.unit, report.dayLengthMinutes))}
                  </TableCell>
                </TableRow>
              {/each}
            </Table>
          </div>

          <h2>{t('rep_per_person')}</h2>
          <div class="scroll" aria-busy={balancesQuery.isFetching}>
            <Table
              dense
              columns="minmax(180px, 1.6fr) minmax(120px, 1fr) 90px 100px 100px 100px 100px"
              ariaLabel={t('rep_per_person')}
            >
              <TableHeader>
                <TableCell header>{t('rep_person')}</TableCell>
                <TableCell header>{t('rep_leave_type')}</TableCell>
                <TableCell header>{t('rep_basis')}</TableCell>
                <TableCell header end>{t('rep_balance')}</TableCell>
                <TableCell header end>{t('rep_booked')}</TableCell>
                <TableCell header end>{t('rep_pending')}</TableCell>
                <TableCell header end>{t('rep_available')}</TableCell>
              </TableHeader>
              {#each report.rows as row (`${row.personId}:${row.leaveTypeId}`)}
                <TableRow href={personHref(row.personId)}>
                  <TableCell class="name">{row.displayName}</TableCell>
                  <TableCell>{row.leaveTypeName}</TableCell>
                  <TableCell>{unitLabel(row.unit)}</TableCell>
                  <TableCell end class="num">{days(row.balance)}</TableCell>
                  <TableCell end class="num">
                    {days(inUnit(row.bookedMinutes, row.unit, report.dayLengthMinutes))}
                  </TableCell>
                  <TableCell end class="num">
                    {days(inUnit(row.pendingMinutes, row.unit, report.dayLengthMinutes))}
                  </TableCell>
                  <TableCell end class="num">{days(row.available)}</TableCell>
                </TableRow>
              {/each}
            </Table>
          </div>
        {/if}
      {:else if balancesQuery.isError}
        {@render failed(balancesQuery.error, () => void balancesQuery.refetch())}
      {/if}
    {/if}
  {/if}
</Page>

<style>
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin-block: 16px 12px;
}
.controls :global(.ctl) {
  flex: 0 1 160px;
}
.controls :global(.ctl.wide) {
  flex-basis: 220px;
}
/*
 * The danger ink is measured on `--kern-canvas`, which is what this page sits on, at 12.5px: it
 * clears 4.5:1 in both themes on its own tint, and the tint is what makes the strip read as a
 * notice rather than as another row.
 */
.refusal {
  margin: 0 0 12px;
  padding-block: 6px;
  padding-inline: 12px;
  border-radius: var(--kern-r-md);
  background: var(--kern-danger-tint);
  color: var(--kern-danger);
  font-size: 12.5px;
}
.rows {
  display: grid;
  gap: 4px;
}
.meta {
  display: grid;
  gap: 4px;
  margin-block: 4px 12px;
}
.meta p,
.note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
}
.headline {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--kern-ink-800);
}
/* Same pair `AttendancePage` measured: 4.58:1 in light and 5.28:1 in dark on the warning tint. */
.finality {
  padding-block: 4px;
  padding-inline: 10px;
  border-radius: var(--kern-r-md);
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
  justify-self: start;
}
.finality.final {
  background: var(--kern-success-tint);
  color: var(--kern-success);
}
/* A colour, not opacity: `--kern-ink-500` is 6.74:1 on the canvas in light and 6.12:1 in dark. */
.note,
.scope {
  color: var(--kern-ink-500);
}
.scope {
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
}
.note + .note {
  margin-block-start: 4px;
}
h2 {
  font-size: 13.5px;
  margin: 16px 0 8px;
}
/* Wide tables scroll inside their own box; the page never scrolls sideways. */
.scroll {
  overflow-x: auto;
  margin-block-end: 8px;
}
.scroll :global(.num) {
  font-variant-numeric: tabular-nums;
}
.scroll :global(.name) {
  font-weight: 500;
  color: var(--kern-ink-800);
}
.scroll :global(.ktr.totals) {
  font-weight: 600;
  color: var(--kern-ink-800);
  border-block-start: 1px solid var(--kern-border-strong);
  border-block-end: 0;
}
/* Held out of the denominator: muted with a colour rather than opacity, so it stays readable. */
.scroll :global(.ktr.excluded .ktd) {
  color: var(--kern-ink-500);
}
</style>
