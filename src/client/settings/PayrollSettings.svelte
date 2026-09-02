<script lang="ts">
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  Field,
  formatDate,
  formatDateRange,
  messageLocale,
  navigation,
  Select,
  SettingsPage,
  SettingsSection,
  Skeleton,
  Switch,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery } from '@tanstack/svelte-query'
import type { PayrollExportFile, PayrollExportRefusal } from '../../contract/exports.js'
import type { Period } from '../../contract/policies.js'
import { getHrApi } from '../api-instance.js'
import { HR_CAPABILITIES } from '../capabilities.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { formatDays, formatDuration, hrKeys } from '../query.js'

/**
 * The payroll handover, and the screen that makes it reachable.
 *
 * `payroll.export.preview` and `payroll.export.v1` were implemented and tested with nothing calling
 * them — the whole frozen contract in `contract/exports.ts` was a file nobody could get. This is
 * the one place a person asks for it, and it follows the server's four rules rather than softening
 * them:
 *
 * **One entity, one period.** The picker offers no "everything": `legalEntityId` is a required
 * input because two entities are two filings, and a screen that let somebody export both at once
 * would be inviting them to send one provider another employer's people. Legal entities come from
 * `entities.list` where the `legal_entities` capability is on. Where it is off that procedure
 * answers 404, and a legal entity row only ever comes from `entities.create` behind the same
 * capability — so the fallback is the entities the payroll periods already name, and a workspace
 * whose periods name none is told plainly that there is nobody to file for.
 *
 * **Preview before download, and the preview is the truth.** The download is offered only against
 * a preview of the same entity, period and draft flag; change any of them and the preview goes,
 * because a Download button beside figures for a different selection is the worst kind of
 * confident. `exportable` is the server's word — the button never decides for itself.
 *
 * **Refuse rather than guess.** Every refusal is listed with its translated sentence and, where it
 * is about people, the people. Their names come off the preview's own hours rows: the server builds
 * a row for everyone in the population precisely so that this screen can say who a refusal is about
 * without a second read behind a second permission.
 *
 * **No money, and the page says so.** The sentence is on the page rather than in a tooltip because
 * the person reading this is the one who will be asked "so what do I pay".
 */
const api = getHrApi()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/**
 * The page is registered behind `hr.payroll.export`, and the check is repeated here rather than
 * assumed: a role edit takes effect on the next render, and a Preview that 403s is worse than a
 * page that says why it is read-only.
 */
const mayExport = $derived(canHr('payrollExport'))
const hasEntities = $derived(session.hasCapability('hr', HR_CAPABILITIES.legalEntities))

/** Durations go through the module's own formatter so the digits match the language around them. */
const DURATION_WORDS = {
  hours: (n: string) => t('hours_short', { n }),
  minutes: (n: string) => t('minutes_short', { n }),
}
const duration = (minutes: number) => formatDuration(minutes, DURATION_WORDS, messageLocale())
const days = (n: number) => `${formatDays(n, messageLocale())} ${t('days', { count: n })}`
const num = (n: number) => new Intl.NumberFormat(messageLocale()).format(n)

/** The range as one string: `formatDateRange` collapses the shared parts and reads correctly in RTL. */
const rangeOf = (range: { startsOn: string; endsOn: string }) =>
  formatDateRange(`${range.startsOn}T00:00:00`, `${range.endsOn}T00:00:00`)

const statusTone = (status: Period['status']): BadgeTone => (status === 'locked' ? 'done' : 'grey')
const statusLabel = (status: Period['status']) =>
  status === 'locked' ? t('periods_locked') : t('periods_open')

/**
 * `t()` answers a key it has no string for with the namespaced key itself, so an employment type
 * this module never named — a custom one, or a row with none — falls back to the stored value
 * rather than putting `hr.employment_…` in front of somebody.
 */
const employmentLabel = (type: string) => {
  if (!type) return ''
  const key = `employment_${type}`
  const label = t(key)
  return label === `hr.${key}` ? type : label
}

// ---------------------------------------------------------------- the choices

/**
 * Every period in one read: `periods.list` answers `nextCursor: null`, so there is nothing to
 * page, and the same list drives the entity fallback below.
 */
const periodsQuery = createQuery(() => ({
  queryKey: hrKeys.periods(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.periods.list({ workspaceId, limit: 200 }),
}))
/** Payroll periods only: the server refuses an attendance period, and offering one would be a trap. */
const payrollPeriods = $derived((periodsQuery.data?.items ?? []).filter((p) => p.kind === 'payroll'))

const entitiesQuery = createQuery(() => ({
  queryKey: hrKeys.entities(workspaceId),
  enabled: Boolean(workspaceId) && hasEntities,
  queryFn: () => api.entities.list({ workspaceId, includeArchived: true }),
}))

type Choice = { value: string; label: string; description?: string }

/**
 * The employers on offer.
 *
 * With the capability on, the list — archived ones included, because a period filed under one is
 * still a period somebody must be able to export. With it off, the entities the payroll periods
 * name: the procedure that would name them answers 404, so they are labelled by number and the
 * manifest names them properly the moment a preview comes back.
 */
const entityChoices = $derived.by((): Choice[] => {
  if (hasEntities) {
    return (entitiesQuery.data ?? []).map((e) => ({
      value: e.id,
      label: e.archivedAt ? t('payroll_entity_archived', { name: e.name }) : e.name,
      description: e.currency ? `${e.country} · ${e.currency}` : e.country,
    }))
  }
  const named = [
    ...new Set(payrollPeriods.map((p) => p.legalEntityId).filter((id): id is string => id !== null)),
  ]
  return named.map((id, index) => ({ value: id, label: t('payroll_entity_unnamed', { n: index + 1 }) }))
})

const choicesLoading = $derived(
  !workspaceId || periodsQuery.isLoading || (hasEntities && entitiesQuery.isLoading),
)

let legalEntityId = $state('')
let periodId = $state('')
let draft = $state(false)

/** Exactly one employer needs no choosing. The same rule the periods form applies. */
$effect(() => {
  const only = entityChoices.length === 1 ? entityChoices[0] : undefined
  if (only && legalEntityId !== only.value && !entityChoices.some((c) => c.value === legalEntityId))
    legalEntityId = only.value
})

/**
 * The periods that can be exported for the chosen entity, newest first: those naming it, and those
 * naming nobody, which close the whole workspace and therefore this entity too. Same rule as
 * `PolicyService.isLocked`, so a lock and its export cannot disagree.
 */
const periodChoices = $derived(
  payrollPeriods
    .filter((p) => legalEntityId !== '' && (p.legalEntityId === null || p.legalEntityId === legalEntityId))
    .slice()
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn)),
)
const periodOptions = $derived(
  periodChoices.map((p) => ({ value: p.id, label: rangeOf(p), description: statusLabel(p.status) })),
)

/**
 * The newest closed period is the one somebody came to export, so that is what the picker lands
 * on; failing that, the newest. A period no longer on offer — the entity changed — is dropped.
 */
$effect(() => {
  if (periodChoices.some((p) => p.id === periodId)) return
  const preferred = periodChoices.find((p) => p.status === 'locked') ?? periodChoices[0]
  periodId = preferred?.id ?? ''
})

const selectedPeriod = $derived(periodChoices.find((p) => p.id === periodId) ?? null)
/** A draft is a statement about an open period. On a closed one the switch is not shown and the flag is inert. */
const draftAsked = $derived(draft && selectedPeriod?.status === 'open')

// ---------------------------------------------------------------- the preview

type Request = { legalEntityId: string; periodId: string; draft: boolean }

/** What Preview was last pressed for. Null until it is. */
let requested = $state<Request | null>(null)

/**
 * True while the preview on screen is for the selection on screen. The moment any of the three
 * inputs moves, the preview and the download go with it — a Download button beside figures for a
 * different entity is a wrong file waiting to happen.
 */
const current = $derived(
  requested !== null &&
    requested.legalEntityId === legalEntityId &&
    requested.periodId === periodId &&
    requested.draft === draftAsked,
)

const previewQuery = createQuery(() => ({
  queryKey: hrKeys.payrollExportPreview(
    workspaceId,
    requested?.legalEntityId ?? '',
    requested?.periodId ?? '',
    requested?.draft ?? false,
  ),
  enabled: Boolean(workspaceId) && requested !== null,
  queryFn: () =>
    api.payroll.export.preview({
      workspaceId,
      legalEntityId: requested?.legalEntityId ?? '',
      periodId: requested?.periodId ?? '',
      draft: requested?.draft ?? false,
    }),
}))
const preview = $derived(current ? (previewQuery.data ?? null) : null)

const canPreview = $derived(mayExport && legalEntityId !== '' && periodId !== '')

function runPreview() {
  if (!canPreview) return
  const next: Request = { legalEntityId, periodId, draft: draftAsked }
  if (current) {
    // Same question again: ask the server again rather than answering from cache, because the
    // whole point of pressing it twice is that something may have moved.
    void previewQuery.refetch()
    return
  }
  requested = next
}

/** Why Preview is off, in the order somebody would fix them. Null when nothing is blocking. */
const previewBlocked = $derived(
  canPreview
    ? null
    : !mayExport
      ? t('payroll_read_only')
      : legalEntityId === ''
        ? t('payroll_pick_entity_first')
        : t('payroll_period_none'),
)

/**
 * A refusal, in the reader's language.
 *
 * The server's sentence is English and names the fix; these say the same thing translated, with
 * the entity and the range from the manifest beside them. An unknown code — a refusal added to the
 * server before this screen learned it — falls back to the server's own words rather than to a
 * key.
 */
function refusalText(refusal: PayrollExportRefusal): string {
  const manifest = preview?.manifest
  const entity = manifest?.legalEntityName ?? ''
  const range = manifest ? rangeOf({ startsOn: manifest.periodStart, endsOn: manifest.periodEnd }) : ''
  switch (refusal.code) {
    case 'hr.period.not_locked':
      return t('payroll_refusal_not_locked', { range, entity })
    case 'hr.payroll.empty':
      return t('payroll_refusal_empty', { entity, range })
    case 'hr.payroll.no_employment':
      return t('payroll_refusal_no_employment', { count: refusal.personIds.length, entity })
    default:
      return refusal.message
  }
}

/**
 * Who a refusal is about, by name.
 *
 * The preview's hours rows carry everyone in the population — the server builds a row for a
 * person it refuses precisely so the screen can name them — so no second read is needed, and no
 * second permission. An id with no row is shown as its first eight characters rather than hidden.
 */
const nameOf = (personId: string): string =>
  preview?.hours.find((row) => row.personId === personId)?.displayName || personId.slice(0, 8)

/** The people at least one refusal names, so their rows below can be marked. */
const refusedPeople = $derived(new Set((preview?.refusals ?? []).flatMap((r) => r.personIds)))

/** How the preview failed to load, in a sentence. */
function failureText(error: unknown, fallbackKey: string): string {
  const failure = error as { code?: string; message?: string }
  if (failure.code === 'FORBIDDEN') return t('payroll_forbidden')
  return failure.message || t(fallbackKey)
}

// ---------------------------------------------------------------- the download

/**
 * One click, one export.
 *
 * `disabled={mutation.isPending}` reaches the button on the next render, and two quick clicks are
 * one render apart — which here means six files landing in somebody's downloads folder.
 */
let downloading = $state(false)
let downloadError = $state<string | null>(null)

/**
 * Hand one file to the browser.
 *
 * The CSV content already begins with the byte order mark the format promises, so nothing is
 * prepended here — a second BOM is a stray character in the first column name of every importer.
 * The object URL is released after a minute rather than immediately: Safari starts the download
 * asynchronously and a URL revoked on the same tick sometimes never opens.
 */
function saveFile(file: PayrollExportFile) {
  const blob = new Blob([file.content], { type: file.contentType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const download = createMutation(() => ({
  mutationFn: (input: Request) => api.payroll.export.v1({ workspaceId, ...input }),
  onSuccess: (result) => {
    for (const file of result.files) saveFile(file)
    downloadError = null
    toast.success(t('payroll_downloaded', { count: result.files.length }))
  },
  onError: (error: unknown) => {
    // The state moved between the preview and the download — somebody reopened the period, or a
    // person lost their employment row. The server's refusal is shown, and the preview is asked
    // again so the list above agrees with it.
    downloadError = failureText(error, 'payroll_download_error')
    void previewQuery.refetch()
  },
  onSettled: () => {
    downloading = false
  },
}))

function runDownload() {
  if (downloading || !requested || !current || !preview?.exportable) return
  downloading = true
  downloadError = null
  download.mutate({ ...requested })
}

// ---------------------------------------------------------------- what the tables show

/** Enough rows to check the file against, not the whole company. The count line says the rest. */
const ROW_CAP = 25
const hoursRows = $derived((preview?.hours ?? []).slice(0, ROW_CAP))
const leaveRows = $derived((preview?.leave ?? []).slice(0, ROW_CAP))

type Fact = { label: string; value: string }

const totals = $derived.by((): Fact[] => {
  const total = preview?.totals
  if (!total) return []
  return [
    { label: t('payroll_t_people'), value: num(total.people) },
    { label: t('payroll_t_day_sheets'), value: num(total.daySheets) },
    { label: t('payroll_t_scheduled'), value: duration(total.scheduledMinutes) },
    { label: t('payroll_t_worked'), value: duration(total.workedMinutes) },
    { label: t('payroll_t_scheduled_worked'), value: duration(total.scheduledWorkedMinutes) },
    { label: t('payroll_t_break'), value: duration(total.breakMinutes) },
    { label: t('payroll_t_overtime'), value: duration(total.overtimeMinutes) },
    { label: t('payroll_t_late'), value: duration(total.lateMinutes) },
    { label: t('payroll_t_early'), value: duration(total.earlyLeaveMinutes) },
    {
      label: t('payroll_t_beyond_cap'),
      // Empty, never zero: null means no ceiling applied, and that is a different fact from "0 over".
      value: total.beyondCapMinutes === null ? t('payroll_no_cap') : duration(total.beyondCapMinutes),
    },
    { label: t('payroll_t_capped'), value: num(total.cappedDays) },
    { label: t('payroll_t_uncapped'), value: num(total.uncappedDays) },
    { label: t('payroll_t_locked_days'), value: num(total.lockedDays) },
    { label: t('payroll_t_open_days'), value: num(total.openDays) },
    { label: t('payroll_t_paid_leave'), value: days(total.paidLeaveDays) },
    { label: t('payroll_t_unpaid_leave'), value: days(total.unpaidLeaveDays) },
  ]
})

const attendanceText = $derived.by(() => {
  const finality = preview?.manifest.attendance
  if (!finality) return ''
  if (finality.lockedDays + finality.openDays === 0) return t('payroll_attendance_none')
  if (finality.final) return t('payroll_attendance_final')
  return t('payroll_attendance_open', {
    count: finality.openDays,
    date: finality.firstOpenDay ? formatDate(finality.firstOpenDay) : '',
  })
})
</script>

<SettingsPage title={t('settings_payroll')} description={t('payroll_desc')}>
  {#if !mayExport}
    <!-- The pickers are readable without the permission; nothing on the page is actionable, and a
         screen that simply omits every control reads as broken rather than as restricted. -->
    <p class="note">{t('payroll_read_only')}</p>
  {/if}

  <!-- On the page, not in a tooltip: this is the sentence the reader will be asked to repeat. -->
  <p class="note">{t('payroll_no_pay')}</p>

  <!-- ---------------------------------------------------------------- what to export -->
  <SettingsSection title={t('payroll_pick_title')} description={t('payroll_pick_desc')}>
    {#if choicesLoading}
      <div class="rows">
        {#each [1, 2] as n (n)}<Skeleton height="60px" />{/each}
      </div>
    {:else if periodsQuery.isError}
      <EmptyState icon="triangle-alert" title={t('periods_error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void periodsQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if hasEntities && entitiesQuery.isError}
      <EmptyState icon="triangle-alert" title={t('payroll_entities_error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void entitiesQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if entityChoices.length === 0}
      <EmptyState icon="building" title={t('payroll_no_entities')} description={t('payroll_no_entities_desc')} />
    {:else}
      <div class="form">
        <Field label={t('office_entity')} hint={t('payroll_entity_hint')} required>
          {#snippet children(id)}
            <Select {id} bind:value={legalEntityId} options={entityChoices} placeholder={t('office_entity')} />
          {/snippet}
        </Field>

        {#if legalEntityId === ''}
          <!-- Nothing to say about periods until there is an employer to say it about. -->
        {:else if periodChoices.length === 0}
          <EmptyState compact icon="calendar-days" title={t('periods_none')} description={t('payroll_period_none')} />
        {:else}
          <Field label={t('periods_range')} hint={t('payroll_period_hint')} required>
            {#snippet children(id)}
              <Select {id} bind:value={periodId} options={periodOptions} placeholder={t('periods_range')} />
            {/snippet}
          </Field>

          {#if selectedPeriod?.status === 'open'}
            <!-- Only for an open period: on a closed one there is nothing for a draft to say. -->
            <Switch
              checked={draft}
              onCheckedChange={(on) => (draft = on)}
              label={t('payroll_draft')}
              description={t('payroll_draft_hint')}
            />
          {/if}
        {/if}
      </div>
    {/if}

    {#snippet footer()}
      <!-- A disabled control with no reason is a bug, so the reason sits beside the control. -->
      {#if previewBlocked && !choicesLoading && entityChoices.length > 0}
        <span class="blocked">{previewBlocked}</span>
      {/if}
      <Button onclick={runPreview} disabled={!canPreview} loading={current && previewQuery.isFetching}>
        {t('payroll_preview')}
      </Button>
    {/snippet}
  </SettingsSection>

  <!-- ---------------------------------------------------------------- the preview -->
  {#if requested !== null && current}
    {#if previewQuery.isLoading}
      <SettingsSection title={t('payroll_manifest_title')}>
        <div class="rows">
          {#each [1, 2, 3, 4] as n (n)}<Skeleton height="44px" />{/each}
        </div>
      </SettingsSection>
    {:else if previewQuery.isError}
      <SettingsSection title={t('payroll_manifest_title')}>
        <EmptyState
          icon="triangle-alert"
          title={t('payroll_preview_error')}
          description={failureText(previewQuery.error, 'payroll_preview_error')}
        >
          {#snippet actions()}
            <Button variant="secondary" onclick={() => void previewQuery.refetch()}>{t('retry')}</Button>
          {/snippet}
        </EmptyState>
      </SettingsSection>
    {:else if preview}
      {@const manifest = preview.manifest}
      {@const period = { startsOn: manifest.periodStart, endsOn: manifest.periodEnd }}

      <!-- Refusals or readiness, and the one button. -->
      <SettingsSection
        title={preview.exportable ? t('payroll_ready') : t('payroll_refusals_title')}
        description={preview.exportable ? t('payroll_ready_desc') : t('payroll_refusals_desc')}
        tone={preview.exportable ? 'default' : 'danger'}
      >
        {#if preview.refusals.length > 0}
          <ul class="refusals">
            {#each preview.refusals as refusal (refusal.code)}
              <li>
                <p class="refusal">{refusalText(refusal)}</p>
                {#if refusal.personIds.length > 0}
                  <p class="people">
                    <span class="sr-only">{t('payroll_refusal_people')}</span>
                    {#each refusal.personIds as personId (personId)}
                      <span class="chip">{nameOf(personId)}</span>
                    {/each}
                  </p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        <ul class="files" aria-label={t('payroll_files')}>
          {#each manifest.files as file (file.name)}
            <li>
              <code class="filename">{file.name}</code>
              <span class="meta">{t('payroll_file_rows', { count: file.rows })}</span>
            </li>
          {/each}
        </ul>

        {#if downloadError}
          <p class="failed" role="alert">{downloadError}</p>
        {/if}

        {#snippet footer()}
          {#if mayExport && !preview.exportable}
            <span class="blocked">{t('payroll_download_blocked')}</span>
          {/if}
          <Button
            icon="download"
            onclick={runDownload}
            disabled={!mayExport || !preview.exportable}
            loading={downloading}
          >
            {t('payroll_download')}
          </Button>
        {/snippet}
      </SettingsSection>

      <!-- The manifest, as facts. -->
      <SettingsSection title={t('payroll_manifest_title')}>
        <dl class="facts">
          <div>
            <dt>{t('office_entity')}</dt>
            <dd>{manifest.legalEntityName}</dd>
          </div>
          <div>
            <dt>{t('payroll_country')}</dt>
            <dd>{manifest.country}</dd>
          </div>
          <div>
            <dt>{t('payroll_currency')}</dt>
            <dd>{manifest.currency ?? t('payroll_currency_none')}</dd>
          </div>
          <div>
            <dt>{t('periods_range')}</dt>
            <dd class="with-badge">
              <span>{rangeOf(period)}</span>
              <Badge tone={statusTone(manifest.periodStatus)}>{statusLabel(manifest.periodStatus)}</Badge>
            </dd>
          </div>
          <div>
            <dt>{t('payroll_finality')}</dt>
            <dd>
              <Badge tone={manifest.draft ? 'warning' : 'done'}>
                {manifest.draft ? t('payroll_draft_badge') : t('payroll_final')}
              </Badge>
            </dd>
          </div>
          <div>
            <dt>{t('payroll_population')}</dt>
            <dd>{t('payroll_population_value', { counted: manifest.counted, population: manifest.population })}</dd>
          </div>
          <div>
            <dt>{t('payroll_attendance')}</dt>
            <dd>{attendanceText}</dd>
          </div>
        </dl>
      </SettingsSection>

      <!-- The totals. -->
      <SettingsSection title={t('payroll_totals_title')} description={t('payroll_totals_desc')}>
        <dl class="facts totals">
          {#each totals as fact (fact.label)}
            <div>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          {/each}
        </dl>
      </SettingsSection>

      <!-- hours.csv -->
      <SettingsSection title={t('payroll_hours_title')} flush={hoursRows.length > 0}>
        {#if hoursRows.length === 0}
          <EmptyState compact icon="users" title={t('payroll_hours_none')} />
        {:else}
          <div class="scroll">
            <div class="table hours" role="table" aria-label={t('payroll_hours_title')}>
              <div class="thead" role="row">
                <span role="columnheader">{t('payroll_col_person')}</span>
                <span role="columnheader">{t('payroll_col_employment')}</span>
                <span class="num" role="columnheader">{t('payroll_col_day_sheets')}</span>
                <span class="num" role="columnheader">{t('payroll_col_worked')}</span>
                <span class="num" role="columnheader">{t('payroll_col_overtime')}</span>
                <span class="num" role="columnheader">{t('payroll_col_leave')}</span>
                <span class="num" role="columnheader">{t('payroll_col_open')}</span>
              </div>
              {#each hoursRows as row (row.personId)}
                <div class="trow" role="row" class:refused={refusedPeople.has(row.personId)}>
                  <span class="cell what" role="cell">
                    <span class="strong">{row.displayName}</span>
                    {#if row.employeeNo}<span class="meta">{row.employeeNo}</span>{/if}
                  </span>
                  <span class="cell what" role="cell">
                    {#if refusedPeople.has(row.personId)}
                      <Badge tone="danger">{t('payroll_no_employment_badge')}</Badge>
                    {:else}
                      <span>{employmentLabel(row.employmentType)}</span>
                      <span class="meta">
                        {t('payroll_fte', { fte: formatDays(row.fte, messageLocale()) })}
                        {#if row.employmentChangedInPeriod}· {t('payroll_changed')}{/if}
                      </span>
                    {/if}
                  </span>
                  <span class="cell num" role="cell">{num(row.daySheets)}</span>
                  <span class="cell num" role="cell">{duration(row.workedMinutes)}</span>
                  <span class="cell num" role="cell">{duration(row.overtimeMinutes)}</span>
                  <span class="cell num" role="cell">
                    {formatDays(row.paidLeaveDays, messageLocale())} / {formatDays(row.unpaidLeaveDays, messageLocale())}
                  </span>
                  <span class="cell num" role="cell">{num(row.openDays)}</span>
                </div>
              {/each}
            </div>
          </div>
          {#if preview.hours.length > hoursRows.length}
            <p class="count">{t('payroll_showing', { shown: hoursRows.length, total: preview.hours.length })}</p>
          {/if}
        {/if}
      </SettingsSection>

      <!-- leave.csv -->
      <SettingsSection title={t('payroll_leave_title')} flush={leaveRows.length > 0}>
        {#if leaveRows.length === 0}
          <EmptyState compact icon="tree-palm" title={t('payroll_leave_none')} />
        {:else}
          <div class="scroll">
            <div class="table leave" role="table" aria-label={t('payroll_leave_title')}>
              <div class="thead" role="row">
                <span role="columnheader">{t('payroll_col_person')}</span>
                <span role="columnheader">{t('payroll_col_type')}</span>
                <span class="num" role="columnheader">{t('payroll_col_days')}</span>
                <span class="num" role="columnheader">{t('payroll_col_requests')}</span>
              </div>
              {#each leaveRows as row (`${row.personId}:${row.leaveTypeKey}`)}
                <div class="trow" role="row">
                  <span class="cell what" role="cell">
                    <span class="strong">{nameOf(row.personId)}</span>
                    {#if row.employeeNo}<span class="meta">{row.employeeNo}</span>{/if}
                  </span>
                  <span class="cell with-badge" role="cell">
                    <span>{row.leaveTypeName}</span>
                    <Badge tone={row.paid ? 'done' : 'grey'}>{row.paid ? t('payroll_paid') : t('payroll_unpaid')}</Badge>
                  </span>
                  <span class="cell num" role="cell">{formatDays(row.days, messageLocale())}</span>
                  <span class="cell num" role="cell">{num(row.requests)}</span>
                </div>
              {/each}
            </div>
          </div>
          {#if preview.leave.length > leaveRows.length}
            <p class="count">{t('payroll_showing', { shown: leaveRows.length, total: preview.leave.length })}</p>
          {/if}
        {/if}
      </SettingsSection>
    {/if}
  {/if}
</SettingsPage>

<style>
.rows {
  display: grid;
  gap: 4px;
}
.form {
  display: grid;
  gap: 14px;
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
.blocked {
  margin-inline-end: auto;
  font-size: 12px;
  line-height: 1.5;
  color: var(--kern-ink-700);
}
.failed {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}

/* ---- refusals ---- */
.refusals {
  display: grid;
  gap: 12px;
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
}
.refusal {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.5;
}
.people {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding-inline: 8px;
  border-radius: var(--kern-r-sm);
  background: var(--kern-danger-tint);
  color: var(--kern-danger);
  font-size: 12px;
  font-weight: 500;
}

/* ---- the files ---- */
.files {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.files li {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.filename {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12.5px;
}

/* ---- facts ---- */
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px 16px;
  margin: 0;
}
.facts > div {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.facts dt {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.facts dd {
  margin: 0;
  font-size: 13.5px;
  overflow-wrap: anywhere;
}
.totals dd {
  font-variant-numeric: tabular-nums;
}
.with-badge {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* ---- the row tables ---- */
/* The table scrolls inside its card; the page never scrolls sideways, in either direction. */
.scroll {
  overflow-x: auto;
}
.table {
  min-width: 100%;
  width: max-content;
}
.hours {
  --hr-payroll-cols: minmax(160px, 1.4fr) minmax(140px, 1fr) 72px 88px 88px 110px 72px;
}
.leave {
  --hr-payroll-cols: minmax(160px, 1.4fr) minmax(180px, 1fr) 72px 88px;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-payroll-cols);
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
  min-height: 48px;
  padding-block: 6px;
  border-block-end: 1px solid var(--kern-border-hairline);
}
.trow:last-child {
  border-block-end: none;
}
/* A colour, not opacity: the row is marked, and its text still has to be read. */
.trow.refused {
  background: var(--kern-danger-tint);
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
  color: var(--kern-ink-500);
}
.num {
  text-align: end;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.count {
  margin: 8px 18px 10px;
  font-size: 12px;
  color: var(--kern-ink-500);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
