<script lang="ts">
import { Badge, Button, Dialog, Field, IconButton, Input, Select, Textarea, toast } from '@kernhq/ui'
import { createMutation, useQueryClient } from '@tanstack/svelte-query'
// The client barrel re-exports the models screens have needed so far, and a punch *direction* was
// not one of them. Straight from the contract rather than widening a barrel other screens share.
import type { PunchDirection } from '../../contract/attendance.js'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Punch } from '../index.js'
import { canHr } from '../permissions.js'

/**
 * Ask for a day to be recorded the way it actually happened.
 *
 * This writes nothing. It raises a request through the same approval engine leave uses, and only an
 * approval turns the lines below into punches — voiding what they replace, keeping the originals.
 * So the dialog is written as a *proposal*: these are the punches you say belong on this day, and
 * this is why.
 *
 * The times are read from the device's clock, which is stated on the form rather than assumed. The
 * one place that would silently go wrong is a night shift — 22:00 followed by 06:00 — so a line
 * whose time runs backwards past the one above it moves to the next day and says so on the row.
 */
interface Props {
  open: boolean
  workspaceId: string
  businessDate: string
  /**
   * The punch this correction replaces, when it was raised from one. Approving the request voids
   * it, which is why the id travels with the proposal rather than being applied here.
   */
  punch: Punch | null
  /** The day's live punches, so correcting a whole day starts from what is already recorded. */
  punches: Punch[]
  onClose: () => void
}
const { open, workspaceId, businessDate, punch, punches, onClose }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

type Line = { key: string; direction: PunchDirection; time: string }

const DIRECTIONS: PunchDirection[] = ['in', 'out', 'break_start', 'break_end']

const directionLabel = (direction: PunchDirection) =>
  direction === 'in'
    ? t('att_punch_in')
    : direction === 'out'
      ? t('att_punch_out')
      : direction === 'break_start'
        ? t('att_punch_break_start')
        : t('att_punch_break_end')

const directionOptions = $derived(DIRECTIONS.map((d) => ({ value: d, label: directionLabel(d) })))

/** `HH:mm` in the device's zone — a value for `<input type="time">`, not a string anybody reads. */
const clockValue = (iso: string): string => {
  const at = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

let nextKey = 0
const line = (direction: PunchDirection, time = ''): Line => ({
  key: `l${nextKey++}`,
  direction,
  time,
})

let lines = $state<Line[]>([])
let reason = $state('')
let submitting = $state(false)
let failure = $state<string | null>(null)

/**
 * What the form starts as, seeded once per opening.
 *
 * Correcting one punch starts from that punch. Correcting a day starts from what the day already
 * has, because a correction is nearly always "these two are right and the third is missing" — and
 * retyping the two that were right is how a correction acquires a new mistake. A day with nothing
 * on it starts as an empty in and out: the shape of a working day, with no hours invented.
 *
 * `seeded` is what keeps it to once. `punches` comes from a query the panel behind this dialog
 * keeps re-reading — every punch, void and decision invalidates it — so an effect that simply
 * depended on it would rebuild the lines and blank the reason underneath somebody who was still
 * typing, at a moment set by the network rather than by anything they did.
 */
let seeded: string | null = null
$effect(() => {
  if (!open) {
    seeded = null
    return
  }
  const opening = punch?.id ?? 'day'
  if (seeded === opening) return
  seeded = opening
  nextKey = 0
  lines = punch
    ? [line(punch.direction, clockValue(punch.at))]
    : punches.length
      ? punches.map((p) => line(p.direction, clockValue(p.at)))
      : [line('in'), line('out')]
  reason = ''
  failure = null
})

const addLine = () => {
  lines = [...lines, line('out')]
}
const removeLine = (key: string) => {
  lines = lines.filter((l) => l.key !== key)
}

/**
 * The lines as instants.
 *
 * A time that runs backwards past the one above it belongs to the next calendar day: a shift from
 * 22:00 to 06:00 is filed on the date it *started*, so building both on `businessDate` would put
 * the clock-out sixteen hours before the clock-in and hand the approver a day that computes to
 * nothing. The rows say when this happened, so nobody has to infer it from a badge they cannot see.
 */
const proposed = $derived.by(() => {
  let dayOffset = 0
  let previous: string | null = null
  return lines.map((l) => {
    if (previous !== null && l.time && l.time < previous) dayOffset += 1
    if (l.time) previous = l.time
    const at = l.time ? new Date(`${businessDate}T${l.time}:00`) : null
    if (at && dayOffset) at.setDate(at.getDate() + dayOffset)
    return {
      key: l.key,
      direction: l.direction,
      at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
      rolled: dayOffset > 0,
    }
  })
})

const canRequest = $derived(canHr('attendancePunch'))
const timesMissing = $derived(proposed.some((p) => p.at === null))
const reasonMissing = $derived(reason.trim().length === 0)
const blocker = $derived(
  !canRequest
    ? t('att_correction_denied')
    : timesMissing
      ? t('att_correction_needs_time')
      : reasonMissing
        ? t('att_correction_needs_reason')
        : null,
)

const create = createMutation(() => ({
  mutationFn: () =>
    api.attendance.regularizations.request({
      workspaceId,
      businessDate,
      punchId: punch?.id ?? null,
      proposed: proposed.map((p) => ({ direction: p.direction, at: p.at as string })),
      reason: reason.trim(),
    }),
  onSuccess: () => {
    toast.success(t('att_correction_sent'))
    // A correction that auto-approves — a workspace with no chain, where the request is settled as
    // it is raised — writes punches and recomputes the day, so the whole module's cache is re-read
    // rather than guessing which keys moved.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
    onClose()
  },
  onError: (error) => {
    // The router refuses through `KernError`, whose reason reaches the client as `data.reason` and
    // whose sentence is the only thing written for a reader. Nothing else that can fail here has
    // written anything for a person: a network drop, a 500 or a gateway carry machine text, in
    // English, so those get this module's own string. The test is the transport's `code`, never
    // the sentence.
    const refused = error as { code?: unknown; message?: string }
    failure = (refused.code === 'CONFLICT' ? refused.message : undefined) || t('att_correction_error')
  },
  onSettled: () => {
    submitting = false
  },
}))

/**
 * `submitting` rather than `create.isPending`: the disabled attribute only reaches the button on
 * the next render, so two quick clicks both fire and the approver is handed the same correction
 * twice.
 */
const submit = () => {
  if (submitting || blocker) return
  submitting = true
  failure = null
  create.mutate()
}

const close = () => {
  if (submitting) return
  onClose()
}
</script>

<Dialog
  {open}
  title={t('att_correction_title')}
  description={t('att_correction_desc')}
  onOpenChange={(next) => {
    if (!next) close()
  }}
>
  <div class="form">
    {#if punch}
      <!--
        Raised from one punch: approving it voids that punch and writes what is below in its place,
        and somebody who does not know that will type a line that duplicates it.
      -->
      <p class="lead">
        {t('att_correction_for_punch', {
          punch: directionLabel(punch.direction),
          time: clockValue(punch.at),
        })}
      </p>
    {/if}

    <div class="lines">
      <h3>{t('att_correction_punches')}</h3>
      {#each lines as l, index (l.key)}
        <div class="line">
          <Select
            value={l.direction}
            options={directionOptions}
            size="sm"
            ariaLabel={t('att_correction_direction')}
            onValueChange={(v) => {
              l.direction = v as PunchDirection
            }}
          />
          <Input type="time" size="sm" bind:value={l.time} aria-label={t('att_correction_time')} />
          {#if proposed[index]?.rolled}
            <Badge tone="info">{t('att_correction_next_day')}</Badge>
          {/if}
          <span class="spacer"></span>
          <!--
            One line is the minimum the contract accepts, so the last remove says why it is dead
            rather than looking broken — and an icon button without a label is "button" to a screen
            reader.
          -->
          <IconButton
            icon="trash-2"
            size={26}
            variant="ghost"
            label={t('att_correction_remove')}
            disabled={lines.length < 2}
            title={lines.length < 2 ? t('att_correction_needs_one') : undefined}
            onclick={() => removeLine(l.key)}
          />
        </div>
      {/each}
      <div>
        <Button size="sm" variant="ghost" icon="plus" onclick={addLine}>{t('att_correction_add')}</Button>
      </div>
      <p class="hint">{t('att_correction_zone_hint')}</p>
    </div>

    <Field label={t('att_correction_reason')} hint={t('att_correction_reason_hint')} required>
      {#snippet children(fieldId)}
        <Textarea id={fieldId} bind:value={reason} rows={3} />
      {/snippet}
    </Field>

    {#if failure}
      <p class="failed" role="alert">{failure}</p>
    {/if}
  </div>

  {#snippet footer()}
    <!-- Whatever is stopping the submit, said out loud. A dead button with no reason is a bug. -->
    {#if blocker}<span class="note">{blocker}</span>{/if}
    <Button variant="ghost" onclick={close} disabled={submitting}>{t('cancel')}</Button>
    <Button onclick={submit} disabled={Boolean(blocker) || submitting} loading={submitting}>
      {t('att_correction_submit')}
    </Button>
  {/snippet}
</Dialog>

<style>
.form {
  display: grid;
  gap: 14px;
}
.lead {
  margin: 0;
  font-size: 13px;
  color: var(--kern-ink-700);
}
.lines {
  display: grid;
  gap: 8px;
}
h3 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.spacer {
  flex: 1;
}
/* A colour, not opacity: opacity fades text against the dialog whatever token it names. */
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-500);
}
/* 6.33:1 on the dialog surface in light, 5.04:1 in dark — 13px text has to clear 4.5. */
.failed {
  margin: 0;
  font-size: 13px;
  color: var(--kern-danger);
}
.note {
  margin-inline-end: auto;
  align-self: center;
  font-size: 12px;
  color: var(--kern-ink-500);
}
</style>
