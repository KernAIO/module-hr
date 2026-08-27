<script lang="ts">
import { Button, Dialog, Field, Select, Textarea } from '@kernhq/ui'
import { untrack } from 'svelte'
import { t } from '../i18n.js'
import type { ApprovalRequest } from '../index.js'
import { summarise } from '../summary.js'

/**
 * Confirming a decision, stating what it does, to whom — and in whose name.
 *
 * Approving leave moves somebody's balance and puts them on the team calendar; rejecting it sends
 * them a notification and changes nothing else. "Are you sure?" says none of that, so the body text
 * is chosen per subject type and per position in the chain — a middle step passes the request on
 * rather than settling it, and an approver who thinks they just granted the leave is a support call.
 *
 * `identities` is who the reader may file this decision as: themselves (`onBehalfOfId: null`), or
 * somebody who delegated their approvals to them. The rule this dialog exists to keep is that a
 * decision is never filed against a person nobody named — so with one identity it is stated, with
 * several it is chosen, and with none confirmed the confirm button does nothing.
 */
interface Props {
  request: ApprovalRequest | null
  decision: 'approve' | 'reject'
  /**
   * Recomputed by the caller as names and delegations arrive, so it may change while the dialog is
   * open. Omitting it means the reader decides as themselves and nothing else is possible — which
   * is what a surface with no delegation in it, like the directory panel or the dashboard widget,
   * is saying.
   */
  identities?: Array<{ onBehalfOfId: string | null; label: string }>
  pending: boolean
  error: string | null
  onConfirm: (comment: string, onBehalfOfId: string | null) => void
  onCancel: () => void
}
const { request, decision, identities, pending, error, onConfirm, onCancel }: Props = $props()

/**
 * One identity by default, and it is the reader's own.
 *
 * A `$derived` rather than a destructuring fallback: a fallback is re-evaluated on every read, so a
 * fresh array and a fresh `t()` call would land in the middle of the equality checks below.
 */
const options = $derived(identities ?? [{ onBehalfOfId: null, label: t('approvals_as_self') }])

let comment = $state('')
/** '' until chosen, 'self' for the reader's own decision, otherwise the person id being acted for. */
let actingAs = $state('')

/** A `Select` needs a string, and `null` is a real identity here rather than the absence of one. */
const keyOf = (identity: { onBehalfOfId: string | null }) => identity.onBehalfOfId ?? 'self'

/**
 * Reset between requests: yesterday's note must not ride along on today's decision, and neither
 * must the name it was filed against.
 *
 * Only `request?.id` is tracked. `identities` changes whenever a name or a delegation arrives, and
 * an effect that read it would wipe a half-typed comment under the reader's hands.
 */
$effect(() => {
  void request?.id
  untrack(() => {
    comment = ''
    // Preselected only where it cannot be a guess: the reader's own name. Which colleague they
    // meant is the one thing this dialog must never assume.
    actingAs = options.some((i) => i.onBehalfOfId === null) ? 'self' : ''
  })
})

/**
 * The identity this click would file under, or null while it is still an open question.
 *
 * A single identity needs no selection — including one that arrives after the dialog opened, which
 * is why this is derived from `identities` rather than from what was preselected.
 */
const chosen = $derived.by(() => {
  if (options.length === 1) return options[0]!
  return options.find((i) => keyOf(i) === actingAs) ?? null
})
const onBehalf = $derived(chosen?.onBehalfOfId ? chosen : null)

const confirm = () => {
  // Guarded rather than trusted to the disabled attribute: an unnamed identity must not become a
  // decision filed as the caller, which is the failure this whole dialog is arranged against.
  if (!chosen || pending) return
  onConfirm(comment, chosen.onBehalfOfId)
}

const isLastStep = $derived(request ? request.currentStep >= Math.max(request.steps.length - 1, 0) : true)

const body = $derived.by(() => {
  if (!request) return ''
  if (decision === 'reject') return t('reject_confirm_body')
  if (!isLastStep) return t('approve_confirm_next')
  return request.subjectType === 'leave' ? t('approve_confirm_leave') : t('approve_confirm_attendance')
})

const title = $derived(decision === 'approve' ? t('approve_confirm_title') : t('reject_confirm_title'))
</script>

<Dialog
  open={Boolean(request)}
  size="sm"
  {title}
  description={body}
  onOpenChange={(o) => {
    if (!o) onCancel()
  }}
>
  {#if request}
    <p class="who">
      {request.requesterName ?? '—'}{#if request.summaryParams || request.summary}<span class="what"
          >&nbsp;— {summarise(request)}</span
        >{/if}
    </p>
  {/if}

  <!--
    The choice comes before the comment, because it changes what the comment is attached to. It is
    only rendered where there is something to choose — one identity is stated below, not offered.
  -->
  {#if options.length > 1}
    <Field label={t('approvals_decide_as')} hint={t('approvals_decide_as_hint')} required>
      {#snippet children(id)}
        <Select
          {id}
          bind:value={actingAs}
          placeholder={t('approvals_decide_as_pick')}
          options={options.map((i) => ({ value: keyOf(i), label: i.label }))}
        />
      {/snippet}
    </Field>
  {/if}

  {#if onBehalf}
    <p class="behalf">{t('approvals_behalf_notice', { name: onBehalf.label })}</p>
  {/if}

  <Field label={t('approval_comment')} hint={t('approval_comment_hint')} error={error}>
    {#snippet children(id)}
      <Textarea {id} bind:value={comment} rows={3} />
    {/snippet}
  </Field>

  {#snippet footer()}
    <Button variant="secondary" onclick={onCancel} disabled={pending}>{t('cancel')}</Button>
    <Button
      variant={decision === 'reject' ? 'danger' : 'primary'}
      loading={pending}
      disabled={!chosen}
      onclick={confirm}
    >
      {decision === 'approve' ? t('approve') : t('reject')}
    </Button>
  {/snippet}
</Dialog>

<style>
.who {
  margin: 0 0 12px;
  font-size: 13.5px;
  font-weight: 500;
}
.what {
  font-weight: 400;
  color: var(--kern-ink-500);
}
/*
  Tinted rather than muted. This is the sentence that says the decision will carry somebody else's
  name, so it has to be the thing the eye lands on before the confirm button — and `--kern-ink-700`
  on `--kern-info-tint` is a pair that holds its contrast in both themes.
*/
.behalf {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: var(--kern-r-md2);
  background: var(--kern-info-tint);
  color: var(--kern-ink-700);
  font-size: 12.5px;
  line-height: 1.5;
}
</style>
