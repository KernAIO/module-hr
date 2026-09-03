<script lang="ts">
import { Button, EmptyState, formatCount, SectionLabel, Skeleton, session } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canHr, HR_CAPABILITIES } from '../permissions.js'
import { hrKeys } from '../query.js'
import ChecklistCard from './ChecklistCard.svelte'
import StartChecklistDialog from './StartChecklistDialog.svelte'

/**
 * This person's onboarding and offboarding checklists, on their panel.
 *
 * Behind the `checklists` capability: a workspace that never switched it on has no section, not an
 * empty one. Below that the server decides what the reader may see — a manager gets every list, a
 * colleague gets the ones with a task for them, and everybody else gets an empty answer. That empty
 * answer hides the section for a non-manager rather than announcing "no checklists", which would be
 * a claim about a colleague the reader was never allowed to make.
 */
interface Props {
  personId: string
  workspaceId: string
  personName: string
}
const { personId, workspaceId, personName }: Props = $props()

const api = getHrApi()

const enabled = $derived(session.hasCapability('hr', HR_CAPABILITIES.checklists) && canHr('checklistView'))
const manage = $derived(canHr('checklistManage'))

const listQuery = createQuery(() => ({
  queryKey: hrKeys.checklists(workspaceId, { personId }),
  enabled: enabled && Boolean(workspaceId && personId),
  queryFn: () => api.checklists.list({ workspaceId, personId, limit: 50 }),
}))
const lists = $derived(listQuery.data ?? [])

/** Visible to a manager always; to anybody else only while there is, or may be, something to show. */
const visible = $derived(enabled && (manage || listQuery.isLoading || listQuery.isError || lists.length > 0))

let starting = $state(false)
</script>

{#if visible}
  <section class="sec">
    <SectionLabel label={t('checklists_title')} count={lists.length ? formatCount(lists.length, 999) : null}>
      {#snippet trailing()}
        <!-- Hidden rather than disabled: starting a list is a permission, and a dead button teaches nothing. -->
        {#if manage}
          <Button size="sm" variant="secondary" icon="plus" onclick={() => (starting = true)}>
            {t('checklist_start')}
          </Button>
        {/if}
      {/snippet}
    </SectionLabel>

    <!-- Held data outranks the error, as everywhere on this panel: every tick invalidates the whole
         module, and a failed background refetch must not blank a list that is on screen. -->
    {#if listQuery.isLoading}
      <div class="rows"><Skeleton lines={3} /></div>
    {:else if lists.length > 0}
      {#each lists as summary (summary.id)}
        <ChecklistCard {summary} {workspaceId} />
      {/each}
    {:else if listQuery.isError}
      <EmptyState compact icon="triangle-alert" title={t('checklists_error')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void listQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else}
      <EmptyState compact icon="list-checks" title={t('checklist_person_none', { name: personName })}>
        {#snippet actions()}
          {#if manage}
            <Button size="sm" icon="plus" onclick={() => (starting = true)}>{t('checklist_start')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {/if}
  </section>

  {#if manage}
    <StartChecklistDialog open={starting} {workspaceId} {personId} onClose={() => (starting = false)} />
  {/if}
{/if}

<style>
.sec {
  margin-block-start: 20px;
}
.rows {
  display: grid;
  gap: 6px;
  padding-block: 8px;
}
</style>
