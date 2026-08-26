<script lang="ts">
import { Button, EmptyState, Skeleton, type WidgetProps } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { formatDays, hrKeys } from '../query.js'

/**
 * What is left of each kind of leave.
 *
 * Shows `available`, not `balance`: pending requests are already spoken for, and a card promising
 * twenty days when five are awaiting approval is how somebody books a week they do not have.
 */
const { workspaceId }: WidgetProps = $props()
const api = getHrApi()

const balanceQuery = createQuery(() => ({
  queryKey: hrKeys.leaveBalance(workspaceId, undefined),
  enabled: Boolean(workspaceId),
  queryFn: () => api.leave.balance.get({ workspaceId }),
}))
const balances = $derived(balanceQuery.data ?? [])
</script>

<!--
  Held balances outrank the error. `invalidateQueries({ queryKey: ['hr'] })` fires on every punch and
  every approval decision anywhere in the module, so a failed background refetch leaves TanStack in
  `error` while `data` is still the last good set of balances — an error branch above this one would
  blank a working card on a transient failure. The error is only the whole card when there is
  nothing else to draw.
-->
{#if balanceQuery.isLoading}
  <Skeleton height="72px" />
{:else if balances.length > 0}
  <ul>
    {#each balances as b (b.leaveTypeId)}
      <li>
        <span class="name">{b.leaveTypeName}</span>
        <span class="value">{formatDays(b.available)} <span class="unit">{t('days', { count: b.available })}</span></span>
      </li>
    {/each}
  </ul>
{:else if balanceQuery.isError}
  <!--
    One row, not an `EmptyState`. This card's smallest declared size is `s`, whose body is 43px —
    one grid row of 84px, less the frame's 41px header — and a compact `EmptyState` is 82px before
    it is given an action, so its retry button sat below a fold nobody scrolls in a card this size.

    Without this branch the empty state below said "No time off booked", which on a card headed "My
    time off" reads as a balance of nothing — the answer somebody plans a year around, given for a
    request that never arrived.
  -->
  <div class="failed" role="alert">
    <span class="msg">{t('balance_error')}</span>
    <Button size="xs" variant="ghost" onclick={() => void balanceQuery.refetch()}>{t('retry')}</Button>
  </div>
{:else}
  <EmptyState bare compact icon="tree-palm" title={t('leave_none')} />
{/if}

<style>
ul {
  display: grid;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.name {
  color: var(--kern-ink-500);
  font-size: 12px;
  min-width: 0;
}
.value {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
.unit {
  font-size: 12px;
  color: var(--kern-ink-500);
}
.failed {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-block: 8px;
  padding-inline: 14px;
}
/* Muted with a colour, never opacity: 9.86:1 on the card in light, 8.96:1 in dark. */
.msg {
  min-width: 0;
  font-size: 12.5px;
  color: var(--kern-ink-600);
}
</style>
