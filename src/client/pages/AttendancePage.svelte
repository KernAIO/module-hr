<script lang="ts">
import {
  Badge,
  Button,
  EmptyState,
  formatDate,
  messageLocale,
  navigation,
  Page,
  PageHeader,
  Skeleton,
  StatTile,
  session,
} from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import ClockControls from '../components/ClockControls.svelte'
import { t } from '../i18n.js'
import { formatDuration, hrKeys, monthRange } from '../query.js'

/**
 * My attendance: the clock, then the month.
 *
 * The totals come from the derived day sheet rather than being added up here — the server already
 * knows what a day is worth, and a second implementation in the browser is how a screen starts
 * disagreeing with a payslip.
 *
 * Which is also why a failed load may not reach the tiles. `days` is `[]` before an answer and `[]`
 * after a refused one, so reducing it either way produces "0h worked, 0h scheduled, 0h overtime" —
 * a confident statement about somebody's month made out of nothing, and the one figure on this page
 * a person might take to their manager. Until there is a day sheet to add up the tiles are
 * skeletons, and the month underneath says the load failed and offers a way to try again.
 */
const api = getHrApi()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const range = $derived(monthRange())

const daysQuery = createQuery(() => ({
  queryKey: hrKeys.attendanceDays(workspaceId, undefined, range.from, range.to),
  enabled: Boolean(workspaceId),
  queryFn: () => api.attendance.days.list({ workspaceId, from: range.from, to: range.to, limit: 100 }),
}))
const days = $derived(daysQuery.data?.items ?? [])

/**
 * A disabled query is not a loading one — it is `pending` and not fetching — so without the
 * workspace test the first frame of this page falls through to the empty state and tells somebody
 * with a full month that nothing is recorded.
 */
const loading = $derived(!workspaceId || daysQuery.isLoading)

/** Nothing to add up: no answer yet, or an answer that never arrived. */
const totalsUnknown = $derived(days.length === 0 && (loading || daysQuery.isError))

const words = {
  hours: (n: string) => t('hours_short', { n }),
  minutes: (n: string) => t('minutes_short', { n }),
}

const totals = $derived({
  worked: days.reduce((sum, d) => sum + d.workedMinutes, 0),
  scheduled: days.reduce((sum, d) => sum + d.scheduledMinutes, 0),
  overtime: days.reduce((sum, d) => sum + d.overtimeMinutes, 0),
})

const duration = (minutes: number) => formatDuration(minutes, words, messageLocale())

const statusLabel = (s: string) =>
  s === 'present'
    ? t('att_status_present')
    : s === 'absent'
      ? t('att_status_absent')
      : s === 'leave'
        ? t('att_status_leave')
        : s === 'holiday'
          ? t('att_status_holiday')
          : s === 'weekend'
            ? t('att_status_weekend')
            : s === 'partial'
              ? t('att_status_partial')
              : t('att_status_pending')

const statusTone = (s: string) =>
  s === 'present'
    ? 'done'
    : s === 'absent'
      ? 'declined'
      : s === 'leave'
        ? 'on-leave'
        : s === 'pending'
          ? 'urgent'
          : 'grey'

/**
 * `formatDate` rather than `Intl` directly: it formats in the reader's *interface* language, which
 * is the one the rest of this row is written in. A bare `Intl` call follows the browser instead, so
 * a Persian interface in an English browser gets "Mon 4 Aug" beside its own digits.
 */
const dayLabel = (iso: string) =>
  formatDate(`${iso}T00:00:00`, { weekday: 'short', day: 'numeric', month: 'short' })
</script>

<PageHeader
  crumbs={[{ label: workspace?.name ?? '' }, { label: t('attendance_title') }]}
  title={t('attendance_title')}
/>

{#snippet tiles()}
  <div class="tiles">
    <StatTile label={t('att_worked')} value={duration(totals.worked)} />
    <StatTile label={t('att_scheduled')} value={duration(totals.scheduled)} />
    <StatTile label={t('att_overtime')} value={duration(totals.overtime)} />
  </div>
{/snippet}

{#snippet tilesUnknown()}
  <div class="tiles">
    {#each [1, 2, 3] as n (n)}<Skeleton height="86px" />{/each}
  </div>
{/snippet}

<Page>
  <ClockControls {workspaceId} />

  {#if totalsUnknown}
    {@render tilesUnknown()}
  {:else}
    {@render tiles()}
  {/if}

  {#if loading}
    <div class="rows">
      {#each [1, 2, 3, 4, 5] as n (n)}<Skeleton height="37px" />{/each}
    </div>
  {:else if days.length}
    <!--
      The month a person already has outranks the failure, because everything here is invalidated by
      a punch: clocking out refetches the day sheet, and a refetch that fails leaves the query in
      `error` with the last good month still in `data`. An error branch above this one would blank
      the whole page — tiles included — for as long as core takes to come back.
    -->
    {#if daysQuery.isError}
      <p class="stale" role="status">
        <span>{t('attendance_stale')}</span>
        <Button size="sm" variant="ghost" onclick={() => void daysQuery.refetch()}>{t('retry')}</Button>
      </p>
    {/if}
    <ul>
      {#each days as day (day.id)}
        <li class="row">
          <span class="date">{dayLabel(day.businessDate)}</span>
          <span class="worked">{duration(day.workedMinutes)}</span>
          {#if day.overtimeMinutes > 0}
            <span class="ot">+{duration(day.overtimeMinutes)}</span>
          {/if}
          <!-- An anomaly is why a day needs a human; saying so beats a silent zero. -->
          {#if day.anomalies.length}
            <Badge tone="warning">{day.anomalies.length}</Badge>
          {/if}
          <Badge tone={statusTone(day.status)}>{statusLabel(day.status)}</Badge>
        </li>
      {/each}
    </ul>
  {:else if daysQuery.isError}
    <EmptyState icon="triangle-alert" title={t('attendance_error')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void daysQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <EmptyState icon="timer" title={t('attendance_none')} description={t('attendance_none_desc')} />
  {/if}
</Page>

<style>
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
  margin-block: 16px 20px;
}
.rows {
  display: grid;
  gap: 4px;
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
  margin-block: 0 8px;
  padding-block: 6px;
  padding-inline: 12px 8px;
  border-radius: var(--kern-r-md);
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
  font-size: 12.5px;
}
ul {
  display: grid;
  gap: 4px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-block-end: 1px solid var(--kern-border);
}
.date {
  flex: 1;
}
.worked,
.ot {
  font-variant-numeric: tabular-nums;
}
.ot {
  color: var(--kern-ink-500);
}
</style>
