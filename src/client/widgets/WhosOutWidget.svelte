<script lang="ts">
import { Avatar, EmptyState, Skeleton, type WidgetProps } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { hrKeys, isoDate } from '../query.js'

/**
 * Who is away over the next fortnight.
 *
 * The leave *type* is shown only when the server sends it — most companies want the team to know
 * somebody is out without knowing it is sick leave, so the decision is made server-side and this
 * renders whatever it was given.
 */
const { workspaceId }: WidgetProps = $props()
const api = getHrApi()

const from = isoDate()
const to = isoDate(new Date(Date.now() + 14 * 86_400_000))

const outQuery = createQuery(() => ({
  queryKey: hrKeys.leaveCalendar(workspaceId, from, to),
  enabled: Boolean(workspaceId),
  queryFn: () => api.leave.team.calendar({ workspaceId, from, to }),
}))
const away = $derived(outQuery.data ?? [])

const range = (a: string, b: string) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).formatRange(
    new Date(`${a}T00:00:00`),
    new Date(`${b}T00:00:00`),
  )
</script>

{#if outQuery.isLoading}
  <Skeleton height="96px" />
{:else if away.length === 0}
  <EmptyState bare compact icon="calendar-days" title={t('leave_none')} />
{:else}
  <ul>
    {#each away as person (person.requestId)}
      <li>
        <Avatar name={person.displayName} id={person.personId} size={24} />
        <span class="name">{person.displayName}</span>
        <span class="meta">{range(person.startsOn, person.endsOn)}</span>
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
  align-items: center;
  gap: 8px;
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  color: var(--kern-ink-500);
  font-size: 12px;
}
</style>
