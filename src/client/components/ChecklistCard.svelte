<script lang="ts">
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  formatDate,
  ProgressBar,
  SectionLabel,
  Skeleton,
} from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import type { ChecklistSummary } from '../../contract/checklists.js'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { hrKeys } from '../query.js'
import ChecklistItems from './ChecklistItems.svelte'

/**
 * One checklist as the person panel draws it: its header from the summary the list already
 * returned, and its items fetched only once the card is opened.
 *
 * Open by default while the list is running and closed once it is done or cancelled — a finished
 * list is history, and a panel that opens three finished lists above the one that matters puts the
 * reader's work below the fold.
 */
interface Props {
  summary: ChecklistSummary
  workspaceId: string
}
const { summary, workspaceId }: Props = $props()

const api = getHrApi()

let open = $state(summary.status === 'open')

const detailQuery = createQuery(() => ({
  queryKey: hrKeys.checklist(workspaceId, summary.id),
  enabled: open && Boolean(workspaceId),
  queryFn: () => api.checklists.get({ workspaceId, checklistId: summary.id }),
}))

const STATUS_TONES: Record<string, BadgeTone> = { open: 'upcoming', done: 'success', cancelled: 'grey' }
const statusLabel = (status: string) =>
  status === 'open'
    ? t('checklist_status_open')
    : status === 'done'
      ? t('checklist_status_done')
      : t('checklist_status_cancelled')
const kindLabel = (kind: string) =>
  kind === 'onboarding' ? t('checklist_kind_onboarding') : t('checklist_kind_offboarding')
</script>

<div class="card">
  <SectionLabel sub collapsible {open} onToggle={() => (open = !open)} label={summary.name}>
    {#snippet trailing()}
      <span class="badges">
        <Badge tone="grey">{kindLabel(summary.kind)}</Badge>
        <Badge tone={STATUS_TONES[summary.status] ?? 'grey'}>{statusLabel(summary.status)}</Badge>
      </span>
    {/snippet}
  </SectionLabel>
  <div class="progress">
    <ProgressBar
      value={summary.progress.done}
      max={summary.progress.total || 1}
      tone={summary.status === 'done' ? 'success' : 'accent'}
      label={t('checklist_progress', { done: String(summary.progress.done), total: String(summary.progress.total) })}
    />
    <span class="count">
      {t('checklist_progress', { done: String(summary.progress.done), total: String(summary.progress.total) })}
      · {t('checklist_anchor_short', { date: formatDate(`${summary.anchorDate}T00:00:00`) })}
    </span>
  </div>
  {#if open}
    {#if detailQuery.isLoading}
      <div class="rows">
        {#each [1, 2, 3] as n (n)}<Skeleton height="40px" />{/each}
      </div>
    {:else if detailQuery.data}
      <ChecklistItems checklist={detailQuery.data} {workspaceId} compact />
    {:else if detailQuery.isError}
      <EmptyState compact icon="triangle-alert" title={t('checklist_detail_error')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void detailQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {/if}
  {/if}
</div>

<style>
.card {
  display: grid;
  gap: 8px;
  margin-block-start: 10px;
}
.badges {
  display: inline-flex;
  gap: 6px;
}
.progress {
  display: grid;
  gap: 4px;
}
.count {
  font-size: 12px;
  color: var(--kern-ink-500);
  font-variant-numeric: tabular-nums;
}
.rows {
  display: grid;
  gap: 4px;
}
</style>
