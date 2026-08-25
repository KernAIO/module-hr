<script lang="ts">
import { EmptyState, Skeleton, type WidgetProps } from '@kernhq/ui'
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

{#if balanceQuery.isLoading}
  <Skeleton height="72px" />
{:else if balances.length === 0}
  <EmptyState bare compact icon="tree-palm" title={t('leave_none')} />
{:else}
  <ul>
    {#each balances as b (b.leaveTypeId)}
      <li>
        <span class="name">{b.leaveTypeName}</span>
        <span class="value">{formatDays(b.available)} <span class="unit">{t('days')}</span></span>
      </li>
    {/each}
  </ul>
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
</style>
