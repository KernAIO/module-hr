<script lang="ts">
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  formatDate,
  formatDateTime,
  Icon,
  Input,
  messageLocale,
  navigation,
  Select,
  type SelectOption,
  SettingsPage,
  SettingsSection,
  Skeleton,
  Switch,
  session,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type {
  ErasureCaveat,
  ErasureClass,
  ErasureReport,
  RetentionBasis,
  RetentionClass,
  RetentionClassRun,
  RetentionRun,
  SubjectAccessManifest,
} from '../../contract/privacy.js'
import { getHrApi } from '../api-instance.js'
import { explainRefusal } from '../components/refusal.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { hrKeys, isoDate } from '../query.js'

/**
 * Retention, subject access and erasure — the three things a data-protection law asks a personnel
 * system for, on one page, behind one key.
 *
 * This is the most consequential screen in the module and it is built on three positions the
 * server already took, each of which the page has to keep visible rather than merely obey:
 *
 * - **Nothing here deletes unless the sweep is on.** Retention horizons are counted; acting on them
 *   is a switch an administrator turns, and the page says which it is in a sentence rather than
 *   hiding the fact in a tooltip. The sweep itself previews first, like the erasure. Erasure
 *   clears the columns that identify a person and leaves every record a wage, an entitlement or an
 *   authorisation was computed from; the report's `kept` half is rendered as prominently as its
 *   `redacted` half, because an erasure that silently retains is the same failure as an export that
 *   silently omits.
 * - **Every destructive act previews first.** `privacy.erase` defaults to a dry run and this page
 *   never sends `dryRun: false` until the preview for *exactly this* person, reason and switch has
 *   been shown — change any of the three and the preview is stale, the button goes, and the
 *   preview has to be asked for again. Then a dialog names the person, restates what happens, and
 *   takes the name typed back before the act.
 * - **An export is a bulk read of the sensitive record.** The bundle decrypts the identity number
 *   and bank details, so the page says so before the button, and the download is logged against the
 *   caller as an `export` read — which the subject sees in their own access log.
 *
 * No number here is a default. "Seven years" is a fact about one country and one document class;
 * the suggested figures live in the help text beside the sentence saying Kern gives no legal
 * advice, and every class ships as "kept indefinitely".
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/**
 * The page is registered behind `hr.privacy.manage`, and the check is repeated here rather than
 * assumed: a role edit takes effect on the next render, and a button that 403s is worse than none.
 */
const manage = $derived(canHr('privacyManage'))

const num = (n: number): string => new Intl.NumberFormat(messageLocale()).format(n)

// ====================================================================================
// labels for every enum the contract renders through the client
// ====================================================================================

const CLASSES: RetentionClass[] = [
  'punchDetail',
  'punches',
  'attendanceDays',
  'leave',
  'personHistory',
  'personDocuments',
  'terminatedPeople',
  'sensitiveAccessLog',
]

const CLASS_LABEL: Record<RetentionClass, () => string> = {
  punchDetail: () => t('privacy_class_punch_detail'),
  punches: () => t('privacy_class_punches'),
  attendanceDays: () => t('privacy_class_attendance_days'),
  leave: () => t('privacy_class_leave'),
  personHistory: () => t('privacy_class_person_history'),
  personDocuments: () => t('privacy_class_person_documents'),
  terminatedPeople: () => t('privacy_class_terminated_people'),
  sensitiveAccessLog: () => t('privacy_class_sensitive_access_log'),
}
const CLASS_DESC: Record<RetentionClass, () => string> = {
  punchDetail: () => t('privacy_class_punch_detail_desc'),
  punches: () => t('privacy_class_punches_desc'),
  attendanceDays: () => t('privacy_class_attendance_days_desc'),
  leave: () => t('privacy_class_leave_desc'),
  personHistory: () => t('privacy_class_person_history_desc'),
  personDocuments: () => t('privacy_class_person_documents_desc'),
  terminatedPeople: () => t('privacy_class_terminated_people_desc'),
  sensitiveAccessLog: () => t('privacy_class_sensitive_access_log_desc'),
}

const ERASURE_CLASS: Record<ErasureClass, () => string> = {
  identity: () => t('privacy_eclass_identity'),
  sensitive: () => t('privacy_eclass_sensitive'),
  history: () => t('privacy_eclass_history'),
  documents: () => t('privacy_eclass_documents'),
  punches: () => t('privacy_eclass_punches'),
  attendance: () => t('privacy_eclass_attendance'),
  leaveRequests: () => t('privacy_eclass_leave_requests'),
  leaveLedger: () => t('privacy_eclass_leave_ledger'),
  employment: () => t('privacy_eclass_employment'),
  officeAssignments: () => t('privacy_eclass_office_assignments'),
  approvals: () => t('privacy_eclass_approvals'),
  approvalDecisions: () => t('privacy_eclass_approval_decisions'),
  regularizations: () => t('privacy_eclass_regularizations'),
  delegations: () => t('privacy_eclass_delegations'),
  headship: () => t('privacy_eclass_headship'),
}

/** Why a record survived, as a sentence the person who asked to be forgotten can read. */
const BASIS: Record<RetentionBasis, () => string> = {
  payRecord: () => t('privacy_basis_pay_record'),
  auditTrail: () => t('privacy_basis_audit_trail'),
  retentionHorizon: () => t('privacy_basis_retention_horizon'),
  notRemovable: () => t('privacy_basis_not_removable'),
  anotherPersonsRecord: () => t('privacy_basis_another_persons_record'),
}

const CAVEAT: Record<ErasureCaveat, () => string> = {
  documentFilesRemain: () => t('privacy_caveat_document_files_remain'),
  photoFileOrphaned: () => t('privacy_caveat_photo_file_orphaned'),
  leaveDocumentFilesRemain: () => t('privacy_caveat_leave_document_files_remain'),
  nationalIdKeptForAudit: () => t('privacy_caveat_national_id_kept'),
  actorHistoryKept: () => t('privacy_caveat_actor_history_kept'),
  lockedPeriodUntouched: () => t('privacy_caveat_locked_period_untouched'),
}

type ExclusionReason = SubjectAccessManifest['excluded'][number]['reason']
const EXCLUDED: Record<ExclusionReason, () => string> = {
  fileContentsNotExportable: () => t('privacy_excluded_file_contents'),
  notRequested: () => t('privacy_excluded_not_requested'),
}

// ====================================================================================
// retention
// ====================================================================================

const retentionQuery = createQuery(() => ({
  queryKey: hrKeys.retention(workspaceId),
  enabled: Boolean(workspaceId),
  // The counts are the dry run. They cost a query per class with a horizon, and this is the one
  // screen that must show them: a horizon with no "already past it" beside it is a data-loss
  // setting with no preview.
  queryFn: () => api.privacy.retention.get({ workspaceId, withCounts: true }),
}))
const retention = $derived(retentionQuery.data)

const stored = $derived.by(() => {
  const out = {} as Record<RetentionClass, number | null>
  for (const cls of CLASSES) out[cls] = retention?.classes.find((c) => c.class === cls)?.days ?? null
  return out
})
const dueNow = (cls: RetentionClass): number | null =>
  retention?.classes.find((c) => c.class === cls)?.dueNow ?? null

/**
 * Held as text, not numbers: an input somebody is half-way through clearing is empty, and a number
 * input turns that into `undefined` — which reads as "no change" and would save the old value
 * behind their back. Empty here means "keep indefinitely", which is a value, and is sent as null.
 */
const blankForm = () => Object.fromEntries(CLASSES.map((c) => [c, ''])) as Record<RetentionClass, string>
let horizons = $state<Record<RetentionClass, string>>(blankForm())
let loaded = $state(false)

$effect(() => {
  if (loaded || !retention) return
  for (const cls of CLASSES) horizons[cls] = stored[cls] === null ? '' : String(stored[cls])
  loaded = true
})

function discard() {
  loaded = false
}

/** A Persian keyboard produces ۱۲۳ and an Arabic one ١٢٣; `Number` reads neither. */
const toLatinDigits = (value: string) =>
  value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))

/** Null is "keep indefinitely"; `undefined` is text the contract would refuse. */
function parseDays(text: string): number | null | undefined {
  const digits = toLatinDigits(text.trim())
  if (digits === '') return null
  if (!/^\d{1,5}$/.test(digits)) return undefined
  const n = Number(digits)
  return n >= 1 && n <= 36_500 ? n : undefined
}

const parsed = $derived(
  Object.fromEntries(CLASSES.map((c) => [c, parseDays(horizons[c])])) as Record<
    RetentionClass,
    number | null | undefined
  >,
)
const valid = $derived(CLASSES.every((c) => parsed[c] !== undefined))
/** Only the classes that moved go to the server: a field left out is unchanged, by contract. */
const changed = $derived(CLASSES.filter((c) => parsed[c] !== undefined && parsed[c] !== stored[c]))
const dirty = $derived(loaded && changed.length > 0)

let saving = $state(false)
let saveError = $state<string | null>(null)

const saveRetention = createMutation(() => ({
  mutationFn: () =>
    api.privacy.retention.set({
      workspaceId,
      retention: Object.fromEntries(changed.map((c) => [c, parsed[c] ?? null])),
    }),
  onSuccess: (data) => {
    saveError = null
    // What came back is the truth for the horizons; the counts are asked for again, because a moved
    // horizon changes what is past it and the write does not compute that.
    queryClient.setQueryData(hrKeys.retention(workspaceId), data)
    loaded = false
    void queryClient.invalidateQueries({ queryKey: hrKeys.retention(workspaceId) })
    toast.success(t('privacy_ret_saved'))
  },
  onError: (err) => {
    saveError = explainRefusal(err, t('privacy_ret_save_error'))
  },
  onSettled: () => {
    saving = false
  },
}))

/** A plain flag set in the same tick as the click; `isPending` reaches the button a render late. */
function runSaveRetention() {
  if (saving || !dirty || !valid || !manage) return
  saving = true
  saveError = null
  saveRetention.mutate()
}

// ====================================================================================
// the sweep
// ====================================================================================

/**
 * The one unattended act in HR that re-running nothing can undo, so the screen is built the way the
 * erasure below is: a dry run first, a preview that names every class and every count, a
 * confirmation that restates what goes, and a list of every run — dry, real, nightly, by hand — so
 * "what did the sweep do last night" is answered here and not in a log.
 *
 * The dry run is pinned to the horizons it was computed against. Change a horizon and the preview
 * is stale: **Run now** is withdrawn until it is run again, because the sentence on the confirm
 * dialog says "the last dry run says", and that has to be true of the horizons in force.
 */
const sweepOn = $derived(retention?.sweepEnabled ?? false)
/** Whether any class has a horizon at all — a sweep with none set does nothing, and says so. */
const anyHorizon = $derived(CLASSES.some((c) => stored[c] !== null))

let switching = $state(false)
let switchError = $state<string | null>(null)

const setSweep = createMutation(() => ({
  mutationFn: (enabled: boolean) =>
    api.privacy.retention.set({ workspaceId, retention: {}, sweepEnabled: enabled }),
  onSuccess: (data) => {
    switchError = null
    queryClient.setQueryData(hrKeys.retention(workspaceId), data)
    void queryClient.invalidateQueries({ queryKey: hrKeys.retention(workspaceId) })
    toast.success(t(data.sweepEnabled ? 'privacy_sweep_on' : 'privacy_sweep_off'))
  },
  onError: (err) => {
    switchError = explainRefusal(err, t('privacy_sweep_switch_error'))
  },
  onSettled: () => {
    switching = false
  },
}))

function toggleSweep(enabled: boolean) {
  if (switching || !manage) return
  switching = true
  switchError = null
  setSweep.mutate(enabled)
}

/** The last dry run, and the horizons it was computed against. */
let sweepPreview = $state<RetentionRun | null>(null)
let sweepPreviewAgainst = $state<string>('')
/** The last real run this screen performed, shown until the next dry run replaces it. */
let swept = $state<RetentionRun | null>(null)
let sweeping = $state<'dry' | 'real' | null>(null)
let sweepError = $state<string | null>(null)
let confirmSweep = $state(false)

const horizonKey = $derived(CLASSES.map((c) => `${c}=${stored[c] ?? ''}`).join(','))
const sweepPreviewStale = $derived(sweepPreview !== null && sweepPreviewAgainst !== horizonKey)
/** Anything at all would go: the confirm button is offered only when the dry run found something. */
const sweepPreviewHasWork = $derived((sweepPreview?.classes ?? []).some((c) => c.affected > 0))

const runSweep = createMutation(() => ({
  mutationFn: (dryRun: boolean) => api.privacy.retention.run({ workspaceId, dryRun }),
  onSuccess: (run, dryRun) => {
    sweepError = null
    if (dryRun) {
      sweepPreview = run
      sweepPreviewAgainst = horizonKey
      swept = null
    } else {
      swept = run
      sweepPreview = null
      confirmSweep = false
      // Rows are gone: the counts beside every horizon, the runs list, and any person card the
      // sweep redacted all have to be read again.
      void queryClient.invalidateQueries({ queryKey: hrKeys.retention(workspaceId) })
      void queryClient.invalidateQueries({ queryKey: hrKeys.people(workspaceId) })
    }
    void queryClient.invalidateQueries({ queryKey: hrKeys.retentionRuns(workspaceId) })
  },
  onError: (err, dryRun) => {
    sweepError = explainRefusal(err, t(dryRun ? 'privacy_sweep_dry_error' : 'privacy_sweep_run_error'))
    confirmSweep = false
    void queryClient.invalidateQueries({ queryKey: hrKeys.retentionRuns(workspaceId) })
  },
  onSettled: () => {
    sweeping = null
  },
}))

function dryRunNow() {
  if (sweeping || !manage) return
  sweeping = 'dry'
  sweepError = null
  runSweep.mutate(true)
}

function sweepNow() {
  if (sweeping || !manage || !sweepPreview || sweepPreviewStale) return
  sweeping = 'real'
  sweepError = null
  runSweep.mutate(false)
}

const runsQuery = createQuery(() => ({
  queryKey: hrKeys.retentionRuns(workspaceId),
  enabled: Boolean(workspaceId) && manage,
  queryFn: () => api.privacy.retention.runs.list({ workspaceId, limit: 20 }),
}))
const runs = $derived<RetentionRun[]>(runsQuery.data ?? [])

/** "3 punches · 12 day sheets", the classes a run touched, in the order the table above shows them. */
const affectedSummary = (classes: RetentionClassRun[]): string =>
  classes
    .filter((c) => c.affected > 0)
    .map((c) => `${CLASS_LABEL[c.class]()} ${num(c.affected)}`)
    .join(' · ')

// ====================================================================================
// the person pickers
// ====================================================================================

/**
 * Everybody, whatever their status. The people these two sections are about have very often left:
 * a subject-access request from a former employee is the ordinary case, and an erasure of somebody
 * still employed is the rare one.
 */
const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forPrivacy: true }),
  enabled: Boolean(workspaceId),
  queryFn: () => api.people.list({ workspaceId, limit: 200 }),
}))
const people = $derived(peopleQuery.data?.items ?? [])
const personOptions = $derived<SelectOption[]>(
  people.map((p) => ({
    value: p.id,
    label: p.displayName,
    description: p.erasedAt ? t('privacy_person_erased') : (p.employeeNo ?? undefined),
  })),
)

// ====================================================================================
// subject access
// ====================================================================================

let exportPersonId = $state('')
let exportPurpose = $state('')
let downloading = $state(false)
let lastManifest = $state<SubjectAccessManifest | null>(null)
const exportPerson = $derived(people.find((p) => p.id === exportPersonId))

/**
 * Hand the bundle to the browser as a file.
 *
 * A Blob and an anchor rather than a data URL: the bundle of a five-year employee is a few
 * megabytes, which a data URL would double and some browsers refuse. The object URL is revoked
 * after a minute rather than at once — revoking it in the same tick as the click loses the
 * download in Safari.
 */
function saveJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const download = createMutation(() => ({
  mutationFn: () =>
    api.privacy.subjectAccess({
      workspaceId,
      personId: exportPersonId,
      purpose: exportPurpose.trim() || undefined,
    }),
  onSuccess: (bundle) => {
    saveJson(bundle, `hr-subject-access-${bundle.manifest.personId}-${isoDate()}.json`)
    lastManifest = bundle.manifest
    // The export wrote an access-log row; the subject's panel should show it without a reload.
    void queryClient.invalidateQueries({ queryKey: hrKeys.accessLog(workspaceId, bundle.manifest.personId) })
    toast.success(t('privacy_sar_done'))
  },
  onError: (err) => toast.error(explainRefusal(err, t('privacy_sar_error'))),
  onSettled: () => {
    downloading = false
  },
}))

function runDownload() {
  if (downloading || !exportPersonId || !manage) return
  downloading = true
  download.mutate()
}

// ====================================================================================
// erasure
// ====================================================================================

let erasePersonId = $state('')
let eraseReason = $state('')
let keepNationalId = $state(false)
const erasePerson = $derived(people.find((p) => p.id === erasePersonId))

let preview = $state<ErasureReport | null>(null)
/** What the preview was computed for. Any change to person, reason or switch makes it stale. */
let previewedFor = $state('')
const eraseKey = $derived(`${erasePersonId}\n${eraseReason.trim()}\n${keepNationalId}`)
const previewCurrent = $derived(Boolean(preview?.dryRun) && previewedFor === eraseKey)

let final = $state<ErasureReport | null>(null)
let previewing = $state(false)
let erasing = $state(false)
let confirmOpen = $state(false)
let typedName = $state('')
const nameMatches = $derived(erasePerson !== undefined && typedName.trim() === erasePerson.displayName)

const reasonMissing = $derived(eraseReason.trim().length === 0)

const erase = createMutation(() => ({
  mutationFn: (dryRun: boolean) =>
    api.privacy.erase({
      workspaceId,
      personId: erasePersonId,
      reason: eraseReason.trim(),
      dryRun,
      keepNationalIdForAudit: keepNationalId,
    }),
  onSuccess: (report, dryRun) => {
    if (dryRun) {
      preview = report
      previewedFor = eraseKey
      final = null
      return
    }
    final = report
    preview = null
    confirmOpen = false
    typedName = ''
    toast.success(t('privacy_erase_done', { name: report.displayName }))
    // The person is a different record now, everywhere: directory, panel, every list that names them.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (err) => toast.error(explainRefusal(err, t('privacy_erase_error'))),
  onSettled: () => {
    previewing = false
    erasing = false
  },
}))

function runPreview() {
  if (previewing || erasing || !erasePersonId || reasonMissing || !manage) return
  previewing = true
  final = null
  erase.mutate(true)
}

function openConfirm() {
  if (!previewCurrent || !erasePerson) return
  typedName = ''
  confirmOpen = true
}

function runErase() {
  if (erasing || !previewCurrent || !nameMatches || !manage) return
  erasing = true
  erase.mutate(false)
}

/** Rows that still have something to clear come first; a class with nothing to do is muted below. */
const withRows = (rows: ErasureReport['redacted']) =>
  [...rows].sort((a, b) => Number(b.rows > 0) - Number(a.rows > 0))
</script>

{#snippet retentionBar()}
  <Button size="sm" variant="secondary" onclick={discard} disabled={!dirty || saving}>
    {t('common.discard')}
  </Button>
  <Button size="sm" onclick={runSaveRetention} disabled={!dirty || !valid} loading={saving}>
    {t('common.save')}
  </Button>
{/snippet}

{#snippet report(r: ErasureReport)}
  <div class="report" class:final={!r.dryRun}>
    <p class="report-lead">
      {#if r.dryRun}
        <Icon name="eye" size={14} strokeWidth={1.8} />
        <span>{t('privacy_erase_preview_lead', { name: r.displayName })}</span>
      {:else}
        <Icon name="check" size={14} strokeWidth={1.8} />
        <span>
          {t('privacy_erase_done_lead', {
            name: r.displayName,
            when: r.erasedAt ? formatDateTime(r.erasedAt) : '—',
          })}
        </span>
      {/if}
    </p>

    <h3 class="report-h">{r.dryRun ? t('privacy_erase_would_clear') : t('privacy_erase_cleared')}</h3>
    <div class="scroll">
      <Table columns="minmax(140px,1.2fr) minmax(120px,1fr) 70px minmax(160px,1.6fr)" dense ariaLabel={t('privacy_erase_would_clear')}>
        <TableHeader>
          <TableCell header>{t('privacy_col_class')}</TableCell>
          <TableCell header>{t('privacy_col_table')}</TableCell>
          <TableCell header end>{t('privacy_col_rows')}</TableCell>
          <TableCell header>{t('privacy_col_columns')}</TableCell>
        </TableHeader>
        {#each withRows(r.redacted) as row (row.class + row.table)}
          <TableRow class={row.rows === 0 ? 'nothing' : undefined}>
            <TableCell>{ERASURE_CLASS[row.class]()}</TableCell>
            <TableCell><span class="mono">{row.table}</span></TableCell>
            <TableCell end><span class="tabular">{num(row.rows)}</span></TableCell>
            <TableCell><span class="mono wrap">{row.columns.join(', ')}</span></TableCell>
          </TableRow>
        {/each}
      </Table>
    </div>

    <h3 class="report-h">{t('privacy_erase_kept')}</h3>
    <p class="report-note">{t('privacy_erase_kept_desc')}</p>
    <div class="scroll">
      <Table columns="minmax(140px,1.2fr) 70px minmax(220px,2fr) 110px" dense ariaLabel={t('privacy_erase_kept')}>
        <TableHeader>
          <TableCell header>{t('privacy_col_class')}</TableCell>
          <TableCell header end>{t('privacy_col_rows')}</TableCell>
          <TableCell header>{t('privacy_col_basis')}</TableCell>
          <TableCell header end>{t('privacy_col_horizon')}</TableCell>
        </TableHeader>
        {#each r.kept as row, i (`${row.class}-${row.basis}-${i}`)}
          <TableRow class={row.rows === 0 ? 'nothing' : undefined}>
            <TableCell>
              <span class="cell-stack">
                <span>{ERASURE_CLASS[row.class]()}</span>
                <span class="mono sub">{row.table}</span>
              </span>
            </TableCell>
            <TableCell end><span class="tabular">{num(row.rows)}</span></TableCell>
            <TableCell><span class="wrap">{BASIS[row.basis]()}</span></TableCell>
            <TableCell end>
              {#if row.retentionDays === null}
                <span class="muted">{t('privacy_ret_indefinite')}</span>
              {:else}
                <span class="tabular">{t('privacy_days_value', { count: row.retentionDays })}</span>
              {/if}
            </TableCell>
          </TableRow>
        {/each}
      </Table>
    </div>

    {#if r.caveats.length || r.filesRemaining.length}
      <h3 class="report-h">{t('privacy_erase_caveats')}</h3>
      <ul class="caveats">
        {#each r.caveats as caveat (caveat)}
          <li><Icon name="info" size={14} strokeWidth={1.8} /><span>{CAVEAT[caveat]()}</span></li>
        {/each}
        {#if r.filesRemaining.length}
          <li>
            <Icon name="file-text" size={14} strokeWidth={1.8} />
            <span>{t('privacy_erase_files_remaining', { count: r.filesRemaining.length })}</span>
          </li>
        {/if}
      </ul>
    {/if}
  </div>
{/snippet}

<SettingsPage title={t('settings_privacy')} description={t('settings_privacy_desc')}>
  {#if !manage}
    <p class="readonly">{t('privacy_readonly')}</p>
  {/if}

  <!-- ================================================================ retention -->
  <SettingsSection
    title={t('privacy_ret_title')}
    description={t('privacy_ret_desc')}
    footer={manage && retention ? retentionBar : undefined}
  >
    {#if !workspaceId || retentionQuery.isLoading}
      <Skeleton lines={6} />
    {:else if retentionQuery.isError}
      <EmptyState compact icon="triangle-alert" title={t('privacy_ret_error')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void retentionQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if retention}
      <p class="note warn">
        <Icon name="info" size={14} strokeWidth={1.7} />
        <span>{t('privacy_ret_no_sweep')}</span>
      </p>

      <div class="classes">
        <div class="class-head" aria-hidden="true">
          <span>{t('privacy_col_class')}</span>
          <span>{t('privacy_ret_days')}</span>
          <span class="end">{t('privacy_ret_due_now')}</span>
        </div>
        {#each CLASSES as cls (cls)}
          {@const err = parsed[cls] === undefined ? t('privacy_ret_invalid') : null}
          {@const due = dueNow(cls)}
          <div class="class-row">
            <label class="class-label" for={`hr-ret-${cls}`}>
              <span class="class-name">{CLASS_LABEL[cls]()}</span>
              <span class="class-desc">{CLASS_DESC[cls]()}</span>
            </label>
            <div class="class-input">
              <Input
                id={`hr-ret-${cls}`}
                bind:value={horizons[cls]}
                inputmode="numeric"
                maxlength={5}
                mono
                placeholder={t('privacy_ret_indefinite')}
                disabled={!manage}
                error={err}
              />
            </div>
            <div class="class-due end">
              {#if due === null}
                <span class="muted">—</span>
              {:else}
                <span class="tabular" class:hot={due > 0}>{num(due)}</span>
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <p class="note">{t('privacy_ret_no_advice')}</p>
      {#if retention.updatedAt}
        <p class="note">{t('privacy_ret_updated', { when: formatDateTime(retention.updatedAt) })}</p>
      {/if}
      {#if saveError}
        <p class="save-error" role="alert">{saveError}</p>
      {/if}
    {/if}
  </SettingsSection>

  <!-- ================================================================ the sweep -->
  {#if manage && retention}
    <SettingsSection title={t('privacy_sweep_title')} description={t('privacy_sweep_switch_desc')}>
      <div class="sweep-switch">
        <Switch
          checked={sweepOn}
          label={t('privacy_sweep_switch')}
          disabled={!manage}
          onCheckedChange={(next) => toggleSweep(next)}
        />
      </div>
      {#if switchError}
        <p class="save-error" role="alert">{switchError}</p>
      {/if}
      {#if sweepOn}
        <p class="note warn">
          <Icon name="info" size={14} strokeWidth={1.7} />
          <span>{t('privacy_sweep_active')}</span>
        </p>
      {/if}
      {#if !anyHorizon}
        <p class="note">{t('privacy_sweep_none')}</p>
      {/if}

      <div class="sweep-actions">
        <Button size="sm" variant="secondary" onclick={dryRunNow} loading={sweeping === 'dry'} disabled={!anyHorizon}>
          {t('privacy_sweep_dry_run')}
        </Button>
        {#if sweepPreview && sweepPreviewHasWork && !sweepPreviewStale}
          <Button size="sm" variant="danger" onclick={() => (confirmSweep = true)} loading={sweeping === 'real'}>
            {t('privacy_sweep_run')}
          </Button>
        {/if}
      </div>
      {#if sweepError}
        <p class="save-error" role="alert">{sweepError}</p>
      {/if}

      {#if sweepPreview}
        <div class="report">
          <p class="report-lead">
            <Icon name="eye" size={14} strokeWidth={1.8} />
            <span>{t('privacy_sweep_dry_lead')}</span>
          </p>
          {#if sweepPreviewStale}
            <p class="note warn"><span>{t('privacy_sweep_stale')}</span></p>
          {/if}
          {#if sweepPreview.classes.length === 0 || !sweepPreviewHasWork}
            <p class="note">{t('privacy_sweep_nothing')}</p>
          {:else}
            <Table columns="minmax(0, 2fr) 1fr 1fr 1fr" ariaLabel={t('privacy_sweep_dry_lead')}>
              <TableHeader>
                <TableCell header>{t('privacy_col_class')}</TableCell>
                <TableCell header end>{t('privacy_sweep_col_matched')}</TableCell>
                <TableCell header end>{t('privacy_sweep_col_would')}</TableCell>
                <TableCell header end>{t('privacy_sweep_col_locked')}</TableCell>
              </TableHeader>
              {#each sweepPreview.classes as row (row.class)}
                <TableRow>
                  <TableCell>{CLASS_LABEL[row.class]()}</TableCell>
                  <TableCell end><span class="tabular">{num(row.matched)}</span></TableCell>
                  <TableCell end><span class="tabular" class:hot={row.affected > 0}>{num(row.affected)}</span></TableCell>
                  <TableCell end><span class="tabular">{num(row.skippedLocked)}</span></TableCell>
                </TableRow>
              {/each}
            </Table>
            <p class="note">{t('privacy_sweep_people', { count: sweepPreview.personIds.length })}</p>
          {/if}
        </div>
      {/if}

      {#if swept}
        <div class="report final">
          <p class="report-lead">
            <Icon name="check" size={14} strokeWidth={1.8} />
            <span>{t('privacy_sweep_done_lead', { when: formatDateTime(swept.finishedAt ?? swept.startedAt) })}</span>
          </p>
          <p class="note">{affectedSummary(swept.classes) || t('privacy_sweep_nothing')}</p>
          <p class="note">{t('privacy_sweep_people', { count: swept.personIds.length })}</p>
          {#if swept.fileIds.length}
            <p class="note">{t('privacy_sweep_files', { count: swept.fileIds.length })}</p>
          {/if}
        </div>
      {/if}

      <h3 class="kern-sublabel runs-title">{t('privacy_sweep_runs_title')}</h3>
      {#if runsQuery.isLoading}
        <Skeleton lines={3} />
      {:else if runsQuery.isError}
        <EmptyState compact icon="triangle-alert" title={t('privacy_sweep_runs_error')}>
          {#snippet actions()}
            <Button size="sm" variant="secondary" onclick={() => void runsQuery.refetch()}>{t('retry')}</Button>
          {/snippet}
        </EmptyState>
      {:else if runs.length === 0}
        <p class="note">{t('privacy_sweep_runs_empty')}</p>
      {:else}
        <Table columns="minmax(0, 1.2fr) 0.8fr minmax(0, 2fr) 0.7fr" ariaLabel={t('privacy_sweep_runs_title')}>
          <TableHeader>
            <TableCell header>{t('privacy_sweep_col_when')}</TableCell>
            <TableCell header>{t('privacy_sweep_col_kind')}</TableCell>
            <TableCell header>{t('privacy_sweep_col_classes')}</TableCell>
            <TableCell header end>{t('privacy_sweep_col_people')}</TableCell>
          </TableHeader>
          {#each runs as run (run.id)}
            <TableRow>
              <TableCell>
                <span class="stack">
                  <span>{formatDateTime(run.startedAt)}</span>
                  <span class="muted">{run.startedBy ? t('privacy_sweep_by_hand') : t('privacy_sweep_by_job')}</span>
                </span>
              </TableCell>
              <TableCell>
                {#if run.error}
                  <span class="hot">{t('privacy_sweep_failed')}</span>
                {:else}
                  {t(run.dryRun ? 'privacy_sweep_kind_dry' : 'privacy_sweep_kind_real')}
                {/if}
              </TableCell>
              <TableCell>
                <span class="wrap">{run.error ?? (affectedSummary(run.classes) || t('privacy_sweep_nothing'))}</span>
              </TableCell>
              <TableCell end><span class="tabular">{num(run.personIds.length)}</span></TableCell>
            </TableRow>
          {/each}
        </Table>
      {/if}
    </SettingsSection>
  {/if}

  <!-- ================================================================ subject access -->
  <SettingsSection title={t('privacy_sar_title')} description={t('privacy_sar_desc')}>
    <div class="form">
      <Field label={t('privacy_person')} id="hr-sar-person">
        {#snippet children(id)}
          <Select
            {id}
            bind:value={exportPersonId}
            options={personOptions}
            placeholder={t('privacy_person_pick')}
            ariaLabel={t('privacy_person')}
            disabled={!manage || peopleQuery.isLoading}
            width="320px"
          />
        {/snippet}
      </Field>
      <Field label={t('privacy_purpose')} hint={t('privacy_purpose_hint')} id="hr-sar-purpose">
        {#snippet children(id)}
          <Input {id} bind:value={exportPurpose} maxlength={500} disabled={!manage} />
        {/snippet}
      </Field>

      <p class="note warn">
        <Icon name="lock" size={14} strokeWidth={1.7} />
        <span>
          {exportPerson
            ? t('privacy_sar_warning_named', { name: exportPerson.displayName })
            : t('privacy_sar_warning')}
        </span>
      </p>

      <div class="actions">
        <Button icon="download" onclick={runDownload} disabled={!exportPersonId || !manage} loading={downloading}>
          {t('privacy_sar_download')}
        </Button>
      </div>

      {#if lastManifest}
        <div class="manifest">
          <p class="manifest-lead">
            <Icon name="check" size={14} strokeWidth={1.8} />
            <span>{t('privacy_sar_generated', { when: formatDateTime(lastManifest.generatedAt) })}</span>
          </p>
          {#if lastManifest.truncated.length}
            <p class="manifest-h">{t('privacy_sar_truncated')}</p>
            <ul class="manifest-list">
              {#each lastManifest.truncated as cut (cut.section)}
                <li>
                  <span class="mono">{cut.section}</span>
                  <span class="muted">
                    {t('privacy_sar_truncated_row', { returned: num(cut.returned), cap: num(cut.cap) })}
                  </span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="note">{t('privacy_sar_complete')}</p>
          {/if}
          {#if lastManifest.excluded.length}
            <p class="manifest-h">{t('privacy_sar_excluded')}</p>
            <ul class="manifest-list">
              {#each lastManifest.excluded as ex (ex.section)}
                <li>
                  <span class="mono">{ex.section}</span>
                  <span class="muted">{EXCLUDED[ex.reason]()}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
  </SettingsSection>

  <!-- ================================================================ erasure -->
  <SettingsSection title={t('privacy_erase_title')} description={t('privacy_erase_desc')} tone="danger">
    <div class="form">
      <Field label={t('privacy_person')} id="hr-erase-person">
        {#snippet children(id)}
          <Select
            {id}
            bind:value={erasePersonId}
            options={personOptions}
            placeholder={t('privacy_person_pick')}
            ariaLabel={t('privacy_person')}
            disabled={!manage || peopleQuery.isLoading}
            width="320px"
          />
        {/snippet}
      </Field>
      {#if erasePerson?.erasedAt}
        <p class="note">{t('privacy_erase_already', { when: formatDate(erasePerson.erasedAt) })}</p>
      {/if}
      <Field label={t('privacy_erase_reason')} hint={t('privacy_erase_reason_hint')} id="hr-erase-reason" required>
        {#snippet children(id)}
          <Textarea {id} bind:value={eraseReason} maxlength={500} rows={2} disabled={!manage} />
        {/snippet}
      </Field>
      <Switch
        bind:checked={keepNationalId}
        label={t('privacy_erase_keep_id')}
        description={t('privacy_erase_keep_id_desc')}
        disabled={!manage}
      />

      <p class="note">{t('privacy_erase_how')}</p>

      <div class="actions">
        <Button
          variant="secondary"
          icon="eye"
          onclick={runPreview}
          disabled={!erasePersonId || reasonMissing || !manage}
          loading={previewing}
        >
          {t('privacy_erase_preview')}
        </Button>
        {#if preview && !previewCurrent}
          <span class="stale">{t('privacy_erase_stale')}</span>
        {/if}
      </div>

      {#if final}
        {@render report(final)}
      {:else if preview && previewCurrent}
        {@render report(preview)}
        <div class="actions">
          <Button variant="danger" icon="shield" onclick={openConfirm} disabled={!manage || erasing}>
            {t('privacy_erase_button', { name: erasePerson?.displayName ?? '' })}
          </Button>
        </div>
      {/if}
    </div>
  </SettingsSection>
</SettingsPage>

<!-- The sweep's confirmation: what the last dry run said will go, class by class, and no undo. -->
<Dialog
  open={confirmSweep}
  size="sm"
  title={t('privacy_sweep_confirm_title')}
  onOpenChange={(open) => {
    if (!open && sweeping !== 'real') confirmSweep = false
  }}
>
  <div class="form">
    <p class="note">{t('privacy_sweep_confirm_body')}</p>
    {#if sweepPreview}
      <ul class="sweep-list">
        {#each sweepPreview.classes.filter((c) => c.affected > 0) as row (row.class)}
          <li>
            <span>{CLASS_LABEL[row.class]()}</span>
            <span class="tabular hot">{num(row.affected)}</span>
          </li>
        {/each}
      </ul>
      <p class="note">{t('privacy_sweep_people', { count: sweepPreview.personIds.length })}</p>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmSweep = false)} disabled={sweeping === 'real'}>
      {t('common.cancel')}
    </Button>
    <Button variant="danger" onclick={sweepNow} loading={sweeping === 'real'}>
      {t('privacy_sweep_confirm_button')}
    </Button>
  {/snippet}
</Dialog>

<Dialog
  open={confirmOpen}
  size="sm"
  title={t('privacy_erase_confirm_title', { name: erasePerson?.displayName ?? '' })}
  onOpenChange={(open) => {
    if (!open && !erasing) confirmOpen = false
  }}
>
  <div class="form">
    <p class="dialog-body">
      {t('privacy_erase_confirm_body', {
        name: erasePerson?.displayName ?? '',
        token: preview?.displayName ?? '',
      })}
    </p>
    {#if keepNationalId}
      <p class="dialog-body">{t('privacy_erase_confirm_keep_id')}</p>
    {/if}
    <p class="dialog-body strong">{t('privacy_erase_confirm_irreversible')}</p>
    <Field label={t('privacy_erase_type_name', { name: erasePerson?.displayName ?? '' })} id="hr-erase-confirm">
      {#snippet children(id)}
        <Input {id} bind:value={typedName} autocomplete="off" spellcheck={false} />
      {/snippet}
    </Field>
  </div>
  {#snippet footer()}
    <Button size="sm" variant="secondary" onclick={() => (confirmOpen = false)} disabled={erasing}>
      {t('common.cancel')}
    </Button>
    <Button size="sm" variant="danger" onclick={runErase} disabled={!nameMatches} loading={erasing}>
      {t('privacy_erase_confirm_button')}
    </Button>
  {/snippet}
</Dialog>

<style>
.readonly {
  margin: 0;
  font-size: 12.5px;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-500);
}
.form {
  display: grid;
  gap: 14px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--kern-ink-500);
}
.note.warn {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--kern-r-md);
  /* Measured: #925e22 on #f7e9d8 is 4.58:1, #d59548 on #3a2c1c is 5.28:1. */
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
}
/* The icon comes from a component, so the scoped selector cannot reach its svg without this. */
.note.warn :global(svg) {
  flex: none;
  margin-block-start: 1px;
}
.save-error {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}
.stale {
  font-size: 12.5px;
  color: var(--kern-ink-500);
}

/* ---- retention rows --------------------------------------------------------------- */
.classes {
  display: grid;
  gap: 2px;
  margin-block: 14px;
}
.class-head,
.class-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 150px 110px;
  gap: 8px 16px;
  align-items: center;
}
.class-head {
  padding: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
  border-block-end: 1px solid var(--kern-border-hairline);
}
.class-row {
  padding: 10px 0;
  border-block-end: 1px solid var(--kern-border-hairline);
}
.class-row:last-child {
  border-block-end: 0;
}
.class-label {
  display: grid;
  gap: 2px;
  min-width: 0;
  cursor: pointer;
}
.class-name {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--kern-ink-900);
}
.class-desc {
  font-size: 12px;
  line-height: 1.45;
  color: var(--kern-ink-500);
}
.class-input {
  min-width: 0;
}
.end {
  text-align: end;
  justify-self: end;
}
.class-due {
  font-size: 13.5px;
}
.hot {
  font-weight: 600;
  color: var(--kern-warning);
}
@media (max-width: 560px) {
  .class-head {
    display: none;
  }
  .class-row {
    grid-template-columns: minmax(0, 1fr) 110px;
  }
  .class-label {
    grid-column: 1 / -1;
  }
}

/* ---- numbers and identifiers ------------------------------------------------------ */
.tabular {
  font-variant-numeric: tabular-nums;
}
.mono {
  font-family: var(--kern-font-mono);
  font-size: 12px;
  /* Table and column names are identifiers and read left to right inside a Persian sentence. */
  direction: ltr;
  unicode-bidi: isolate;
}
.wrap {
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.4;
}
.sub {
  color: var(--kern-ink-500);
}
.cell-stack {
  display: grid;
  gap: 1px;
  min-width: 0;
}
/* A colour, not opacity. */
.muted {
  color: var(--kern-ink-500);
}
.scroll {
  overflow-x: auto;
  border: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-md);
}
/* A row with nothing to clear is still a fact; it is muted with a colour, never faded. */
.scroll :global(.ktr.nothing) {
  color: var(--kern-ink-450);
}
.scroll :global(.ktr) {
  min-height: 40px;
  padding-block: 6px;
  align-items: start;
}
.scroll :global(.ktd) {
  white-space: normal;
  align-items: start;
}

/* ---- the erasure report ------------------------------------------------------------- */
.report {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface);
}
.report.final {
  border-color: var(--kern-success);
}
.report-lead {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--kern-ink-900);
}
.report-lead :global(svg) {
  flex: none;
  margin-block-start: 2px;
}
.report-h {
  margin: 8px 0 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.report-note {
  margin: -4px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--kern-ink-500);
}
.caveats {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.caveats li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--kern-ink-700);
}
.caveats :global(svg) {
  flex: none;
  margin-block-start: 3px;
  color: var(--kern-ink-500);
}

/* ---- the export manifest ------------------------------------------------------------ */
.manifest {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface);
}
.manifest-lead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--kern-ink-900);
}
.manifest-h {
  margin: 6px 0 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--kern-ink-700);
}
.manifest-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  font-size: 12.5px;
}
.manifest-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}

/* ---- the confirmation --------------------------------------------------------------- */
.dialog-body {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kern-ink-700);
}
.dialog-body.strong {
  font-weight: 600;
  color: var(--kern-ink-900);
}
  .sweep-switch {
    padding: 4px 0 8px;
  }
  .sweep-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin: 10px 0 4px;
  }
  .runs-title {
    margin: 18px 0 8px;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .wrap {
    overflow-wrap: anywhere;
  }
  .sweep-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }
  .sweep-list li {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
</style>
