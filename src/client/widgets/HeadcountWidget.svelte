<script lang="ts">
import { Skeleton, StatTile, type WidgetProps } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { hrKeys } from '../query.js'

/** How many people work here. One number, so the frame's header is dropped (`compact`). */
const { workspaceId }: WidgetProps = $props()
const api = getHrApi()

const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { status: 'active' }),
  enabled: Boolean(workspaceId),
  queryFn: () => api.people.list({ workspaceId, limit: 1, status: ['active'] }),
}))
// `total` rather than `items.length`: the request asks for one row, because drawing a number does
// not need the list behind it.
const count = $derived(peopleQuery.data?.total ?? 0)
</script>

{#if peopleQuery.isLoading}
  <Skeleton height="72px" />
{:else}
  <StatTile
    label={t('widget_headcount_title')}
    value={new Intl.NumberFormat().format(count)}
  />
{/if}
