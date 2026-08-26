<script lang="ts">
import { Avatar, Button, EmptyState, formatDateRange, Skeleton, type WidgetProps } from '@kernhq/ui'
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

/**
 * `formatDateRange` rather than `Intl` here: it formats in the reader's *interface* language, which
 * `undefined` does not — that is the browser's language, so a Persian interface printed "6 Aug".
 * `T00:00:00` stays on both ends: a bare `YYYY-MM-DD` is parsed as UTC midnight, which prints the
 * day before west of Greenwich.
 */
const range = (a: string, b: string) =>
  formatDateRange(`${a}T00:00:00`, `${b}T00:00:00`, { day: 'numeric', month: 'short' })
</script>

<!--
  Held rows outrank the error. `invalidateQueries({ queryKey: ['hr'] })` fires on every punch and
  every approval decision anywhere in the module, so a failed background refetch leaves TanStack in
  `error` while `data` is still the last good calendar — an error branch above this one would blank
  a working card on a transient failure. The error is only the whole card when there is nothing
  else to draw.
-->
{#if outQuery.isLoading}
  <Skeleton height="96px" />
{:else if away.length > 0}
  <ul>
    {#each away as person (person.requestId)}
      <li>
        <Avatar name={person.displayName} id={person.personId} size={24} />
        <span class="name">{person.displayName}</span>
        <span class="meta">{range(person.startsOn, person.endsOn)}</span>
      </li>
    {/each}
  </ul>
{:else if outQuery.isError}
  <!--
    One row, not an `EmptyState`, for the same reason as the rest of this module's cards: a compact
    `EmptyState` is 82px before it is given an action, which is twice the 43px body a widget has at
    size `s`. This card starts at `m` and has the room, but a person reading two failed HR cards
    side by side should not be shown two different shapes of failure.

    Without this branch the empty state below said "No time off booked" — read on a card headed
    "Who's out" as *nobody is away*, which is the precise opposite of what is actually unknown, and
    the one answer somebody schedules a week of work around.
  -->
  <div class="failed" role="alert">
    <span class="msg">{t('whos_out_error')}</span>
    <Button size="xs" variant="ghost" onclick={() => void outQuery.refetch()}>{t('retry')}</Button>
  </div>
{:else}
  <EmptyState bare compact icon="calendar-days" title={t('leave_none')} />
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
