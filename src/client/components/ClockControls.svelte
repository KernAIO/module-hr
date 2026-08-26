<script lang="ts">
import { Button, localTime, Skeleton, toast } from '@kernhq/ui'
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

/**
 * The reasons the server refuses a punch for, and this module's string for each.
 *
 * Keyed by the `reason` the router sends beside the refusal — never by the sentence, because a list
 * of sentences is a list somebody has to keep in sync and the day it drifts the reader is told
 * nothing. A reason missing from here is not a bug; it is the fallback doing its job: a sixth
 * refusal added to `punch()` shows the sentence the router wrote until a string lands here.
 *
 * The message keys on the right are written out in full so `t()` passes them through untouched,
 * which is what lets `onError` tell a resolved string from a key that resolved to itself.
 */
const punchRefusalMessages: Record<string, string> = {
  'hr.clock.already_clocked_in': 'hr.clock_refused_already_in',
  'hr.clock.not_clocked_in': 'hr.clock_refused_not_in',
  'hr.clock.break_before_clock_in': 'hr.clock_refused_break_needs_in',
  'hr.clock.already_on_break': 'hr.clock_refused_already_on_break',
  'hr.clock.not_on_break': 'hr.clock_refused_not_on_break',
}

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
  onError: (error) => {
    // The router refuses an impossible transition — clocking in twice, a break before clocking in —
    // and that refusal is the only thing that says why the button did nothing. It arrives as two
    // pieces: a `reason` this file translates, and the English sentence the router wrote for a
    // reader. Nothing else that can fail here has written anything for a person: a network drop, a
    // 500 or a gateway carry machine text, in English, and a clock is the last place to paste one.
    // So a refusal is explained and everything else falls back to this module's own string.
    //
    // The test is the transport's `code`, never the sentence: a list of sentences is a list
    // somebody has to keep in sync, and the day it drifts the person is told nothing.
    const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
    const refused = failure.code === 'CONFLICT'
    const reason = refused && typeof failure.data?.reason === 'string' ? failure.data.reason : null
    const key = reason ? punchRefusalMessages[reason] : undefined
    // `t()` answers a key it has no string for with the key itself, so a translation is only used
    // when it is one, and both ways of not having one land on the server's sentence: a reason no
    // key covers, and a key whose string has not been merged yet. Neither may put
    // `hr.clock_refused_not_in` — or nothing at all — in front of a person.
    const translated = key ? t(key) : undefined
    const explained = translated && translated !== key ? translated : refused ? failure.message : undefined
    toast.error(explained || t('clock_punch_error'))
    // A refusal is the server saying its picture of the day is not the one on screen — most often
    // because the auto clock-out sweep closed the shift, or a punch arrived from another device.
    // Both of those wrote a punch, so the day sheet beside the clock is as wrong as the clock is:
    // re-read all of HR, exactly as a punch that landed does. Without this the same wrong clock
    // stays up and every retry earns the same toast with no route to the truth.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
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

const since = $derived(clock?.since ? localTime(new Date(clock.since)) : null)
</script>

<!--
  Held data outranks the error, because this query polls. A failed background refetch leaves
  TanStack in `error` while `data` is still the last good clock, so an error branch above this one
  took "Working since 09:00" *and the clock-out button* off the screen of somebody mid-shift for a
  minute at a time — every core restart, every rolling deploy. The error is only the whole frame
  when there is nothing else to draw.
-->
{#if stateQuery.isLoading}
  <Skeleton height="72px" />
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
      {#if stateQuery.isError}
        <!--
          The total is the number that drifts — it is counted from an open span, so it is only ever
          as current as the last successful poll. Saying so in its place costs no height (the widget
          body is about 44px) and takes nothing away: the poll is still running, and a punch
          refreshes the clock either way, so there is nothing here for a person to do.
        -->
        <span class="total stale" role="status">{t('clock_stale')}</span>
      {:else}
        <span class="total">
          {t('worked_today')}: {formatDuration(clock.workedMinutesToday, words)}
        </span>
      {/if}
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
{:else if stateQuery.isError}
  <!--
    The same row as the clock, rather than an `EmptyState`: this is read most often inside the clock
    widget, whose body is about one grid row — roughly 44px — and a compact `EmptyState` is more
    than twice that, so its retry button sat below a fold nobody scrolls. Here the button lands
    where the clock-out button would have been.
  -->
  <div class="clock" role="alert">
    <span class="line">{t('clock_error')}</span>
    <Button size="sm" variant="secondary" onclick={() => void stateQuery.refetch()}>
      {t('retry')}
    </Button>
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
/* 5.23:1 on --kern-surface in light, 6.80:1 in dark — this is 12px text, so it has to clear 4.5. */
.stale {
  color: var(--kern-warning);
}
.actions {
  display: flex;
  gap: 8px;
}
</style>
