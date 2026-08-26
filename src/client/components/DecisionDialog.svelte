<script lang="ts">
import { Button, Dialog, Field, Textarea } from '@kernhq/ui'
import { t } from '../i18n.js'
import type { ApprovalRequest } from '../index.js'
import { summarise } from '../summary.js'

/**
 * Confirming a decision, stating what it does and to whom.
 *
 * Approving leave moves somebody's balance and puts them on the team calendar; rejecting it sends
 * them a notification and changes nothing else. "Are you sure?" says none of that, so the body text
 * is chosen per subject type and per position in the chain — a middle step passes the request on
 * rather than settling it, and an approver who thinks they just granted the leave is a support call.
 */
interface Props {
  request: ApprovalRequest | null
  decision: 'approve' | 'reject'
  pending: boolean
  error: string | null
  onConfirm: (comment: string) => void
  onCancel: () => void
}
const { request, decision, pending, error, onConfirm, onCancel }: Props = $props()

let comment = $state('')

/** Reset between requests: yesterday's note must not ride along on today's decision. */
$effect(() => {
  void request?.id
  comment = ''
})

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
      onclick={() => onConfirm(comment)}
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
</style>
