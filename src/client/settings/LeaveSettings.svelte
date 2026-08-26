<script lang="ts">
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  formatCount,
  Icon,
  IconButton,
  Input,
  type MenuItem,
  navigation,
  SectionLabel,
  Select,
  SettingsPage,
  Skeleton,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { LeaveType } from '../index.js'
import { canHr } from '../permissions.js'
import { hrKeys } from '../query.js'

/**
 * The kinds of time off this workspace has.
 *
 * Everything downstream of leave reads this list: the request dialog's picker, the balance tiles,
 * the ledger, the team calendar. Until this screen existed the list could only be seeded, so a
 * workspace that switched leave on got a request dialog with an empty dropdown — the capability is
 * `defaultEnabled`, so that was every workspace with HR.
 *
 * Two fields are deliberately not editable after creation, because the contract does not accept
 * them on `update`: the **key**, which imports and the API name a type by, and the **unit**, which
 * every ledger entry was already converted into. Both are stated in the form rather than silently
 * ignored.
 *
 * Archiving is the only way out. There is no restore — `update` cannot clear `archivedAt` — so the
 * confirmation says so alongside what archiving keeps.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')
const canManage = $derived(canHr('leaveManage'))

/** The registry holds over a hundred icons; these are the ones that mean something on a leave type. */
const LEAVE_ICONS: { name: string; label: () => string }[] = [
  { name: 'tree-palm', label: () => t('leave_icon_holiday') },
  { name: 'activity', label: () => t('leave_icon_sick') },
  { name: 'house', label: () => t('leave_icon_home') },
  { name: 'briefcase', label: () => t('leave_icon_trip') },
  { name: 'user-plus', label: () => t('leave_icon_family') },
  { name: 'calendar-days', label: () => t('leave_icon_calendar') },
  { name: 'clock', label: () => t('leave_icon_hours') },
  { name: 'star', label: () => t('leave_icon_special') },
]

/**
 * Mid-tone hues, on purpose: the colour is drawn as an icon on the page's own background, and it
 * has to stay visible against paper and against ink. A pale pastel disappears in light mode and a
 * near-black one in dark.
 */
const LEAVE_COLORS: { value: string; label: () => string }[] = [
  { value: '#4c8bf5', label: () => t('leave_color_blue') },
  { value: '#3aa675', label: () => t('leave_color_green') },
  { value: '#d68b2c', label: () => t('leave_color_amber') },
  { value: '#dd5a5a', label: () => t('leave_color_red') },
  { value: '#8a6ee0', label: () => t('leave_color_purple') },
  { value: '#3ba1b5', label: () => t('leave_color_teal') },
  { value: '#cf5f8c', label: () => t('leave_color_pink') },
  { value: '#7a8794', label: () => t('leave_color_slate') },
]

const DEFAULT_COLOR = LEAVE_COLORS[0]!.value
const DEFAULT_ICON = LEAVE_ICONS[0]!.name

/**
 * What the ledger means by a day. `services/ledger.ts` stores every movement in minutes and reads
 * a day back as eight hours, so a limit typed in days has to be multiplied by the same number the
 * server divides by — anything else shows one figure and enforces another.
 */
const MINUTES_PER_DAY = 8 * 60
const minutesPerUnit = (unit: LeaveType['unit']) => (unit === 'hour' ? 60 : MINUTES_PER_DAY)

const unitLabel = (unit: LeaveType['unit']): string =>
  unit === 'hour'
    ? t('leave_unit_hour')
    : unit === 'half_day'
      ? t('leave_unit_half_day')
      : t('leave_unit_day')

/**
 * Its own cache key, even though the request dialog asks the same procedure.
 *
 * That one caches `hrKeys.leaveTypes(ws)` with `includeArchived: false`; serving it this answer
 * would offer somebody an archived type to book. This screen always fetches both and splits them
 * here, so showing the archived ones costs no round trip.
 */
const typesQuery = createQuery(() => ({
  queryKey: [...hrKeys.leaveTypes(workspaceId), 'settings'] as const,
  enabled: Boolean(workspaceId),
  queryFn: () => api.leave.types.list({ workspaceId, includeArchived: true }),
}))
const types = $derived(typesQuery.data ?? [])
const active = $derived(types.filter((type) => !type.archivedAt))
const archived = $derived(types.filter((type) => type.archivedAt))

let showArchived = $state(false)

const invalidate = () => {
  void queryClient.invalidateQueries({ queryKey: ['hr', 'leave-types'] })
  // A balance row carries its type's name and unit, so a rename has to reach the tiles too.
  void queryClient.invalidateQueries({ queryKey: ['hr', 'leave-balance'] })
}

// ---------------------------------------------------------------- the form

let dialogOpen = $state(false)
/** null while creating. It is also what decides whether `key` and `unit` may still be chosen. */
let editingId = $state<string | null>(null)
let name = $state('')
let key = $state('')
let paid = $state(true)
let unit = $state<LeaveType['unit']>('day')
let color = $state(DEFAULT_COLOR)
let icon = $state(DEFAULT_ICON)
let workingDaysOnly = $state(true)
let requireDocument = $state(false)
let documentDays = $state('3')
let allowNegative = $state(false)
let negativeLimit = $state('0')
/** Touched once, the key stops following the name — otherwise a rename would rewrite it. */
let keyEdited = $state(false)
/** Set in the same tick as the click: `isPending` only reaches the button on the next render. */
let saving = $state(false)
let reordering = $state(false)

const editing = $derived(editingId !== null)

/** `Annual leave` → `annual_leave`: the key is a machine name, not a sentence. */
const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)

$effect(() => {
  if (!keyEdited) key = slugify(name)
})

function startNew() {
  editingId = null
  name = ''
  key = ''
  paid = true
  unit = 'day'
  color = DEFAULT_COLOR
  icon = DEFAULT_ICON
  workingDaysOnly = true
  requireDocument = false
  documentDays = '3'
  allowNegative = false
  negativeLimit = '0'
  keyEdited = false
  dialogOpen = true
}

/** Minutes back into the unit somebody typed them in, without a trailing `.00`. */
const fromMinutes = (minutes: number, forUnit: LeaveType['unit']) =>
  String(Math.round((minutes / minutesPerUnit(forUnit)) * 100) / 100)

function startEdit(type: LeaveType) {
  editingId = type.id
  name = type.name
  key = type.key
  paid = type.paid
  unit = type.unit
  color = type.color ?? DEFAULT_COLOR
  icon = type.icon ?? DEFAULT_ICON
  workingDaysOnly = type.countsWorkingDaysOnly
  requireDocument = type.requiresDocumentAfterDays !== null
  documentDays = String(type.requiresDocumentAfterDays ?? 3)
  allowNegative = type.allowNegative
  negativeLimit = fromMinutes(type.maxNegativeMinutes, type.unit)
  keyEdited = true
  dialogOpen = true
}

const keyValid = $derived(/^[a-z][a-z0-9_]*$/.test(key) && key.length <= 48)
const documentValid = $derived(!requireDocument || Number(documentDays) >= 1)
const negativeValid = $derived(!allowNegative || Number(negativeLimit) >= 0)
const canSave = $derived(
  canManage && name.trim().length > 0 && (editing || keyValid) && documentValid && negativeValid,
)

const save = createMutation(() => ({
  mutationFn: () => {
    const common = {
      workspaceId,
      name: name.trim(),
      paid,
      color,
      icon,
      requiresDocumentAfterDays: requireDocument ? Math.max(1, Math.round(Number(documentDays))) : null,
      countsWorkingDaysOnly: workingDaysOnly,
      allowNegative,
      maxNegativeMinutes: allowNegative
        ? Math.max(0, Math.round(Number(negativeLimit) * minutesPerUnit(unit)))
        : 0,
    }
    return editingId
      ? api.leave.types.update({ ...common, leaveTypeId: editingId })
      : api.leave.types.create({ ...common, key, unit })
  },
  onSuccess: (saved: LeaveType) => {
    dialogOpen = false
    invalidate()
    toast.success(t('leave_type_saved', { name: saved.name }))
  },
  onError: (error: Error) => toast.error(error.message),
  onSettled: () => {
    saving = false
  },
}))

function submit() {
  if (!canSave || saving) return
  saving = true
  save.mutate()
}

// ---------------------------------------------------------------- rows

let archiving = $state<LeaveType | null>(null)

const archive = createMutation(() => ({
  mutationFn: (type: LeaveType) => api.leave.types.archive({ workspaceId, leaveTypeId: type.id }),
  onSuccess: (_result: unknown, type: LeaveType) => {
    archiving = null
    invalidate()
    toast.success(t('leave_type_archived_toast', { name: type.name }))
  },
  onError: (error: Error) => toast.error(error.message),
}))

const reorder = createMutation(() => ({
  mutationFn: async (vars: { id: string; delta: number }) => {
    const next = [...active]
    const from = next.findIndex((type) => type.id === vars.id)
    const to = from + vars.delta
    if (from < 0 || to < 0 || to >= next.length) return
    next.splice(to, 0, next.splice(from, 1)[0]!)
    // Every row whose position no longer matches its stored `order` is written, not only the two
    // that changed places: a seeded workspace has every type at order 0 and falls back to sorting
    // by name, so exchanging two zeros would move nothing on screen. The list writes its own
    // positions the first time anybody reorders it.
    await Promise.all(
      next.flatMap((type, index) =>
        type.order === index
          ? []
          : [api.leave.types.update({ workspaceId, leaveTypeId: type.id, order: index })],
      ),
    )
  },
  onSuccess: invalidate,
  onError: (error: Error) => toast.error(error.message),
  onSettled: () => {
    reordering = false
  },
}))

function move(id: string, delta: number) {
  if (reordering) return
  reordering = true
  reorder.mutate({ id, delta })
}

function actionsFor(type: LeaveType, index: number): MenuItem[] {
  if (type.archivedAt) {
    // Archived types keep an edit action — a typo in a name still shows up on old requests — but
    // nothing here can bring one back, so no restore is offered.
    return [{ label: t('common.edit'), icon: 'pencil', onSelect: () => startEdit(type) }]
  }
  const last = index === active.length - 1
  return [
    { label: t('common.edit'), icon: 'pencil', onSelect: () => startEdit(type) },
    {
      label: t('leave_type_move_up'),
      icon: 'chevron-up',
      disabled: index === 0,
      hint: index === 0 ? t('leave_type_first') : undefined,
      onSelect: () => move(type.id, -1),
    },
    {
      label: t('leave_type_move_down'),
      icon: 'chevron-down',
      disabled: last,
      hint: last ? t('leave_type_last') : undefined,
      onSelect: () => move(type.id, 1),
    },
    { type: 'separator' },
    {
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      onSelect: () => {
        archiving = type
      },
    },
  ]
}

/** What this type does beyond having a name — the column somebody scans to compare two of them. */
function rulesFor(type: LeaveType): string[] {
  const rules: string[] = []
  if (type.countsWorkingDaysOnly) rules.push(t('leave_type_working_days'))
  if (type.requiresDocumentAfterDays !== null)
    rules.push(t('leave_type_document_after', { count: type.requiresDocumentAfterDays }))
  if (type.allowNegative) rules.push(t('leave_type_negative'))
  return rules
}
</script>

<SettingsPage title={t('settings_leave')} description={t('leave_types_desc')}>
  {#snippet actions()}
    {#if canManage}
      <Button size="sm" icon="plus" onclick={startNew}>{t('leave_type_new')}</Button>
    {/if}
  {/snippet}

  {#if typesQuery.isLoading}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="48px" />{/each}
    </div>
  {:else if typesQuery.isError}
    <EmptyState icon="triangle-alert" title={t('leave_types_error')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void typesQuery.refetch()}>{t('common.retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if types.length === 0}
    <EmptyState icon="tree-palm" title={t('leave_types_none')} description={t('leave_types_none_desc')}>
      {#snippet actions()}
        {#if canManage}
          <Button icon="plus" onclick={startNew}>{t('leave_type_new')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <div class="section">
      <SectionLabel label={t('leave_types')} count={formatCount(active.length)}>
        {#snippet trailing()}
          {#if archived.length}
            <Button
              size="xs"
              variant="ghost"
              icon={showArchived ? 'eye-off' : 'eye'}
              onclick={() => (showArchived = !showArchived)}
            >
              {showArchived ? t('leave_types_hide_archived') : t('leave_types_show_archived')}
            </Button>
          {/if}
        {/snippet}
      </SectionLabel>

      {#if active.length === 0}
        <EmptyState
          bare
          compact
          icon="tree-palm"
          title={t('leave_types_none')}
          description={t('leave_types_none_desc')}
        />
      {:else}
        <div class="table" role="table" aria-label={t('leave_types')}>
          <div class="thead" role="row">
            <span role="columnheader">{t('leave_type')}</span>
            <span role="columnheader">{t('leave_type_unit')}</span>
            <span role="columnheader">{t('leave_type_paid')}</span>
            <span role="columnheader">{t('leave_type_rules')}</span>
            <span class="sr-only" role="columnheader">{t('leave_type_actions')}</span>
          </div>
          {#each active as type, index (type.id)}
            {@const rules = rulesFor(type)}
            <div class="trow" role="row">
              <span class="cell name" role="cell">
                <span class="chip" style:color={type.color ?? 'var(--kern-ink-400)'}>
                  <Icon name={type.icon ?? DEFAULT_ICON} size={15} strokeWidth={1.8} />
                </span>
                <span class="tname">{type.name}</span>
                <span class="tkey">{type.key}</span>
              </span>
              <span class="cell muted" role="cell">{unitLabel(type.unit)}</span>
              <span class="cell" role="cell">
                <Badge tone={type.paid ? 'success' : 'grey'}>
                  {type.paid ? t('leave_type_paid') : t('leave_type_unpaid')}
                </Badge>
              </span>
              <span class="cell rules" role="cell">
                {#if rules.length}
                  {#each rules as rule (rule)}<span class="rule">{rule}</span>{/each}
                {:else}
                  <span class="rule">—</span>
                {/if}
              </span>
              <span class="cell actions" role="cell">
                {#if canManage}
                  <DropdownMenu items={actionsFor(type, index)} align="end">
                    {#snippet trigger(props)}
                      <IconButton {...props} icon="ellipsis" size={28} label={t('leave_type_actions')} />
                    {/snippet}
                  </DropdownMenu>
                {/if}
              </span>
            </div>
          {/each}
        </div>
        {#if canManage && active.length > 1}
          <p class="hint">{t('leave_type_order_hint')}</p>
        {/if}
      {/if}
    </div>

    {#if showArchived && archived.length}
      <div class="section">
        <SectionLabel label={t('leave_type_archived')} count={formatCount(archived.length)} />
        <div class="table" role="table" aria-label={t('leave_type_archived')}>
          {#each archived as type (type.id)}
            <div class="trow" role="row">
              <span class="cell name" role="cell">
                <span class="chip" style:color="var(--kern-ink-400)">
                  <Icon name={type.icon ?? DEFAULT_ICON} size={15} strokeWidth={1.8} />
                </span>
                <span class="tname muted">{type.name}</span>
                <span class="tkey">{type.key}</span>
                <Badge tone="grey">{t('leave_type_archived')}</Badge>
              </span>
              <span class="cell muted" role="cell">{unitLabel(type.unit)}</span>
              <span class="cell" role="cell"></span>
              <span class="cell rules" role="cell"></span>
              <span class="cell actions" role="cell">
                {#if canManage}
                  <DropdownMenu items={actionsFor(type, -1)} align="end">
                    {#snippet trigger(props)}
                      <IconButton {...props} icon="ellipsis" size={28} label={t('leave_type_actions')} />
                    {/snippet}
                  </DropdownMenu>
                {/if}
              </span>
            </div>
          {/each}
        </div>
        <p class="hint">{t('leave_type_archive_permanent')}</p>
      </div>
    {/if}
  {/if}
</SettingsPage>

<Dialog
  bind:open={dialogOpen}
  size="md"
  title={editing ? t('leave_type_edit') : t('leave_type_new')}
  onOpenChange={(next) => {
    if (!next) dialogOpen = false
  }}
>
  <div class="form">
    <!--
      The picker preview. A leave type is chosen from a dropdown by its colour and icon as much as
      by its name, so the form shows the thing being made rather than the fields it is made of.
    -->
    <div class="preview">
      <span class="plabel">{t('leave_type_preview')}</span>
      <span class="pchip">
        <span class="chip" style:color={color}>
          <Icon name={icon} size={15} strokeWidth={1.8} />
        </span>
        <span class="pname">{name.trim() || t('leave_type_name_placeholder')}</span>
      </span>
    </div>

    <Field label={t('leave_type_name')} id="hr-leave-type-name" required>
      {#snippet children(id)}
        <Input {id} bind:value={name} placeholder={t('leave_type_name_placeholder')} />
      {/snippet}
    </Field>

    <Field
      label={t('leave_type_key')}
      id="hr-leave-type-key"
      hint={editing ? t('leave_type_key_fixed') : t('leave_type_key_hint')}
      error={!editing && key.length > 0 && !keyValid ? t('leave_type_key_invalid') : null}
    >
      {#snippet children(id)}
        <Input
          {id}
          mono
          bind:value={key}
          disabled={editing}
          oninput={() => (keyEdited = true)}
          placeholder="annual_leave"
        />
      {/snippet}
    </Field>

    <Field
      label={t('leave_type_unit')}
      id="hr-leave-type-unit"
      hint={editing ? t('leave_type_unit_fixed') : undefined}
    >
      {#snippet children(id)}
        <Select
          {id}
          value={unit}
          disabled={editing}
          options={[
            { value: 'day', label: t('leave_unit_day') },
            { value: 'half_day', label: t('leave_unit_half_day') },
            { value: 'hour', label: t('leave_unit_hour') },
          ]}
          onValueChange={(next) => (unit = next as LeaveType['unit'])}
        />
      {/snippet}
    </Field>

    <div class="grid2">
      <div class="pick">
        <span class="lbl">{t('leave_type_color')}</span>
        <div class="swatches">
          {#each LEAVE_COLORS as choice (choice.value)}
            <button
              type="button"
              class="swatch"
              class:on={color === choice.value}
              style="--swatch: {choice.value}"
              aria-pressed={color === choice.value}
              aria-label={choice.label()}
              title={choice.label()}
              onclick={() => (color = choice.value)}
            ></button>
          {/each}
        </div>
      </div>

      <div class="pick">
        <span class="lbl">{t('leave_type_icon')}</span>
        <div class="swatches">
          {#each LEAVE_ICONS as choice (choice.name)}
            <button
              type="button"
              class="ico"
              class:on={icon === choice.name}
              aria-pressed={icon === choice.name}
              aria-label={choice.label()}
              title={choice.label()}
              onclick={() => (icon = choice.name)}
            >
              <Icon name={choice.name} size={16} strokeWidth={1.8} />
            </button>
          {/each}
        </div>
      </div>
    </div>

    <div class="switches">
      <Checkbox
        checked={paid}
        label={t('leave_type_paid')}
        description={t('leave_type_paid_hint')}
        onCheckedChange={(on) => (paid = on)}
      />
      <Checkbox
        checked={workingDaysOnly}
        label={t('leave_type_working_days')}
        description={t('leave_type_working_days_hint')}
        onCheckedChange={(on) => (workingDaysOnly = on)}
      />
      <Checkbox
        checked={requireDocument}
        label={t('leave_type_document')}
        description={t('leave_type_document_hint')}
        onCheckedChange={(on) => (requireDocument = on)}
      />
      {#if requireDocument}
        <div class="nested">
          <Field label={t('leave_type_document_days')} id="hr-leave-type-doc-days">
            {#snippet children(id)}
              <Input {id} type="number" min="1" step="1" bind:value={documentDays} />
            {/snippet}
          </Field>
        </div>
      {/if}
      <Checkbox
        checked={allowNegative}
        label={t('leave_type_negative')}
        description={t('leave_type_negative_hint')}
        onCheckedChange={(on) => (allowNegative = on)}
      />
      {#if allowNegative}
        <div class="nested">
          <Field
            label={t('leave_type_negative_limit')}
            id="hr-leave-type-negative"
            hint={unit === 'hour' ? t('leave_type_negative_hours_hint') : t('leave_type_negative_days_hint')}
          >
            {#snippet children(id)}
              <Input {id} type="number" min="0" step="0.5" bind:value={negativeLimit} />
            {/snippet}
          </Field>
        </div>
      {/if}
    </div>
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (dialogOpen = false)}>{t('common.cancel')}</Button>
    <Button disabled={!canSave} loading={save.isPending} onclick={submit}>{t('common.save')}</Button>
  {/snippet}
</Dialog>

<!--
  Archiving is not deleting, and an HR admin has to know that before clicking: the ledger is
  append-only, so every day already taken stays taken and every balance reads the same afterwards.
  What does change is that nobody can pick it again — and nothing on this screen undoes it.
-->
<Dialog
  open={archiving !== null}
  size="sm"
  title={archiving ? t('leave_type_archive_title', { name: archiving.name }) : ''}
  onOpenChange={(next) => {
    if (!next) archiving = null
  }}
>
  <p class="body">{t('leave_type_archive_body')}</p>
  <p class="body warn">{t('leave_type_archive_permanent')}</p>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (archiving = null)}>{t('common.cancel')}</Button>
    <Button
      variant="danger"
      loading={archive.isPending}
      onclick={() => {
        if (archiving && !archive.isPending) archive.mutate(archiving)
      }}
    >
      {t('common.archive')}
    </Button>
  {/snippet}
</Dialog>

<style>
.section {
  display: grid;
  gap: 4px;
}
.rows {
  display: grid;
  gap: 4px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  --hr-leave-cols: minmax(180px, 1.6fr) 110px 88px minmax(140px, 1.2fr) max-content;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-leave-cols);
  gap: 12px;
  align-items: center;
  padding-inline: 10px;
}
.thead {
  height: 34px;
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
.cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name {
  display: flex;
  align-items: center;
  gap: 8px;
}
.chip {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: var(--kern-r-sm);
  border: 1px solid var(--kern-border-hairline);
  background: var(--kern-surface-chip);
}
.tname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13.5px;
  font-weight: 500;
}
.tkey {
  flex: none;
  font-family: var(--kern-font-mono);
  font-size: 11px;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-400);
}
.muted {
  font-size: 13px;
  color: var(--kern-ink-500);
}
.rules {
  display: flex;
  align-items: center;
  font-size: 12.5px;
  color: var(--kern-ink-500);
}
.rule {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rule + .rule::before {
  content: '·';
  margin-inline: 6px;
  color: var(--kern-ink-300);
}
.actions {
  display: flex;
  justify-content: flex-end;
  overflow: visible;
}
.hint {
  margin-block-start: 8px;
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

/* ---- dialog ---- */
.form {
  display: grid;
  gap: 14px;
}
.preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-chip);
}
.plabel {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.pchip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--kern-ink-900);
}
.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}
.pick {
  display: grid;
  gap: 6px;
}
.lbl {
  font-size: 12px;
  font-weight: 500;
  color: var(--kern-ink-600);
}
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.swatch,
.ico {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-sm);
  background: none;
  cursor: pointer;
}
.swatch {
  background: var(--swatch);
}
.swatch.on,
.ico.on {
  border-color: var(--kern-accent);
  box-shadow: 0 0 0 1px var(--kern-accent);
}
/* A swatch carries no text, so the ring is the only thing telling a keyboard where it is. */
.swatch:focus-visible,
.ico:focus-visible {
  outline: 2px solid var(--kern-accent);
  outline-offset: 2px;
}
.ico {
  color: var(--kern-ink-600);
}
.ico:hover {
  background: var(--kern-surface-hover);
}
.ico.on {
  color: var(--kern-accent);
}
.switches {
  display: grid;
  gap: 12px;
}
.nested {
  max-width: 180px;
  margin-inline-start: 26px;
}
.body {
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kern-ink-700);
}
.warn {
  margin-block-start: 8px;
  color: var(--kern-ink-500);
}

@media (max-width: 720px) {
  .table {
    --hr-leave-cols: minmax(140px, 1.6fr) 96px max-content;
  }
  /* Pay and the rules survive in the editor; the name and the unit are what a narrow list needs. */
  .thead > :nth-child(3),
  .trow > :nth-child(3),
  .thead > :nth-child(4),
  .trow > :nth-child(4) {
    display: none;
  }
}
</style>
