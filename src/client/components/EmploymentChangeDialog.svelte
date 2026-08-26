<script lang="ts">
import { Button, Dialog, Field, formatDate, Input, Select, toast } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
// The client barrel re-exports the models the screens have needed so far, and the employment *type*
// was not one of them. Straight from the contract rather than widening a barrel another lane shares.
import type { EmploymentType } from '../../contract/models.js'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Employment, OrgUnit, Position } from '../index.js'
import { canHr } from '../permissions.js'
import { hrKeys, isoDate } from '../query.js'
import { explainRefusal } from './refusal.js'

/**
 * Recording that somebody's job changed.
 *
 * `employment.change` never updates a row: it closes the open period and opens a new one from a
 * date. So this is not an edit form, and the difference matters twice over.
 *
 * **The date is the field.** `effectiveFrom` may be in the past on purpose — a promotion agreed in
 * March and entered in May has to say March, or every approval and balance computed against it
 * reads the wrong job. So the date leads the form, back-dating is offered rather than fought, and
 * the summary above the button says whose record moves and from when.
 *
 * **Nothing here can clear a field.** The server carries the open period's value forward wherever a
 * field arrives empty, which is what makes "change the manager and leave everything else" one
 * click — and it also means a "None" option would be a lie. So a control shows the current value
 * and offers others; emptying it is not on the menu.
 */
interface Props {
  open: boolean
  workspaceId: string
  personId: string
  personName: string
  /** The open period, or null when this person has no employment row yet. */
  current: Employment | null
  units: OrgUnit[]
  positions: Position[]
  onClose: () => void
}
const { open, workspaceId, personId, personName, current, units, positions, onClose }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

let effectiveFrom = $state(isoDate())
let orgUnitId = $state('')
let positionId = $state('')
let managerPersonId = $state('')
let employmentType = $state<EmploymentType>('full_time')
let fte = $state('')
let hours = $state('')
let reason = $state('')

/** Yesterday's half-filled change must not ride along on today's, so every open starts from the record. */
$effect(() => {
  if (!open) return
  effectiveFrom = isoDate()
  orgUnitId = current?.orgUnitId ?? ''
  positionId = current?.positionId ?? ''
  managerPersonId = current?.managerPersonId ?? ''
  employmentType = current?.employmentType ?? 'full_time'
  fte = current ? String(current.fte) : ''
  hours = current?.contractHoursWeek == null ? '' : String(current.contractHoursWeek)
  reason = ''
})

/**
 * Everybody who could be the manager, asked for only once the dialog is open.
 *
 * A panel that fetched the whole directory to draw one read-only line would pay for this list on
 * every person somebody clicked; here it is the price of a picker that is actually open.
 */
const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { limit: 200 }),
  enabled: open && Boolean(workspaceId),
  queryFn: () => api.people.list({ workspaceId, limit: 200 }),
}))
const people = $derived(peopleQuery.data?.items ?? [])

const typeOptions = [
  { value: 'full_time', label: t('employment_full_time') },
  { value: 'part_time', label: t('employment_part_time') },
  { value: 'contract', label: t('employment_contract') },
  { value: 'intern', label: t('employment_intern') },
  { value: 'temporary', label: t('employment_temporary') },
  { value: 'freelance', label: t('employment_freelance') },
]

const unitOptions = $derived(units.map((u) => ({ value: u.id, label: u.name })))
const positionOptions = $derived(positions.map((p) => ({ value: p.id, label: p.title })))
/** Nobody manages themselves, and offering it only earns a refusal from the database. */
const managerOptions = $derived(
  people.filter((p) => p.id !== personId).map((p) => ({ value: p.id, label: p.displayName })),
)

/**
 * A calendar date, read in the reader's language.
 *
 * The `T00:00:00` is not decoration: `new Date('2026-03-01')` is parsed as *UTC* midnight, so west
 * of Greenwich the panel would print the last day of February for a change dated the first of March.
 */
const dateLabel = (iso: string): string => formatDate(`${iso}T00:00:00`)

/**
 * The server refuses a date before the open period starts, and says so in a sentence.
 *
 * Saying it here as well is not belt and braces: it is the difference between a field that explains
 * itself while somebody types and a toast after they press the button.
 */
const tooEarly = $derived(Boolean(current && effectiveFrom && effectiveFrom < current.effectiveFrom))
const backdated = $derived(Boolean(effectiveFrom) && effectiveFrom < isoDate() && !tooEarly)

const dateError = $derived(
  tooEarly && current ? t('job_change_too_early', { date: dateLabel(current.effectiveFrom) }) : null,
)

const number = (value: string): number | undefined => {
  const parsed = Number(value)
  return value.trim() === '' || Number.isNaN(parsed) ? undefined : parsed
}

const fteValid = $derived(
  fte.trim() === '' || (number(fte) !== undefined && Number(fte) > 0 && Number(fte) <= 1),
)
const hoursValid = $derived(
  hours.trim() === '' || (number(hours) !== undefined && Number(hours) >= 0 && Number(hours) <= 168),
)

/**
 * `saving` rather than `change.isPending`: the disabled attribute only reaches the button on the
 * next render, so two quick clicks are one render apart — and here that is two periods opened on
 * the same date, which the database then has to refuse.
 */
let saving = $state(false)

const change = createMutation(() => ({
  mutationFn: () =>
    api.employment.change({
      workspaceId,
      personId,
      effectiveFrom,
      orgUnitId: orgUnitId || undefined,
      positionId: positionId || undefined,
      managerPersonId: managerPersonId || undefined,
      employmentType,
      fte: number(fte),
      contractHoursWeek: number(hours),
      reason: reason.trim() || null,
    }),
  onSuccess: () => {
    toast.success(t('job_changed', { name: personName }))
    // A job change moves the reporting line, the department and everything resolved from them —
    // the panel's own resolution row included — so the module's cache is dropped whole rather than
    // guessing which keys a new period touched.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
    onClose()
  },
  onError: (error) => toast.error(explainRefusal(error, t('job_change_error'))),
  onSettled: () => {
    saving = false
  },
}))

const submit = () => {
  if (saving) return
  saving = true
  change.mutate()
}

const canSubmit = $derived(
  Boolean(effectiveFrom) && !tooEarly && fteValid && hoursValid && canHr('employmentManage') && !saving,
)
</script>

<Dialog
  {open}
  title={t('job_change_title', { name: personName })}
  description={t('job_change_body')}
  onOpenChange={(next) => {
    if (!next) onClose()
  }}
>
  <div class="form">
    <Field
      label={t('job_effective_from')}
      hint={t('job_effective_hint')}
      error={dateError}
      id="hr-job-from"
      required
    >
      {#snippet children(id)}
        <Input {id} type="date" value={effectiveFrom} oninput={(e) => (effectiveFrom = e.currentTarget.value)} />
      {/snippet}
    </Field>

    <Field label={t('department')} id="hr-job-unit">
      {#snippet children(id)}
        <Select
          {id}
          value={orgUnitId}
          onValueChange={(v) => (orgUnitId = v)}
          options={unitOptions}
          placeholder={t('job_not_set')}
          ariaLabel={t('department')}
        />
      {/snippet}
    </Field>

    <Field label={t('job_position')} id="hr-job-position">
      {#snippet children(id)}
        <Select
          {id}
          value={positionId}
          onValueChange={(v) => (positionId = v)}
          options={positionOptions}
          placeholder={t('job_not_set')}
          ariaLabel={t('job_position')}
        />
      {/snippet}
    </Field>

    <Field label={t('manager')} id="hr-job-manager">
      {#snippet children(id)}
        <Select
          {id}
          value={managerPersonId}
          onValueChange={(v) => (managerPersonId = v)}
          options={managerOptions}
          placeholder={t('job_not_set')}
          ariaLabel={t('manager')}
        />
      {/snippet}
    </Field>

    <Field label={t('employment')} id="hr-job-type">
      {#snippet children(id)}
        <Select
          {id}
          value={employmentType}
          onValueChange={(v) => (employmentType = v as EmploymentType)}
          options={typeOptions}
          ariaLabel={t('employment')}
        />
      {/snippet}
    </Field>

    <div class="pair">
      <Field
        label={t('job_fte')}
        hint={t('job_fte_hint')}
        error={fteValid ? null : t('job_fte_invalid')}
        id="hr-job-fte"
      >
        {#snippet children(id)}
          <Input
            {id}
            type="number"
            min="0.05"
            max="1"
            step="0.05"
            value={fte}
            oninput={(e) => (fte = e.currentTarget.value)}
          />
        {/snippet}
      </Field>
      <Field
        label={t('job_hours')}
        error={hoursValid ? null : t('job_hours_invalid')}
        id="hr-job-hours"
      >
        {#snippet children(id)}
          <Input
            {id}
            type="number"
            min="0"
            max="168"
            step="0.5"
            value={hours}
            oninput={(e) => (hours = e.currentTarget.value)}
          />
        {/snippet}
      </Field>
    </div>

    <Field label={t('job_reason')} hint={t('job_reason_hint')} id="hr-job-reason">
      {#snippet children(id)}
        <Input {id} bind:value={reason} maxlength={200} />
      {/snippet}
    </Field>

    <!--
      The sentence somebody needs before they press the button: whose record moves, from when, and
      what happens to the period that is open now. "Are you sure?" says none of that, and this is an
      append-only record — the new period is undone by recording another change, never by an undo.
    -->
    <p class="summary">
      {t('job_change_summary', { name: personName, date: effectiveFrom ? dateLabel(effectiveFrom) : '—' })}
      {#if current}
        <span class="muted">
          {t('job_change_closes', { date: dateLabel(current.effectiveFrom) })}
        </span>
      {/if}
      {#if backdated}
        <span class="muted">{t('job_change_backdated')}</span>
      {/if}
    </p>
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={onClose} disabled={change.isPending}>{t('common.cancel')}</Button>
    <Button loading={change.isPending} disabled={!canSubmit} onclick={submit}>{t('job_change')}</Button>
  {/snippet}
</Dialog>

<style>
.form {
  display: grid;
  gap: 14px;
}
.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 14px;
}
.summary {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-raised);
  font-size: 13px;
  line-height: 1.5;
}
/* A colour, not opacity: opacity fades text against the dialog whatever token it names. */
.muted {
  display: block;
  color: var(--kern-ink-500);
  font-size: 12px;
}
</style>
