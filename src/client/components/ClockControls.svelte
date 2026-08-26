<script lang="ts">
import { Button, EmptyState, Skeleton, toast } from '@kernhq/ui'
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
 *
 * Every state of the query is drawn, including the two that used to render nothing: a failed state
 * fetch took the clock off the attendance page and off the dashboard card with no message and no
 * way back, and the only thing that could bring it back was a reload.
 */
interface Props {
  workspaceId: string
}
const { workspaceId }: Props = $props()

type Punch = 'in' | 'out' | 'break_start' | 'break_end'

const api = getHrApi()
const queryClient = useQueryClient()

const stateQuery = createQuery(() => ({
  queryKey: hrKeys.clockState(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.attendance.state({ workspaceId }),
  // The elapsed total is computed server-side from an open span, so it goes stale on its own.
  refetchInterval: 60_000,
}))
// Not `state`: a variable of that name turns every `$state(...)` in this file into a store read
// of it, and the rune stops existing.
const clock = $derived(stateQuery.data)

const words = {
  hours: (n: string) => t('hours_short', { n }),
  minutes: (n: string) => t('minutes_short', { n }),
}

/**
 * `punching` rather than `act.isPending`: the disabled attribute only reaches the button on the
 * next render, so two quick clicks both fire and the day sheet grows a punch nobody made. This is
 * set in the same tick as the first click.
 */
let punching = $state(false)

const act = createMutation(() => ({
  mutationFn: async (action: Punch) => {
    if (action === 'in') return api.attendance.clockIn({ workspaceId })
    if (action === 'out') return api.attendance.clockOut({ workspaceId })
    if (action === 'break_start') return api.attendance.breakStart({ workspaceId })
    return api.attendance.breakEnd({ workspaceId })
  },
  onSuccess: () => {
    // A punch changes the day sheet as well as the clock, and both are on screen.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: () => {
    // This is the only path that creates attendance, and a rejected clock-out used to say nothing
    // at all — so somebody went home believing the day was closed. The message says what did not
    // happen, because the clock beside it still reads "Working since 09:00" and that is the truth.
    toast.error(t('clock_punch_error'))
  },
  onSettled: () => {
    punching = false
  },
}))

const punch = (action: Punch) => {
  if (punching) return
  punching = true
  act.mutate(action)
}

const since = $derived(
  clock?.since
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(clock.since))
    : null,
)
</script>

{#if stateQuery.isLoading}
  <Skeleton height="72px" />
{:else if stateQuery.isError}
  <EmptyState compact icon="triangle-alert" title={t('clock_error')}>
    {#snippet actions()}
      <Button size="sm" variant="secondary" onclick={() => void stateQuery.refetch()}>
        {t('retry')}
      </Button>
    {/snippet}
  </EmptyState>
{:else if clock}
  <div class="clock">
    <div class="status">
      <span class="line">
        {#if clock.onBreak && since}
          {t('on_break_since', { time: since })}
        {:else if clock.clockedIn && since}
          {t('clocked_in_since', { time: since })}
        {:else}
          {t('not_clocked_in')}
        {/if}
      </span>
      <span class="total">
        {t('worked_today')}: {formatDuration(clock.workedMinutesToday, words)}
      </span>
    </div>

    <div class="actions">
      {#if !clock.clockedIn}
        <Button size="sm" disabled={punching} onclick={() => punch('in')}>
          {t('clock_in')}
        </Button>
      {:else}
        {#if clock.onBreak}
          <Button size="sm" variant="secondary" disabled={punching} onclick={() => punch('break_end')}>
            {t('break_end')}
          </Button>
        {:else}
          <Button size="sm" variant="secondary" disabled={punching} onclick={() => punch('break_start')}>
            {t('break_start')}
          </Button>
        {/if}
        <Button size="sm" disabled={punching} onclick={() => punch('out')}>
          {t('clock_out')}
        </Button>
      {/if}
    </div>
  </div>
{:else}
  <!--
    No workspace yet. The query is disabled until one arrives, and a disabled query is not
    "loading" — so without this branch the clock is simply absent for that first frame.
  -->
  <Skeleton height="72px" />
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
