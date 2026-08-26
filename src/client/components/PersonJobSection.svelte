<script lang="ts">
import {
  Badge,
  Button,
  EmptyState,
  formatCount,
  formatDate,
  formatDateRange,
  messageLocale,
  SectionLabel,
  Skeleton,
} from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Employment } from '../index.js'
import { canHr } from '../permissions.js'
import { formatDays, hrKeys } from '../query.js'
import EmploymentChangeDialog from './EmploymentChangeDialog.svelte'
import PersonInline from './PersonInline.svelte'

/**
 * What this person's job is, what it was, and how to change it.
 *
 * `hr.employment.manage` is granted by default and says "Change job, manager, department or hours";
 * until this section existed it granted access to nothing, and `employment.history` — the whole
 * reason the table is effective-dated — was called from nowhere. A record that cannot answer "who
 * did she report to in March" is the thing the March approval needs, so the history is here rather
 * than in a report somebody exports.
 *
 * The history is behind a disclosure: it is one query per person, almost nobody opens a panel to
 * read it, and the current period says most of what somebody came for.
 */
interface Props {
  personId: string
  workspaceId: string
  personName: string
}
const { personId, workspaceId, personName }: Props = $props()

const api = getHrApi()

const mayView = $derived(canHr('employmentView'))
const mayManage = $derived(canHr('employmentManage'))
/** Departments and positions are the org chart's, and a viewer without it sees ids or nothing. */
const mayReadOrg = $derived(canHr('orgView'))

/**
 * The same key `PersonPanel` uses for the current period.
 *
 * Two queries, one cache entry: the panel needs the open row for the reporting line it draws beside
 * the office, and this section needs it for everything below. Sharing the key is what keeps that
 * from being two requests for one answer.
 */
const currentQuery = createQuery(() => ({
  queryKey: hrKeys.employment(workspaceId, personId),
  enabled: Boolean(workspaceId && personId) && mayView,
  queryFn: () => api.employment.current({ workspaceId, personId }),
}))
const current = $derived(currentQuery.data)

let showHistory = $state(false)

const historyQuery = createQuery(() => ({
  queryKey: ['hr', 'employment-history', workspaceId, personId] as const,
  enabled: showHistory && Boolean(workspaceId && personId) && mayView,
  queryFn: () => api.employment.history({ workspaceId, personId }),
}))
const history = $derived(historyQuery.data ?? [])

let changing = $state(false)

/**
 * The two lists that turn an id into a word, fetched with the section rather than with the history.
 *
 * The open period names a position, so waiting for the disclosure would leave the one fact somebody
 * came for blank. Both are per-workspace lists cached under their own key, so the second person
 * somebody opens costs nothing.
 *
 * Archived rows are included on purpose: a period from two years ago points at a department that may
 * well have been dissolved since, and printing its id — or nothing — is how history stops being
 * readable.
 */
const unitsQuery = createQuery(() => ({
  queryKey: ['hr', 'org-units', workspaceId, 'with-archived'] as const,
  enabled: Boolean(workspaceId) && mayView && mayReadOrg,
  queryFn: () => api.org.units.tree({ workspaceId, includeArchived: true }),
}))
const positionsQuery = createQuery(() => ({
  queryKey: ['hr', 'positions', workspaceId, 'with-archived'] as const,
  enabled: Boolean(workspaceId) && mayView && mayReadOrg,
  queryFn: () => api.org.positions.list({ workspaceId, includeArchived: true }),
}))
const units = $derived(unitsQuery.data ?? [])
const positions = $derived(positionsQuery.data ?? [])

const unitName = (id: string | null): string | null =>
  id ? (units.find((u) => u.id === id)?.name ?? null) : null
const positionTitle = (id: string | null): string | null =>
  id ? (positions.find((p) => p.id === id)?.title ?? null) : null

/**
 * The employment types the server can send, as words.
 *
 * A map rather than a chain, and an unknown value falls through to itself — a type added on the
 * server shows up as its raw name rather than as nothing.
 */
const EMPLOYMENT_KEYS: Record<string, string> = {
  full_time: 'employment_full_time',
  part_time: 'employment_part_time',
  contract: 'employment_contract',
  intern: 'employment_intern',
  temporary: 'employment_temporary',
  freelance: 'employment_freelance',
}
const typeLabel = (value: string) => (EMPLOYMENT_KEYS[value] ? t(EMPLOYMENT_KEYS[value]) : value)

/**
 * A calendar date, read in the reader's language.
 *
 * The `T00:00:00` is not decoration: `new Date('2026-03-01')` is parsed as *UTC* midnight, so west
 * of Greenwich the panel would print the last day of February for a period starting in March.
 */
const dateLabel = (iso: string): string => formatDate(`${iso}T00:00:00`)

/** A locale-aware number that keeps halves: 0.8 of a full-time week, 37.5 hours of one. */
const num = (value: number) => formatDays(value, messageLocale())

/**
 * A period, as one string.
 *
 * `formatDateRange` rather than two dates and a dash: a hand-built range reads backwards under
 * `dir="rtl"` — the earlier date lands to the right of the later one — and this collapses the parts
 * the two dates share for free. An open period ends at "now" rather than at a date, and saying so
 * beats an empty cell.
 */
const periodLabel = (row: Employment): string =>
  row.effectiveTo
    ? formatDateRange(`${row.effectiveFrom}T00:00:00`, `${row.effectiveTo}T00:00:00`)
    : t('job_since', { date: dateLabel(row.effectiveFrom) })
</script>

{#if mayView}
  <section class="sec">
    <SectionLabel label={t('employment')}>
      {#snippet trailing()}
        <!-- Hidden rather than disabled: `hr.employment.manage` is a permission, so somebody without
             it may never record a change, and a dead button teaches nothing. -->
        {#if mayManage}
          <Button size="sm" variant="secondary" icon="plus" onclick={() => (changing = true)}>
            {t('job_change')}
          </Button>
        {/if}
      {/snippet}
    </SectionLabel>

    <!--
      Held data outranks the error. Every punch and every decision invalidates the whole module, so a
      failed background refetch leaves the query in `error` with the job still in hand — and an error
      branch above this one would blank a record that is on screen and correct.
    -->
    {#if currentQuery.isLoading}
      <div class="rows"><Skeleton lines={3} /></div>
    {:else if current}
      <!--
        No department and no manager here: the panel lists both directly above, resolved through the
        office ladder rather than read off this row, and saying it twice in one column reads as two
        answers to the same question. In the history below they are the point — that is where "who
        did she report to in March" is asked.
      -->
      <dl class="facts">
        <dt>{t('job_period')}</dt>
        <dd>{periodLabel(current)}</dd>
        {#if positionTitle(current.positionId)}
          <dt>{t('job_position')}</dt>
          <dd>{positionTitle(current.positionId)}</dd>
        {/if}
        <dt>{t('employment')}</dt>
        <dd>
          <Badge tone="grey">{typeLabel(current.employmentType)}</Badge>
          {#if current.fte < 1}<span class="muted">{t('job_fte_value', { fte: num(current.fte) })}</span>{/if}
        </dd>
        {#if current.contractHoursWeek !== null}
          <dt>{t('job_hours')}</dt>
          <dd>{t('job_hours_value', { hours: num(current.contractHoursWeek) })}</dd>
        {/if}
        {#if current.reason}
          <dt>{t('job_reason')}</dt>
          <dd class="muted">{current.reason}</dd>
        {/if}
      </dl>
    {:else if currentQuery.isError}
      <EmptyState compact icon="triangle-alert" title={t('job_error')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void currentQuery.refetch()}>
            {t('retry')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <EmptyState compact icon="briefcase" title={t('job_none')} description={t('job_none_desc')}>
        {#snippet actions()}
          {#if mayManage}
            <Button size="sm" icon="plus" onclick={() => (changing = true)}>{t('job_change')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {/if}

    <SectionLabel
      sub
      collapsible
      open={showHistory}
      onToggle={() => (showHistory = !showHistory)}
      label={t('job_history')}
      count={showHistory && history.length ? formatCount(history.length, 999) : null}
    />

    {#if showHistory}
      {#if historyQuery.isLoading}
        <div class="rows">
          {#each [1, 2] as n (n)}<Skeleton height="52px" />{/each}
        </div>
      {:else if history.length}
        <ol class="history">
          {#each history as row (row.id)}
            <li class:open={row.effectiveTo === null}>
              <span class="when">{periodLabel(row)}</span>
              <span class="what">
                <Badge tone={row.effectiveTo === null ? 'accent' : 'grey'}>
                  {typeLabel(row.employmentType)}
                </Badge>
                {#if positionTitle(row.positionId)}<span>{positionTitle(row.positionId)}</span>{/if}
                {#if unitName(row.orgUnitId)}<span class="muted">{unitName(row.orgUnitId)}</span>{/if}
              </span>
              {#if row.managerPersonId}
                <span class="muted">
                  {t('manager')}: <PersonInline id={row.managerPersonId} {workspaceId} />
                </span>
              {/if}
              {#if row.reason}<span class="muted">{row.reason}</span>{/if}
            </li>
          {/each}
        </ol>
      {:else if historyQuery.isError}
        <EmptyState compact icon="triangle-alert" title={t('job_history_error')}>
          {#snippet actions()}
            <Button size="sm" variant="secondary" onclick={() => void historyQuery.refetch()}>
              {t('retry')}
            </Button>
          {/snippet}
        </EmptyState>
      {:else}
        <p class="hint">{t('job_history_none')}</p>
      {/if}
    {/if}
  </section>

  {#if mayManage}
    <EmploymentChangeDialog
      open={changing}
      {workspaceId}
      {personId}
      {personName}
      current={current ?? null}
      {units}
      {positions}
      onClose={() => (changing = false)}
    />
  {/if}
{/if}

<style>
.sec {
  margin-block-start: 20px;
}
.rows {
  display: grid;
  gap: 6px;
  padding-block: 8px;
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  margin: 10px 0 4px;
}
.facts dt {
  color: var(--kern-ink-500);
  font-size: 12px;
}
.facts dd {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.history {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.history li {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  border-radius: var(--kern-r-md);
  border-inline-start: 2px solid var(--kern-border);
  background: var(--kern-surface);
  font-size: 13px;
}
/* The period in force, marked with a border rather than a tint alone so it survives a theme where
   the tint is nearly the surface it sits on. */
.history li.open {
  border-inline-start-color: var(--kern-accent);
  background: var(--kern-surface-active);
}
.when {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.what {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
/* A colour, not opacity: opacity fades text against the panel whatever token it names. */
.muted {
  color: var(--kern-ink-500);
  font-size: 12px;
}
.hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--kern-ink-500);
}
</style>
