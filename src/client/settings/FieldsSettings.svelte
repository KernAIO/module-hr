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
  IconButton,
  Input,
  type MenuItem,
  navigation,
  SectionLabel,
  Select,
  SettingsPage,
  Skeleton,
  session,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import {
  bySection,
  FIELD_KEY_MAX,
  FIELD_KEY_RE,
  FIELD_SECTIONS,
  FIELD_TYPES,
  type FieldSection,
  type FieldType,
  hasOptions,
  optionsText,
  parseOptions,
  slugifyKey,
} from '../components/custom-fields.js'
import { t } from '../i18n.js'
import type { CustomFieldDef } from '../index.js'
import { canHr } from '../permissions.js'
import { hrKeys } from '../query.js'

/**
 * The fields this workspace adds to a person's record.
 *
 * `fields.{list,create,update,archive}` have been on the contract since custom fields shipped, and
 * until this screen existed nothing could call three of them: a definition could only be seeded,
 * so `people.custom` was a column every screen carried and nothing could fill.
 *
 * Two things are fixed at creation, because `update` does not accept them: the **key**, which
 * imports and the API name a field by, and the **type**, which every value already stored was
 * saved in. Both are stated on the edit form rather than silently ignored.
 *
 * Archiving is the only way out, and it keeps the values — the server leaves `people.custom`
 * untouched so a field switched back on brings back what everybody had. There is no restore:
 * `update` cannot clear `archivedAt`, and the confirmation says so.
 *
 * Order is written with `update` — there is no reorder procedure — and within a section: after a
 * move, every field in that section whose position no longer matches its `order` is renumbered
 * from zero. Sections are drawn apart on every screen, so an order that repeats across two of
 * them means nothing.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')
const canManage = $derived(canHr('fieldManage'))

const sectionLabel = (section: FieldSection): string =>
  section === 'profile'
    ? t('field_section_profile')
    : section === 'employment'
      ? t('field_section_employment')
      : t('field_section_other')

const typeLabel = (type: FieldType): string => {
  switch (type) {
    case 'text':
      return t('field_type_text')
    case 'number':
      return t('field_type_number')
    case 'date':
      return t('field_type_date')
    case 'select':
      return t('field_type_select')
    case 'multi_select':
      return t('field_type_multi_select')
    case 'boolean':
      return t('field_type_boolean')
    case 'url':
      return t('field_type_url')
  }
}

/**
 * Its own cache key, even though the person forms ask the same procedure: they cache
 * `hrKeys.fields(ws)` with `includeArchived: false`, and serving them this answer would put an
 * archived field back on the hire form. This screen fetches both and splits them here.
 */
const fieldsQuery = createQuery(() => ({
  queryKey: [...hrKeys.fields(workspaceId), 'settings'] as const,
  enabled: Boolean(workspaceId),
  queryFn: () => api.fields.list({ workspaceId, includeArchived: true }),
}))
const fields = $derived(fieldsQuery.data ?? [])
const active = $derived(fields.filter((field) => !field.archivedAt))
const archived = $derived(fields.filter((field) => field.archivedAt))
const grouped = $derived(bySection(active))

let showArchived = $state(false)

const invalidate = () => {
  void queryClient.invalidateQueries({ queryKey: ['hr', 'field'] })
  // A person panel draws its values by these definitions, so a rename has to reach it too.
  void queryClient.invalidateQueries({ queryKey: ['hr', 'person'] })
}

// ---------------------------------------------------------------- the form

let dialogOpen = $state(false)
/** null while creating. It is also what decides whether `key` and `type` may still be chosen. */
let editingId = $state<string | null>(null)
let name = $state('')
let key = $state('')
let type = $state<FieldType>('text')
let section = $state<FieldSection>('profile')
let required = $state(false)
let sensitive = $state(false)
let options = $state('')
/** Touched once, the key stops following the name — otherwise a rename would rewrite it. */
let keyEdited = $state(false)
/** Set in the same tick as the click: `isPending` only reaches the button on the next render. */
let saving = $state(false)
let reordering = $state(false)

const editing = $derived(editingId !== null)

$effect(() => {
  if (!keyEdited) key = slugifyKey(name)
})

function startNew() {
  editingId = null
  name = ''
  key = ''
  type = 'text'
  section = 'profile'
  required = false
  sensitive = false
  options = ''
  keyEdited = false
  dialogOpen = true
}

function startEdit(field: CustomFieldDef) {
  editingId = field.id
  name = field.name
  key = field.key
  type = field.type
  section = field.section
  required = field.required
  sensitive = field.sensitive
  options = optionsText(field.options)
  keyEdited = true
  dialogOpen = true
}

const keyValid = $derived(FIELD_KEY_RE.test(key) && key.length <= FIELD_KEY_MAX)
const keyTaken = $derived(!editing && fields.some((field) => field.key === key))
const parsedOptions = $derived(parseOptions(options))
const optionsValid = $derived(!hasOptions(type) || parsedOptions.length > 0)
const canSave = $derived(
  canManage && name.trim().length > 0 && (editing || (keyValid && !keyTaken)) && optionsValid,
)

const save = createMutation(() => ({
  mutationFn: () => {
    const common = {
      workspaceId,
      name: name.trim(),
      section,
      required,
      sensitive,
      options: hasOptions(type) ? parsedOptions : null,
    }
    return editingId
      ? api.fields.update({ ...common, fieldId: editingId })
      : api.fields.create({ ...common, key, type })
  },
  onSuccess: (saved: CustomFieldDef) => {
    dialogOpen = false
    invalidate()
    toast.success(t('field_saved', { name: saved.name }))
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

let archiving = $state<CustomFieldDef | null>(null)

const archive = createMutation(() => ({
  mutationFn: (field: CustomFieldDef) => api.fields.archive({ workspaceId, fieldId: field.id }),
  onSuccess: (_result: unknown, field: CustomFieldDef) => {
    archiving = null
    invalidate()
    toast.success(t('field_archived_toast', { name: field.name }))
  },
  onError: (error: Error) => toast.error(error.message),
}))

const reorder = createMutation(() => ({
  mutationFn: async (vars: { field: CustomFieldDef; delta: number }) => {
    const next = [...grouped[vars.field.section]]
    const from = next.findIndex((field) => field.id === vars.field.id)
    const to = from + vars.delta
    if (from < 0 || to < 0 || to >= next.length) return
    next.splice(to, 0, next.splice(from, 1)[0]!)
    // Every field in the section whose position no longer matches its stored `order` is written,
    // not only the two that changed places: a seeded workspace has every field at order 0 and
    // falls back to sorting by name, so exchanging two zeros would move nothing on screen.
    await Promise.all(
      next.flatMap((field, index) =>
        field.order === index ? [] : [api.fields.update({ workspaceId, fieldId: field.id, order: index })],
      ),
    )
  },
  onSuccess: invalidate,
  onError: (error: Error) => toast.error(error.message),
  onSettled: () => {
    reordering = false
  },
}))

function move(field: CustomFieldDef, delta: number) {
  if (reordering) return
  reordering = true
  reorder.mutate({ field, delta })
}

function actionsFor(field: CustomFieldDef, index: number): MenuItem[] {
  if (field.archivedAt) {
    // Archived fields keep an edit action — a typo in a name still shows on old records — but
    // nothing here can bring one back, so no restore is offered.
    return [{ label: t('common.edit'), icon: 'pencil', onSelect: () => startEdit(field) }]
  }
  const last = index === grouped[field.section].length - 1
  return [
    { label: t('common.edit'), icon: 'pencil', onSelect: () => startEdit(field) },
    {
      label: t('field_move_up'),
      icon: 'chevron-up',
      disabled: index === 0,
      hint: index === 0 ? t('field_first') : undefined,
      onSelect: () => move(field, -1),
    },
    {
      label: t('field_move_down'),
      icon: 'chevron-down',
      disabled: last,
      hint: last ? t('field_last') : undefined,
      onSelect: () => move(field, 1),
    },
    { type: 'separator' },
    {
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      onSelect: () => {
        archiving = field
      },
    },
  ]
}

const typeOptions = FIELD_TYPES.map((value) => ({ value, label: typeLabel(value) }))
const sectionOptions = FIELD_SECTIONS.map((value) => ({ value, label: sectionLabel(value) }))
</script>

{#snippet row(field: CustomFieldDef, index: number)}
  <div class="trow" role="row">
    <span class="cell name" role="cell">
      <span class="fname" class:muted={Boolean(field.archivedAt)}>{field.name}</span>
      <span class="fkey">{field.key}</span>
    </span>
    <span class="cell muted" role="cell">{typeLabel(field.type)}</span>
    <span class="cell flags" role="cell">
      {#if field.archivedAt}
        <Badge tone="grey">{t('field_archived')}</Badge>
      {:else}
        {#if field.required}<Badge tone="grey">{t('field_required')}</Badge>{/if}
        {#if field.sensitive}
          <Badge tone="warning">{t('field_sensitive')}</Badge>
        {/if}
      {/if}
    </span>
    <span class="cell actions" role="cell">
      {#if canManage}
        <DropdownMenu items={actionsFor(field, index)} align="end">
          {#snippet trigger(props)}
            <IconButton {...props} icon="ellipsis" size={28} label={t('field_actions')} />
          {/snippet}
        </DropdownMenu>
      {/if}
    </span>
  </div>
{/snippet}

<SettingsPage title={t('settings_fields')} description={t('fields_desc')}>
  {#snippet actions()}
    {#if archived.length}
      <Button
        size="sm"
        variant="ghost"
        icon={showArchived ? 'eye-off' : 'eye'}
        onclick={() => (showArchived = !showArchived)}
      >
        {showArchived ? t('fields_hide_archived') : t('fields_show_archived')}
      </Button>
    {/if}
    {#if canManage}
      <Button size="sm" icon="plus" onclick={startNew}>{t('field_new')}</Button>
    {/if}
  {/snippet}

  {#if fieldsQuery.isLoading}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="48px" />{/each}
    </div>
  {:else if fieldsQuery.isError}
    <EmptyState icon="triangle-alert" title={t('fields_error')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void fieldsQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if fields.length === 0}
    <EmptyState icon="file-input" title={t('fields_none')} description={t('fields_none_desc')}>
      {#snippet actions()}
        {#if canManage}
          <Button icon="plus" onclick={startNew}>{t('field_new')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    {#if active.length === 0}
      <EmptyState bare compact icon="file-input" title={t('fields_none')} description={t('fields_none_desc')} />
    {/if}
    {#each FIELD_SECTIONS as sec (sec)}
      {#if grouped[sec].length}
        <div class="section">
          <SectionLabel label={sectionLabel(sec)} count={formatCount(grouped[sec].length)} />
          <div class="table" role="table" aria-label={sectionLabel(sec)}>
            <div class="thead" role="row">
              <span role="columnheader">{t('field_name')}</span>
              <span role="columnheader">{t('field_type')}</span>
              <span role="columnheader">{t('field_flags')}</span>
              <span class="sr-only" role="columnheader">{t('field_actions')}</span>
            </div>
            {#each grouped[sec] as field, index (field.id)}
              {@render row(field, index)}
            {/each}
          </div>
        </div>
      {/if}
    {/each}
    {#if canManage && active.length > 1}
      <p class="hint">{t('field_order_hint')}</p>
    {/if}

    {#if showArchived && archived.length}
      <div class="section">
        <SectionLabel label={t('field_archived')} count={formatCount(archived.length)} />
        <div class="table" role="table" aria-label={t('field_archived')}>
          {#each archived as field (field.id)}
            {@render row(field, -1)}
          {/each}
        </div>
        <p class="hint">{t('field_archive_permanent')}</p>
      </div>
    {/if}
  {/if}
</SettingsPage>

<Dialog
  bind:open={dialogOpen}
  size="md"
  title={editing ? t('field_edit') : t('field_new')}
  onOpenChange={(next) => {
    if (!next) dialogOpen = false
  }}
>
  <div class="form">
    <Field label={t('field_name')} id="hr-field-name" required>
      {#snippet children(id)}
        <Input {id} bind:value={name} placeholder={t('field_name_placeholder')} />
      {/snippet}
    </Field>

    <Field
      label={t('field_key')}
      id="hr-field-key"
      hint={editing ? t('field_key_fixed') : t('field_key_hint')}
      error={!editing && key.length > 0 && !keyValid
        ? t('field_key_invalid')
        : keyTaken
          ? t('field_key_taken')
          : null}
    >
      {#snippet children(id)}
        <Input
          {id}
          mono
          dir="ltr"
          bind:value={key}
          disabled={editing}
          oninput={() => (keyEdited = true)}
          placeholder="t_shirt_size"
        />
      {/snippet}
    </Field>

    <div class="grid2">
      <Field label={t('field_type')} id="hr-field-type" hint={editing ? t('field_type_fixed') : undefined}>
        {#snippet children(id)}
          <Select
            {id}
            value={type}
            disabled={editing}
            options={typeOptions}
            ariaLabel={t('field_type')}
            onValueChange={(next) => (type = next as FieldType)}
          />
        {/snippet}
      </Field>
      <Field label={t('field_section')} id="hr-field-section" hint={t('field_section_hint')}>
        {#snippet children(id)}
          <Select
            {id}
            value={section}
            options={sectionOptions}
            ariaLabel={t('field_section')}
            onValueChange={(next) => (section = next as FieldSection)}
          />
        {/snippet}
      </Field>
    </div>

    {#if hasOptions(type)}
      <Field
        label={t('field_options')}
        id="hr-field-options"
        required
        hint={editing ? t('field_options_edit_hint') : t('field_options_hint')}
        error={options.trim().length > 0 && parsedOptions.length === 0 ? t('field_options_invalid') : null}
      >
        {#snippet children(id)}
          <Textarea {id} bind:value={options} rows={5} autosize placeholder={t('field_options_placeholder')} />
        {/snippet}
      </Field>
    {/if}

    <div class="switches">
      <Checkbox
        checked={required}
        label={t('field_required')}
        description={t('field_required_hint')}
        onCheckedChange={(on) => (required = on)}
      />
      <Checkbox
        checked={sensitive}
        label={t('field_sensitive')}
        description={t('field_sensitive_hint')}
        onCheckedChange={(on) => (sensitive = on)}
      />
    </div>
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (dialogOpen = false)}>{t('common.cancel')}</Button>
    <Button disabled={!canSave} loading={save.isPending} onclick={submit}>{t('common.save')}</Button>
  {/snippet}
</Dialog>

<!--
  Archiving is not deleting, and an admin has to know that before clicking: the values people
  already have stay on their records, and come back if the field is ever re-created under the same
  key. What does change is that the field leaves every form and every profile — and nothing on this
  screen undoes it.
-->
<Dialog
  open={archiving !== null}
  size="sm"
  title={archiving ? t('field_archive_title', { name: archiving.name }) : ''}
  onOpenChange={(next) => {
    if (!next) archiving = null
  }}
>
  <p class="body">{t('field_archive_body')}</p>
  <p class="body warn">{t('field_archive_permanent')}</p>

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
.section + .section {
  margin-block-start: 20px;
}
.rows {
  display: grid;
  gap: 4px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  --hr-field-cols: minmax(180px, 1.6fr) 120px minmax(120px, 1fr) max-content;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-field-cols);
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
.fname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13.5px;
  font-weight: 500;
}
.fkey {
  flex: none;
  font-family: var(--kern-font-mono);
  font-size: 11px;
  /* A key reads left to right whatever the interface direction. */
  direction: ltr;
  unicode-bidi: isolate;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-400);
}
.muted {
  font-size: 13px;
  color: var(--kern-ink-500);
}
.flags {
  display: flex;
  align-items: center;
  gap: 6px;
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
.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}
.switches {
  display: grid;
  gap: 12px;
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
    --hr-field-cols: minmax(140px, 1.6fr) max-content;
  }
  /* The type and the flags survive in the editor; the name and the key are what a narrow list needs. */
  .thead > :nth-child(2),
  .trow > :nth-child(2),
  .thead > :nth-child(3),
  .trow > :nth-child(3) {
    display: none;
  }
}
</style>
