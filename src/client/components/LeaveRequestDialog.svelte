<script lang="ts">
import { Button, Dialog, Field, Input, navigation, Select, Textarea, toast } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { formatDays, hrKeys, isoDate } from '../query.js'

/**
 * Book time off.
 *
 * The Request time off button already went to `?new=1`. This is the form that URL was promising:
 * pick a type and a range, see what it would cost, then submit. Simulation runs before create so a
 * blocked request is refused here rather than after the click.
 */
interface Props {
  open: boolean
  workspaceId: string
  workspaceSlug: string
}

let { open, workspaceId, workspaceSlug }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

let shown = $state(false)
$effect(() => {
  if (open) shown = true
})

let leaveTypeId = $state('')
let startsOn = $state(isoDate())
let endsOn = $state(isoDate())
let reason = $state('')

const typesQuery = createQuery(() => ({
  queryKey: hrKeys.leaveTypes(workspaceId),
  enabled: Boolean(workspaceId) && open,
  queryFn: () => api.leave.types.list({ workspaceId, includeArchived: false }),
}))
const types = $derived(typesQuery.data ?? [])
const typeOptions = $derived(types.map((type) => ({ value: type.id, label: type.name })))

$effect(() => {
  if (open && !leaveTypeId && types[0]) leaveTypeId = types[0].id
})

const simQuery = createQuery(() => ({
  queryKey: ['hr', 'leave-sim', workspaceId, leaveTypeId, startsOn, endsOn] as const,
  enabled: Boolean(workspaceId && leaveTypeId && startsOn && endsOn && open),
  queryFn: () =>
    api.leave.requests.simulate({
      workspaceId,
      leaveTypeId,
      startsOn,
      endsOn,
    }),
}))
const sim = $derived(simQuery.data)
const blocked = $derived((sim?.blockers.length ?? 0) > 0)

const close = () => {
  shown = false
  void navigation.go(`/${workspaceSlug}/hr/leave`, { replaceState: true, keepFocus: true, noScroll: true })
}

const create = createMutation(() => ({
  mutationFn: () =>
    api.leave.requests.create({
      workspaceId,
      leaveTypeId,
      startsOn,
      endsOn,
      reason: reason.trim() || null,
      idempotencyKey: crypto.randomUUID(),
    }),
  onSuccess: () => {
    toast.success(t('leave_submitted'))
    void queryClient.invalidateQueries({ queryKey: ['hr', 'leave-balance'] })
    void queryClient.invalidateQueries({ queryKey: ['hr', 'leave-requests'] })
    void queryClient.invalidateQueries({ queryKey: ['hr', 'leave-calendar'] })
    reason = ''
    close()
  },
  onError: (error: Error) => toast.error(error.message),
}))

const canSubmit = $derived(
  Boolean(leaveTypeId && startsOn && endsOn) && !blocked && canHr('leaveRequest') && !simQuery.isFetching,
)
</script>

<Dialog
  bind:open={shown}
  title={t('request_leave')}
  onOpenChange={(next) => {
    if (!next) close()
  }}
>
  <div class="form">
    <Field label={t('leave_type')} id="hr-leave-type" required>
      {#snippet children(id)}
        <Select {id} bind:value={leaveTypeId} options={typeOptions} />
      {/snippet}
    </Field>
    <div class="dates">
      <Field label={t('leave_from')} id="hr-leave-from" required>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={startsOn} />
        {/snippet}
      </Field>
      <Field label={t('leave_to')} id="hr-leave-to" required>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={endsOn} />
        {/snippet}
      </Field>
    </div>
    <Field label={t('leave_reason')} id="hr-leave-reason" hint={t('common.optional')}>
      {#snippet children(id)}
        <Textarea {id} bind:value={reason} rows={3} />
      {/snippet}
    </Field>

    {#if sim}
      {#if blocked}
        <p class="block" role="alert">
          {t('leave_blocked')}
          {sim.blockers[0]?.message ?? ''}
        </p>
      {:else}
        <p class="cost">
          {t('leave_would_cost', { days: formatDays(sim.workingDays) })}
          ·
          {t('leave_after', { days: formatDays(sim.balanceAfterMinutes / 480) })}
        </p>
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={close}>{t('common.cancel')}</Button>
    <Button onclick={() => create.mutate()} disabled={!canSubmit} loading={create.isPending}>
      {t('request_leave')}
    </Button>
  {/snippet}
</Dialog>

<style>
.form {
  display: grid;
  gap: 14px;
}
.dates {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.cost {
  margin: 0;
  font-size: 13px;
  color: var(--kern-ink-500);
}
.block {
  margin: 0;
  font-size: 13px;
  color: var(--kern-danger);
}
</style>
