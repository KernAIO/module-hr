<script lang="ts">
import { Button, formatCount, Skeleton, StatTile, type WidgetProps } from '@kernhq/ui'
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
/**
 * `total` rather than `items.length`: the request asks for one row, because drawing a number does
 * not need the list behind it.
 *
 * No `?? 0`. A tile reading "0 people" is a claim about the company, and it was the claim this card
 * made every time the fetch failed — indistinguishable from a workspace nobody has been added to.
 * `undefined` is what says "not known", and the branches below are ordered on it.
 */
const total = $derived(peopleQuery.data?.total)
/**
 * `formatCount`'s default caps at "99+", which is right for a badge on a nav row and wrong for a
 * headcount — a four-hundred-person company would read "99+". The cap is lifted rather than the
 * locale dropped: a bare `Intl.NumberFormat()` follows the browser's language, so a Persian
 * interface would be the one screen printing Latin digits.
 */
const people = $derived(total === undefined ? '' : formatCount(total, Number.MAX_SAFE_INTEGER))
</script>

<!--
  The held number outranks the error, as everywhere else in this module:
  `invalidateQueries({ queryKey: ['hr'] })` fires on every punch and every approval decision, so a
  failed background refetch leaves TanStack in `error` while `data` is still the last good count.
  Blanking a card that has a number, because the poll behind it missed once, is the louder bug.
-->
{#if peopleQuery.isLoading}
  <Skeleton height="72px" />
{:else if total !== undefined}
  <StatTile label={t('widget_headcount_title')} value={people} />
{:else if peopleQuery.isError}
  <!--
    The label stays and the number does not. This widget is `compact`, so the frame draws no header
    and the tile's own label is the only thing naming the card — drop it and the board grows an
    anonymous box. The reason takes the number's place, in the same footprint the tile occupied, so
    nothing around it moves.
  -->
  <div class="failed" role="alert">
    <div class="text">
      <span class="label">{t('widget_headcount_title')}</span>
      <span class="msg">{t('people_error')}</span>
    </div>
    <Button size="xs" variant="ghost" onclick={() => void peopleQuery.refetch()}>{t('retry')}</Button>
  </div>
{:else}
  <!--
    No workspace yet. The query is disabled until one arrives, and a disabled query is not
    "loading" — so without this branch the card is simply absent for that first frame.
  -->
  <Skeleton height="72px" />
{/if}

<style>
/* The tile's own frame, so a card that fails keeps the shape it had a moment ago. */
.failed {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-block: 14px;
  padding-inline: 16px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-2xl);
  background: var(--kern-surface-raised);
}
.text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.label {
  font-size: 12px;
  color: var(--kern-ink-450);
}
/* Muted with a colour, never opacity: 9.86:1 on the tile in light, 8.96:1 in dark. */
.msg {
  font-size: 12.5px;
  color: var(--kern-ink-600);
}
</style>
