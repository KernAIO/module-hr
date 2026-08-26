<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  formatDate,
  Input,
  messageLocale,
  SegmentedControl,
  Sheet,
  Skeleton,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
// `LedgerKind` is not one of the models the client barrel re-exports, and widening a barrel every
// screen shares to name one union is the wrong direction. Straight from the contract.
import type { LedgerKind } from '../../contract/leave.js'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { LeaveBalance, LeaveLedgerEntry } from '../index.js'
import { canHr } from '../permissions.js'
import { formatDays, hrKeys, isoDate } from '../query.js'

/**
 * How a balance adds up — and the one place it can be changed by hand.
 *
 * The ledger is append-only, and that is the whole point of showing it: a cancelled booking is a
 * **reversal beside the consumption it reverses**, not a gap where a row used to be. So a row that
 * has been undone is marked rather than removed, and the row that undid it says which one it was.
 * Somebody reconciling reads down the running balance; somebody arguing about a number reads the
 * reason column.
 *
 * The running balance is anchored at the *top*, not built up from zero at the bottom. The server
 * returns the newest entries first and caps the page, so counting up from the oldest row on screen
 * would be counting up from an arbitrary point in the year and every figure would be wrong by
 * whatever was cut off. Anchored at the balance the server already computed for this year, each row
 * shows what the balance was immediately after it — which stays true however much is missing below.
 *
 * No `hasCapability` check here: the ledger lives behind `leave`, exactly the capability the route
 * carrying this page already declares. A second check would be the only one of its kind in this
 * module and would say nothing new.
 */
interface Props {
  /** The tile that was opened. `null` closes the panel — and keeps it live: it is the parent's own
   *  query row, so an adjustment moves the figure at the top of this panel without a second fetch. */
  balance: LeaveBalance | null
  workspaceId: string
  /** Whose balance this is. Named in the confirmation, because an adjustment is done *to* somebody. */
  personName: string
  onClose: () => void
}
const { balance, workspaceId, personName, onClose }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

const open = $derived(balance !== null)
const personId = $derived(balance?.personId ?? '')
const leaveTypeId = $derived(balance?.leaveTypeId ?? '')
const periodYear = $derived(balance?.periodYear ?? new Date().getFullYear())
const typeName = $derived(balance?.leaveTypeName ?? '')
/** Half-days are still counted in days; only an hourly type is read in hours. */
const hourly = $derived(balance?.unit === 'hour')
const minutesPerUnit = $derived(hourly ? 60 : 8 * 60)

/**
 * The cap the contract allows, asked for in full.
 *
 * `leave.ledger.list` answers `nextCursor: null` whatever it returns, so there is no second page to
 * fetch: a year longer than this is truncated, and the note under the table says so rather than
 * letting somebody reconcile against a list that quietly stops.
 */
const LIMIT = 200

const ledgerQuery = createQuery(() => ({
  queryKey: hrKeys.leaveLedger(workspaceId, personId, leaveTypeId, periodYear),
  enabled: open && Boolean(workspaceId) && Boolean(personId),
  queryFn: () => api.leave.ledger.list({ workspaceId, personId, leaveTypeId, periodYear, limit: LIMIT }),
}))
const entries = $derived(ledgerQuery.data?.items ?? [])

/**
 * A disabled query is `pending` and not fetching, so a closed panel is not "loading" — without the
 * `open` test the first frame after every close would draw skeletons behind the closing animation.
 */
const loading = $derived(open && ledgerQuery.isLoading)
const empty = $derived(open && !loading && entries.length === 0 && !ledgerQuery.isError)

/**
 * A failed refetch that still has an answer to show. Every adjustment and every decision invalidates
 * the whole module, so a refetch failing while the last good list is still in `data` is the ordinary
 * case — an error branch above the data would blank a table somebody is reading numbers off.
 */
const stale = $derived(ledgerQuery.isError && entries.length > 0)

type LedgerRow = {
  entry: LeaveLedgerEntry
  /** The balance immediately after this entry. */
  afterMinutes: number
  /** The entry this one undoes, when it is on screen. */
  reverses: LeaveLedgerEntry | null
  /** Whether a later entry undid this one. */
  reversed: boolean
}

const rows = $derived.by<LedgerRow[]>(() => {
  const items = entries
  const byId = new Map(items.map((e) => [e.id, e]))
  const reversedIds = new Set(items.map((e) => e.reversesEntryId).filter((id): id is string => id !== null))
  let running = balance?.balanceMinutes ?? 0
  return items.map((entry) => {
    const afterMinutes = running
    running -= entry.amountMinutes
    return {
      entry,
      afterMinutes,
      reverses: entry.reversesEntryId ? (byId.get(entry.reversesEntryId) ?? null) : null,
      reversed: reversedIds.has(entry.id),
    }
  })
})

/** The same arithmetic the server does on the way out, so the two never disagree by a rounding step. */
const inUnit = (minutes: number) =>
  hourly ? Math.round((minutes / 60) * 10) / 10 : Math.round((minutes / (60 * 8)) * 100) / 100

/**
 * `signDisplay: 'always'` rather than a '+' glued in front of a formatted number: a ledger is read
 * for its signs, and which glyph a sign is — and which side of the digits it goes — belongs to the
 * locale. The interface language is passed explicitly for the same reason every formatter in
 * `@kernhq/ui` takes it: the browser's own language is not the one this screen is written in.
 */
const signedNumber = $derived(
  new Intl.NumberFormat(messageLocale(), { signDisplay: 'always', maximumFractionDigits: 2 }),
)
/** A year, in the reader's digits — `formatCount` would group it into "2,026". */
const yearLabel = $derived(new Intl.NumberFormat(messageLocale(), { useGrouping: false }).format(periodYear))

const unitWord = (value: number) => t(hourly ? 'hours' : 'days', { count: Math.abs(value) })
const change = (minutes: number) => `${signedNumber.format(inUnit(minutes))} ${unitWord(inUnit(minutes))}`
const plain = (minutes: number) => formatDays(inUnit(minutes), messageLocale())
const amountWithUnit = (value: number) => `${formatDays(value, messageLocale())} ${unitWord(value)}`

/** A `YYYY-MM-DD` read as a local day. `new Date('2026-03-01')` is UTC midnight, which is the day
 *  before in every zone west of Greenwich. */
const day = (iso: string) => formatDate(`${iso}T00:00:00`)

/**
 * Every kind the contract can produce, named the way somebody reconciling would say it.
 *
 * The set is closed in `LedgerKind`, so this switch is exhaustive by construction — a kind added to
 * the contract stops compiling here rather than rendering a raw `carry_out` at a person.
 */
const kindLabel = (kind: LedgerKind): string =>
  kind === 'grant'
    ? t('leave_kind_grant')
    : kind === 'accrual'
      ? t('leave_kind_accrual')
      : kind === 'consumption'
        ? t('leave_kind_consumption')
        : kind === 'reversal'
          ? t('leave_kind_reversal')
          : kind === 'expiry'
            ? t('leave_kind_expiry')
            : kind === 'adjustment'
              ? t('leave_kind_adjustment')
              : kind === 'carry_in'
                ? t('leave_kind_carry_in')
                : kind === 'carry_out'
                  ? t('leave_kind_carry_out')
                  : t('leave_kind_encashment')

// ---------------------------------------------------------------- adjusting by hand

const canAdjust = $derived(canHr('leaveAdjust'))

let adjusting = $state(false)
/** A plain string, because that is what `SegmentedControl` binds; only 'remove' is ever tested. */
let direction = $state('add')
let amountText = $state('')
let effectiveOn = $state(isoDate())
let reason = $state('')
/**
 * Errors appear once somebody has pressed the button, and the button is never disabled.
 *
 * A greyed-out control that does not say what is missing is the defect this avoids: the reason is
 * required by the contract, so an empty form would otherwise be a dead button with no explanation.
 * Pressing it names every field that is not ready instead.
 */
let attempted = $state(false)
let adjustError = $state<string | null>(null)
/** Not `adjust.isPending`: the disabled attribute reaches the button on the next render, so two
 *  quick clicks both fire — and both would be recorded, which for a ledger means two adjustments. */
let adjustInFlight = $state(false)

const amountValue = $derived(Number(amountText))
const amountOk = $derived(amountText.trim().length > 0 && Number.isFinite(amountValue) && amountValue > 0)
const reasonOk = $derived(reason.trim().length > 0)
const dateOk = $derived(/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn))
const signedMinutes = $derived(Math.round(amountValue * minutesPerUnit) * (direction === 'remove' ? -1 : 1))

/**
 * Which entitlement year the entry lands in is decided by `effectiveOn`, server-side.
 *
 * So an adjustment dated in another year moves a balance this panel is not showing, and the list
 * behind the dialog would not move at all — which reads as a write that failed. Said out loud
 * instead, before it happens.
 */
const otherYear = $derived(dateOk ? Number(effectiveOn.slice(0, 4)) : periodYear)
const yearMismatch = $derived(dateOk && otherYear !== periodYear)
const otherYearLabel = $derived(
  new Intl.NumberFormat(messageLocale(), { useGrouping: false }).format(otherYear),
)

const openAdjust = () => {
  direction = 'add'
  amountText = ''
  effectiveOn = isoDate()
  reason = ''
  attempted = false
  adjustError = null
  adjusting = true
}

const closeAdjust = () => {
  if (adjustInFlight) return
  adjusting = false
}

const adjust = createMutation(() => ({
  mutationFn: () =>
    api.leave.adjust({
      workspaceId,
      personId,
      leaveTypeId,
      // `kind` is left at the contract's default, `adjustment`. The other eight are the engine's
      // own words for what it did — an accrual it computed, an expiry it swept — and letting a
      // person write one by hand would put a sentence in the ledger that nothing else agrees with.
      amountMinutes: signedMinutes,
      effectiveOn,
      reason: reason.trim(),
    }),
  onSuccess: () => {
    adjusting = false
    adjustError = null
    toast.success(t('leave_adjusted_toast'))
    // An adjustment moves a balance, this ledger, and anything showing days left — the widget on
    // the dashboard included. The whole module's cache goes rather than a guess at which keys moved.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error) => {
    adjustError = adjustFailure(error)
    // A refusal means the server's picture is not the one on screen. Re-read exactly as a write
    // that landed does, so the figures behind the dialog are the ones a retry would act on.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onSettled: () => {
    adjustInFlight = false
  },
}))

/**
 * The refusals this screen has its own sentence for, keyed by the `reason` beside the refusal —
 * never by the sentence, because a list of sentences is a list somebody has to keep in sync and the
 * day it drifts the reader is told nothing.
 *
 * Empty on purpose: `leave.adjust` refuses nothing by name today — it appends, and the only things
 * that can stop it are the permission and the capability, neither of which this button is offered
 * without. The shape is here so that a refusal added to the router later (a locked payroll period is
 * the obvious one) reaches a reader by having a key written, not by this file being restructured.
 */
const adjustRefusalMessages: Record<string, string> = {}

/**
 * What a refused adjustment says to the person who asked for it.
 *
 * The test is the transport's `code`, never the sentence: `KernError.conflict` arrives as CONFLICT
 * with its `reason` at `data.reason`. Anything else — a network drop, a 500, a gateway — carries
 * machine text in English, which is the last thing to paste in front of somebody. The same shape as
 * `ClockControls.svelte` and the cancellation on `LeavePage.svelte`; there is no third.
 */
function adjustFailure(error: unknown): string {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (failure.code !== 'CONFLICT') return t('leave_adjust_error')
  const reason_ = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason_ ? adjustRefusalMessages[reason_] : undefined
  // `t()` answers a key it has no string for with the key itself, so both ways of not having one —
  // a reason no key covers, and a key whose string has not been merged — land on the router's
  // sentence rather than putting `hr.leave_adjust_refused_…` in front of somebody.
  const translated = key ? t(key) : undefined
  return (translated && translated !== key ? translated : failure.message) || t('leave_adjust_error')
}

const submitAdjust = () => {
  attempted = true
  if (adjustInFlight || !amountOk || !reasonOk || !dateOk) return
  adjustInFlight = true
  adjustError = null
  adjust.mutate()
}
</script>

<Sheet
  {open}
  width={560}
  title={t('leave_ledger_title', { name: typeName })}
  onOpenChange={(next) => {
    if (!next) onClose()
  }}
>
  {#snippet actions()}
    <!--
      The way in to an adjustment, except when the ledger is empty — there it is the empty state's
      own action, so the offer sits where somebody is already looking and never twice on one panel.
    -->
    {#if canAdjust && !empty}
      <Button size="sm" variant="secondary" icon="sliders-vertical" onclick={openAdjust}>
        {t('leave_adjust')}
      </Button>
    {/if}
  {/snippet}

  <p class="anchor">
    <span>{t('leave_ledger_year', { year: yearLabel })}</span>
    <span class="figure">
      <span>{t('leave_ledger_balance')}</span>
      <strong>{amountWithUnit(inUnit(balance?.balanceMinutes ?? 0))}</strong>
    </span>
  </p>

  {#if stale}
    <p class="stale" role="status">
      <span>{t('leave_stale')}</span>
      <Button size="sm" variant="ghost" onclick={() => void ledgerQuery.refetch()}>{t('retry')}</Button>
    </p>
  {/if}

  {#if loading}
    <div class="rows">
      {#each [1, 2, 3, 4, 5] as n (n)}<Skeleton height="44px" />{/each}
    </div>
  {:else if rows.length}
    <div class="table" role="table" aria-label={t('leave_ledger_title', { name: typeName })}>
      <div class="thead" role="row">
        <span role="columnheader">{t('leave_ledger_when')}</span>
        <span role="columnheader">{t('leave_ledger_what')}</span>
        <span role="columnheader" class="num">{t('leave_ledger_change')}</span>
        <span role="columnheader" class="num">{t('leave_ledger_after')}</span>
      </div>
      {#each rows as row (row.entry.id)}
        <div class="trow" role="row">
          <span class="cell when" role="cell">{day(row.entry.effectiveOn)}</span>
          <span class="cell what" role="cell">
            <span class="kind">
              {kindLabel(row.entry.kind)}
              {#if row.reversed}<Badge tone="grey">{t('leave_ledger_reversed')}</Badge>{/if}
            </span>
            {#if row.reverses}
              <span class="note">{t('leave_ledger_reverses', { date: day(row.reverses.effectiveOn) })}</span>
            {/if}
            {#if row.entry.reason}<span class="note">{row.entry.reason}</span>{/if}
          </span>
          <span class="cell num" class:credit={row.entry.amountMinutes > 0} class:debit={row.entry.amountMinutes < 0} role="cell">
            {change(row.entry.amountMinutes)}
          </span>
          <span class="cell num after" role="cell">{plain(row.afterMinutes)}</span>
        </div>
      {/each}
    </div>
    {#if entries.length >= LIMIT}
      <p class="capped">{t('leave_ledger_capped', { count: LIMIT })}</p>
    {/if}
  {:else if ledgerQuery.isError}
    <EmptyState compact icon="triangle-alert" title={t('leave_ledger_error')}>
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={() => void ledgerQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <!--
      Nothing has moved in this entitlement year. That is a real state — a type added in March has
      an empty ledger until the first grant — so it names what would fill it, and offers the one
      thing a person on this panel can do about it.
    -->
    <EmptyState
      compact
      icon="scroll-text"
      title={t('leave_ledger_none')}
      description={t('leave_ledger_none_desc')}
    >
      {#snippet actions()}
        {#if canAdjust}
          <Button size="sm" variant="secondary" icon="sliders-vertical" onclick={openAdjust}>
            {t('leave_adjust')}
          </Button>
        {/if}
      {/snippet}
    </EmptyState>
  {/if}
</Sheet>

<!--
  Adjusting is writing a row nobody can take out again, so the dialog says whose balance moves, by
  how much and in which direction — live, as the amount is typed, because the mistake this catches
  is a 20 where a 2 was meant and no amount of "are you sure" catches that.
-->
<Dialog
  open={adjusting}
  title={t('leave_adjust_title')}
  description={t('leave_adjust_desc')}
  onOpenChange={(next) => {
    if (!next) closeAdjust()
  }}
>
  <div class="form">
    <!--
      No `Field` around this one: `Field` renders a `<label for>`, and a segmented control is a
      radiogroup rather than one focusable input for a label to point at. Its own `label` names the
      group for a screen reader, and the two buttons say what they do on the face of them.
    -->
    <SegmentedControl
      label={t('leave_adjust_direction')}
      bind:value={direction}
      items={[
        { value: 'add', label: t('leave_adjust_add'), icon: 'plus' },
        { value: 'remove', label: t('leave_adjust_remove'), icon: 'minus' },
      ]}
    />

    <Field
      label={hourly ? t('leave_adjust_amount_hours') : t('leave_adjust_amount_days')}
      required
      error={attempted && !amountOk ? t('leave_adjust_amount_invalid') : null}
    >
      {#snippet children(id)}
        <Input {id} type="number" min="0" step="0.5" inputmode="decimal" bind:value={amountText} />
      {/snippet}
    </Field>

    <Field
      label={t('leave_adjust_effective')}
      required
      hint={t('leave_adjust_effective_hint')}
      error={attempted && !dateOk ? t('leave_adjust_effective_invalid') : null}
    >
      {#snippet children(id)}
        <Input {id} type="date" bind:value={effectiveOn} />
      {/snippet}
    </Field>

    <Field
      label={t('leave_reason')}
      required
      hint={t('leave_adjust_reason_hint')}
      error={attempted && !reasonOk ? t('leave_adjust_reason_required') : null}
    >
      {#snippet children(id)}
        <Textarea {id} rows={3} bind:value={reason} />
      {/snippet}
    </Field>
  </div>

  {#if amountOk && dateOk}
    <p class="consequence">
      {direction === 'add'
        ? t('leave_adjust_confirm_add', {
            name: personName,
            type: typeName,
            amount: amountWithUnit(amountValue),
            date: day(effectiveOn),
          })
        : t('leave_adjust_confirm_remove', {
            name: personName,
            type: typeName,
            amount: amountWithUnit(amountValue),
            date: day(effectiveOn),
          })}
    </p>
    {#if yearMismatch}
      <p class="warn">{t('leave_adjust_other_year', { year: otherYearLabel })}</p>
    {/if}
  {/if}
  <p class="permanent">{t('leave_adjust_irreversible')}</p>
  {#if adjustError}<p class="failed" role="alert">{adjustError}</p>{/if}

  {#snippet footer()}
    <!-- Secondary, as in `DecisionDialog`: on a dialog that writes something permanent the way out
         must not be the faintest control on it. -->
    <Button variant="secondary" onclick={closeAdjust} disabled={adjustInFlight}>{t('cancel')}</Button>
    <Button variant="danger" loading={adjustInFlight} onclick={submitAdjust}>{t('leave_adjust')}</Button>
  {/snippet}
</Dialog>

<style>
.anchor {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 14px;
  font-size: 12.5px;
  color: var(--kern-ink-500);
}
.figure {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.figure strong {
  font-size: 15px;
  color: var(--kern-ink-900);
  font-variant-numeric: tabular-nums;
}
/*
 * The warning ink is 4.58:1 on its own tint in light and 5.28:1 in dark, and the tint is what makes
 * the strip read as a notice rather than as another row of the table.
 */
.stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-block: 0 12px;
  padding-block: 6px;
  padding-inline: 12px 8px;
  border-radius: var(--kern-r-md);
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
  font-size: 12.5px;
}
.rows {
  display: grid;
  gap: 4px;
}

/* One grid for the header and every row, so the two number columns line up down the panel. */
.table {
  --hr-ledger-cols: 96px minmax(0, 1fr) 92px 76px;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-ledger-cols);
  gap: 10px;
  align-items: start;
}
.thead {
  height: 30px;
  align-items: center;
  border-block-end: 1px solid var(--kern-border);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.trow {
  padding-block: 9px;
  border-block-end: 1px solid var(--kern-border-hairline);
}
.cell {
  min-width: 0;
  font-size: 13px;
}
.when {
  color: var(--kern-ink-500);
}
.what {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.kind {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  color: var(--kern-ink-900);
}
/* A colour, not opacity: opacity fades the text against the panel whatever token it names. */
.note {
  font-size: 12px;
  color: var(--kern-ink-500);
  overflow-wrap: anywhere;
}
.num {
  text-align: end;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* 7.00:1 in light and 8.50:1 in dark on --kern-surface-raised, which is what a sheet sits on. */
.credit {
  color: var(--kern-success-ink);
}
/* 6.33:1 in light, 5.04:1 in dark on the same surface. */
.debit {
  color: var(--kern-danger);
}
.after {
  color: var(--kern-ink-700);
}
.capped {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--kern-ink-500);
}

.form {
  display: grid;
  gap: 14px;
}
.consequence {
  margin: 14px 0 0;
  padding: 10px 12px;
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-chip);
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kern-ink-900);
}
.warn {
  margin: 8px 0 0;
  padding: 8px 12px;
  border-radius: var(--kern-r-md);
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
  font-size: 12.5px;
  line-height: 1.5;
}
.permanent {
  margin: 10px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--kern-ink-500);
}
/* A dialog body sits on --kern-surface-raised, not the page: 6.33:1 there in light, 5.04:1 in dark. */
.failed {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--kern-danger);
}

@media (max-width: 768px) {
  .table {
    --hr-ledger-cols: 84px minmax(0, 1fr) 82px 66px;
  }
}
</style>
