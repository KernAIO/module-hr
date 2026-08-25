<script lang="ts">
import { Avatar } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { hrKeys } from '../query.js'

/**
 * A person, rendered wherever another module mentions one — a chat message, an issue's assignee.
 *
 * This is what `objectTypes: [{ type: 'person' }]` on the server buys: HR owns how a person looks,
 * so every module shows the same name and avatar without importing anything of HR's.
 */
interface Props {
  id: string
  workspaceId: string
}
const { id, workspaceId }: Props = $props()

const api = getHrApi()

const personQuery = createQuery(() => ({
  queryKey: hrKeys.person(workspaceId, id),
  enabled: Boolean(workspaceId && id),
  queryFn: () => api.people.get({ workspaceId, personId: id }),
}))
const person = $derived(personQuery.data)
</script>

<span class="inline">
  {#if person}
    <Avatar name={person.displayName} id={person.id} size={18} />
    <span>{person.displayName}</span>
  {:else}
    <!-- No skeleton: an inline mention that pulses inside a sentence is worse than a plain name. -->
    <span class="pending">…</span>
  {/if}
</span>

<style>
.inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  vertical-align: baseline;
}
.pending {
  color: var(--kern-ink-500);
}
</style>
