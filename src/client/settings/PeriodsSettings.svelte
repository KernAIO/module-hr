<script lang="ts">
import {
  Badge,
  type BadgeTone,
  Button,
  Dialog,
  EmptyState,
  Field,
  formatDateRange,
  formatDateTime,
  Input,
  navigation,
  Select,
  SettingsPage,
  SettingsSection,
  Skeleton,
  session,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
// The client barrel re-exports the models the screens have needed so far, and the period was not
// one of them. Straight from the contract rather than widening a barrel another screen shares.
import type { Period } from '../../contract/policies.js'
import { getHrApi } from '../api-instance.js'
import { HR_CAPABILITIES } from '../capabilities.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { isoDate } from '../query.js'

/**
 * The lock that makes a filed month stay filed.
 *
 * Everything else in this module respects a locked period — `PolicyService.assertOpen` refuses a
 * write into one, and `attendance.days.recompute` skips the days inside it — and until this screen
 * existed nothing could put one there. `periods.list`, `create`, `lock` and `unlock` were all
 * implemented with no caller, so the mechanism the module is built around was unreachable.
 *
 * Three things about periods that the screen has to keep visible, because getting any of them
 * wrong is a payroll problem rather than a display problem:
 *
 * **A period scopes to its legal entity.** `isLocked` reads a period with no entity as closing the
 * whole workspace and one with an entity as closing only the people that entity employed *on that
 * date*. So the list names what each period applies to, and the create form only offers the choice
 * where the `legal_entities` capability is on — but a period that names an entity is still labelled
 * as such when the capability is later switched off, because a screen that drew it as
 * workspace-wide would be lying about who is frozen.
 *
 * **The kind is a label, not a switch.** `isLocked` does not filter on `kind`: an *attendance*
 * period closes the same dates a *payroll* one would. The kind records why the month was closed,
 * and the sections say so rather than implying two independent locks.
 *
 * **Reopening is the consequential act.** Locking is the safe direction — it stops figures moving.
 * Unlocking lets a month move underneath a payroll somebody has already filed, which is why the
 * contract makes the reason mandatory, the server writes it onto the period, and this screen shows
 * the days that come back rather than a bare "done".
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/**
 * `hr.period.manage` is dangerous and owner-only by default, and the settings page is registered
 * behind it — but the check is repeated here rather than assumed, because a role edit takes effect
 * on the next render and a button that 403s is worse than no button.
 */
const manage = $derived(canHr('periodManage'))
const hasEntities = $derived(session.hasCapability('hr', HR_CAPABILITIES.legalEntities))

type Kind = Period['kind']
const KINDS: Kind[] = ['payroll', 'attendance']

/**
 * `[module, entity, …scope]`, the shape `hrKeys` uses. Spelled here rather than in `query.ts`
 * because this is the only screen that asks.
 */
const periodsKey = (ws: string) => ['hr', 'periods', ws] as const
const entitiesKey = (ws: string) => ['hr', 'entities', ws] as const

/**
 * Every period in one read.
 *
 * `periods.list` takes a `kind` but always answers `nextCursor: null`, so two filtered queries
 * would be two round trips for one list that is already whole. 200 is the contract's maximum and
 * some years of months; the overlap check below is only as good as what came back, which is why
 * the server's exclusion constraint is still the thing that decides.
 */
const periodsQuery = createQuery(() => ({
  queryKey: periodsKey(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.periods.list({ workspaceId, limit: 200 }),
}))

/**
 * The retained value, never the query status. Locking invalidates the whole module, so a refetch
 * failing while the last good list is still in `data` is the ordinary case — an error branch above
 * the data would blank a working screen for as long as core takes to come back.
 */
const periods = $derived(periodsQuery.data?.items ?? [])
/** A disabled query is `pending` and not fetching, so it is not loading. */
const loading = $derived(!workspaceId || periodsQuery.isLoading)
const stale = $derived(periodsQuery.isError && periods.length > 0)

const entitiesQuery = createQuery(() => ({
  queryKey: entitiesKey(workspaceId),
  enabled: Boolean(workspaceId) && hasEntities,
  queryFn: () => api.entities.list({ workspaceId, includeArchived: true }),
}))
const entities = $derived(entitiesQuery.data ?? [])

const byKind = (kind: Kind) => periods.filter((p) => p.kind === kind)

/**
 * The scope column appears when the workspace has entities — and also when it does not but a period
 * names one anyway, which is what a workspace that switched `legal_entities` off leaves behind.
 * Those rows cannot be named (the procedure that names them answers 404 with the capability off),
 * so they say "one legal entity" rather than being drawn as if they closed everybody.
 */
const showScope = $derived(hasEntities || periods.some((p) => p.legalEntityId !== null))

const scopeLabel = (legalEntityId: string | null): string =>
  legalEntityId === null
    ? t('periods_scope_all')
    : (entities.find((e) => e.id === legalEntityId)?.name ?? t('periods_scope_entity'))

/** The range as one string: `formatRange` collapses the shared parts and reads correctly in RTL. */
const rangeOf = (period: { startsOn: string; endsOn: string }) =>
  formatDateRange(`${period.startsOn}T00:00:00`, `${period.endsOn}T00:00:00`)

const statusTone = (status: Period['status']): BadgeTone => (status === 'locked' ? 'done' : 'grey')
const statusLabel = (status: Period['status']) =>
  status === 'locked' ? t('periods_locked') : t('periods_open')

/**
 * A period change moves the attendance day sheet, the balances computed from it and anything a
 * policy would have recomputed, so the module's cache is dropped whole rather than guessing which
 * keys a lock touched.
 */
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: ['hr'] })
}

/**
 * One click, one write.
 *
 * `disabled={mutation.isPending}` reaches the button on the next render, and two quick clicks are
 * one render apart — which here means two periods, or a lock and its own reopen.
 */
let firing = $state(false)
function once(run: () => void) {
  if (firing) return
  firing = true
  run()
}
const settled = () => {
  firing = false
}

/**
 * What a refusal says to the person who asked for it.
 *
 * The map is empty because none of the four period procedures carries a machine-readable reason
 * yet: `lock` refuses an already-locked period through `KernError.conflict` with a sentence and no
 * code, and `create` is refused by the `hr_periods_no_overlap` exclusion constraint rather than by
 * the router. So the router's own sentence is what reaches the reader, and this is where a reason
 * goes the day one is added — never a match on the sentence, which drifts silently.
 */
const refusalMessages: Record<string, string> = {}

function failureText(error: unknown, fallbackKey: string): string {
  const failure = error as { message?: string; data?: { reason?: unknown } }
  const reason = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason ? refusalMessages[reason] : undefined
  // `t()` answers a key it has no string for with the key itself, so both ways of not having one —
  // a reason no key covers, and a key whose string has not been merged — land on the router's
  // sentence rather than putting `hr.periods_…` in front of somebody.
  const translated = key ? t(key) : undefined
  return (translated && translated !== key ? translated : failure.message) || t(fallbackKey)
}

// ---------------------------------------------------------------- create

type Draft = { kind: Kind; legalEntityId: string; startsOn: string; endsOn: string }

/**
 * The form is open or shut on its own flag, and the draft is never null.
 *
 * `bind:value` needs an assignable expression, and TypeScript does not carry an `{#if draft}`
 * narrowing into the snippet the field is written in — so a nullable draft turns four date and
 * select bindings into hand-written change handlers for nothing.
 */
let createOpen = $state(false)
let draft = $state<Draft>({ kind: 'payroll', legalEntityId: '', ...lastMonth() })
let createError = $state<string | null>(null)

/**
 * The month somebody has just finished is the one they came to close, so that is what the form
 * opens on — not today's month, which is still running.
 */
function lastMonth(): { startsOn: string; endsOn: string } {
  const now = new Date()
  return {
    startsOn: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    endsOn: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)),
  }
}

function openCreate(kind: Kind) {
  createError = null
  draft = { kind, legalEntityId: '', ...lastMonth() }
  createOpen = true
}

const rangeValid = $derived(draft.startsOn !== '' && draft.endsOn !== '' && draft.endsOn >= draft.startsOn)

/**
 * The period this one would overlap, found here rather than at the server.
 *
 * `hr_periods_no_overlap` excludes two periods of one kind covering the same day for the same
 * employer, and a constraint violation arrives as an opaque failure with a Postgres sentence in it.
 * Naming the period in the way is the difference between "that did not work" and "January is
 * already there".
 */
const clash = $derived.by(() => {
  if (!rangeValid) return null
  const entity = draft.legalEntityId || null
  return (
    periods.find(
      (p) =>
        p.kind === draft.kind &&
        p.legalEntityId === entity &&
        p.startsOn <= draft.endsOn &&
        p.endsOn >= draft.startsOn,
    ) ?? null
  )
})

const canCreate = $derived(manage && rangeValid && clash === null)

const create = createMutation(() => ({
  mutationFn: (input: Draft) =>
    api.periods.create({
      workspaceId,
      kind: input.kind,
      legalEntityId: input.legalEntityId || null,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
    }),
  onSuccess: (period: Period) => {
    toast.success(t('periods_created', { range: rangeOf(period) }))
    createOpen = false
    createError = null
    refresh()
  },
  onError: (error: Error) => {
    createError = failureText(error, 'periods_create_error')
  },
  onSettled: settled,
}))

// ---------------------------------------------------------------- lock

let locking = $state<Period | null>(null)
let lockNote = $state('')
let lockError = $state<string | null>(null)

function openLock(period: Period) {
  locking = period
  lockNote = ''
  lockError = null
}

const lock = createMutation(() => ({
  mutationFn: (period: Period) =>
    api.periods.lock({ workspaceId, periodId: period.id, note: lockNote.trim() || null }),
  onSuccess: (result: Period & { lockedDays: number }) => {
    // The count is the point of the response: "closed" says nothing about how much stopped moving.
    toast.success(
      result.lockedDays === 0
        ? t('periods_locked_none')
        : t('periods_locked_toast', { count: result.lockedDays }),
    )
    locking = null
    lockError = null
    refresh()
  },
  onError: (error: Error) => {
    lockError = failureText(error, 'periods_lock_error')
  },
  onSettled: settled,
}))

// ---------------------------------------------------------------- reopen

let reopening = $state<Period | null>(null)
let reason = $state('')
let reopenError = $state<string | null>(null)

function openReopen(period: Period) {
  reopening = period
  reason = ''
  reopenError = null
}

const reasonValid = $derived(reason.trim().length > 0)

/**
 * The other closed periods that would keep some of these days shut.
 *
 * `setPeriodLock` asks `isLocked` about every day it is about to reopen and leaves the ones another
 * period still closes — so reopening an entity's January while the workspace's January is closed
 * changes nothing at all. Two periods overlap in *people* unless both name an entity and the
 * entities differ; either one naming nobody covers everybody the other does.
 */
const stillClosedBy = $derived.by(() => {
  const period = reopening
  if (!period) return []
  return periods.filter(
    (other) =>
      other.id !== period.id &&
      other.status === 'locked' &&
      other.startsOn <= period.endsOn &&
      other.endsOn >= period.startsOn &&
      (other.legalEntityId === null ||
        period.legalEntityId === null ||
        other.legalEntityId === period.legalEntityId),
  )
})

const reopen = createMutation(() => ({
  mutationFn: (period: Period) =>
    api.periods.unlock({ workspaceId, periodId: period.id, reason: reason.trim() }),
  onSuccess: (result: Period & { unlockedDays: number }) => {
    toast.success(
      result.unlockedDays === 0
        ? t('periods_reopened_none')
        : t('periods_reopened_toast', { count: result.unlockedDays }),
    )
    reopening = null
    reopenError = null
    refresh()
  },
  onError: (error: Error) => {
    reopenError = failureText(error, 'periods_reopen_error')
  },
  onSettled: settled,
}))

const kindOptions = $derived([
  { value: 'payroll', label: t('periods_payroll') },
  { value: 'attendance', label: t('periods_attendance') },
])

/** Archived entities are included: a period filed under one is still a period somebody must name. */
const entityOptions = $derived([
  { value: '', label: t('periods_scope_all') },
  ...entities.map((e) => ({ value: e.id, label: e.name })),
])

const sectionTitle = (kind: Kind) => (kind === 'payroll' ? t('periods_payroll') : t('periods_attendance'))
const sectionDesc = (kind: Kind) =>
  kind === 'payroll' ? t('periods_payroll_desc') : t('periods_attendance_desc')
</script>

<SettingsPage title={t('settings_periods')} description={t('periods_desc')}>
  {#if stale}
    <p class="stale" role="status">
      <span>{t('periods_stale')}</span>
      <Button size="sm" variant="ghost" onclick={() => void periodsQuery.refetch()}>{t('retry')}</Button>
    </p>
  {/if}

  {#if !manage}
    <!-- The list is readable without the permission; nothing on it is actionable, and a screen that
         simply omits every control reads as broken rather than as restricted. -->
    <p class="note">{t('periods_read_only')}</p>
  {/if}

  {#if !loading && periodsQuery.isError && periods.length === 0}
    <!--
      One error, not one per section. Nothing was retained, so both lists below would say the same
      thing twice — and the retry belongs to the single read that failed, which fills both.
    -->
    <SettingsSection title={t('settings_periods')}>
      <EmptyState icon="triangle-alert" title={t('periods_error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void periodsQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    </SettingsSection>
  {:else}
    {#each KINDS as kind (kind)}
      {@const rows = byKind(kind)}
      <SettingsSection title={sectionTitle(kind)} description={sectionDesc(kind)} flush={rows.length > 0}>
        {#snippet action()}
          {#if manage}
            <Button size="sm" icon="plus" variant="secondary" onclick={() => openCreate(kind)}>
              {t('periods_new')}
            </Button>
          {/if}
        {/snippet}

        {#if loading}
          <div class="rows pad">
            {#each [1, 2, 3] as n (n)}<Skeleton height="52px" />{/each}
          </div>
        {:else if rows.length > 0}
          <!-- The action column is dropped rather than left empty when the viewer cannot act: a 120px
               gutter beside every row reads as a column that failed to load. -->
          <div
            class="table"
            class:scoped={showScope}
            class:readonly={!manage}
            role="table"
            aria-label={sectionTitle(kind)}
          >
            <div class="thead" role="row">
              <span role="columnheader">{t('periods_range')}</span>
              {#if showScope}<span role="columnheader">{t('periods_scope')}</span>{/if}
              <span role="columnheader">{t('status')}</span>
              {#if manage}<span class="sr-only" role="columnheader">{t('approvals_actions')}</span>{/if}
            </div>
            {#each rows as period (period.id)}
              <div class="trow" role="row">
                <span class="cell what" role="cell">
                  <span class="strong">{rangeOf(period)}</span>
                  {#if period.lockedAt}
                    <span class="meta">{t('periods_closed_on', { date: formatDateTime(period.lockedAt) })}</span>
                  {/if}
                  {#if period.note}
                    <span class="meta">{period.note}</span>
                  {/if}
                </span>
                {#if showScope}
                  <span class="cell muted" role="cell">{scopeLabel(period.legalEntityId)}</span>
                {/if}
                <span class="cell" role="cell">
                  <Badge tone={statusTone(period.status)}>{statusLabel(period.status)}</Badge>
                </span>
                {#if manage}
                  <span class="cell actions" role="cell">
                    {#if period.status === 'locked'}
                      <Button size="sm" variant="secondary" icon="lock-open" onclick={() => openReopen(period)}>
                        {t('periods_reopen')}
                      </Button>
                    {:else}
                      <Button size="sm" variant="secondary" icon="lock" onclick={() => openLock(period)}>
                        {t('periods_lock')}
                      </Button>
                    {/if}
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <EmptyState icon="calendar-days" title={t('periods_none')} description={t('periods_none_desc')}>
            {#snippet actions()}
              {#if manage}
                <Button icon="plus" onclick={() => openCreate(kind)}>{t('periods_new')}</Button>
              {/if}
            {/snippet}
          </EmptyState>
        {/if}
      </SettingsSection>
    {/each}
  {/if}
</SettingsPage>

<!-- ---------------------------------------------------------------- a new period -->
<Dialog
  open={createOpen}
  title={t('periods_create_title')}
  description={t('periods_create_desc')}
  onOpenChange={(o) => {
    if (!o && !create.isPending) createOpen = false
  }}
>
  <div class="form">
    <Field label={t('periods_kind')} hint={t('periods_kind_hint')}>
      {#snippet children(id)}
        <Select
          {id}
          value={draft.kind}
          onValueChange={(v) => {
            draft.kind = v as Kind
          }}
          options={kindOptions}
        />
      {/snippet}
    </Field>

    {#if hasEntities}
      <Field label={t('office_entity')} hint={t('periods_entity_hint')}>
        {#snippet children(id)}
          <Select
            {id}
            bind:value={draft.legalEntityId}
            options={entityOptions}
            disabled={entitiesQuery.isLoading}
          />
        {/snippet}
      </Field>
    {/if}

    <div class="pair">
      <Field label={t('periods_starts')} required>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={draft.startsOn} />
        {/snippet}
      </Field>
      <Field
        label={t('periods_ends')}
        required
        error={draft.endsOn && !rangeValid ? t('periods_range_invalid') : null}
      >
        {#snippet children(id)}
          <Input {id} type="date" bind:value={draft.endsOn} />
        {/snippet}
      </Field>
    </div>

    {#if clash}
      <!-- Stated where the button is refused rather than only in the tooltip nobody opens: two
           periods of one kind may not cover the same day for the same employer. -->
      <p class="failed" role="alert">{t('periods_overlap', { range: rangeOf(clash) })}</p>
    {/if}
    {#if createError}
      <p class="failed" role="alert">{createError}</p>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (createOpen = false)} disabled={create.isPending}>
      {t('cancel')}
    </Button>
    <Button
      loading={create.isPending}
      disabled={!canCreate}
      onclick={() => once(() => create.mutate($state.snapshot(draft)))}
    >
      {t('common.create')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- close a period -->
<Dialog
  open={locking !== null}
  size="sm"
  title={locking ? t('periods_lock_title', { range: rangeOf(locking) }) : ''}
  onOpenChange={(o) => {
    if (!o && !lock.isPending) locking = null
  }}
>
  {#if locking}
    <p class="body">{t('periods_lock_body', { scope: scopeLabel(locking.legalEntityId) })}</p>
    <p class="body muted">{t('periods_lock_adjustments')}</p>

    <Field label={t('periods_lock_note')} hint={t('periods_lock_note_hint')}>
      {#snippet children(id)}
        <Textarea {id} bind:value={lockNote} rows={2} maxlength={500} />
      {/snippet}
    </Field>
  {/if}
  {#if lockError}
    <p class="failed" role="alert">{lockError}</p>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (locking = null)} disabled={lock.isPending}>
      {t('cancel')}
    </Button>
    <Button
      loading={lock.isPending}
      onclick={() => {
        if (locking) once(() => locking && lock.mutate(locking))
      }}
    >
      {t('periods_lock_confirm')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- reopen one -->
<!--
  The most consequential thing anyone does on this screen, so the dialog says what it costs before
  it happens: the days come back, a payroll filed against them can move underneath the figures
  somebody has already sent out, and the reason is kept on the period so the list says why.
-->
<Dialog
  open={reopening !== null}
  size="sm"
  title={reopening ? t('periods_reopen_title', { range: rangeOf(reopening) }) : ''}
  onOpenChange={(o) => {
    if (!o && !reopen.isPending) reopening = null
  }}
>
  {#if reopening}
    <p class="body">{t('periods_reopen_body', { scope: scopeLabel(reopening.legalEntityId) })}</p>
    <p class="body warn">{t('periods_reopen_filed')}</p>

    {#if stillClosedBy.length > 0}
      <!-- `setPeriodLock` leaves a day that another closed period still covers, so reopening this
           one can change nothing at all. Better said here than discovered in the count afterwards. -->
      <div class="body">
        <p class="note-line">{t('periods_reopen_overlap')}</p>
        <ul class="overlaps">
          {#each stillClosedBy as other (other.id)}
            <li>
              <span>{rangeOf(other)}</span>
              {#if showScope}<span class="muted">{scopeLabel(other.legalEntityId)}</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <Field label={t('periods_reopen_reason')} hint={t('periods_reopen_reason_hint')} required>
      {#snippet children(id)}
        <Textarea {id} bind:value={reason} rows={3} maxlength={500} />
      {/snippet}
    </Field>
    {#if !reasonValid}
      <!-- Why the button below is dead. Plain text rather than a live region: it is a standing
           condition, and announcing it on every keystroke is noise. -->
      <p class="hint">{t('periods_reopen_reason_required')}</p>
    {/if}
  {/if}
  {#if reopenError}
    <p class="failed" role="alert">{reopenError}</p>
  {/if}

  {#snippet footer()}
    <!-- Secondary, as in `DecisionDialog`: on a destructive confirmation the way out must not be the
         faintest control on it. And it says "Keep it closed" rather than the shared "Cancel", which
         beside a period screen reads as cancelling the period itself. -->
    <Button variant="secondary" onclick={() => (reopening = null)} disabled={reopen.isPending}>
      {t('periods_reopen_keep')}
    </Button>
    <Button
      variant="danger"
      loading={reopen.isPending}
      disabled={!reasonValid}
      onclick={() => {
        if (reopening) once(() => reopening && reopen.mutate(reopening))
      }}
    >
      {t('periods_reopen')}
    </Button>
  {/snippet}
</Dialog>

<style>
.rows {
  display: grid;
  gap: 4px;
}
.pad {
  padding: 2px 0;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  --hr-period-cols: minmax(180px, 1fr) 92px 120px;
  width: 100%;
}
.table.scoped {
  --hr-period-cols: minmax(180px, 1fr) minmax(120px, 0.7fr) 92px 120px;
}
.table.readonly {
  --hr-period-cols: minmax(180px, 1fr) 92px;
}
.table.scoped.readonly {
  --hr-period-cols: minmax(180px, 1fr) minmax(120px, 0.7fr) 92px;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-period-cols);
  gap: 12px;
  align-items: center;
  padding-inline: 18px;
}
.thead {
  height: 32px;
  border-block-end: 1px solid var(--kern-border);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.trow {
  min-height: 52px;
  padding-block: 8px;
  border-block-end: 1px solid var(--kern-border-hairline);
}
.trow:last-child {
  border-block-end: none;
}
.cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.what {
  display: grid;
  gap: 2px;
}
.strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 500;
}
.meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-500);
}
.muted {
  font-size: 13px;
  color: var(--kern-ink-500);
}
.actions {
  display: flex;
  justify-content: flex-end;
  overflow: visible;
}

/*
 * The warning ink is 4.37:1 on `--kern-canvas` and 4.58:1 in light / 5.28:1 in dark on its own
 * tint, which is what a 12.5px line has to clear — and the tint is what makes the strip read as a
 * notice rather than as another card.
 */
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
.note {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--kern-r-md2);
  background: var(--kern-info-tint);
  color: var(--kern-ink-700);
  font-size: 12.5px;
  line-height: 1.5;
}
.body {
  margin: 0 0 12px;
  font-size: 13.5px;
  line-height: 1.5;
}
.body.muted {
  font-size: 12.5px;
}
.warn {
  padding: 10px 12px;
  border-radius: var(--kern-r-md2);
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
  font-size: 12.5px;
}
.note-line {
  margin: 0 0 4px;
  font-size: 12.5px;
  color: var(--kern-ink-700);
}
.overlaps {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12.5px;
}
.overlaps li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.failed {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}

.form {
  display: grid;
  gap: 14px;
}
.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .table,
  .table.scoped {
    --hr-period-cols: minmax(140px, 1fr) 108px;
  }
  .table.readonly,
  .table.scoped.readonly {
    --hr-period-cols: minmax(140px, 1fr) 92px;
  }
  /*
   * Two columns, and which one survives depends on whether the viewer can act. With an action the
   * status badge goes, because the action already states it — a row offering "Reopen" is a closed
   * one. Without an action the badge is the only signal there is, so the scope goes instead.
   */
  .table.scoped .thead > :nth-child(2),
  .table.scoped .trow > :nth-child(2),
  .table:not(.readonly) .thead > :nth-child(2),
  .table:not(.readonly) .trow > :nth-child(2),
  .table.scoped:not(.readonly) .thead > :nth-child(3),
  .table.scoped:not(.readonly) .trow > :nth-child(3) {
    display: none;
  }
  .pair {
    grid-template-columns: 1fr;
  }
}
</style>
