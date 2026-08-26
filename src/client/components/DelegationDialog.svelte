<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  formatDateRange,
  Input,
  Select,
  Skeleton,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { hrKeys } from '../query.js'

/**
 * Who decides while I am away.
 *
 * A delegation does not move a request — it lets somebody else act on the one already addressed to
 * me, and the decision records both names. That is why this lives beside the inbox rather than in
 * settings: it is a personal arrangement about my own queue, not a policy about anyone else's.
 *
 * Existing delegations are listed with a way to revoke, because the failure mode of this feature is
 * one somebody set up last summer and forgot.
 */
interface Props {
  open: boolean
  workspaceId: string
  onClose: () => void
}
const { open, workspaceId, onClose }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

const delegationsQuery = createQuery(() => ({
  queryKey: hrKeys.delegations(workspaceId),
  enabled: open && Boolean(workspaceId),
  queryFn: () => api.approvals.delegations({ workspaceId }),
}))

const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forDelegation: true }),
  enabled: open && Boolean(workspaceId),
  queryFn: () => api.people.list({ workspaceId, limit: 200, status: ['active'] }),
}))
const people = $derived(peopleQuery.data?.items ?? [])

let toPersonId = $state('')
let startsOn = $state(new Date().toISOString().slice(0, 10))
let endsOn = $state('')
let formError = $state<string | null>(null)

const create = createMutation(() => ({
  mutationFn: () => api.approvals.delegate({ workspaceId, toPersonId, startsOn, endsOn }),
  onSuccess: () => {
    toPersonId = ''
    endsOn = ''
    formError = null
    void queryClient.invalidateQueries({ queryKey: hrKeys.delegations(workspaceId) })
  },
  onError: () => {
    formError = t('delegate_error')
  },
}))

const revoke = createMutation(() => ({
  mutationFn: (delegationId: string) => api.approvals.revokeDelegation({ workspaceId, delegationId }),
  onSuccess: () => void queryClient.invalidateQueries({ queryKey: hrKeys.delegations(workspaceId) }),
}))

/**
 * The one thing worth refusing before the server does: a window that ends before it starts is a
 * delegation that silently never applies, and the API's error for it reads like a bug report.
 */
const canSubmit = $derived(Boolean(toPersonId) && Boolean(startsOn) && Boolean(endsOn) && endsOn >= startsOn)
const datesInvalid = $derived(Boolean(startsOn) && Boolean(endsOn) && endsOn < startsOn)

const nameOf = (personId: string) => people.find((p) => p.id === personId)?.displayName ?? '—'

const range = (from: string, to: string) => formatDateRange(from, to)
</script>

<Dialog
  {open}
  size="md"
  title={t('delegate_title')}
  description={t('delegate_desc')}
  onOpenChange={(o) => {
    if (!o) onClose()
  }}
>
  <div class="existing">
    {#if delegationsQuery.isLoading}
      <Skeleton height="44px" />
    {:else if (delegationsQuery.data ?? []).length === 0}
      <EmptyState compact icon="user" title={t('delegate_none')} />
    {:else}
      <ul>
        {#each delegationsQuery.data ?? [] as d (d.id)}
          <li>
            <span class="stack">
              <span class="name">{nameOf(d.toPersonId)}</span>
              <span class="meta">
                {range(d.startsOn, d.endsOn)}
                <Badge tone="grey">{d.subjectType ? d.subjectType : t('delegate_all_types')}</Badge>
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              loading={revoke.isPending && revoke.variables === d.id}
              onclick={() => revoke.mutate(d.id)}
            >
              {t('delegate_revoke')}
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <form
    class="form"
    onsubmit={(e) => {
      e.preventDefault()
      if (canSubmit) create.mutate()
    }}
  >
    <Field label={t('delegate_to')} required error={formError}>
      {#snippet children(id)}
        <Select
          {id}
          bind:value={toPersonId}
          disabled={peopleQuery.isLoading}
          options={[
            { value: '', label: '—' },
            ...people.map((p) => ({ value: p.id, label: p.displayName })),
          ]}
        />
      {/snippet}
    </Field>
    <div class="dates">
      <Field label={t('delegate_from_date')} required>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={startsOn} />
        {/snippet}
      </Field>
      <Field
        label={t('delegate_to_date')}
        required
        error={datesInvalid ? t('delegate_dates_invalid') : null}
      >
        {#snippet children(id)}
          <Input {id} type="date" bind:value={endsOn} min={startsOn} />
        {/snippet}
      </Field>
    </div>
    <div class="submit">
      <Button type="submit" disabled={!canSubmit} loading={create.isPending}>{t('delegate_add')}</Button>
    </div>
  </form>
</Dialog>

<style>
.existing {
  margin-block-end: 16px;
}
ul {
  display: grid;
  gap: 4px;
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-md);
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.name {
  font-size: 13.5px;
  font-weight: 500;
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.form {
  display: grid;
  gap: 12px;
  padding-block-start: 16px;
  border-block-start: 1px solid var(--kern-border);
}
.dates {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.submit {
  display: flex;
  justify-content: flex-end;
}
</style>
