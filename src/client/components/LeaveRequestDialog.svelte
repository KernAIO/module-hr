<script lang="ts">
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  navigation,
  Select,
  Skeleton,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { hrKeys, isoDate } from '../query.js'

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
const selectedType = $derived(types.find((type) => type.id === leaveTypeId))

$effect(() => {
  if (open && !leaveTypeId && types[0]) leaveTypeId = types[0].id
})

/**
 * The balance, from the same key the time-off page reads.
 *
 * Not a second opinion: `available` is the server's own figure in the type's own unit, and it is
 * the number that page already shows — so opening this form costs nothing and the two screens
 * cannot disagree.
 */
const balanceQuery = createQuery(() => ({
  queryKey: hrKeys.leaveBalance(workspaceId, undefined),
  enabled: Boolean(workspaceId) && open,
  queryFn: () => api.leave.balance.get({ workspaceId }),
}))
const balance = $derived(balanceQuery.data?.find((row) => row.leaveTypeId === leaveTypeId))

const simQuery = createQuery(() => ({
  queryKey: ['hr', 'leave_balance', workspaceId, 'leave-sim', leaveTypeId, startsOn, endsOn] as const,
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
const blockers = $derived(sim?.blockers ?? [])
const blocked = $derived(blockers.length > 0)

/**
 * What this would cost, in the unit the server reports the balance in.
 *
 * Both halves are the server's own numbers and both scale with whatever a working day is worth, so
 * subtracting one from the other stays right the day that stops being eight hours. Dividing
 * `balanceAfterMinutes` by a hard 480 here did not: it disagreed with the same figure on the
 * time-off page, which has always shown `available`.
 */
const cost = $derived(sim && balance ? (balance.unit === 'hour' ? sim.minutes / 60 : sim.workingDays) : null)
const after = $derived(balance && cost !== null ? Math.round((balance.available - cost) * 100) / 100 : null)

const availableLabel = $derived(
  balance
    ? balance.unit === 'hour'
      ? t('leave_available_now_hours', { count: balance.available })
      : t('leave_available_now', { count: balance.available })
    : null,
)
const afterLabel = $derived(
  balance && after !== null
    ? balance.unit === 'hour'
      ? t('leave_after_hours', { count: after })
      : t('leave_after', { count: after })
    : null,
)

/**
 * The cost, and the one other number worth having beside it.
 *
 * Blocked, that is what they hold — "not enough" is only answerable next to it. Clear, it is what
 * would be left. Neither appears until the balance has arrived: a figure this form worked out for
 * itself is how the two screens came to disagree in the first place.
 */
const costLine = $derived.by(() => {
  if (!sim) return null
  const spend = t('leave_would_cost', { count: sim.workingDays })
  const tail = blocked ? availableLabel : afterLabel
  return tail ? `${spend} · ${tail}` : spend
})

/**
 * A blocker's `code`, as this module's own sentence.
 *
 * Keyed by the code `simulate` puts beside its prose for exactly this, never by the sentence: a
 * list of sentences is a list somebody has to keep in sync, and the day it drifts the reader is
 * told nothing. Every blocker is drawn, not the first — fixing the one on screen used to reveal a
 * second the form had never mentioned.
 */
const BLOCKER_KEYS: Record<string, string> = {
  range: 'hr.leave_blocked_range',
  archived: 'hr.leave_blocked_archived',
  empty: 'hr.leave_blocked_empty',
  insufficient: 'hr.leave_blocked_insufficient',
  below_floor: 'hr.leave_blocked_below_floor',
  overlap: 'hr.leave_blocked_overlap',
  document_required: 'hr.leave_blocked_document_required',
}

/**
 * Four of these name the leave type and one counts the days before a document is needed, and both
 * facts live on the type this form is holding. `null` means the fact is not here — the type was
 * archived out of the list between opening the form and simulating — and a sentence with `{type}`
 * still in it is worse than the server's own.
 */
function blockerParams(code: string): Record<string, string | number> | undefined | null {
  if (code === 'range' || code === 'empty' || code === 'overlap') return undefined
  const name = selectedType?.name
  if (!name) return null
  if (code !== 'document_required') return { type: name }
  const days = selectedType?.requiresDocumentAfterDays
  return days === null || days === undefined ? null : { type: name, count: days }
}

function blockerText(blocker: { code: string; message: string }): string {
  const key = BLOCKER_KEYS[blocker.code]
  const params = blockerParams(blocker.code)
  // `t()` answers a key it has no string for with the key itself, so a translation is only used
  // when it is one. Both ways of not having one — a code nothing covers here, and a key whose
  // string has not been merged yet — land on the sentence the router wrote rather than on
  // `hr.leave_blocked_overlap` in front of a person.
  const text = key && params !== null ? t(key, params) : undefined
  return text && text !== key ? text : blocker.message
}

const close = () => {
  shown = false
  void navigation.go(`/${workspaceSlug}/hr/leave`, { replaceState: true, keepFocus: true, noScroll: true })
}

/**
 * `submitting` rather than `create.isPending`: the disabled attribute only reaches the button on
 * the next render, so two quick clicks both fire, each with its own idempotency key — and the
 * second earns "you already have leave booked on those days" for the request the first one made.
 */
let submitting = $state(false)

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
    // Two prefixes cover four screens: the balance, this dialog's preview and the ledger all sit
    // under `leave_balance`, the request list and the team calendar under `leave_request`.
    void queryClient.invalidateQueries({ queryKey: ['hr', 'leave_balance'] })
    void queryClient.invalidateQueries({ queryKey: ['hr', 'leave_request'] })
    reason = ''
    close()
  },
  onError: (error) => {
    // `create` runs the same `simulate` the preview does and refuses on its first blocker, so a
    // refusal here is a blocker code with `hr.leave.` in front of it — a sentence this form can
    // already write. Nothing else that can fail has written anything for a person: a network drop,
    // a 500 or a gateway carry machine text, in English, so those get this module's own string.
    //
    // The test is the transport's `code`, never the sentence.
    const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
    const refused = failure.code === 'CONFLICT'
    const reasonCode = refused && typeof failure.data?.reason === 'string' ? failure.data.reason : null
    const code = reasonCode?.startsWith('hr.leave.') ? reasonCode.slice('hr.leave.'.length) : null
    const message = typeof failure.message === 'string' ? failure.message : ''
    const explained = code ? blockerText({ code, message }) : refused ? message : ''
    toast.error(explained || t('leave_request_error'))
    // A refusal is the server saying the preview on screen is not what it sees — most often
    // because the same days were booked from somewhere else, or a holiday moved into the range.
    // So re-read the preview and the balance it is measured against, exactly as a request that
    // landed does; without this every retry earns the same toast with no route to the truth. Both
    // sit under the `leave_balance` prefix, which is why one line reaches them.
    void queryClient.invalidateQueries({ queryKey: ['hr', 'leave_balance'] })
    void queryClient.invalidateQueries({ queryKey: ['hr', 'leave_request'] })
  },
  onSettled: () => {
    submitting = false
  },
}))

const submit = () => {
  if (submitting) return
  submitting = true
  create.mutate()
}

const canRequest = $derived(canHr('leaveRequest'))
const canSubmit = $derived(
  Boolean(leaveTypeId && startsOn && endsOn) && !blocked && canRequest && !simQuery.isFetching && !submitting,
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
    <!--
      The type list was never consulted here: a failed fetch left an empty dropdown and a dead
      submit with nothing said, and a workspace with no types at all looked identical to one whose
      network had dropped. Loading, then the list, then the failure, then the honest empty.
    -->
    {#if typesQuery.isLoading || !workspaceId}
      <div class="skel">
        <Skeleton width="48px" height="12px" />
        <Skeleton height="34px" />
      </div>
    {:else if types.length}
      <Field label={t('leave_type')} id="hr-leave-type" required>
        {#snippet children(id)}
          <Select {id} bind:value={leaveTypeId} options={typeOptions} />
        {/snippet}
      </Field>
    {:else if typesQuery.isError}
      <EmptyState compact icon="triangle-alert" title={t('leave_types_error')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void typesQuery.refetch()}>
            {t('retry')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <EmptyState
        compact
        icon="tree-palm"
        title={t('leave_types_none')}
        description={t('leave_types_none_desc')}
      >
        {#snippet actions()}
          {#if canHr('leaveManage')}
            <Button
              size="sm"
              variant="secondary"
              icon="settings"
              href={`/${workspaceSlug}/settings/hr/leave`}
            >
              {t('leave_types_manage')}
            </Button>
          {/if}
        {/snippet}
      </EmptyState>
    {/if}

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

    {#if simQuery.isLoading}
      <Skeleton width="70%" height="14px" />
    {:else if sim}
      {#if costLine}<p class="cost">{costLine}</p>{/if}
      {#if blockers.length}
        <div class="blocked" role="alert">
          <p class="lead">{t('leave_blocked')}</p>
          <ul>
            {#each blockers as blocker (blocker.code)}
              <li>{blockerText(blocker)}</li>
            {/each}
          </ul>
        </div>
      {/if}
    {:else if simQuery.isError}
      <div class="blocked" role="alert">
        <p class="lead">{t('leave_sim_error')}</p>
        <!-- A wrapper, so the button sizes to its label rather than stretching across the grid. -->
        <div>
          <Button size="sm" variant="secondary" onclick={() => void simQuery.refetch()}>{t('retry')}</Button>
        </div>
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <!--
      The URL reaches this form whether or not the person may use it — the Request time off button
      is gated, a pasted `?new=1` is not — so the submit says why it is dead rather than looking
      broken.
    -->
    {#if !canRequest}<span class="note">{t('leave_request_denied')}</span>{/if}
    <Button variant="ghost" onclick={close}>{t('common.cancel')}</Button>
    <Button onclick={submit} disabled={!canSubmit} loading={create.isPending}>
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
.skel {
  display: grid;
  gap: 6px;
}
.cost {
  margin: 0;
  font-size: 13px;
  color: var(--kern-ink-500);
}
/* 6.33:1 on the dialog surface in light, 5.04:1 in dark — this is 13px text, so it clears 4.5. */
.blocked {
  display: grid;
  gap: 6px;
  font-size: 13px;
  color: var(--kern-danger);
}
.lead {
  margin: 0;
  font-weight: 500;
}
.blocked ul {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
/* A colour, not opacity: opacity fades text against the dialog whatever token it names. */
.note {
  margin-inline-end: auto;
  align-self: center;
  font-size: 12px;
  color: var(--kern-ink-500);
}
</style>
