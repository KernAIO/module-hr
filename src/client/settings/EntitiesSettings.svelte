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
  messageLocale,
  navigation,
  SectionLabel,
  Select,
  SettingsPage,
  SettingsSection,
  Skeleton,
  StatTile,
  Switch,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { HR_CAPABILITIES } from '../capabilities.js'
import { countryOptions, currencyOptions, withCode } from '../countries.js'
import { t } from '../i18n.js'
import type { CostCenter, LegalEntity } from '../index.js'
import { canHr } from '../permissions.js'
import { hrKeys } from '../query.js'

/**
 * Who actually employs these people, and which budget their hours are booked against.
 *
 * **Why the screen exists at all.** `payroll.export.v1` takes a `legalEntityId` and refuses without
 * one, and the only source of those ids is `entities.list` — so a workspace with the payroll
 * capability on and no employer on file has a payroll screen it can never press the button on.
 * Every procedure behind this area was implemented and none of them had a caller: an entity could
 * be created by an API call and by nothing a person could reach.
 *
 * **The distinction the two sections keep apart.** A legal entity is who signs the contract and
 * files the payroll — a group with a Dutch B.V. and a Turkish A.Ş. closes two payrolls out of one
 * workspace, and the office is not that: two Turkish offices can share one employer and one office
 * can host two. A cost centre is the other question, asked by finance rather than by law: which
 * budget the hours land on. It carries the office, the department and the employer it belongs to
 * because a real chart of accounts is cut along all three, and every one of them is optional
 * because most companies only cut along one.
 *
 * **Neither is ever deleted.** Both archive, and archived rows stay readable behind a toggle: an
 * office, a period and an exported payroll file all name their employer, and a filing whose
 * employer has vanished is a number nobody can explain. There is no unarchive in the contract, so
 * archiving an employer asks for its name to be typed back — it is the one act here that a person
 * cannot undo from this screen.
 *
 * The contract has no cost-centre update, so a cost centre is created and archived and never
 * edited: its row menu carries one item, and the create dialog says so, because a form somebody
 * expects to be able to re-open is worse than a field they know to get right the first time.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspace = $derived(session.workspaces.find((w) => w.slug === navigation.workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/** Reading is an administrator's; writing ships granted to the owner alone. */
const canManage = $derived(canHr('entityManage'))
/**
 * Whether the other two things a cost centre hangs off can be *asked about* at all.
 *
 * Offices are a capability and a permission — a procedure behind a capability that is off answers
 * 404, not an empty list, so asking would draw an error over a working screen. Departments are
 * neither: they are part of `core` and gated on the permission alone.
 */
const hasOffices = $derived(session.hasCapability('hr', HR_CAPABILITIES.offices) && canHr('officeView'))
const hasOrg = $derived(canHr('orgView'))

// ---------------------------------------------------------------- reference data

const countries = $derived(countryOptions(messageLocale()))
const countryNames = $derived(new Map(countries.map((c) => [c.value, c.label])))
const countryLabel = (code: string): string => countryNames.get(code) ?? code

const currencies = $derived(currencyOptions(messageLocale()))

/**
 * Everything on screen is declared before the first `createQuery`, and that ordering is load-bearing
 * rather than tidy: `createQuery` evaluates its options function immediately to build the observer,
 * so an `enabled` reading a `$state` declared further down throws "Cannot access before
 * initialization" — at runtime, on the first render, which nothing here type-checks.
 */
interface EntityDraft {
  /** `null` while creating. The two procedures take different fields, so this decides which. */
  id: string | null
  name: string
  country: string
  registrationNo: string
  taxNo: string
  currency: string
}

interface CentreDraft {
  code: string
  name: string
  officeId: string
  orgUnitId: string
  legalEntityId: string
}

let entityDraft = $state<EntityDraft | null>(null)
let entityError = $state<string | null>(null)
let centreDraft = $state<CentreDraft | null>(null)
let centreError = $state<string | null>(null)

let showArchivedEntities = $state(false)
let showArchivedCentres = $state(false)

let archivingEntityId = $state<string | null>(null)
let typedName = $state('')
let archivingCentreId = $state<string | null>(null)
let actionError = $state<string | null>(null)

/**
 * One click, one write.
 *
 * `disabled={mutation.isPending}` reaches the button on the next render, and two quick clicks are
 * one render apart — which on this screen is two employers with the same name, or a cost centre
 * archived twice. Each flag is set in the same tick as the click and cleared when the call settles.
 */
let saving = $state(false)
let acting = $state(false)

// ---------------------------------------------------------------- the lists

/**
 * Archived rows come with the rest and are hidden here, so one request answers both views.
 *
 * Its own cache key, even though four other screens ask the same procedure: they cache
 * `hrKeys.entities(ws)` to fill a picker, and serving them this answer would offer somebody an
 * archived employer to assign an office to.
 */
const entitiesQuery = createQuery(() => ({
  queryKey: hrKeys.entitiesAll(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.entities.list({ workspaceId, includeArchived: true }),
}))
const allEntities = $derived((entitiesQuery.data ?? []) as LegalEntity[])
const liveEntities = $derived(allEntities.filter((e) => !e.archivedAt))
const archivedEntityCount = $derived(allEntities.length - liveEntities.length)
const entities = $derived(showArchivedEntities ? allEntities : liveEntities)
const entityNames = $derived(new Map(allEntities.map((e) => [e.id, e.name])))

const centresQuery = createQuery(() => ({
  queryKey: hrKeys.costCenters(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.entities.costCenters.list({ workspaceId, includeArchived: true }),
}))
const allCentres = $derived((centresQuery.data ?? []) as CostCenter[])
const liveCentres = $derived(allCentres.filter((c) => !c.archivedAt))
const archivedCentreCount = $derived(allCentres.length - liveCentres.length)
const centres = $derived(showArchivedCentres ? allCentres : liveCentres)

/**
 * The other two things a cost centre can hang off.
 *
 * Archived ones included, because the list above names what each centre is attached to and a budget
 * booked against an office that has since been archived still has to say which. The pickers below
 * filter them back out — offering one would be a dead reference.
 *
 * Not deferred until the dialog opens: the table needs these names on first paint, and both keys
 * are shared with screens that would fetch them anyway.
 */
const officesQuery = createQuery(() => ({
  queryKey: hrKeys.officesAll(workspaceId),
  enabled: Boolean(workspaceId) && hasOffices,
  queryFn: () => api.offices.list({ workspaceId, includeArchived: true }),
}))
const unitsQuery = createQuery(() => ({
  queryKey: hrKeys.orgUnitsAll(workspaceId),
  enabled: Boolean(workspaceId) && hasOrg,
  queryFn: () => api.org.units.tree({ workspaceId, includeArchived: true }),
}))

const allOffices = $derived(officesQuery.data ?? [])
const allUnits = $derived(unitsQuery.data ?? [])
const officeNames = $derived(new Map(allOffices.map((o) => [o.id, o.name])))
const unitNames = $derived(new Map(allUnits.map((u) => [u.id, u.name])))

const stats = $derived({
  entities: liveEntities.length,
  countries: new Set(liveEntities.map((e) => e.country)).size,
  centres: liveCentres.length,
})

/**
 * An employer's name is drawn on the offices, periods, accrual and payroll screens, and a cost
 * centre reaches the payroll file. Invalidating the module is cheaper than guessing which.
 */
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: ['hr'] })
}

// ---------------------------------------------------------------- the employer form

function openEntityCreate() {
  entityError = null
  entityDraft = {
    id: null,
    // Nothing is guessed. A second employer is usually in a different country from the first, and
    // a pre-filled country is the field nobody re-reads.
    name: '',
    country: '',
    registrationNo: '',
    taxNo: '',
    currency: '',
  }
}

function openEntityEdit(entity: LegalEntity) {
  entityError = null
  entityDraft = {
    id: entity.id,
    name: entity.name,
    country: entity.country,
    registrationNo: entity.registrationNo ?? '',
    taxNo: entity.taxNo ?? '',
    currency: entity.currency ?? '',
  }
}

const entityValid = $derived(
  entityDraft !== null && entityDraft.name.trim().length > 0 && entityDraft.country.length === 2,
)

/**
 * The record's own country and currency are forced into the option lists.
 *
 * A code this runtime cannot name would otherwise be missing, the field would render empty, and
 * saving would quietly move the employer to a different country or a different currency.
 */
const entityCountries = $derived(withCode(countries, entityDraft?.country ?? ''))
const entityCurrencies = $derived([
  { value: '', label: t('ent_currency_none') },
  ...withCode(currencies, entityDraft?.currency ?? ''),
])

const saveEntity = createMutation(() => ({
  mutationFn: (input: EntityDraft) => {
    const shared = {
      workspaceId,
      name: input.name.trim(),
      country: input.country,
      // `null`, not `undefined`: the contract takes a nullish value and the server patches every key
      // it is handed, so a cleared registration number has to arrive as an explicit null.
      registrationNo: input.registrationNo.trim() || null,
      taxNo: input.taxNo.trim() || null,
      currency: input.currency || null,
    }
    return input.id === null
      ? api.entities.create(shared)
      : api.entities.update({ ...shared, entityId: input.id })
  },
  onSuccess: (entity, input) => {
    toast.success(input.id === null ? t('ent_created', { name: entity.name }) : t('ent_saved'))
    entityDraft = null
    entityError = null
    refresh()
  },
  onError: (error: Error) => {
    entityError = error.message || t('ent_save_error')
  },
  onSettled: () => {
    saving = false
  },
}))

function submitEntity() {
  if (!entityDraft || !entityValid || !canManage || saving) return
  saving = true
  entityError = null
  saveEntity.mutate($state.snapshot(entityDraft) as EntityDraft)
}

// ---------------------------------------------------------------- archiving an employer

const archivingEntity = $derived(allEntities.find((e) => e.id === archivingEntityId) ?? null)
/** Trimmed on both sides: a name copied off the row above often brings a space with it. */
const nameMatches = $derived(archivingEntity !== null && typedName.trim() === archivingEntity.name.trim())
/** What stops working the moment the employer goes: the cost centres booked against it. */
const centresOnArchiving = $derived(
  archivingEntityId === null ? 0 : liveCentres.filter((c) => c.legalEntityId === archivingEntityId).length,
)

const archiveEntity = createMutation(() => ({
  mutationFn: (vars: { entityId: string; name: string }) =>
    api.entities.archive({ workspaceId, entityId: vars.entityId }),
  onSuccess: (_ok, vars) => {
    toast.success(t('ent_archived_toast', { name: vars.name }))
    archivingEntityId = null
    typedName = ''
    // The row it leaves behind is only readable with the toggle on, and somebody who just archived
    // it wants to see where it went rather than watch it disappear.
    showArchivedEntities = true
    refresh()
  },
  onError: (error: Error) => {
    actionError = error.message || t('ent_archive_error')
  },
  onSettled: () => {
    acting = false
  },
}))

function confirmArchiveEntity() {
  const target = archivingEntity
  if (!target || !nameMatches || !canManage || acting) return
  acting = true
  actionError = null
  archiveEntity.mutate({ entityId: target.id, name: target.name })
}

function entityMenu(entity: LegalEntity): MenuItem[] {
  if (!canManage || entity.archivedAt) return []
  return [
    { label: t('common.edit'), icon: 'square-pen', onSelect: () => openEntityEdit(entity) },
    { type: 'separator' },
    {
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      onSelect: () => {
        actionError = null
        typedName = ''
        archivingEntityId = entity.id
      },
    },
  ]
}

// ---------------------------------------------------------------- the cost-centre form

function openCentreCreate() {
  centreError = null
  centreDraft = { code: '', name: '', officeId: '', orgUnitId: '', legalEntityId: '' }
}

const centreValid = $derived(
  centreDraft !== null && centreDraft.code.trim().length > 0 && centreDraft.name.trim().length > 0,
)

/** Live rows only in the pickers: attaching a budget to an archived one is a dead reference. */
const officeChoices = $derived([
  { value: '', label: t('cc_attach_none') },
  ...allOffices.filter((o) => !o.archivedAt).map((o) => ({ value: o.id, label: o.name })),
])
const unitChoices = $derived([
  { value: '', label: t('cc_attach_none') },
  ...allUnits.filter((u) => !u.archivedAt).map((u) => ({ value: u.id, label: u.name })),
])
/** Live employers only: attaching a budget to one that has been archived is a dead reference. */
const entityChoices = $derived([
  { value: '', label: t('cc_attach_none') },
  ...liveEntities.map((e) => ({ value: e.id, label: e.name })),
])

const saveCentre = createMutation(() => ({
  mutationFn: (input: CentreDraft) =>
    api.entities.costCenters.create({
      workspaceId,
      code: input.code.trim(),
      name: input.name.trim(),
      officeId: input.officeId || null,
      orgUnitId: input.orgUnitId || null,
      legalEntityId: input.legalEntityId || null,
    }),
  onSuccess: (centre) => {
    toast.success(t('cc_created', { code: centre.code }))
    centreDraft = null
    centreError = null
    refresh()
  },
  onError: (error: Error) => {
    centreError = error.message || t('cc_save_error')
  },
  onSettled: () => {
    saving = false
  },
}))

function submitCentre() {
  if (!centreDraft || !centreValid || !canManage || saving) return
  saving = true
  centreError = null
  saveCentre.mutate($state.snapshot(centreDraft) as CentreDraft)
}

// ---------------------------------------------------------------- archiving a cost centre

const archivingCentre = $derived(allCentres.find((c) => c.id === archivingCentreId) ?? null)

const archiveCentre = createMutation(() => ({
  mutationFn: (vars: { costCenterId: string; code: string }) =>
    api.entities.costCenters.archive({ workspaceId, costCenterId: vars.costCenterId }),
  onSuccess: (_ok, vars) => {
    toast.success(t('cc_archived_toast', { code: vars.code }))
    archivingCentreId = null
    showArchivedCentres = true
    refresh()
  },
  onError: (error: Error) => {
    actionError = error.message || t('cc_archive_error')
  },
  onSettled: () => {
    acting = false
  },
}))

function confirmArchiveCentre() {
  const target = archivingCentre
  if (!target || !canManage || acting) return
  acting = true
  actionError = null
  archiveCentre.mutate({ costCenterId: target.id, code: target.code })
}

/**
 * What a cost centre is attached to, as one line — and whether it is attached to anything at all.
 *
 * The two are separate answers because the interesting case is where they disagree. Each name is
 * looked up in a list that may not be there: the office capability can be off, in which case
 * `offices.list` answers 404 and no office on this page has a name. Saying "the whole workspace"
 * about a centre that is in fact booked to an office would be a plain untruth, so `attached` counts
 * the ids and `names` reports only what could actually be read.
 *
 * Employers are named from the full list rather than the live one: a centre booked against an
 * archived employer must still say which.
 */
function attachments(centre: CostCenter): { attached: boolean; names: string[] } {
  const ids = [centre.legalEntityId, centre.officeId, centre.orgUnitId]
  const names = [
    centre.legalEntityId ? entityNames.get(centre.legalEntityId) : undefined,
    centre.officeId ? officeNames.get(centre.officeId) : undefined,
    centre.orgUnitId ? unitNames.get(centre.orgUnitId) : undefined,
  ]
  return { attached: ids.some(Boolean), names: names.filter((name): name is string => Boolean(name)) }
}

function centreMenu(centre: CostCenter): MenuItem[] {
  if (!canManage || centre.archivedAt) return []
  return [
    {
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      onSelect: () => {
        actionError = null
        archivingCentreId = centre.id
      },
    },
  ]
}
</script>

<SettingsPage title={t('settings_entities')} description={t('entities_desc')}>
  {#snippet actions()}
    {#if canManage}
      <Button size="sm" icon="plus" onclick={openEntityCreate}>{t('ent_add')}</Button>
    {/if}
  {/snippet}

  {#if entitiesQuery.isLoading}
    <div class="tiles">
      {#each [1, 2, 3] as n (n)}<Skeleton height="86px" />{/each}
    </div>
  {:else if !entitiesQuery.isError && allEntities.length > 0}
    <div class="tiles">
      <StatTile size="md" label={t('ent_section')} value={formatCount(stats.entities, 999)} />
      <StatTile size="md" label={t('offices_countries')} value={formatCount(stats.countries, 999)} />
      <StatTile size="md" label={t('cc_section')} value={formatCount(stats.centres, 999)} />
    </div>
  {/if}

  <!-- ------------------------------------------------------------- legal entities -->
  <SettingsSection title={t('ent_section')} description={t('ent_section_desc')}>
    {#snippet action()}
      {#if archivedEntityCount > 0}
        <Switch
          size="sm"
          checked={showArchivedEntities}
          onCheckedChange={(on) => (showArchivedEntities = on)}
          label={t('ent_show_archived')}
        />
      {/if}
    {/snippet}

    {#if entitiesQuery.isLoading || !workspaceId}
      <div class="rows">
        {#each [1, 2] as n (n)}<Skeleton height="52px" />{/each}
      </div>
    {:else if entitiesQuery.isError}
      <EmptyState icon="triangle-alert" title={t('ent_error')} description={t('ent_error_desc')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void entitiesQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if entities.length === 0}
      <EmptyState icon="building-2" title={t('ent_none')} description={t('ent_none_desc')}>
        {#snippet actions()}
          {#if canManage}<Button icon="plus" onclick={openEntityCreate}>{t('ent_add')}</Button>{/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table entities" role="table" aria-label={t('ent_section')}>
        <div class="thead" role="row">
          <span role="columnheader">{t('ent_name')}</span>
          <span role="columnheader">{t('office_country')}</span>
          <span role="columnheader">{t('ent_registration_no')}</span>
          <span role="columnheader">{t('ent_currency')}</span>
          <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
        </div>
        {#each entities as entity (entity.id)}
          <div class="trow" role="row">
            <span class="cell stack" role="cell">
              <span class="name">
                {entity.name}
                {#if entity.archivedAt}<Badge tone="grey">{t('ent_archived')}</Badge>{/if}
              </span>
              {#if entity.taxNo}
                <span class="sub mono">{t('ent_tax_no_line', { value: entity.taxNo })}</span>
              {/if}
            </span>
            <span class="cell" role="cell">{countryLabel(entity.country)}</span>
            <span class="cell mono sub" role="cell">{entity.registrationNo ?? '—'}</span>
            <span class="cell mono" role="cell">{entity.currency ?? '—'}</span>
            <span class="cell end" role="cell">
              {#if canManage && !entity.archivedAt}
                <DropdownMenu items={entityMenu(entity)} align="end">
                  {#snippet trigger(props)}
                    <IconButton
                      {...props}
                      icon="ellipsis"
                      size={28}
                      label={t('ent_actions_for', { name: entity.name })}
                    />
                  {/snippet}
                </DropdownMenu>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </SettingsSection>

  <!-- ------------------------------------------------------------- cost centres -->
  <SettingsSection title={t('cc_section')} description={t('cc_section_desc')}>
    {#snippet action()}
      <span class="trailing">
        {#if archivedCentreCount > 0}
          <Switch
            size="sm"
            checked={showArchivedCentres}
            onCheckedChange={(on) => (showArchivedCentres = on)}
            label={t('ent_show_archived')}
          />
        {/if}
        {#if canManage}
          <Button size="xs" variant="ghost" icon="plus" onclick={openCentreCreate}>{t('cc_add')}</Button>
        {/if}
      </span>
    {/snippet}

    {#if centresQuery.isLoading || !workspaceId}
      <div class="rows">
        {#each [1, 2] as n (n)}<Skeleton height="44px" />{/each}
      </div>
    {:else if centresQuery.isError}
      <EmptyState icon="triangle-alert" title={t('cc_error')} description={t('ent_error_desc')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void centresQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if centres.length === 0}
      <EmptyState icon="hash" title={t('cc_none')} description={t('cc_none_desc')}>
        {#snippet actions()}
          {#if canManage}<Button icon="plus" onclick={openCentreCreate}>{t('cc_add')}</Button>{/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table centres" role="table" aria-label={t('cc_section')}>
        <div class="thead" role="row">
          <span role="columnheader">{t('cc_code')}</span>
          <span role="columnheader">{t('cc_name')}</span>
          <span role="columnheader">{t('cc_attached')}</span>
          <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
        </div>
        {#each centres as centre (centre.id)}
          {@const attached = attachments(centre)}
          <div class="trow" role="row">
            <span class="cell mono code" role="cell">{centre.code}</span>
            <span class="cell" role="cell">
              <span class="name">
                {centre.name}
                {#if centre.archivedAt}<Badge tone="grey">{t('ent_archived')}</Badge>{/if}
              </span>
            </span>
            <span class="cell sub" role="cell">
              <!-- Three states, not two: named, attached to something this page cannot name, and
                   genuinely attached to nothing. Only the last one is the whole workspace. -->
              {#if attached.names.length > 0}
                {attached.names.join(' · ')}
              {:else if attached.attached}
                —
              {:else}
                {t('cc_attach_workspace')}
              {/if}
            </span>
            <span class="cell end" role="cell">
              {#if canManage && !centre.archivedAt}
                <DropdownMenu items={centreMenu(centre)} align="end">
                  {#snippet trigger(props)}
                    <IconButton
                      {...props}
                      icon="ellipsis"
                      size={28}
                      label={t('cc_actions_for', { code: centre.code })}
                    />
                  {/snippet}
                </DropdownMenu>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </SettingsSection>
</SettingsPage>

<!-- ------------------------------------------------------------------ employer form -->
<Dialog
  open={entityDraft !== null}
  title={entityDraft?.id ? t('ent_edit_title', { name: entityDraft.name }) : t('ent_new')}
  description={t('ent_form_desc')}
  onOpenChange={(open) => {
    if (!open && !saving) entityDraft = null
  }}
>
  {#if entityDraft}
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault()
        submitEntity()
      }}
    >
      <Field label={t('ent_name')} hint={t('ent_name_hint')} required>
        {#snippet children(id)}
          <Input {id} bind:value={entityDraft!.name} maxlength={200} autocomplete="off" />
        {/snippet}
      </Field>

      <div class="pair">
        <Field label={t('office_country')} hint={t('ent_country_hint')} required>
          {#snippet children(id)}
            <Select {id} bind:value={entityDraft!.country} options={entityCountries} placeholder={t('choose')} />
          {/snippet}
        </Field>
        <Field label={t('ent_currency')} hint={t('ent_currency_hint')}>
          {#snippet children(id)}
            <Select
              {id}
              bind:value={entityDraft!.currency}
              options={entityCurrencies}
              placeholder={t('ent_currency_none')}
            />
          {/snippet}
        </Field>
      </div>

      <div class="pair">
        <Field label={t('ent_registration_no')} hint={t('ent_registration_no_hint')}>
          {#snippet children(id)}
            <Input {id} mono bind:value={entityDraft!.registrationNo} maxlength={64} autocomplete="off" />
          {/snippet}
        </Field>
        <Field label={t('ent_tax_no')} hint={t('ent_tax_no_hint')}>
          {#snippet children(id)}
            <Input {id} mono bind:value={entityDraft!.taxNo} maxlength={64} autocomplete="off" />
          {/snippet}
        </Field>
      </div>

      {#if entityError}<p class="err" role="alert">{entityError}</p>{/if}
    </form>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (entityDraft = null)} disabled={saving}>
      {t('common.cancel')}
    </Button>
    <Button onclick={submitEntity} disabled={!entityValid || !canManage} loading={saving}>
      {entityDraft?.id ? t('common.save') : t('ent_add')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ archive an employer -->
<Dialog
  open={archivingEntity !== null}
  size="sm"
  title={t('ent_archive_title', { name: archivingEntity?.name ?? '' })}
  onOpenChange={(open) => {
    if (!open && !acting) archivingEntityId = null
  }}
>
  <div class="form">
    <p class="body">{t('ent_archive_body')}</p>
    {#if centresOnArchiving > 0}
      <p class="body">{t('ent_archive_centres', { count: centresOnArchiving })}</p>
    {/if}
    <p class="body strong">{t('ent_archive_irreversible')}</p>
    <Field label={t('ent_archive_type_name', { name: archivingEntity?.name ?? '' })}>
      {#snippet children(id)}
        <Input {id} bind:value={typedName} autocomplete="off" spellcheck={false} />
      {/snippet}
    </Field>
    {#if actionError}<p class="err" role="alert">{actionError}</p>{/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (archivingEntityId = null)} disabled={acting}>
      {t('common.cancel')}
    </Button>
    <Button variant="danger" onclick={confirmArchiveEntity} disabled={!nameMatches} loading={acting}>
      {t('common.archive')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ cost-centre form -->
<Dialog
  open={centreDraft !== null}
  title={t('cc_new')}
  description={t('cc_form_desc')}
  onOpenChange={(open) => {
    if (!open && !saving) centreDraft = null
  }}
>
  {#if centreDraft}
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault()
        submitCentre()
      }}
    >
      <div class="pair">
        <Field label={t('cc_code')} hint={t('cc_code_hint')} required>
          {#snippet children(id)}
            <Input
              {id}
              mono
              maxlength={32}
              autocomplete="off"
              value={centreDraft!.code}
              oninput={(event) => {
                // Upper-cased as it is typed rather than on save: the code is what a payroll file
                // carries, and a field that silently changes what was typed once the dialog closes
                // is a field somebody re-opens to check.
                if (centreDraft) centreDraft.code = event.currentTarget.value.toUpperCase()
              }}
            />
          {/snippet}
        </Field>
        <Field label={t('cc_name')} hint={t('cc_name_hint')} required>
          {#snippet children(id)}
            <Input {id} bind:value={centreDraft!.name} maxlength={160} autocomplete="off" />
          {/snippet}
        </Field>
      </div>

      <SectionLabel sub label={t('cc_attach')} />
      <p class="hint">{t('cc_attach_hint')}</p>

      <Field label={t('office_entity')}>
        {#snippet children(id)}
          <Select
            {id}
            bind:value={centreDraft!.legalEntityId}
            options={entityChoices}
            placeholder={t('cc_attach_none')}
          />
        {/snippet}
      </Field>
      <div class="pair">
        {#if hasOffices}
          <Field label={t('office')}>
            {#snippet children(id)}
              <Select
                {id}
                bind:value={centreDraft!.officeId}
                options={officeChoices}
                disabled={officesQuery.isLoading}
                placeholder={t('cc_attach_none')}
              />
            {/snippet}
          </Field>
        {/if}
        {#if hasOrg}
          <Field label={t('department')}>
            {#snippet children(id)}
              <Select
                {id}
                bind:value={centreDraft!.orgUnitId}
                options={unitChoices}
                disabled={unitsQuery.isLoading}
                placeholder={t('cc_attach_none')}
              />
            {/snippet}
          </Field>
        {/if}
      </div>

      {#if centreError}<p class="err" role="alert">{centreError}</p>{/if}
    </form>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (centreDraft = null)} disabled={saving}>
      {t('common.cancel')}
    </Button>
    <Button onclick={submitCentre} disabled={!centreValid || !canManage} loading={saving}>
      {t('common.create')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ archive a cost centre -->
<Dialog
  open={archivingCentre !== null}
  size="sm"
  title={t('cc_archive_title', { code: archivingCentre?.code ?? '' })}
  onOpenChange={(open) => {
    if (!open && !acting) archivingCentreId = null
  }}
>
  <p class="body">{t('cc_archive_body')}</p>
  <p class="body muted">{t('cc_archive_keeps')}</p>
  {#if actionError}<p class="err" role="alert">{actionError}</p>{/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (archivingCentreId = null)} disabled={acting}>
      {t('common.cancel')}
    </Button>
    <Button variant="danger" onclick={confirmArchiveCentre} loading={acting}>{t('common.archive')}</Button>
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
.trailing {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  width: 100%;
}
.entities {
  --hr-ent-cols: minmax(150px, 1.6fr) minmax(110px, 1fr) minmax(100px, 1fr) 72px 36px;
}
.centres {
  --hr-ent-cols: 104px minmax(140px, 1.2fr) minmax(140px, 1.4fr) 36px;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-ent-cols);
  gap: 12px;
  align-items: center;
  padding-inline: 10px;
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
  border-block-end: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-md);
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
  font-size: 13px;
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
.code {
  font-size: 12.5px;
  font-weight: 500;
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
  gap: 14px;
}
.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.body {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kern-ink-700);
  text-wrap: pretty;
}
.body.muted {
  color: var(--kern-ink-500);
}
.body.strong {
  font-weight: 500;
  color: var(--kern-ink-900);
}
.err {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}

@media (max-width: 720px) {
  .entities {
    --hr-ent-cols: minmax(140px, 1.6fr) minmax(100px, 1fr) 72px 36px;
  }
  .centres {
    --hr-ent-cols: 92px minmax(130px, 1fr) 36px;
  }
  /* The registration number and the attachment line are the columns a narrow screen can lose:
     both are also on the row's own second line or in the dialog that set them. */
  .entities .thead > :nth-child(3),
  .entities .trow > :nth-child(3),
  .centres .thead > :nth-child(3),
  .centres .trow > :nth-child(3) {
    display: none;
  }
  .pair {
    grid-template-columns: 1fr;
  }
}
</style>
