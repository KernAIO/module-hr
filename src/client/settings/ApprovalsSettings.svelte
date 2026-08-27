<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  formatCount,
  IconButton,
  Input,
  type MenuItem,
  navigation,
  SectionLabel,
  Select,
  type SelectOption,
  SettingsPage,
  SettingsSection,
  Skeleton,
  Switch,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { tick } from 'svelte'
// Straight from the contract rather than widening the client barrel: the barrel re-exports
// `ApprovalChain` because a screen needed it, and the subject, step and approver shapes are only
// ever assembled here.
import type {
  ApprovalChainSpec,
  ApprovalStepSpec,
  ApprovalSubjectType,
  ApproverSubject,
} from '../../contract/approvals.js'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { ApprovalChain } from '../index.js'
import { canHr } from '../permissions.js'
import { hrKeys } from '../query.js'

/**
 * Who signs what — the screen `approvals_chains_hint` has been pointing at.
 *
 * Three facts about the engine decide everything on this page, and getting any of them wrong here
 * would make the screen lie about the server:
 *
 * **A chain is snapshotted onto a request when it is raised.** Editing a chain, making another one
 * the default, or archiving this one changes nothing that is already in flight — each request keeps
 * the copy it was raised with and the approvers that copy resolved to. That is stated in the edit
 * dialog and again, at length, in the archive confirmation, because an admin who suspects archiving
 * might strand a half-signed request simply will not archive.
 *
 * **Only the default is used.** `chainFor` looks up the default for the subject type and nothing
 * else — a chain that is not the default is a draft, not an alternative route. So the list says so
 * plainly rather than implying five chains all do something.
 *
 * **No default means one implicit step: the requester's manager.** That is what makes a small
 * company work without configuring anything, and it is the sentence somebody needs before they
 * archive the only chain they have.
 *
 * The permission is `hr.approval.manage`, which is what the server gates every procedure here on —
 * including `list`. There is no read-only audience for this page: somebody without the permission
 * never sees it, because the settings entry declares it.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/**
 * The server gates `chains.list` on this too, so somebody without it gets no rows either. Checked
 * here as well because a button that is going to be refused should not be offered.
 */
const manage = $derived(canHr('approvalManage'))

// ---------------------------------------------------------------- vocabulary

/**
 * What an admin may build a chain *for* — the two things this module can actually raise.
 *
 * `ApprovalSubjectType` still carries `overtime`, `timesheet` and `shift_swap`, because the engine
 * is keyed by subject type on purpose and a stored chain must keep parsing. But offering them here
 * let somebody design, name and save a chain that nothing can ever fire, and then wait for
 * approvals that never arrive — a worse failure than the feature being absent, because it looks
 * configured. They join this list with the code that raises them.
 *
 * `subjectLabel` below stays exhaustive: a workspace that already saved one of those chains must
 * still see it named rather than rendered as a raw enum value.
 */
const SUBJECT_TYPES: ApprovalSubjectType[] = ['leave', 'regularization']

/** The same names the inbox uses. An approval called one thing here and another there is two things. */
const subjectLabel = (subject: ApprovalSubjectType): string =>
  subject === 'leave'
    ? t('leave_title')
    : subject === 'regularization'
      ? t('attendance_title')
      : subject === 'overtime'
        ? t('att_overtime')
        : subject === 'timesheet'
          ? t('approval_subject_timesheet')
          : t('approval_subject_shift_swap')

type ApproverKind = ApproverSubject['kind']

/**
 * The kinds this screen offers.
 *
 * `group` is missing on purpose: groups live in core and this module's client has no way to list
 * them, so the only picker it could offer is a box to paste a UUID into. A chain that already names
 * one is preserved rather than dropped — see `kindOptions` and the group row below.
 */
const OFFERED_KINDS: ApproverKind[] = [
  'manager',
  'manager_of_manager',
  'org_unit_head',
  'office_head',
  'person',
  'permission',
]

const kindLabel = (kind: ApproverKind): string =>
  kind === 'person'
    ? t('chain_who_person')
    : kind === 'manager'
      ? t('chain_who_manager')
      : kind === 'manager_of_manager'
        ? t('chain_who_manager_of_manager')
        : kind === 'org_unit_head'
          ? t('chain_who_org_unit_head')
          : kind === 'office_head'
            ? t('chain_who_office_head')
            : kind === 'permission'
              ? t('chain_who_permission')
              : t('chain_who_group')

/** Whether the kind needs a second answer — which person, which permission, which group. */
const needsId = (kind: ApproverKind) => kind === 'person' || kind === 'permission' || kind === 'group'

/**
 * The permissions worth standing in for a group of approvers.
 *
 * Not every key this module declares: "anybody who may view the directory" is most of the company
 * and would make a step meaningless. These are the six that name somebody who does a job. A chain
 * carrying a key that is not on the list keeps it — the option is added back below rather than
 * silently rewritten to the first entry.
 */
const APPROVER_PERMISSIONS = [
  'hr.person.manage',
  'hr.leave.manage',
  'hr.attendance.manage',
  'hr.office.manage',
  'hr.approval.manage',
] as const

const permissionLabel = (key: string): string =>
  key === 'hr.person.manage'
    ? t('chain_perm_person')
    : key === 'hr.leave.manage'
      ? t('chain_perm_leave')
      : key === 'hr.attendance.manage'
        ? t('chain_perm_attendance')
        : key === 'hr.office.manage'
          ? t('chain_perm_office')
          : key === 'hr.approval.manage'
            ? t('chain_perm_approval')
            : key

const modeLabel = (mode: ApprovalStepSpec['mode']): string =>
  mode === 'all' ? t('chain_mode_all') : mode === 'any' ? t('chain_mode_any') : t('chain_mode_quorum')

const timeoutLabel = (on: ApprovalStepSpec['onTimeout']): string =>
  on === 'remind'
    ? t('chain_timeout_remind')
    : on === 'escalate'
      ? t('chain_timeout_escalate')
      : t('chain_timeout_auto_approve')

// ---------------------------------------------------------------- what is on screen

let subject = $state<ApprovalSubjectType>('leave')

/**
 * The draft is declared above the queries on purpose.
 *
 * `createQuery` reads its options function as it is created, and the directory query's `enabled`
 * asks whether the editor is open — so a `let draft` below it is still in its temporal dead zone
 * when that first read happens, and the whole screen dies on "Cannot access 'draft' before
 * initialization". At runtime only, on first render, which nothing here type-checks.
 */

/** `key` is for `{#each}` alone: two identical steps must not share an identity while being edited. */
type ApproverDraft = { key: string; kind: ApproverKind; id: string }
type StepDraft = {
  key: string
  name: string
  approvers: ApproverDraft[]
  mode: ApprovalStepSpec['mode']
  /** People, not rows — one row can stand for several. Only read when the mode is `quorum`. */
  minApprovals: number
  /** Empty means it waits for ever, which is what the contract's `null` says. */
  slaHours: string
  onTimeout: ApprovalStepSpec['onTimeout']
}
interface Draft {
  /** `null` while creating. The two procedures take different fields, so this decides which. */
  id: string | null
  /** Fixed after creation: `chains.update` has no `subjectType`, and moving one would strand it. */
  subjectType: ApprovalSubjectType
  name: string
  isDefault: boolean
  steps: StepDraft[]
}

let draft = $state<Draft | null>(null)
let formError = $state<string | null>(null)

/**
 * `[module, entity, …scope]`, the shape `hrKeys` uses. Spelled here rather than in `query.ts`
 * because this is the only screen that asks — the same reason the office roster key is spelled in
 * `OfficesSettings`.
 */
const chainsKey = (ws: string) => ['hr', 'approval-chains', ws] as const

/**
 * Every subject type at once, not the filtered call.
 *
 * The filter above is a view of one list, so switching between the five kinds is instant and the
 * counts beside them are real rather than "the one I last fetched".
 */
const chainsQuery = createQuery(() => ({
  queryKey: chainsKey(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.approvals.chains.list({ workspaceId }),
}))
const allChains = $derived((chainsQuery.data ?? []) as ApprovalChain[])
const chains = $derived(allChains.filter((c) => c.subjectType === subject))
const defaultChain = $derived(chains.find((c) => c.isDefault) ?? null)

const subjectOptions = $derived(
  SUBJECT_TYPES.map((s) => ({
    value: s,
    label: subjectLabel(s),
    description: t('chain_subject_count', {
      count: allChains.filter((c) => c.subjectType === s).length,
    }),
  })),
)

/**
 * The directory, for the "a named person" approver.
 *
 * Only while the editor is open: a settings page nobody has opened a dialog on has no reason to
 * pull two hundred people.
 */
const directoryQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forChains: true }),
  enabled: Boolean(workspaceId) && draft !== null,
  queryFn: () => api.people.list({ workspaceId, limit: 200, status: ['active'] }),
}))
const directory = $derived(directoryQuery.data?.items ?? [])

/**
 * One click, one write.
 *
 * `disabled={mutation.isPending}` reaches the button on the next render, and two quick clicks are
 * one render apart — which here means two chains, or a chain archived twice. The flag is set in the
 * same tick as the click and cleared when the call settles.
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
 * A chain change moves the inbox and every screen that raises a request, so the module's cache is
 * dropped whole rather than guessing which keys a new default touched.
 */
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: ['hr'] })
}

/**
 * What a refused write says to the person who made it.
 *
 * The transport's `code` is what is tested, never the sentence — a list of sentences is a list
 * somebody has to keep in sync, and the day it drifts the reader is told nothing. `NOT_FOUND` is
 * the one that actually happens: two administrators in the same settings screen, one archives, the
 * other saves. Anything else falls back to the server's own machine text. The same shape as
 * `ClockControls` and `ApprovalsPage`; do not invent a third.
 */
const refusalMessages: Record<string, string> = {}

function chainFailure(error: unknown): string {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (failure.code === 'NOT_FOUND') return t('chain_gone')
  const reason = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason ? refusalMessages[reason] : undefined
  // `t()` answers a key it has no string for with the key itself, so both ways of not having one —
  // a reason no key covers, and a key whose string is not merged yet — land on the server's
  // sentence rather than putting `hr.chain_refused_…` in front of somebody.
  const translated = key ? t(key) : undefined
  return (translated && translated !== key ? translated : failure.message) || t('chain_save_error')
}

// ---------------------------------------------------------------- the draft

let nextKey = 0
const freshKey = () => `k${nextKey++}`

const newApprover = (kind: ApproverKind = 'manager'): ApproverDraft => ({
  key: freshKey(),
  kind,
  id: '',
})

const newStep = (name: string): StepDraft => ({
  key: freshKey(),
  name,
  approvers: [newApprover()],
  mode: 'any',
  minApprovals: 2,
  slaHours: '',
  onTimeout: 'remind',
})

function openCreate() {
  formError = null
  draft = {
    id: null,
    subjectType: subject,
    name: '',
    // A workspace with no chain for this kind almost certainly wants the one it is building to be
    // the one that runs; a second chain does nothing until somebody makes it the default, so it
    // does not steal the flag from the chain already in use.
    isDefault: defaultChain === null,
    steps: [newStep(t('chain_step_first'))],
  }
}

function openEdit(chain: ApprovalChain) {
  formError = null
  draft = {
    id: chain.id,
    subjectType: chain.subjectType,
    name: chain.name,
    isDefault: chain.isDefault,
    steps: chain.spec.steps.map((step) => ({
      key: freshKey(),
      name: step.name,
      approvers: step.approvers.map((a) => ({ key: freshKey(), kind: a.kind, id: a.id ?? '' })),
      mode: step.mode,
      minApprovals: step.minApprovals,
      slaHours: step.slaHours === null ? '' : String(step.slaHours),
      onTimeout: step.onTimeout,
    })),
  }
}

// ---------------------------------------------------------------- editing the steps

function addStep() {
  if (!draft) return
  draft.steps = [...draft.steps, newStep(t('chain_step_n', { n: formatCount(draft.steps.length + 1) }))]
}

function removeStep(index: number) {
  if (!draft || draft.steps.length <= 1) return
  draft.steps = draft.steps.filter((_, i) => i !== index)
}

function moveStep(index: number, by: number) {
  if (!draft) return
  const to = index + by
  if (to < 0 || to >= draft.steps.length) return
  const steps = [...draft.steps]
  const [moved] = steps.splice(index, 1)
  if (moved) steps.splice(to, 0, moved)
  draft.steps = steps
}

/**
 * Reorder, and keep the keyboard somewhere.
 *
 * The `{#each}` is keyed, so the pressed button moves with its step and holds focus — right up
 * until the step reaches an end and the button disables itself. The browser blurs a focused element
 * the moment it becomes disabled and hands focus nowhere, so somebody reordering steps by keyboard
 * would be dropped back to the top of the page on the last press. Focus goes to the arrow pointing
 * the other way, which is the one they can still use.
 */
async function moveFrom(event: Event, index: number, by: number) {
  const pressed = event.currentTarget
  moveStep(index, by)
  await tick()
  if (!(pressed instanceof HTMLButtonElement) || !pressed.disabled) return
  const other = by < 0 ? pressed.nextElementSibling : pressed.previousElementSibling
  if (other instanceof HTMLButtonElement && !other.disabled) other.focus()
}

function addApprover(step: StepDraft) {
  step.approvers = [...step.approvers, newApprover()]
}

function removeApprover(step: StepDraft, index: number) {
  if (step.approvers.length <= 1) return
  step.approvers = step.approvers.filter((_, i) => i !== index)
}

/** Changing the kind drops the id with it: a person id is not a permission key. */
function setKind(approver: ApproverDraft, kind: string) {
  approver.kind = kind as ApproverKind
  approver.id = ''
}

const personOptions = $derived<SelectOption[]>(directory.map((p) => ({ value: p.id, label: p.displayName })))

/**
 * The permission choices, with whatever the chain already holds forced in.
 *
 * Without that a key chosen outside this list would render as an empty select, and saving would
 * quietly move the step to a different group of people.
 */
function permissionOptions(current: string): SelectOption[] {
  const keys = [...APPROVER_PERMISSIONS] as string[]
  if (current && !keys.includes(current)) keys.push(current)
  return keys.map((key) => ({ value: key, label: permissionLabel(key) }))
}

/** `group` is only ever an option where the chain already uses it — see `OFFERED_KINDS`. */
function kindOptions(current: ApproverKind): SelectOption[] {
  const kinds = current === 'group' ? [...OFFERED_KINDS, 'group' as ApproverKind] : OFFERED_KINDS
  return kinds.map((kind) => ({ value: kind, label: kindLabel(kind) }))
}

// ---------------------------------------------------------------- validating and saving

/**
 * The first thing that stops this being saved, as a sentence.
 *
 * One message rather than a per-field error set: the Save button states why it is disabled, and a
 * disabled control with no explanation is a defect.
 */
const blocked = $derived.by<string | null>(() => {
  if (!draft) return null
  if (!draft.name.trim()) return t('chain_needs_name')
  for (const [index, step] of draft.steps.entries()) {
    const n = formatCount(index + 1)
    if (!step.name.trim()) return t('chain_needs_step_name', { n })
    if (step.approvers.length === 0) return t('chain_needs_approver', { n })
    for (const approver of step.approvers)
      if (needsId(approver.kind) && !approver.id) return t('chain_needs_who', { n })
    if (step.mode === 'quorum' && (!Number.isFinite(step.minApprovals) || step.minApprovals < 1))
      return t('chain_needs_min', { n })
  }
  return null
})

/**
 * The draft as the contract wants it.
 *
 * `minApprovals` is only read by the server for `quorum` — `all` needs every resolved approver and
 * `any` needs one — but the contract requires at least 1 on every step, so the other two modes send
 * 1 rather than a number that would look meaningful and never be used.
 */
function toSpec(steps: StepDraft[]): ApprovalChainSpec {
  return {
    steps: steps.map((step) => ({
      name: step.name.trim(),
      approvers: step.approvers.map((a) => (needsId(a.kind) ? { kind: a.kind, id: a.id } : { kind: a.kind })),
      mode: step.mode,
      minApprovals: step.mode === 'quorum' ? Math.max(1, Math.trunc(step.minApprovals)) : 1,
      slaHours: step.slaHours.trim() === '' ? null : Math.max(1, Math.trunc(Number(step.slaHours))),
      onTimeout: step.onTimeout,
    })),
  }
}

const save = createMutation(() => ({
  // `$state.snapshot` because the draft is a state proxy, and a proxy cannot be cloned on its way
  // into the request — the call throws instead of saving.
  mutationFn: (input: Draft) =>
    input.id === null
      ? api.approvals.chains.create({
          workspaceId,
          name: input.name.trim(),
          subjectType: input.subjectType,
          spec: toSpec(input.steps),
          isDefault: input.isDefault,
        })
      : api.approvals.chains.update({
          workspaceId,
          chainId: input.id,
          name: input.name.trim(),
          spec: toSpec(input.steps),
          isDefault: input.isDefault,
        }),
  onSuccess: (chain, input) => {
    toast.success(input.id === null ? t('chain_created', { name: chain.name }) : t('chain_saved'))
    // A chain created for another kind than the one on screen would otherwise vanish on save.
    subject = chain.subjectType
    draft = null
    formError = null
    refresh()
  },
  onError: (error: unknown) => {
    formError = chainFailure(error)
  },
  onSettled: settled,
}))

function submit() {
  if (!draft || blocked || firing) return
  formError = null
  const input = $state.snapshot(draft) as Draft
  once(() => save.mutate(input))
}

// ---------------------------------------------------------------- default, and archive

let makingDefaultId = $state<string | null>(null)
let archivingId = $state<string | null>(null)
let actionError = $state<string | null>(null)

/** The live rows, not snapshots: a name edited in another tab must not be confirmed under the old one. */
const makingDefault = $derived(allChains.find((c) => c.id === makingDefaultId) ?? null)
const archiving = $derived(allChains.find((c) => c.id === archivingId) ?? null)
const replacedDefault = $derived(
  makingDefault
    ? (allChains.find((c) => c.subjectType === makingDefault.subjectType && c.isDefault) ?? null)
    : null,
)

const setDefault = createMutation(() => ({
  mutationFn: (chain: ApprovalChain) =>
    api.approvals.chains.update({ workspaceId, chainId: chain.id, isDefault: true }),
  onSuccess: (_chain, input) => {
    toast.success(t('chain_default_toast', { name: input.name }))
    makingDefaultId = null
    actionError = null
    refresh()
  },
  onError: (error: unknown) => {
    actionError = chainFailure(error)
  },
  onSettled: settled,
}))

const archive = createMutation(() => ({
  mutationFn: (chain: ApprovalChain) => api.approvals.chains.archive({ workspaceId, chainId: chain.id }),
  onSuccess: (_ok, input) => {
    toast.success(t('chain_archived_toast', { name: input.name }))
    archivingId = null
    actionError = null
    refresh()
  },
  onError: (error: unknown) => {
    actionError = chainFailure(error)
  },
  onSettled: settled,
}))

function chainMenu(chain: ApprovalChain): MenuItem[] {
  return [
    { label: t('common.edit'), icon: 'square-pen', onSelect: () => openEdit(chain) },
    {
      label: t('chain_make_default'),
      icon: 'star',
      disabled: chain.isDefault,
      // Disabled with the reason beside it: it is already the one every new request uses.
      hint: chain.isDefault ? t('chain_already_default') : undefined,
      onSelect: () => {
        actionError = null
        makingDefaultId = chain.id
      },
    },
    { type: 'separator' },
    {
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      onSelect: () => {
        actionError = null
        archivingId = chain.id
      },
    },
  ]
}

/** "Manager · Local HR · Finance" — the step names, in the order they run. */
const stepNames = (chain: ApprovalChain) => chain.spec.steps.map((s) => s.name).join(' · ')
</script>

<SettingsPage title={t('settings_approvals')} description={t('chain_desc')}>
  {#snippet actions()}
    {#if manage}
      <Button size="sm" icon="plus" onclick={openCreate}>{t('chain_new')}</Button>
    {/if}
  {/snippet}

  <SettingsSection title={subjectLabel(subject)} description={t('chain_section_desc')}>
    {#snippet action()}
      <Select
        size="sm"
        width="190px"
        value={subject}
        ariaLabel={t('chain_subject_filter')}
        onValueChange={(v) => (subject = v as ApprovalSubjectType)}
        options={subjectOptions}
      />
    {/snippet}

    <!--
      Held rows outrank the error. Every write here invalidates all of `['hr']`, so a failed
      background refetch leaves TanStack in `error` with the last good list still in `data` — an
      error branch above this one would blank a working table and take its menus with it.
    -->
    {#if chainsQuery.isLoading}
      <div class="rows">
        {#each [1, 2, 3] as n (n)}<Skeleton height="48px" />{/each}
      </div>
    {:else if chains.length > 0}
      <div class="table" role="table" aria-label={t('settings_approvals')}>
        <div class="thead" role="row">
          <span role="columnheader">{t('chain_name')}</span>
          <span class="num" role="columnheader">{t('chain_steps')}</span>
          <span role="columnheader">{t('chain_who')}</span>
          <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
        </div>
        {#each chains as chain (chain.id)}
          <div class="trow" class:on={chain.isDefault} role="row">
            <span class="cell what" role="cell">
              <span class="strong">{chain.name}</span>
              {#if chain.isDefault}
                <Badge tone="accent">{t('chain_in_use')}</Badge>
              {/if}
            </span>
            <span class="cell muted num" role="cell">{formatCount(chain.spec.steps.length, 99)}</span>
            <span class="cell muted" role="cell">{stepNames(chain)}</span>
            <span class="cell actions" role="cell">
              {#if manage}
                <DropdownMenu items={chainMenu(chain)}>
                  {#snippet trigger(props)}
                    <IconButton
                      icon="ellipsis"
                      label={t('chain_actions_for', { name: chain.name })}
                      size={28}
                      {...props}
                    />
                  {/snippet}
                </DropdownMenu>
              {/if}
            </span>
          </div>
        {/each}
      </div>

      {#if defaultChain === null}
        <!-- The truth from `chainFor`: with no default, the engine falls back to one implicit step. -->
        <p class="note warn">{t('chain_no_default_note', { subject: subjectLabel(subject) })}</p>
      {/if}
    {:else if chainsQuery.isError}
      <EmptyState icon="triangle-alert" title={t('chain_error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void chainsQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else}
      <EmptyState
        icon="list-checks"
        title={t('chain_none', { subject: subjectLabel(subject) })}
        description={t('chain_none_desc')}
      >
        {#snippet actions()}
          {#if manage}<Button icon="plus" onclick={openCreate}>{t('chain_new')}</Button>{/if}
        {/snippet}
      </EmptyState>
    {/if}
  </SettingsSection>
</SettingsPage>

<!-- ---------------------------------------------------------------- the chain editor -->
<Dialog
  open={draft !== null}
  size="lg"
  title={draft?.id ? t('chain_edit_title') : t('chain_create_title')}
  onOpenChange={(o) => {
    if (!o) draft = null
  }}
>
  {#if draft}
    <div class="form">
      <!-- The whole point of the engine, and the thing nobody expects: editing this cannot reach a
           request that has already been raised. -->
      <p class="note">{t('chain_snapshot_note')}</p>

      <div class="pair">
        <Field label={t('chain_name')} hint={t('chain_name_hint')} required>
          {#snippet children(id)}
            <Input {id} bind:value={draft!.name} maxlength={120} />
          {/snippet}
        </Field>
        <Field
          label={t('chain_subject_filter')}
          hint={draft.id ? t('chain_subject_locked') : t('chain_subject_hint')}
        >
          {#snippet children(id)}
            <Select
              {id}
              value={draft!.subjectType}
              disabled={draft!.id !== null}
              onValueChange={(v) => draft && (draft.subjectType = v as ApprovalSubjectType)}
              options={SUBJECT_TYPES.map((s) => ({ value: s, label: subjectLabel(s) }))}
            />
          {/snippet}
        </Field>
      </div>

      <Switch
        checked={draft.isDefault}
        onCheckedChange={(v) => draft && (draft.isDefault = v)}
        label={t('chain_default_switch')}
        description={t('chain_default_switch_hint')}
      />

      <SectionLabel label={t('chain_steps')} count={draft.steps.length} sub>
        {#snippet trailing()}
          <Button size="sm" variant="secondary" icon="plus" onclick={addStep}>
            {t('chain_add_step')}
          </Button>
        {/snippet}
      </SectionLabel>

      <div class="steps">
        {#each draft.steps as step, index (step.key)}
          <div class="step">
            <div class="step-head">
              <span class="step-n">{t('chain_step_n', { n: formatCount(index + 1) })}</span>
              <span class="grow"></span>
              <IconButton
                icon="chevron-up"
                size={26}
                label={t('chain_move_up', { n: formatCount(index + 1) })}
                disabled={index === 0}
                onclick={(event) => void moveFrom(event, index, -1)}
              />
              <IconButton
                icon="chevron-down"
                size={26}
                label={t('chain_move_down', { n: formatCount(index + 1) })}
                disabled={index === draft.steps.length - 1}
                onclick={(event) => void moveFrom(event, index, 1)}
              />
              <!-- The label carries the reason as well as the tooltip: a screen reader gets the
                   same sentence a pointer does. The contract requires at least one step. -->
              <IconButton
                icon="trash-2"
                size={26}
                disabled={draft.steps.length <= 1}
                label={draft.steps.length <= 1 ? t('chain_last_step') : t('chain_remove_step')}
                title={draft.steps.length <= 1 ? t('chain_last_step') : undefined}
                onclick={() => removeStep(index)}
              />
            </div>

            <Field label={t('chain_step_name')} required>
              {#snippet children(id)}
                <Input {id} size="sm" bind:value={step.name} maxlength={80} />
              {/snippet}
            </Field>

            <div class="who">
              <span class="who-label">{t('chain_approvers')}</span>
              {#each step.approvers as approver, ai (approver.key)}
                <div class="approver">
                  <Select
                    size="sm"
                    value={approver.kind}
                    ariaLabel={t('chain_who')}
                    onValueChange={(v) => setKind(approver, v)}
                    options={kindOptions(approver.kind)}
                  />
                  {#if approver.kind === 'person'}
                    <Select
                      size="sm"
                      value={approver.id}
                      ariaLabel={t('chain_who_person')}
                      placeholder={directoryQuery.isLoading
                        ? t('common.loading')
                        : personOptions.length === 0
                          ? t('no_people')
                          : t('choose')}
                      onValueChange={(v) => (approver.id = v)}
                      options={personOptions}
                    />
                  {:else if approver.kind === 'permission'}
                    <Select
                      size="sm"
                      value={approver.id}
                      ariaLabel={t('chain_who_permission')}
                      placeholder={t('choose')}
                      onValueChange={(v) => (approver.id = v)}
                      options={permissionOptions(approver.id)}
                    />
                  {:else if approver.kind === 'group'}
                    <!-- Kept, not editable: this module's client cannot list core's groups, so the
                         only control it could offer is a box to paste a UUID into. -->
                    <Input size="sm" mono value={approver.id} disabled aria-label={t('chain_who_group')} />
                  {:else}
                    <span class="resolved">{t('chain_resolved_hint')}</span>
                  {/if}
                  <IconButton
                    icon="x"
                    size={26}
                    disabled={step.approvers.length <= 1}
                    label={step.approvers.length <= 1
                      ? t('chain_last_approver')
                      : t('chain_remove_approver')}
                    title={step.approvers.length <= 1 ? t('chain_last_approver') : undefined}
                    onclick={() => removeApprover(step, ai)}
                  />
                </div>
              {/each}
              <div>
                <Button size="sm" variant="secondary" icon="plus" onclick={() => addApprover(step)}>
                  {t('chain_add_approver')}
                </Button>
              </div>
            </div>

            <div class="pair">
              <Field label={t('chain_mode')} hint={t('chain_mode_hint')}>
                {#snippet children(id)}
                  <Select
                    {id}
                    size="sm"
                    value={step.mode}
                    onValueChange={(v) => (step.mode = v as ApprovalStepSpec['mode'])}
                    options={[
                      { value: 'any', label: modeLabel('any') },
                      { value: 'all', label: modeLabel('all') },
                      { value: 'quorum', label: modeLabel('quorum') },
                    ]}
                  />
                {/snippet}
              </Field>
              {#if step.mode === 'quorum'}
                <Field label={t('chain_min')} hint={t('chain_min_hint')} required>
                  {#snippet children(id)}
                    <Input
                      {id}
                      size="sm"
                      type="number"
                      min={1}
                      max={99}
                      value={String(step.minApprovals)}
                      oninput={(e) => (step.minApprovals = Number(e.currentTarget.value))}
                    />
                  {/snippet}
                </Field>
              {/if}
            </div>

            <div class="pair">
              <Field label={t('chain_sla')} hint={t('chain_sla_hint')}>
                {#snippet children(id)}
                  <Input
                    {id}
                    size="sm"
                    type="number"
                    min={1}
                    max={2000}
                    placeholder={t('chain_sla_none')}
                    bind:value={step.slaHours}
                  />
                {/snippet}
              </Field>
              {#if step.slaHours.trim() !== ''}
                <Field label={t('chain_on_timeout')}>
                  {#snippet children(id)}
                    <Select
                      {id}
                      size="sm"
                      value={step.onTimeout}
                      onValueChange={(v) => (step.onTimeout = v as ApprovalStepSpec['onTimeout'])}
                      options={[
                        { value: 'remind', label: timeoutLabel('remind') },
                        { value: 'escalate', label: timeoutLabel('escalate') },
                        { value: 'auto_approve', label: timeoutLabel('auto_approve') },
                      ]}
                    />
                  {/snippet}
                </Field>
              {/if}
            </div>

            {#if step.slaHours.trim() !== '' && step.onTimeout === 'auto_approve'}
              <!-- Said out loud, because it is the one setting on this screen that grants an
                   approval nobody read. -->
              <p class="note warn">{t('chain_auto_approve_warning')}</p>
            {/if}
          </div>
        {/each}
      </div>

      {#if formError}
        <p class="err" role="alert">{formError}</p>
      {:else if blocked}
        <p class="hint">{blocked}</p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (draft = null)} disabled={save.isPending}>
      {t('cancel')}
    </Button>
    <Button loading={save.isPending} disabled={!manage || blocked !== null} onclick={submit}>
      {draft?.id ? t('common.save') : t('common.create')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- make this the one in use -->
<Dialog
  open={makingDefault !== null}
  size="sm"
  title={makingDefault ? t('chain_default_title', { name: makingDefault.name }) : ''}
  onOpenChange={(o) => {
    if (!o) makingDefaultId = null
  }}
>
  {#if makingDefault}
    <p class="body">
      {t('chain_default_body', { subject: subjectLabel(makingDefault.subjectType) })}
    </p>
    {#if replacedDefault && replacedDefault.id !== makingDefault.id}
      <p class="body muted">{t('chain_default_replaces', { name: replacedDefault.name })}</p>
    {/if}
    <p class="note">{t('chain_default_inflight')}</p>
    {#if actionError}
      <p class="err" role="alert">{actionError}</p>
    {/if}
  {/if}

  {#snippet footer()}
    <Button
      variant="secondary"
      onclick={() => (makingDefaultId = null)}
      disabled={setDefault.isPending}
    >
      {t('cancel')}
    </Button>
    <Button
      loading={setDefault.isPending}
      onclick={() => {
        if (makingDefault) once(() => makingDefault && setDefault.mutate(makingDefault))
      }}
    >
      {t('chain_make_default')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- archive -->
<Dialog
  open={archiving !== null}
  size="sm"
  title={archiving ? t('chain_archive_title', { name: archiving.name }) : ''}
  onOpenChange={(o) => {
    if (!o) archivingId = null
  }}
>
  {#if archiving}
    <!--
      The sentence this dialog exists for. A request snapshots its chain when it is raised, so
      archiving cannot add a signature to something half-signed or take one away — and an admin who
      suspects it might will leave a chain nobody uses in the list for ever.
    -->
    <p class="note">{t('chain_archive_inflight')}</p>
    <p class="body">
      {archiving.isDefault
        ? t('chain_archive_was_default', { subject: subjectLabel(archiving.subjectType) })
        : t('chain_archive_unused')}
    </p>
    {#if archiving.isDefault}
      <p class="note warn">{t('chain_archive_default_warning')}</p>
    {/if}
    {#if actionError}
      <p class="err" role="alert">{actionError}</p>
    {/if}
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (archivingId = null)} disabled={archive.isPending}>
      {t('cancel')}
    </Button>
    <Button
      variant="danger"
      loading={archive.isPending}
      onclick={() => {
        if (archiving) once(() => archiving && archive.mutate(archiving))
      }}
    >
      {t('common.archive')}
    </Button>
  {/snippet}
</Dialog>

<style>
.rows {
  display: grid;
  gap: 4px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  --hr-chain-cols: minmax(150px, 1.2fr) 62px minmax(150px, 1.4fr) 32px;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-chain-cols);
  gap: 10px;
  align-items: center;
  padding-inline: 10px;
  border-inline-start: 2px solid transparent;
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
  border-block-end: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-md);
}
.trow:hover {
  background: var(--kern-surface-raised);
}
/* The one chain that actually runs. A border as well as a tint, so it survives a theme where the
   tint is nearly the surface it sits on. */
.trow.on {
  border-inline-start-color: var(--kern-accent);
  background: var(--kern-surface-active);
}
.cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.what {
  display: flex;
  align-items: center;
  gap: 8px;
}
.strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13.5px;
  font-weight: 500;
}
.muted {
  font-size: 13px;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-500);
}
.num {
  font-variant-numeric: tabular-nums;
}
.actions {
  display: flex;
  justify-content: flex-end;
  overflow: visible;
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

.steps {
  display: grid;
  gap: 12px;
}
.step {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md2);
  background: var(--kern-surface);
}
.step-head {
  display: flex;
  align-items: center;
  gap: 4px;
}
.step-n {
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.grow {
  flex: 1;
}

.who {
  display: grid;
  gap: 6px;
}
.who-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--kern-ink-800);
}
.approver {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) minmax(140px, 1.2fr) 26px;
  gap: 8px;
  align-items: center;
}
.resolved {
  font-size: 12.5px;
  color: var(--kern-ink-500);
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
.note.warn {
  background: var(--kern-warning-tint);
}
.body {
  margin: 0 0 8px;
  font-size: 13.5px;
  line-height: 1.5;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.err {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-danger);
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
  .table {
    --hr-chain-cols: minmax(130px, 1fr) 52px 32px;
  }
  /* The step names go; the count and the "in use" badge are what cannot. */
  .thead > :nth-child(3),
  .trow > :nth-child(3) {
    display: none;
  }
  .pair {
    grid-template-columns: 1fr;
  }
  .approver {
    grid-template-columns: minmax(0, 1fr) 26px;
  }
  /* The kind and its remove button keep the first line; whichever control answers "which one"
     takes the whole second line rather than being squeezed to nothing. */
  .approver > :nth-child(2) {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>
