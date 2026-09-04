<script lang="ts">
import {
  Badge,
  type BadgeTone,
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
  messageLocale,
  navigation,
  SectionLabel,
  SegmentedControl,
  Select,
  type SelectOption,
  SettingsPage,
  SettingsSection,
  Sheet,
  Skeleton,
  StatTile,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { HR_CAPABILITIES } from '../capabilities.js'
import { countryOptions } from '../countries.js'
import { t } from '../i18n.js'
import type { Office } from '../index.js'
import { canHr } from '../permissions.js'
import { hrKeys, isoDate } from '../query.js'

/**
 * Where the company works, and who it decides for.
 *
 * The read-only list lives on `/hr/offices`; this is the screen that creates one, and until it
 * existed a workspace could never have a second office — every procedure behind offices was
 * implemented and none of them had a caller.
 *
 * **The rule this screen exists to keep visible:** a person may hold several offices at once, and
 * exactly one of them is primary. Only the primary decides their holidays, their policies and the
 * timezone their day is attributed to; the others grant presence — the directory, the local HR
 * view, later the geofence. Somebody who assigns a second office expecting a calendar to change has
 * been misled, so the roster labels every row with which kind it is and the assignment control says
 * what switching it on replaces.
 *
 * There is no "show archived" here on purpose. The contract has no `unarchive`, so a list of
 * archived offices would be rows nothing can act on; the archive confirmation says where the office
 * goes instead.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspace = $derived(session.workspaces.find((w) => w.slug === navigation.workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const canManage = $derived(canHr('officeManage'))
const canAssign = $derived(canHr('officeAssign'))
const hasCalendars = $derived(session.hasCapability('hr', HR_CAPABILITIES.calendars))
const hasEntities = $derived(session.hasCapability('hr', HR_CAPABILITIES.legalEntities))

type OfficeRow = Office & { headcount: number }

/** The six kinds the contract declares, as the option list and the label map at once. */
const KINDS = ['head_office', 'branch', 'site', 'warehouse', 'store', 'remote'] as const
type Kind = (typeof KINDS)[number]
const KIND_LABELS: Record<Kind, () => string> = {
  head_office: () => t('office_kind_head_office'),
  branch: () => t('office_kind_branch'),
  site: () => t('office_kind_site'),
  warehouse: () => t('office_kind_warehouse'),
  store: () => t('office_kind_store'),
  remote: () => t('office_kind_remote'),
}
const kindLabel = (kind: string): string => KIND_LABELS[kind as Kind]?.() ?? kind
const kindTone = (kind: string): BadgeTone => (kind === 'remote' ? 'info' : 'grey')

/** `formatCount` caps at 99 for badges. A headcount is a real number and must not read "99+". */
const count = (n: number) => formatCount(n, Number.MAX_SAFE_INTEGER)

// ---------------------------------------------------------------- reference data

/**
 * Every country the runtime can name, in the reader's own language.
 *
 * The list lives in `countries.ts`, which the legal-entity screen shares: two settings pages
 * offering two different sets of countries is the kind of difference nobody reports.
 */
const countries = $derived(countryOptions(messageLocale()))
const countryNames = $derived(new Map(countries.map((c) => [c.value, c.label])))
const countryLabel = (code: string): string => countryNames.get(code) ?? code

/** The IANA zones the runtime knows. Empty on a runtime without `supportedValuesOf`. */
const ZONES: string[] = (() => {
  try {
    return [...Intl.supportedValuesOf('timeZone')]
  } catch {
    return []
  }
})()

/**
 * The browser's own zone as the starting point for a new office.
 *
 * `resolvedOptions()` reads a setting rather than formatting anything, so it is not the bare `Intl`
 * call the house rule is about — nothing here is shown to the reader without going through the
 * option list.
 */
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- what is open

/**
 * Every piece of "what is on screen" is declared before the first `createQuery`, and that ordering
 * is load-bearing rather than tidy.
 *
 * `createQuery` evaluates its options function immediately to build the observer, so an `enabled`
 * that reads a `$state` declared further down the file throws "Cannot access 'draft' before
 * initialization" — at runtime only, on the first render, which nothing here type-checks.
 */
interface Draft {
  /** `null` while creating. The two procedures take different fields, so this decides which. */
  id: string | null
  name: string
  code: string
  kind: Kind
  country: string
  region: string
  city: string
  timezone: string
  parentOfficeId: string
  legalEntityId: string
  calendarId: string
  headPersonId: string
  seedCalendarFromPack: boolean
}

let draft = $state<Draft | null>(null)
let formError = $state<string | null>(null)
/**
 * `disabled={save.isPending}` reaches the button one render late, and two quick clicks are one
 * render apart — which on create is two offices. The guard is set in the same tick as the click.
 */
let saving = $state(false)

let rosterOfficeId = $state<string | null>(null)
let rosterFilter = $state('all')

// ---------------------------------------------------------------- queries

const officesQuery = createQuery(() => ({
  queryKey: hrKeys.offices(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.offices.list({ workspaceId, includeArchived: false }),
}))
const offices = $derived((officesQuery.data ?? []) as OfficeRow[])

const stats = $derived({
  offices: offices.length,
  countries: new Set(offices.map((o) => o.country)).size,
  people: offices.reduce((sum, o) => sum + o.headcount, 0),
})

/**
 * The directory, for the two person pickers — head of office, and who to assign.
 *
 * Only fetched while one of them is on screen: a settings page nobody has opened a dialog on has
 * no reason to pull two hundred people.
 */
const directoryQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forOffices: true }),
  enabled: Boolean(workspaceId) && (draft !== null || rosterOfficeId !== null),
  queryFn: () => api.people.list({ workspaceId, limit: 200, status: ['active'] }),
}))
const directory = $derived(directoryQuery.data?.items ?? [])

const calendarsQuery = createQuery(() => ({
  queryKey: hrKeys.calendars(workspaceId),
  enabled: Boolean(workspaceId) && hasCalendars && draft?.id != null,
  queryFn: () => api.calendars.list({ workspaceId, includeArchived: false }),
}))

/**
 * `[module, entity, …scope]`, the shape `hrKeys` uses. Spelled here rather than in `query.ts`
 * because this screen is the only one that asks.
 *
 * `person`, not `office`: a roster changes when somebody is assigned, unassigned or renamed, and
 * `offices.assign` announces the person it moved rather than the office it moved them to.
 */
const officePeopleKey = (ws: string, officeId: string, primaryOnly: boolean) =>
  ['hr', 'person', ws, 'office-people', officeId, primaryOnly ? 'primary' : 'all'] as const

/**
 * `hrKeys.entities`, not a local spelling of it. This picker is the same live-employers cache the
 * reports and accrual screens read, so a second key here would be a second copy that a write to
 * either never refreshes — and the shared one is spelt after the `legal_entity` the router
 * announces, which is what gets it invalidated at all.
 */
const entitiesQuery = createQuery(() => ({
  queryKey: hrKeys.entities(workspaceId),
  enabled: Boolean(workspaceId) && hasEntities && draft !== null,
  queryFn: () => api.entities.list({ workspaceId, includeArchived: false }),
}))

// ---------------------------------------------------------------- the form

function openCreate() {
  formError = null
  draft = {
    id: null,
    name: '',
    code: '',
    kind: 'branch',
    // No country is guessed. A second office is usually in a different one from the first, and a
    // pre-filled country is the field nobody re-reads.
    country: '',
    region: '',
    city: '',
    timezone: browserZone(),
    parentOfficeId: '',
    legalEntityId: '',
    calendarId: '',
    headPersonId: '',
    seedCalendarFromPack: true,
  }
}

function openEdit(office: OfficeRow) {
  formError = null
  draft = {
    id: office.id,
    name: office.name,
    code: office.code ?? '',
    kind: office.kind as Kind,
    country: office.country,
    region: office.region ?? '',
    city: office.city ?? '',
    timezone: office.timezone,
    parentOfficeId: office.parentOfficeId ?? '',
    legalEntityId: office.legalEntityId ?? '',
    calendarId: office.calendarId ?? '',
    headPersonId: office.headPersonId ?? '',
    // Only offered on create: the pack is what a new office's calendar is built from, and an
    // existing one already has whatever it has.
    seedCalendarFromPack: false,
  }
}

const draftValid = $derived(
  draft !== null && draft.name.trim().length > 0 && draft.country.length === 2 && draft.timezone !== '',
)

/**
 * Zones as a grouped list, with the office's own zone forced in.
 *
 * A zone the runtime has retired (`Asia/Calcutta`) would otherwise be dropped from the options, the
 * field would render empty, and saving would quietly move the office to a different one.
 */
const timezones = $derived.by((): SelectOption[] => {
  const zones = new Set(ZONES)
  if (draft?.timezone) zones.add(draft.timezone)
  return [...zones].sort().map((zone) => {
    const slash = zone.indexOf('/')
    if (slash === -1) return { value: zone, label: zone }
    return {
      value: zone,
      label: zone
        .slice(slash + 1)
        .replaceAll('_', ' ')
        .replaceAll('/', ' / '),
      group: zone.slice(0, slash),
    }
  })
})

const kindChoices = $derived(KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind]() })))
const parentChoices = $derived([
  { value: '', label: t('office_parent_none') },
  ...offices.filter((o) => o.id !== draft?.id).map((o) => ({ value: o.id, label: o.name })),
])
const entityChoices = $derived([
  { value: '', label: t('office_entity_none') },
  ...(entitiesQuery.data ?? []).map((e) => ({ value: e.id, label: e.name })),
])
const calendarChoices = $derived([
  { value: '', label: t('office_calendar_default') },
  ...(calendarsQuery.data ?? []).map((c) => ({ value: c.id, label: c.name })),
])
const peopleChoices = $derived(directory.map((p) => ({ value: p.id, label: p.displayName })))
/** Head of office is a field somebody can clear; who to assign is not, so only one carries a null. */
const headChoices = $derived([{ value: '', label: t('office_head_none') }, ...peopleChoices])

const save = createMutation(() => ({
  mutationFn: (input: Draft) => {
    const shared = {
      workspaceId,
      name: input.name.trim(),
      kind: input.kind,
      country: input.country,
      region: input.region.trim() || null,
      city: input.city.trim() || null,
      timezone: input.timezone,
      code: input.code.trim() || null,
      legalEntityId: input.legalEntityId || null,
    }
    return input.id === null
      ? api.offices.create({
          ...shared,
          parentOfficeId: input.parentOfficeId || null,
          seedCalendarFromPack: input.seedCalendarFromPack,
        })
      : api.offices.update({
          ...shared,
          officeId: input.id,
          calendarId: input.calendarId || null,
          headPersonId: input.headPersonId || null,
        })
  },
  onSuccess: (office, input) => {
    toast.success(input.id === null ? t('office_created', { name: office.name }) : t('office_saved'))
    draft = null
    formError = null
    // An office decides holidays, policies and a timezone, so a change to one moves resolutions and
    // day sheets as well as this list. Invalidating the module is cheaper than guessing which.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error: Error) => {
    formError = error.message || t('office_save_error')
  },
  onSettled: () => {
    saving = false
  },
}))

function submitDraft() {
  if (!draft || !draftValid || saving) return
  saving = true
  formError = null
  save.mutate($state.snapshot(draft) as Draft)
}

// ---------------------------------------------------------------- default and archive

let makingDefaultId = $state<string | null>(null)
let archivingId = $state<string | null>(null)
let actionError = $state<string | null>(null)
let acting = $state(false)

const makingDefault = $derived(offices.find((o) => o.id === makingDefaultId) ?? null)
const archiving = $derived(offices.find((o) => o.id === archivingId) ?? null)
const currentDefault = $derived(offices.find((o) => o.isDefault) ?? null)

const setDefault = createMutation(() => ({
  mutationFn: (vars: { officeId: string; name: string }) =>
    api.offices.setDefault({ workspaceId, officeId: vars.officeId }),
  onSuccess: (_office, vars) => {
    toast.success(t('office_default_toast', { name: vars.name }))
    makingDefaultId = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error: Error) => {
    actionError = error.message || t('office_default_error')
  },
  onSettled: () => {
    acting = false
  },
}))

const archive = createMutation(() => ({
  mutationFn: (vars: { officeId: string; name: string }) =>
    api.offices.archive({ workspaceId, officeId: vars.officeId }),
  onSuccess: (_ok, vars) => {
    toast.success(t('office_archived_toast', { name: vars.name }))
    archivingId = null
    if (rosterOfficeId === vars.officeId) rosterOfficeId = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error: Error) => {
    actionError = error.message || t('office_archive_error')
  },
  onSettled: () => {
    acting = false
  },
}))

// ---------------------------------------------------------------- the roster

/** The live row, not a snapshot: the name and the headcount move while the panel is open. */
const rosterOffice = $derived(offices.find((o) => o.id === rosterOfficeId) ?? null)

const rosterQuery = createQuery(() => ({
  queryKey: officePeopleKey(workspaceId, rosterOfficeId ?? '', rosterFilter === 'primary'),
  enabled: Boolean(workspaceId) && rosterOfficeId !== null,
  queryFn: () =>
    api.offices.people({
      workspaceId,
      officeId: rosterOfficeId ?? '',
      limit: 100,
      primaryOnly: rosterFilter === 'primary',
    }),
}))
const roster = $derived(rosterQuery.data?.items ?? [])

let assignPersonId = $state('')
let assignFrom = $state(isoDate())
let assignPrimary = $state(true)
let assignReason = $state('')
let assignError = $state<string | null>(null)
let assigning = $state(false)

/** A fresh panel starts with an empty form rather than the last office's half-typed one. */
$effect(() => {
  void rosterOfficeId
  assignPersonId = ''
  assignFrom = isoDate()
  assignPrimary = true
  assignReason = ''
  assignError = null
})

const assign = createMutation(() => ({
  mutationFn: (vars: { officeId: string; personId: string; name: string }) =>
    api.offices.assign({
      workspaceId,
      officeId: vars.officeId,
      personId: vars.personId,
      isPrimary: assignPrimary,
      effectiveFrom: assignFrom,
      reason: assignReason.trim() || null,
    }),
  onSuccess: (_assignments, vars) => {
    toast.success(t('office_assigned_toast', { name: vars.name }))
    assignPersonId = ''
    assignReason = ''
    assignError = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error: Error) => {
    assignError = error.message || t('office_assign_error')
  },
  onSettled: () => {
    assigning = false
  },
}))

function submitAssignment() {
  const officeId = rosterOfficeId
  if (!officeId || !assignPersonId || !assignFrom || assigning) return
  assigning = true
  assignError = null
  assign.mutate({
    officeId,
    personId: assignPersonId,
    name: directory.find((p) => p.id === assignPersonId)?.displayName ?? '',
  })
}

let unassigning = $state<{ personId: string; name: string; primary: boolean } | null>(null)
let unassignUntil = $state(isoDate())

const unassign = createMutation(() => ({
  mutationFn: (vars: { officeId: string; personId: string; name: string }) =>
    api.offices.unassign({
      workspaceId,
      officeId: vars.officeId,
      personId: vars.personId,
      effectiveTo: unassignUntil,
    }),
  onSuccess: (_ok, vars) => {
    toast.success(t('office_unassigned_toast', { name: vars.name }))
    unassigning = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error: Error) => {
    actionError = error.message || t('office_unassign_error')
  },
  onSettled: () => {
    acting = false
  },
}))

function confirmUnassign() {
  const officeId = rosterOfficeId
  const target = unassigning
  if (!officeId || !target || acting) return
  acting = true
  actionError = null
  unassign.mutate({ officeId, personId: target.personId, name: target.name })
}

// ---------------------------------------------------------------- row actions

function actionsFor(office: OfficeRow): MenuItem[] {
  const items: MenuItem[] = [
    { label: t('office_people_manage'), icon: 'users', onSelect: () => (rosterOfficeId = office.id) },
  ]
  if (!canManage) return items
  items.unshift({ label: t('common.edit'), icon: 'pencil', onSelect: () => openEdit(office) })
  items.push({
    label: t('office_make_default'),
    icon: 'star',
    disabled: office.isDefault,
    hint: office.isDefault ? t('office_make_default_already') : undefined,
    onSelect: () => {
      actionError = null
      makingDefaultId = office.id
    },
  })
  items.push({ type: 'separator' })
  items.push({
    label: t('common.archive'),
    icon: 'archive',
    danger: true,
    // The workspace must always have a default, so the server refuses this one. Saying why beats
    // an error the person only meets after the confirmation.
    disabled: office.isDefault,
    hint: office.isDefault ? t('office_archive_blocked') : undefined,
    onSelect: () => {
      actionError = null
      archivingId = office.id
    },
  })
  return items
}
</script>

<SettingsPage title={t('settings_offices')} description={t('offices_settings_desc')}>
  {#snippet actions()}
    {#if canManage}
      <Button size="sm" icon="plus" onclick={openCreate}>{t('office_add')}</Button>
    {/if}
  {/snippet}

  {#if officesQuery.isLoading}
    <div class="tiles">
      {#each [1, 2, 3] as n (n)}<Skeleton height="86px" />{/each}
    </div>
  {:else if !officesQuery.isError && offices.length > 0}
    <div class="tiles">
      <StatTile size="md" label={t('offices_title')} value={count(stats.offices)} />
      <StatTile size="md" label={t('offices_countries')} value={count(stats.countries)} />
      <StatTile size="md" label={t('office_people')} value={count(stats.people)} />
    </div>
  {/if}

  <SettingsSection flush>
    {#if officesQuery.isLoading}
      <div class="pad rows">
        {#each [1, 2, 3] as n (n)}<Skeleton height="56px" />{/each}
      </div>
    {:else if officesQuery.isError}
      <div class="pad">
        <EmptyState icon="triangle-alert" title={t('offices_error')}>
          {#snippet actions()}
            <Button variant="secondary" onclick={() => void officesQuery.refetch()}>{t('retry')}</Button>
          {/snippet}
        </EmptyState>
      </div>
    {:else if offices.length === 0}
      <div class="pad">
        <EmptyState icon="building" title={t('offices_none')} description={t('offices_none_desc')}>
          {#snippet actions()}
            {#if canManage}
              <Button icon="plus" onclick={openCreate}>{t('office_add')}</Button>
            {/if}
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <div class="table" role="table" aria-label={t('offices_title')}>
        <div class="thead" role="row">
          <span role="columnheader">{t('office')}</span>
          <span role="columnheader">{t('office_kind')}</span>
          <span role="columnheader">{t('office_country')}</span>
          <span class="num" role="columnheader">{t('office_people')}</span>
          <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
        </div>
        {#each offices as office (office.id)}
          <div class="trow" role="row">
            <span class="cell stack" role="cell">
              <span class="name">
                {office.name}
                {#if office.isDefault}<Badge tone="accent">{t('office_default')}</Badge>{/if}
              </span>
              {#if office.code}<span class="sub mono">{office.code}</span>{/if}
            </span>
            <span class="cell" role="cell">
              <Badge tone={kindTone(office.kind)}>{kindLabel(office.kind)}</Badge>
            </span>
            <span class="cell stack" role="cell">
              <span class="sub">{office.city ? `${office.city}, ` : ''}{countryLabel(office.country)}</span>
              <span class="sub mono">{office.timezone}</span>
            </span>
            <span class="cell num" role="cell">{count(office.headcount)}</span>
            <span class="cell end" role="cell">
              <DropdownMenu items={actionsFor(office)} align="end">
                {#snippet trigger(props)}
                  <IconButton
                    {...props}
                    icon="ellipsis"
                    size={28}
                    label={t('office_actions', { name: office.name })}
                  />
                {/snippet}
              </DropdownMenu>
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </SettingsSection>
</SettingsPage>

<!-- ------------------------------------------------------------------ create and edit -->
<Dialog
  open={draft !== null}
  size="lg"
  title={draft?.id ? t('office_edit_title', { name: draft.name }) : t('office_new')}
  onOpenChange={(open) => {
    if (!open) draft = null
  }}
>
  {#if draft}
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault()
        submitDraft()
      }}
    >
      <SectionLabel sub label={t('office_form_what')} />
      <div class="pair">
        <Field label={t('display_name')} required>
          {#snippet children(id)}
            <Input {id} bind:value={draft!.name} autocomplete="off" />
          {/snippet}
        </Field>
        <Field label={t('office_kind')}>
          {#snippet children(id)}
            <Select {id} bind:value={draft!.kind} options={kindChoices} placeholder={t('choose')} />
          {/snippet}
        </Field>
      </div>
      <div class="pair">
        <Field label={t('office_code')} hint={t('office_code_hint')}>
          {#snippet children(id)}
            <Input {id} mono bind:value={draft!.code} autocomplete="off" />
          {/snippet}
        </Field>
        {#if draft.id === null}
          <Field label={t('office_parent')} hint={t('office_parent_hint')}>
            {#snippet children(id)}
              <Select
                {id}
                bind:value={draft!.parentOfficeId}
                options={parentChoices}
                placeholder={t('office_parent_none')}
              />
            {/snippet}
          </Field>
        {/if}
      </div>

      <SectionLabel sub label={t('office_form_where')} />
      <div class="pair">
        <Field label={t('office_country')} required>
          {#snippet children(id)}
            <Select {id} bind:value={draft!.country} options={countries} placeholder={t('choose')} />
          {/snippet}
        </Field>
        <Field label={t('office_city')} hint={t('common.optional')}>
          {#snippet children(id)}
            <Input {id} bind:value={draft!.city} autocomplete="off" />
          {/snippet}
        </Field>
      </div>
      <div class="pair">
        <Field label={t('office_region')} hint={t('office_region_hint')}>
          {#snippet children(id)}
            <Input {id} mono bind:value={draft!.region} autocomplete="off" />
          {/snippet}
        </Field>
        <Field label={t('office_timezone')} hint={t('office_timezone_hint')} required>
          {#snippet children(id)}
            <Select {id} bind:value={draft!.timezone} options={timezones} placeholder={t('choose')} />
          {/snippet}
        </Field>
      </div>

      {#if draft.id === null || hasEntities || hasCalendars}
        <SectionLabel sub label={t('office_form_follows')} />
      {/if}
      {#if draft.id === null}
        <!--
          The one control on this form that decides something a person cannot see: without the pack
          the office shares the workspace calendar, and nobody would guess that from a checkbox.
        -->
        <Checkbox
          bind:checked={draft!.seedCalendarFromPack}
          label={t('office_seed')}
          description={t('office_seed_desc')}
        />
      {/if}
      <div class="pair">
        {#if hasEntities}
          <Field label={t('office_entity')} hint={t('office_entity_hint')}>
            {#snippet children(id)}
              <Select
                {id}
                bind:value={draft!.legalEntityId}
                options={entityChoices}
                disabled={entitiesQuery.isLoading}
                placeholder={t('office_entity_none')}
              />
            {/snippet}
          </Field>
        {/if}
        {#if draft.id !== null && hasCalendars}
          <Field label={t('office_calendar')} hint={t('office_calendar_hint')}>
            {#snippet children(id)}
              <Select
                {id}
                bind:value={draft!.calendarId}
                options={calendarChoices}
                disabled={calendarsQuery.isLoading}
                placeholder={t('office_calendar_default')}
              />
            {/snippet}
          </Field>
        {/if}
      </div>
      {#if draft.id !== null}
        <Field label={t('office_head')} hint={t('common.optional')}>
          {#snippet children(id)}
            <Select
              {id}
              bind:value={draft!.headPersonId}
              options={headChoices}
              disabled={directoryQuery.isLoading}
              placeholder={t('office_head_none')}
            />
          {/snippet}
        </Field>
      {/if}

      {#if formError}<p class="err" role="alert">{formError}</p>{/if}
    </form>
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (draft = null)}>{t('common.cancel')}</Button>
    <Button onclick={submitDraft} disabled={!draftValid || !canManage} loading={saving}>
      {draft?.id ? t('common.save') : t('office_add')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ make default -->
<Dialog
  open={makingDefault !== null}
  size="sm"
  title={t('office_default_title', { name: makingDefault?.name ?? '' })}
  onOpenChange={(open) => {
    if (!open) makingDefaultId = null
  }}
>
  <p class="body">
    {t('office_default_body', {
      current: currentDefault?.name ?? '',
      name: makingDefault?.name ?? '',
    })}
  </p>
  {#if actionError}<p class="err" role="alert">{actionError}</p>{/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (makingDefaultId = null)}>{t('common.cancel')}</Button>
    <Button
      loading={acting}
      onclick={() => {
        if (!makingDefault || acting) return
        acting = true
        actionError = null
        setDefault.mutate({ officeId: makingDefault.id, name: makingDefault.name })
      }}
    >
      {t('office_make_default')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ archive -->
<Dialog
  open={archiving !== null}
  size="sm"
  title={t('office_archive_title', { name: archiving?.name ?? '' })}
  onOpenChange={(open) => {
    if (!open) archivingId = null
  }}
>
  <p class="body">
    {archiving && archiving.headcount > 0
      ? t('office_archive_body', { count: archiving.headcount })
      : t('office_archive_body_empty')}
  </p>
  <p class="body muted">{t('office_archive_note')}</p>
  {#if actionError}<p class="err" role="alert">{actionError}</p>{/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (archivingId = null)}>{t('common.cancel')}</Button>
    <Button
      variant="danger"
      loading={acting}
      onclick={() => {
        if (!archiving || acting) return
        acting = true
        actionError = null
        archive.mutate({ officeId: archiving.id, name: archiving.name })
      }}
    >
      {t('common.archive')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ the roster -->
<Sheet
  open={rosterOffice !== null}
  width={480}
  title={t('office_people_title', { name: rosterOffice?.name ?? '' })}
  onOpenChange={(open) => {
    if (!open) rosterOfficeId = null
  }}
>
  <p class="explainer">{t('office_primary_explainer')}</p>

  <div class="filter">
    <SegmentedControl
      size="sm"
      label={t('office_people')}
      bind:value={rosterFilter}
      items={[
        { value: 'all', label: t('office_people_all') },
        { value: 'primary', label: t('office_people_primary_only') },
      ]}
    />
  </div>

  {#if rosterQuery.isLoading}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="44px" />{/each}
    </div>
  {:else if rosterQuery.isError}
    <EmptyState compact icon="triangle-alert" title={t('office_people_error')}>
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={() => void rosterQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if roster.length === 0}
    <!--
      Two different emptinesses. "Nobody works here" is wrong when the filter is on and somebody
      does work here without this being the office that decides for them.
    -->
    <EmptyState
      compact
      icon="user"
      title={rosterFilter === 'primary' ? t('office_people_none_primary') : t('office_people_none')}
      description={t('office_people_none_desc')}
    />
  {:else}
    <ul class="roster">
      {#each roster as person (person.id)}
        <li>
          <span class="stack">
            <span class="name">{person.displayName}</span>
            <span class="sub">
              {#if person.isPrimaryHere}
                <Badge tone="accent">{t('office_primary_here')}</Badge>
              {:else}
                <Badge tone="grey">{t('office_also_here')}</Badge>
              {/if}
            </span>
          </span>
          {#if canAssign}
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('office_unassign_label', { name: person.displayName })}
              onclick={() => {
                actionError = null
                unassignUntil = isoDate()
                unassigning = {
                  personId: person.id,
                  name: person.displayName,
                  primary: person.isPrimaryHere,
                }
              }}
            >
              {t('common.remove')}
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if canAssign}
    <form
      class="assign"
      onsubmit={(event) => {
        event.preventDefault()
        submitAssignment()
      }}
    >
      <SectionLabel sub label={t('office_assign')} />
      <Field label={t('office_assign_person')} required>
        {#snippet children(id)}
          <Select
            {id}
            bind:value={assignPersonId}
            options={peopleChoices}
            disabled={directoryQuery.isLoading}
            placeholder={directory.length === 0 ? t('no_people') : t('choose')}
          />
        {/snippet}
      </Field>
      <Field label={t('office_assign_from')} required>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={assignFrom} />
        {/snippet}
      </Field>
      <Checkbox
        bind:checked={assignPrimary}
        label={t('office_assign_primary')}
        description={t('office_assign_primary_desc')}
      />
      <Field label={t('office_assign_reason')} hint={t('common.optional')}>
        {#snippet children(id)}
          <Input {id} bind:value={assignReason} autocomplete="off" />
        {/snippet}
      </Field>
      {#if assignError}<p class="err" role="alert">{assignError}</p>{/if}
      <div class="end">
        <Button
          type="submit"
          size="sm"
          disabled={!assignPersonId || !assignFrom}
          loading={assigning}
        >
          {t('office_assign_submit')}
        </Button>
      </div>
    </form>
  {/if}
</Sheet>

<!-- ------------------------------------------------------------------ unassign -->
<Dialog
  open={unassigning !== null}
  size="sm"
  title={t('office_unassign_title', {
    name: unassigning?.name ?? '',
    office: rosterOffice?.name ?? '',
  })}
  onOpenChange={(open) => {
    if (!open) unassigning = null
  }}
>
  <p class="body">
    {unassigning?.primary
      ? t('office_unassign_body_primary')
      : t('office_unassign_body_other', { office: rosterOffice?.name ?? '' })}
  </p>
  <Field label={t('office_unassign_until')} required>
    {#snippet children(id)}
      <Input {id} type="date" bind:value={unassignUntil} />
    {/snippet}
  </Field>
  {#if actionError}<p class="err" role="alert">{actionError}</p>{/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (unassigning = null)}>{t('common.cancel')}</Button>
    <Button variant="danger" loading={acting} disabled={!unassignUntil} onclick={confirmUnassign}>
      {t('common.remove')}
    </Button>
  {/snippet}
</Dialog>

<style>
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.rows {
  display: grid;
  gap: 4px;
}
.pad {
  padding: 4px 18px 18px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  --hr-office-cols: minmax(160px, 1.6fr) 116px minmax(130px, 1fr) 64px 36px;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-office-cols);
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
  min-height: 56px;
  border-block-end: 1px solid var(--kern-border-hairline);
}
.trow:last-child {
  border-block-end: 0;
}
.trow:hover {
  background: var(--kern-surface-hover);
}
.cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 500;
}
.sub {
  font-size: 12px;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-500);
}
.mono {
  font-family: var(--kern-font-mono);
}
.num {
  text-align: end;
  font-size: 13px;
  color: var(--kern-ink-500);
  font-variant-numeric: tabular-nums;
}
.end {
  display: flex;
  justify-content: flex-end;
  overflow: visible;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.form {
  display: grid;
  gap: 12px;
}
.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.body {
  margin: 0 0 12px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kern-ink-700);
  text-wrap: pretty;
}
.body.muted {
  color: var(--kern-ink-500);
}
.err {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}

.explainer {
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-lg);
  background: var(--kern-surface-chip);
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--kern-ink-700);
  text-wrap: pretty;
}
.filter {
  margin-block-end: 10px;
}
.roster {
  display: grid;
  gap: 4px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.roster li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 6px 10px;
  border: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-md);
}
.assign {
  display: grid;
  gap: 12px;
  margin-block-start: 20px;
  padding-block-start: 16px;
  border-block-start: 1px solid var(--kern-border);
}

@media (max-width: 720px) {
  .table {
    --hr-office-cols: minmax(140px, 1.6fr) minmax(110px, 1fr) 64px 36px;
  }
  /* The kind badge is the column a narrow screen can lose: it is the least load-bearing fact. */
  .thead > :nth-child(2),
  .trow > :nth-child(2) {
    display: none;
  }
  .pair {
    grid-template-columns: 1fr;
  }
}
</style>
