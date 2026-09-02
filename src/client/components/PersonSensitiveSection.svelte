<script lang="ts">
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  formatDate,
  Icon,
  Input,
  messageLocale,
  SectionLabel,
  Skeleton,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { CustomFieldDef } from '../index.js'
import { canHr } from '../permissions.js'
import CustomFieldsForm from './CustomFieldsForm.svelte'
import { type CustomValues, formatValue, mergeCustom, missingRequired, sameCustom } from './custom-fields.js'
import { explainRefusal } from './refusal.js'

/**
 * The fields `hr.person.view_sensitive` exists for, and the one somebody needs in a hurry.
 *
 * Both permissions are `dangerous` with `defaultRoles: []` — deliberately nobody's — and until this
 * section existed neither reached anything: a national identity number, a birth date, an IBAN and
 * an emergency contact were storable, encrypted and unreadable.
 *
 * **Nothing is fetched until it is asked for.** The section is collapsed and the query is disabled,
 * so opening somebody's panel does not pull their bank details onto the screen of whoever is
 * standing behind you, and does not decrypt them server-side either. Holding the permission is not
 * the same as wanting the data on screen.
 *
 * **The emergency contact is not buried.** It is the field that has to be found by somebody who has
 * never opened this panel before, under pressure — so it is the first thing inside the section, the
 * section says so in its own hint, and the number is a `tel:` link rather than a string to copy out
 * by hand.
 */
interface Props {
  personId: string
  workspaceId: string
  personName: string
  /**
   * The record's `custom` map and the definitions marked sensitive, from the panel.
   *
   * A sensitive custom field — a passport number, say — lives in `people.custom` beside the plain
   * ones, and the server has already withheld it from a reader without `hr.person.view_sensitive`.
   * It is drawn here rather than on the identity list so that the disclosure this section asks
   * for covers it too, and it is edited here for the same reason. The write still goes through
   * `people.update`, which costs `hr.person.manage`; a holder of `manage_sensitive` alone sees the
   * values and is told, once, why the controls are not on the form.
   */
  custom: CustomValues
  fields: CustomFieldDef[]
}
const { personId, workspaceId, personName, custom, fields }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

const mayView = $derived(canHr('personViewSensitive'))
const mayManage = $derived(canHr('personManageSensitive'))
/** `people.update` is what writes a custom value, and it costs the plain manage permission. */
const mayWriteCustom = $derived(mayManage && canHr('personManage'))

let revealed = $state(false)

const customRows = $derived.by(() => {
  const ctx = {
    locale: messageLocale(),
    yes: t('field_yes'),
    no: t('field_no'),
    date: (iso: string) => formatDate(`${iso}T00:00:00`),
  }
  return [...fields]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .flatMap((def) => {
      const text = formatValue(def, custom[def.key], ctx)
      return text === null ? [] : [{ def, text }]
    })
})

const sensitiveQuery = createQuery(() => ({
  queryKey: ['hr', 'sensitive', workspaceId, personId] as const,
  // The permission *and* the disclosure: a query fired on render would decrypt and send these
  // fields to a screen nobody has asked to look at.
  enabled: revealed && mayView && Boolean(workspaceId && personId),
  queryFn: () => api.people.sensitive.get({ workspaceId, personId }),
}))
const details = $derived(sensitiveQuery.data)
const empty = $derived(
  Boolean(details) &&
    !details?.nationalId &&
    !details?.birthDate &&
    !details?.iban &&
    !details?.emergencyContact &&
    customRows.length === 0,
)

/**
 * A calendar date, read in the reader's language.
 *
 * The `T00:00:00` is not decoration: `new Date('1991-03-01')` is parsed as *UTC* midnight, so west
 * of Greenwich a birthday on the first would be shown as the last day of the month before.
 */
const dateLabel = (iso: string): string => formatDate(`${iso}T00:00:00`)

/** `tel:` wants the number without the spaces people write it with. */
const dial = (phone: string) => `tel:${phone.replace(/[^+0-9]/g, '')}`

// ---------------------------------------------------------------- editing

let editing = $state(false)
let nationalId = $state('')
let birthDate = $state('')
let iban = $state('')
let contactName = $state('')
let relationship = $state('')
let contactPhone = $state('')
let customEdit = $state<CustomValues>({})

function openEdit() {
  nationalId = details?.nationalId ?? ''
  birthDate = details?.birthDate ?? ''
  iban = details?.iban ?? ''
  contactName = details?.emergencyContact?.name ?? ''
  relationship = details?.emergencyContact?.relationship ?? ''
  contactPhone = details?.emergencyContact?.phone ?? ''
  customEdit = Object.fromEntries(fields.map((def) => [def.key, custom[def.key]]))
  editing = true
}

const missing = $derived(editing && mayWriteCustom ? missingRequired(fields, customEdit) : [])

/** A contact is a name *and* a number; either alone is somebody nobody can reach. */
const contactPartial = $derived(
  (contactName.trim() === '') !== (contactPhone.trim() === '') && (contactName + contactPhone).trim() !== '',
)

/**
 * `saving` rather than `save.isPending`: the disabled attribute only reaches the button on the next
 * render, so two quick clicks are one render apart — and both would write.
 */
let saving = $state(false)

const save = createMutation(() => ({
  // Unlike an employment change, an empty field here really does clear: `sensitive.update` takes
  // null for every one of these, which is what makes "she asked us to delete her bank details" a
  // thing this screen can do.
  mutationFn: async () => {
    const saved = await api.people.sensitive.update({
      workspaceId,
      personId,
      nationalId: nationalId.trim() || null,
      birthDate: birthDate || null,
      iban: iban.trim() || null,
      emergencyContact:
        contactName.trim() && contactPhone.trim()
          ? {
              name: contactName.trim(),
              relationship: relationship.trim() || undefined,
              phone: contactPhone.trim(),
            }
          : null,
    })
    // The custom values are a second write to a different table, and only when one changed:
    // `people.update` replaces the whole map, so it is sent the record's map with these keys over
    // it. Snapshot, not the `$state` proxy, which the API layer cannot clone.
    if (mayWriteCustom) {
      const merged = mergeCustom(custom, $state.snapshot(customEdit))
      if (!sameCustom(merged, custom)) await api.people.update({ workspaceId, personId, custom: merged })
    }
    return saved
  },
  onSuccess: () => {
    toast.success(t('person_updated'))
    void queryClient.invalidateQueries({ queryKey: ['hr', 'sensitive', workspaceId, personId] })
    void queryClient.invalidateQueries({ queryKey: ['hr', 'person', workspaceId, personId] })
    editing = false
  },
  onError: (error) => toast.error(explainRefusal(error, t('sensitive_save_error'))),
  onSettled: () => {
    saving = false
  },
}))

const submit = () => {
  if (saving || missing.length) return
  saving = true
  save.mutate()
}
</script>

<!-- No permission, no section: this is not a door to rattle. -->
{#if mayView}
  <section class="sec">
    <SectionLabel
      collapsible
      open={revealed}
      onToggle={() => (revealed = !revealed)}
      label={t('sensitive_title')}
    >
      {#snippet trailing()}
        {#if revealed && mayManage && details}
          <Button size="sm" variant="secondary" icon="pencil" onclick={openEdit}>{t('common.edit')}</Button>
        {/if}
      {/snippet}
    </SectionLabel>

    {#if !revealed}
      <p class="hint">{t('sensitive_hidden')}</p>
    {:else if sensitiveQuery.isLoading}
      <div class="rows"><Skeleton lines={3} /></div>
    {:else if details && !empty}
      <!--
        The emergency contact first, and as a row somebody can act on. Everything below it is a fact
        to read; this one is a phone call, and it is the reason a colleague opens this section at a
        moment when reading carefully is not on offer.
      -->
      <div class="emergency">
        <span class="ec-head">
          <Icon name="circle-alert" size={14} strokeWidth={1.8} />
          {t('sensitive_emergency')}
        </span>
        {#if details.emergencyContact}
          <span class="ec-name">
            {details.emergencyContact.name}
            {#if details.emergencyContact.relationship}
              <span class="muted">— {details.emergencyContact.relationship}</span>
            {/if}
          </span>
          <a class="ec-phone" href={dial(details.emergencyContact.phone)}>
            {details.emergencyContact.phone}
          </a>
        {:else}
          <span class="muted">{t('sensitive_emergency_none')}</span>
          {#if mayManage}
            <Button size="sm" variant="secondary" onclick={openEdit}>{t('sensitive_add_contact')}</Button>
          {/if}
        {/if}
      </div>

      <dl class="facts">
        {#if details.birthDate}
          <dt>{t('sensitive_birth_date')}</dt>
          <dd>{dateLabel(details.birthDate)}</dd>
        {/if}
        {#if details.nationalId}
          <dt>{t('sensitive_national_id')}</dt>
          <dd class="mono">{details.nationalId}</dd>
        {/if}
        {#if details.iban}
          <dt>{t('sensitive_iban')}</dt>
          <dd class="mono">{details.iban}</dd>
        {/if}
        <!-- The workspace's own sensitive fields, inside the same disclosure as the built-in ones. -->
        {#each customRows as row (row.def.id)}
          <dt>{row.def.name}</dt>
          {#if row.def.type === 'url'}
            <dd class="mono">
              <a href={row.text} target="_blank" rel="noopener noreferrer">{row.text}</a>
            </dd>
          {:else}
            <dd>{row.text}</dd>
          {/if}
        {/each}
      </dl>
    {:else if sensitiveQuery.isError}
      <EmptyState compact icon="triangle-alert" title={t('sensitive_error')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void sensitiveQuery.refetch()}>
            {t('retry')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <EmptyState
        compact
        icon="lock"
        title={t('sensitive_none')}
        description={t('sensitive_none_desc')}
      >
        {#snippet actions()}
          {#if mayManage}
            <Button size="sm" icon="plus" onclick={openEdit}>{t('sensitive_add_contact')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {/if}
  </section>

  <Dialog
    bind:open={editing}
    title={t('sensitive_edit_title', { name: personName })}
    description={t('sensitive_edit_body')}
  >
    <div class="form">
      <Field
        label={t('sensitive_contact_name')}
        hint={t('sensitive_contact_hint')}
        error={contactPartial ? t('sensitive_contact_partial') : null}
        id="hr-sens-contact"
      >
        {#snippet children(id)}
          <Input {id} bind:value={contactName} maxlength={160} autocomplete="off" />
        {/snippet}
      </Field>
      <div class="pair">
        <Field label={t('sensitive_relationship')} hint={t('common.optional')} id="hr-sens-rel">
          {#snippet children(id)}
            <Input {id} bind:value={relationship} maxlength={64} autocomplete="off" />
          {/snippet}
        </Field>
        <Field label={t('phone')} id="hr-sens-phone">
          {#snippet children(id)}
            <Input {id} type="tel" bind:value={contactPhone} maxlength={32} autocomplete="off" />
          {/snippet}
        </Field>
      </div>

      <Field label={t('sensitive_birth_date')} hint={t('common.optional')} id="hr-sens-birth">
        {#snippet children(id)}
          <Input {id} type="date" value={birthDate} oninput={(e) => (birthDate = e.currentTarget.value)} />
        {/snippet}
      </Field>
      <Field label={t('sensitive_national_id')} hint={t('common.optional')} id="hr-sens-nid">
        {#snippet children(id)}
          <Input {id} mono bind:value={nationalId} maxlength={64} autocomplete="off" />
        {/snippet}
      </Field>
      <Field label={t('sensitive_iban')} hint={t('common.optional')} id="hr-sens-iban">
        {#snippet children(id)}
          <Input {id} mono bind:value={iban} maxlength={48} autocomplete="off" />
        {/snippet}
      </Field>

      {#if fields.length && mayWriteCustom}
        <CustomFieldsForm defs={fields} bind:values={customEdit} idPrefix="hr-sens" headings={false} />
      {:else if fields.length}
        <p class="muted">{t('field_sensitive_needs_manage')}</p>
      {/if}
    </div>

    {#snippet footer()}
      {#if missing.length}
        <span class="note">{t('field_required_missing', { name: missing[0]!.name })}</span>
      {/if}
      <Button variant="secondary" onclick={() => (editing = false)} disabled={save.isPending}>
        {t('common.cancel')}
      </Button>
      <Button
        loading={save.isPending}
        disabled={contactPartial || !mayManage || saving || missing.length > 0}
        onclick={submit}
      >
        {t('common.save')}
      </Button>
    {/snippet}
  </Dialog>
{/if}

<style>
.sec {
  margin-block-start: 20px;
}
.rows {
  display: grid;
  gap: 6px;
  padding-block: 8px;
}
.hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.emergency {
  display: grid;
  gap: 4px;
  margin-block-start: 10px;
  padding: 10px 12px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  background: var(--kern-surface);
}
.ec-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.ec-name {
  font-size: 13.5px;
  font-weight: 500;
}
.ec-phone {
  font-size: 14px;
  /* Underlined as well as coloured: colour alone is not what makes a link a link, and this is the
     one control on the panel somebody uses without reading the page first. */
  text-decoration: underline;
  text-underline-offset: 3px;
  font-variant-numeric: tabular-nums;
  color: var(--kern-accent-text);
  /* The number is read left to right whatever the interface direction: a phone number mirrored by
     the paragraph around it is a number somebody dials wrong. */
  direction: ltr;
  unicode-bidi: isolate;
  width: fit-content;
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  margin: 12px 0 0;
}
.facts dt {
  color: var(--kern-ink-500);
  font-size: 12px;
}
.facts dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.mono {
  font-family: var(--kern-font-mono);
  font-size: 12.5px;
  direction: ltr;
  unicode-bidi: isolate;
}
/* A colour, not opacity: opacity fades text against the panel whatever token it names. */
.muted {
  color: var(--kern-ink-500);
  font-size: 12px;
}
.form {
  display: grid;
  gap: 14px;
}
.note {
  margin-inline-end: auto;
  align-self: center;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.mono a {
  color: var(--kern-accent-text);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 14px;
}
</style>
