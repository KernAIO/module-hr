<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  formatDateTime,
  localTime,
  messageLocale,
  Skeleton,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { AttendanceDay, Punch, Regularization } from '../index.js'
import { canHr } from '../permissions.js'
import { formatDuration, isoDate } from '../query.js'
import RegularizationDialog from './RegularizationDialog.svelte'

/**
 * One day of the sheet, opened up.
 *
 * The person reading this is arguing with a number on their timesheet, so everything here either
 * helps them make that argument or helps them withdraw it: the punches the total was computed from,
 * the anomalies named rather than counted, the corrections they have already asked for, and the two
 * things somebody can actually do — void a wrong punch, or ask for one that is missing.
 *
 * **A void is a correcting row, not an edit.** The original keeps its place in the list, struck
 * through, and the reason travels with it. That is the whole reason attendance records punches the
 * way it does, and a list that quietly dropped the voided row would be claiming the opposite.
 */
interface Props {
  workspaceId: string
  day: AttendanceDay
  /**
   * The corrections this person has waiting, from the page's one query — filtered to this day here.
   * Its states travel with it, because a section that silently shows nothing when a fetch failed
   * tells somebody they have asked for nothing.
   */
  corrections: { items: Regularization[]; loading: boolean; failed: boolean; retry: () => void }
}
const { workspaceId, day, corrections }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

const canManage = $derived(canHr('attendanceManage'))
const canRequest = $derived(canHr('attendancePunch'))

/**
 * `includeVoided`, because a voided punch is the point.
 *
 * The confirmation below promises the original stays on the record; a list that then dropped it
 * would make that promise a lie the first time somebody used it.
 */
const punchesQuery = createQuery(() => ({
  // The same literal shape `hrKeys` builds — `['hr', entity, workspace, …scope]` — so the module's
  // blanket `['hr']` invalidation after a punch, a void or a correction reaches it.
  queryKey: ['hr', 'punches', workspaceId, 'me', day.businessDate] as const,
  enabled: Boolean(workspaceId),
  queryFn: () =>
    api.attendance.punches.list({
      workspaceId,
      from: day.businessDate,
      to: day.businessDate,
      includeVoided: true,
      limit: 100,
    }),
}))
const rows = $derived(punchesQuery.data?.items ?? [])

/**
 * A void writes a correcting row that points at *itself*, and the server's own note beside it says
 * it exists to carry the reason rather than to be counted as a punch. Drawn as one it would put a
 * second "Clocked in 09:00" directly under the one it voided, which reads as a duplicate punch —
 * so it is held back here and used for the reason it carries.
 */
const voidNotes = $derived(
  new Map(rows.filter((p) => p.voidedByPunchId === p.id).map((p) => [p.id, p.note] as const)),
)
const punches = $derived(rows.filter((p) => p.voidedByPunchId !== p.id))
const live = $derived(punches.filter((p) => p.voidedByPunchId === null))

/** No answer yet, or an answer that never arrived — the retained list is what decides, not the status. */
const loading = $derived(!workspaceId || punchesQuery.isLoading)

/**
 * The reason a void was given, out of the note the correcting row carries.
 *
 * The server writes `Voids <id>: <reason>`, so the id is peeled off to leave the sentence somebody
 * typed. A note that does not match is shown whole rather than guessed at — losing the reason
 * would take away the one thing a disputed punch is read for.
 */
const VOID_NOTE = /^Voids [0-9a-f-]{36}:\s*/i
const voidReason = (punch: Punch): string | null => {
  const note = punch.voidedByPunchId ? (voidNotes.get(punch.voidedByPunchId) ?? null) : null
  return note ? note.replace(VOID_NOTE, '') : null
}

const directionLabel = (direction: string) =>
  direction === 'in'
    ? t('att_punch_in')
    : direction === 'out'
      ? t('att_punch_out')
      : direction === 'break_start'
        ? t('att_punch_break_start')
        : t('att_punch_break_end')

const methodLabel = (method: string) =>
  method === 'web'
    ? t('att_method_web')
    : method === 'mobile'
      ? t('att_method_mobile')
      : method === 'kiosk'
        ? t('att_method_kiosk')
        : method === 'qr'
          ? t('att_method_qr')
          : method === 'device'
            ? t('att_method_device')
            : method === 'import'
              ? t('att_method_import')
              : t('att_method_manual')

/**
 * The time, with the date added only when it is not this day's.
 *
 * A night shift files its punches on the date it started, so the clock-out of a 22:00–06:00 shift
 * reads "06:00" on a row headed by the previous day — and a bare time there is the one number on
 * this panel somebody would misread.
 */
const timeLabel = (punch: Punch) =>
  isoDate(new Date(punch.at)) === day.businessDate ? localTime(new Date(punch.at)) : formatDateTime(punch.at)

const words = {
  hours: (n: string) => t('hours_short', { n }),
  minutes: (n: string) => t('minutes_short', { n }),
}

/**
 * How far the device's clock was out, when that is a fact worth stating.
 *
 * Under a minute is rounding, not disagreement, and "0 minutes out" beside a claimed punch reads
 * as an accusation of nothing.
 */
const skewLabel = (punch: Punch): string | null =>
  punch.skewMs !== null && Math.abs(punch.skewMs) >= 60_000
    ? t('att_punch_skew', {
        amount: formatDuration(Math.round(Math.abs(punch.skewMs) / 60_000), words, messageLocale()),
      })
    : null

/**
 * What an anomaly means, in words.
 *
 * Keyed by the code `computeDay` writes, never by its position in the array. A code with no string
 * yet falls back to the code itself: unlovely, and still more than the number that was here before.
 */
const ANOMALY_KEYS: Record<string, string> = {
  double_clock_in: 'hr.att_anomaly_double_clock_in',
  clock_out_without_in: 'hr.att_anomaly_clock_out_without_in',
  missing_clock_out: 'hr.att_anomaly_missing_clock_out',
  break_not_ended: 'hr.att_anomaly_break_not_ended',
  double_break_start: 'hr.att_anomaly_double_break_start',
  break_end_without_start: 'hr.att_anomaly_break_end_without_start',
  overtime_beyond_cap: 'hr.att_anomaly_overtime_beyond_cap',
}
const anomalyLabel = (code: string): string => {
  const key = ANOMALY_KEYS[code]
  // `t()` answers a key it has no string for with the key itself, so both ways of not having one —
  // a code nothing covers here, and a key whose string has not been merged yet — land on the code
  // rather than on `hr.att_anomaly_…` in front of a person.
  const text = key ? t(key) : undefined
  return text && text !== key ? text : code
}

/** This day's corrections, newest first — the server orders by date, and one day is one date. */
const dayCorrections = $derived(corrections.items.filter((r) => r.businessDate === day.businessDate))

/**
 * A closed month cannot move, so a correction to it would change nothing.
 *
 * `recomputeDay` leaves a locked day exactly where it is, which means voiding a punch on one writes
 * the correcting row and the totals above it stay as they were. Better to say so than to offer a
 * button whose effect is invisible.
 */
const frozen = $derived(day.locked)

/** The punch waiting on a confirmation, and what the last attempt said. */
let voiding = $state<Punch | null>(null)
let voidReasonText = $state('')
let voidInFlight = $state(false)
let voidError = $state<string | null>(null)

let requestOpen = $state(false)
let requestPunch = $state<Punch | null>(null)

/** Reset between punches: yesterday's reason must not ride along on today's void. */
$effect(() => {
  void voiding?.id
  voidReasonText = ''
})

/**
 * The void refusals this module has its own sentence for, keyed by the `reason` the router sends
 * beside the refusal — never by the sentence, because a list of sentences is a list somebody has to
 * keep in sync and the day it drifts the reader is told nothing.
 *
 * Empty on purpose: `voidPunch` refuses an already-voided punch through `KernError.conflict` with
 * no reason argument today, so its own sentence is the only thing that says which punch and why.
 * That is the fallback below doing its job, and a reason added to the server later reaches a reader
 * here the moment somebody writes its string.
 */
const voidRefusalMessages: Record<string, string> = {}

function voidFailure(error: unknown): string {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (failure.code !== 'CONFLICT') return t('att_void_error')
  const reason = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason ? voidRefusalMessages[reason] : undefined
  const translated = key ? t(key) : undefined
  return (translated && translated !== key ? translated : failure.message) || t('att_void_error')
}

const voidPunch = createMutation(() => ({
  mutationFn: (input: { punchId: string; reason: string }) =>
    api.attendance.punches.void({ workspaceId, punchId: input.punchId, reason: input.reason }),
  onSuccess: () => {
    voiding = null
    voidError = null
    toast.success(t('att_void_done'))
    // A void rewrites the day sheet, the totals above it and this list, so the whole module's cache
    // is re-read rather than guessing which keys moved.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error) => {
    voidError = voidFailure(error)
    // A refusal is the server saying its picture of this day is not the one on screen — most often
    // because the punch was already voided from somewhere else. Re-read exactly as a void that
    // landed does; without this the same dead row sits in the list and every retry earns the same
    // sentence.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onSettled: () => {
    voidInFlight = false
  },
}))

/**
 * `voidInFlight` rather than `voidPunch.isPending`: the disabled attribute only reaches the button
 * on the next render, so two quick clicks both fire — and the second arrives at a punch the first
 * has already voided, which the server answers with a refusal the person did nothing to deserve.
 */
const confirmVoid = () => {
  if (!voiding || voidInFlight || !voidReasonText.trim()) return
  voidInFlight = true
  voidError = null
  voidPunch.mutate({ punchId: voiding.id, reason: voidReasonText.trim() })
}

const closeVoid = () => {
  if (voidInFlight) return
  voiding = null
  voidError = null
}

const openRequest = (punch: Punch | null) => {
  requestPunch = punch
  requestOpen = true
}
</script>

<div class="detail">
  {#if day.anomalies.length}
    <!--
      The count that used to be here said a number and no noun. These are the sentences behind it,
      and they are the reason the day needs a person at all.
    -->
    <section class="block anomalies" aria-label={t('att_anomalies')}>
      <h3>{t('att_anomalies')}</h3>
      <!--
        Keyed by position, not by the code: `computeDay` pushes one entry per occurrence, so a day
        with two unmatched clock-ins carries `double_clock_in` twice — and a keyed `{#each}` with a
        repeated key throws at render rather than drawing the second one.
      -->
      <ul class="plain">
        {#each day.anomalies as code, index (index)}
          <li>{anomalyLabel(code)}</li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="block" aria-label={t('att_punches')}>
    <h3>{t('att_punches')}</h3>

    {#if loading}
      <div class="skel">
        {#each [1, 2] as n (n)}<Skeleton height="34px" />{/each}
      </div>
    {:else if punches.length}
      <!--
        The punches a person already has outrank the failure: everything here is invalidated by a
        punch, a void and a decision, so a refetch failing while the last good list is still in
        `data` is the ordinary case. An error branch above this one would blank the day somebody
        opened it to read.
      -->
      {#if punchesQuery.isError}
        <p class="stale" role="status">
          <span>{t('att_punches_stale')}</span>
          <Button size="sm" variant="ghost" onclick={() => void punchesQuery.refetch()}>{t('retry')}</Button>
        </p>
      {/if}
      <ul class="plain punches">
        {#each punches as punch (punch.id)}
          {@const voided = punch.voidedByPunchId !== null}
          {@const reason = voidReason(punch)}
          {@const skew = skewLabel(punch)}
          <li class="punch" class:voided>
            <div class="line">
              <span class="dir">{directionLabel(punch.direction)}</span>
              <span class="time">{timeLabel(punch)}</span>
              <Badge tone="grey">{methodLabel(punch.method)}</Badge>
              {#if punch.trust === 'disputed'}
                <Badge tone="declined">{t('att_trust_disputed')}</Badge>
              {:else if punch.trust === 'claimed'}
                <Badge tone="warning">{t('att_trust_claimed')}</Badge>
              {/if}
              {#if voided}<Badge tone="grey">{t('att_punch_voided')}</Badge>{/if}
              <span class="spacer"></span>
              {#if canManage && !voided}
                <!--
                  Hidden from somebody who may never void, disabled with the reason stated below
                  when the month is closed — a control that does nothing and does not say why is
                  the defect this screen was opened to fix.
                -->
                <Button size="sm" variant="ghost" disabled={frozen} onclick={() => (voiding = punch)}>
                  {t('att_void')}
                </Button>
              {/if}
              {#if canRequest && !voided}
                <Button size="sm" variant="ghost" disabled={frozen} onclick={() => openRequest(punch)}>
                  {t('att_correct_this')}
                </Button>
              {/if}
            </div>
            <!--
              The honest state of an offline punch, and what a void did — both under the row they
              belong to rather than in a tooltip nobody opens.
            -->
            {#if punch.trust !== 'trusted' && skew}
              <p class="sub warn">{skew}</p>
            {/if}
            {#if voided && reason}
              <p class="sub">{t('att_punch_void_reason', { reason })}</p>
            {/if}
          </li>
        {/each}
      </ul>
      {#if frozen}
        <p class="sub note">{t('att_locked_no_change')}</p>
      {/if}
    {:else if punchesQuery.isError}
      <EmptyState compact icon="triangle-alert" title={t('att_punches_error')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void punchesQuery.refetch()}>
            {t('retry')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <!--
        Nothing recorded is the commonest reason somebody opens a day: they worked it and the clock
        has no idea. So the empty state offers the thing that fills it, and only promises it to
        somebody who may actually ask.
      -->
      <EmptyState
        compact
        icon="timer"
        title={t('att_punches_none')}
        description={canRequest ? t('att_punches_none_desc') : undefined}
      >
        {#snippet actions()}
          {#if canRequest}
            <Button size="sm" variant="secondary" disabled={frozen} onclick={() => openRequest(null)}>
              {t('att_correction_request')}
            </Button>
          {/if}
        {/snippet}
      </EmptyState>
      {#if frozen && canRequest}
        <p class="sub note">{t('att_locked_no_change')}</p>
      {/if}
    {/if}
  </section>

  {#if corrections.loading}
    <div class="skel"><Skeleton height="34px" /></div>
  {:else if dayCorrections.length}
    <section class="block" aria-label={t('att_corrections_pending')}>
      <h3>{t('att_corrections_pending')}</h3>
      <ul class="plain">
        {#each dayCorrections as correction (correction.id)}
          <li class="correction">
            <div class="line">
              <span class="proposal">
                {correction.proposed
                  .map((p) => `${directionLabel(p.direction)} ${localTime(new Date(p.at))}`)
                  .join(' · ')}
              </span>
              <Badge tone="upcoming">{t('att_correction_waiting')}</Badge>
            </div>
            <p class="sub">{correction.reason}</p>
          </li>
        {/each}
      </ul>
    </section>
  {:else if corrections.failed}
    <!--
      A failed list of corrections must not read as "you have asked for nothing" — that is exactly
      the sentence somebody would act on by asking a second time.
    -->
    <p class="stale" role="status">
      <span>{t('att_corrections_error')}</span>
      <Button size="sm" variant="ghost" onclick={corrections.retry}>{t('retry')}</Button>
    </p>
  {/if}

  {#if canRequest && punches.length > 0}
    <div class="foot">
      <Button size="sm" variant="secondary" icon="square-pen" disabled={frozen} onclick={() => openRequest(null)}>
        {t('att_correction_request')}
      </Button>
    </div>
  {/if}
</div>

<!--
  Voiding is not deleting, and the person pressing it has to know that before it happens rather than
  after: the record keeps the punch and gains a row saying who struck it out and why. Somebody who
  believes they erased a punch will type a different reason from somebody who knows the sentence is
  permanent.
-->
<Dialog
  open={voiding !== null}
  size="sm"
  title={t('att_void_title')}
  onOpenChange={(next) => {
    if (!next) closeVoid()
  }}
>
  {#if voiding}
    <p class="body">
      {t('att_void_body', { punch: directionLabel(voiding.direction), time: timeLabel(voiding) })}
    </p>
    <p class="body note">{t('att_void_kept')}</p>
  {/if}

  <Field label={t('att_void_reason_label')} hint={t('att_void_reason_hint')} required>
    {#snippet children(fieldId)}
      <Textarea id={fieldId} bind:value={voidReasonText} rows={3} />
    {/snippet}
  </Field>

  {#if voidError}
    <p class="body failed" role="alert">{voidError}</p>
  {/if}

  {#snippet footer()}
    <!-- Says why the danger button is dead, rather than leaving somebody to guess at it. -->
    {#if !voidReasonText.trim()}<span class="hint">{t('att_void_reason_missing')}</span>{/if}
    <!--
      Secondary, as in `DecisionDialog`: on a destructive confirmation the way out must not be the
      faintest control on it.
    -->
    <Button variant="secondary" onclick={closeVoid} disabled={voidInFlight}>{t('att_void_keep')}</Button>
    <Button
      variant="danger"
      loading={voidInFlight}
      disabled={!voidReasonText.trim()}
      onclick={confirmVoid}
    >
      {t('att_void')}
    </Button>
  {/snippet}
</Dialog>

<RegularizationDialog
  open={requestOpen}
  {workspaceId}
  businessDate={day.businessDate}
  punch={requestPunch}
  punches={live}
  onClose={() => {
    requestOpen = false
    requestPunch = null
  }}
/>

<style>
.detail {
  display: grid;
  gap: 16px;
  margin-block: 4px 12px;
  margin-inline-start: 12px;
  padding: 14px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface);
}
.block {
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
.plain {
  display: grid;
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.skel {
  display: grid;
  gap: 6px;
}
/*
 * The warning ink is 4.58:1 on its own tint in light and 5.28:1 in dark, and the tint is what makes
 * the block read as a notice rather than as another list.
 */
.anomalies ul {
  padding: 8px 12px;
  border-radius: var(--kern-r-md);
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
  font-size: 12.5px;
  line-height: 1.5;
}
.punches {
  gap: 2px;
}
.punch,
.correction {
  display: grid;
  gap: 2px;
  padding-block: 6px;
  border-block-end: 1px solid var(--kern-border-hairline);
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
.dir {
  font-size: 13px;
  font-weight: 500;
}
.time {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--kern-ink-700);
}
.proposal {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
/*
 * A voided punch is struck through and *still legible*: `opacity` would fade its text against the
 * panel whatever token it names, and this row is the evidence that nothing was deleted.
 */
.voided .dir,
.voided .time {
  color: var(--kern-ink-500);
  text-decoration: line-through;
}
.sub {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--kern-ink-500);
}
/* 5.23:1 on --kern-surface in light, 6.80:1 in dark — 12px text has to clear 4.5. */
.warn {
  color: var(--kern-warning);
}
.note {
  margin-block-start: 2px;
}
.stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding-block: 6px;
  padding-inline: 12px 8px;
  border-radius: var(--kern-r-md);
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
  font-size: 12.5px;
}
.foot {
  display: flex;
}
.body {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kern-ink-700);
}
/* A colour, not opacity: opacity fades the text against the dialog whatever token it names. */
.body.note {
  margin-block: 8px 12px;
  color: var(--kern-ink-500);
}
/* A dialog body sits on --kern-surface-raised, not the page: 6.33:1 there in light, 5.04:1 in dark. */
.failed {
  margin-block-start: 8px;
  color: var(--kern-danger);
}
.hint {
  margin-inline-end: auto;
  align-self: center;
  font-size: 12px;
  color: var(--kern-ink-500);
}
</style>
