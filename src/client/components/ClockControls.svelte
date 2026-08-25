<script lang="ts">
import { Button, Skeleton } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { formatDuration, hrKeys } from '../query.js'

/**
 * Clock in, out and break — the whole of attendance for most people.
 *
 * Only the transitions that are currently legal are offered, because the server refuses the others
 * anyway and a button that always errors is worse than no button. Clocked out: one action. Clocked
 * in: clock out, and start a break. On a break: end it.
 */
interface Props {
  workspaceId: string
}
const { workspaceId }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

const stateQuery = createQuery(() => ({
  queryKey: hrKeys.clockState(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.attendance.state({ workspaceId }),
  // The elapsed total is computed server-side from an open span, so it goes stale on its own.
  refetchInterval: 60_000,
}))
const state = $derived(stateQuery.data)

const words = {
  hours: (n: string) => t('hours_short', { n }),
  minutes: (n: string) => t('minutes_short', { n }),
}

const act = createMutation(() => ({
  mutationFn: async (action: 'in' | 'out' | 'break_start' | 'break_end') => {
    if (action === 'in') return api.attendance.clockIn({ workspaceId })
    if (action === 'out') return api.attendance.clockOut({ workspaceId })
    if (action === 'break_start') return api.attendance.breakStart({ workspaceId })
    return api.attendance.breakEnd({ workspaceId })
  },
  onSuccess: () => {
    // A punch changes the day sheet as well as the clock, and both are on screen.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
}))

const since = $derived(
  state?.since
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(state.since))
    : null,
)
</script>

{#if stateQuery.isLoading}
  <Skeleton height="72px" />
{:else if state}
  <div class="clock">
    <div class="status">
      <span class="line">
        {#if state.onBreak && since}
          {t('on_break_since', { time: since })}
        {:else if state.clockedIn && since}
          {t('clocked_in_since', { time: since })}
        {:else}
          {t('not_clocked_in')}
        {/if}
      </span>
      <span class="total">
        {t('worked_today')}: {formatDuration(state.workedMinutesToday, words)}
      </span>
    </div>

    <div class="actions">
      {#if !state.clockedIn}
        <Button size="sm" disabled={act.isPending} onclick={() => act.mutate('in')}>
          {t('clock_in')}
        </Button>
      {:else}
        {#if state.onBreak}
          <Button size="sm" variant="secondary" disabled={act.isPending} onclick={() => act.mutate('break_end')}>
            {t('break_end')}
          </Button>
        {:else}
          <Button size="sm" variant="secondary" disabled={act.isPending} onclick={() => act.mutate('break_start')}>
            {t('break_start')}
          </Button>
        {/if}
        <Button size="sm" disabled={act.isPending} onclick={() => act.mutate('out')}>
          {t('clock_out')}
        </Button>
      {/if}
    </div>
  </div>
{/if}

<style>
.clock {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface);
}
.status {
  display: flex;
  flex-direction: column;
}
.line {
  font-weight: 500;
}
.total {
  color: var(--kern-ink-500);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.actions {
  display: flex;
  gap: 8px;
}
</style>
