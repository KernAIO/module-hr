<script lang="ts">
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  formatDate,
  Icon,
  Input,
  messageLocale,
  navigation,
  RightPanel,
  Skeleton,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { CustomFieldDef } from '../index.js'
import { canHr } from '../permissions.js'
import { hrKeys, isoDate } from '../query.js'
import CustomFieldsForm from './CustomFieldsForm.svelte'
import {
  bySection,
  type CustomValues,
  FIELD_SECTIONS,
  formatValue,
  mergeCustom,
  missingRequired,
  sameCustom,
} from './custom-fields.js'
import PersonAccessLogSection from './PersonAccessLogSection.svelte'
import PersonDocumentsSection from './PersonDocumentsSection.svelte'
import PersonJobSection from './PersonJobSection.svelte'
import PersonSensitiveSection from './PersonSensitiveSection.svelte'
import { personnelWithheld } from './redaction.js'
import { explainRefusal } from './refusal.js'

/**
 * One person, beside the directory rather than instead of it.
 *
 * A panel rather than a route because picking somebody out of a list and going back to it is the
 * whole interaction — a full page navigation loses the list's scroll position and the search term,
 * and both are how the person got here.
 *
 * The record is editable here: name and contact, and ending employment. Those APIs existed before
 * this panel did; showing three fields and no actions was not a finished screen.
 *
 * Below the identity list the panel is three sections, each of them a permission or a capability
 * this module declared and then reached from nowhere: the **job** and its effective-dated history,
 * the **personal details** `hr.person.view_sensitive` exists for, and the **documents** the
 * `documents` capability switches on. Each owns its own queries, its own four states and its own
 * gate — the panel decides where they sit, not whether they may be seen.
 */
interface Props {
  personId: string
  workspaceId: string
  workspaceSlug: string
}
const { personId, workspaceId, workspaceSlug }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

const personQuery = createQuery(() => ({
  queryKey: hrKeys.person(workspaceId, personId),
  enabled: Boolean(workspaceId && personId),
  queryFn: () => api.people.get({ workspaceId, personId }),
}))
const person = $derived(personQuery.data)

const resolutionQuery = createQuery(() => ({
  queryKey: hrKeys.resolution(workspaceId, personId),
  enabled: Boolean(workspaceId && personId),
  queryFn: () => api.offices.resolveFor({ workspaceId, personId }),
}))
const resolution = $derived(resolutionQuery.data)

/**
 * The open period, for the reporting line only.
 *
 * `PersonJobSection` reads the same key for everything it draws, so this is one request rather than
 * two: what the job *is* belongs to that section, and what it implies about who somebody reports to
 * belongs beside the office in the list below.
 */
const employmentQuery = createQuery(() => ({
  queryKey: hrKeys.employment(workspaceId, personId),
  enabled: Boolean(workspaceId && personId) && canHr('employmentView'),
  queryFn: () => api.employment.current({ workspaceId, personId }),
}))
const employment = $derived(employmentQuery.data)

const managerId = $derived(resolution?.managerPersonId ?? employment?.managerPersonId ?? null)
const managerQuery = createQuery(() => ({
  queryKey: hrKeys.person(workspaceId, managerId ?? ''),
  enabled: Boolean(workspaceId && managerId),
  queryFn: () => api.people.get({ workspaceId, personId: managerId! }),
}))

/**
 * The workspace's own fields, live ones only.
 *
 * Split by `sensitive` here and handed to two different places: the plain ones are drawn below
 * the identity list and edited with the name and contact details; the sensitive ones go to the
 * section `hr.person.view_sensitive` gates, and are edited there. The server has already dropped
 * a sensitive value this reader may not see from `person.custom`, so nothing here decides who
 * sees what — only where it sits.
 */
const fieldsQuery = createQuery(() => ({
  queryKey: hrKeys.fields(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.fields.list({ workspaceId }),
}))
const plainFields = $derived((fieldsQuery.data ?? []).filter((def) => !def.sensitive))
const sensitiveFields = $derived((fieldsQuery.data ?? []).filter((def) => def.sensitive))

const sectionLabel = (section: CustomFieldDef['section']): string =>
  section === 'profile'
    ? t('field_section_profile')
    : section === 'employment'
      ? t('field_section_employment')
      : t('field_section_other')

/** Each section with at least one value to show, as label and sentence pairs. */
const customRows = $derived.by(() => {
  if (!person) return []
  const grouped = bySection(plainFields)
  const ctx = {
    locale: messageLocale(),
    yes: t('field_yes'),
    no: t('field_no'),
    date: (iso: string) => formatDate(`${iso}T00:00:00`),
  }
  return FIELD_SECTIONS.flatMap((section) => {
    const rows = grouped[section].flatMap((def) => {
      const text = formatValue(def, person.custom[def.key], ctx)
      return text === null ? [] : [{ def, text }]
    })
    return rows.length ? [{ section, rows }] : []
  })
})

const close = () =>
  void navigation.go(`/${workspaceSlug}/hr`, { replaceState: true, keepFocus: true, noScroll: true })

let editing = $state(false)
let displayName = $state('')
let workEmail = $state('')
let personalEmail = $state('')
let phone = $state('')
let custom = $state<CustomValues>({})

$effect(() => {
  if (editing && person) {
    displayName = person.displayName
    workEmail = person.workEmail ?? ''
    personalEmail = person.personalEmail ?? ''
    phone = person.phone ?? ''
    custom = Object.fromEntries(plainFields.map((def) => [def.key, person.custom[def.key]]))
  }
})

const missing = $derived(editing ? missingRequired(plainFields, custom) : [])

/**
 * `saving` and `ending` rather than `isPending`: the disabled attribute only reaches the button on
 * the next render, so two quick clicks both fire — twice through here is two history rows for one
 * decision. These are set in the same tick as the first click.
 */
let saving = $state(false)
let ending = $state(false)

const save = createMutation(() => ({
  mutationFn: () => {
    // `people.update` replaces the whole map, so what goes up is the record's map with the edited
    // keys over it — never the edited keys alone, which would erase every field this form does
    // not show. Left out entirely when nothing changed: a map that matches is a history row
    // saying nothing happened. Snapshot, not the `$state` proxy, which the API layer cannot clone.
    const merged = mergeCustom(person?.custom ?? {}, $state.snapshot(custom))
    return api.people.update({
      workspaceId,
      personId,
      displayName: displayName.trim(),
      workEmail: workEmail.trim() || null,
      personalEmail: personalEmail.trim() || null,
      phone: phone.trim() || null,
      custom: sameCustom(merged, person?.custom ?? {}) ? undefined : merged,
    })
  },
  onSuccess: () => {
    toast.success(t('person_updated'))
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
    editing = false
  },
  onError: (error) => toast.error(explainRefusal(error, t('person_save_error'))),
  onSettled: () => {
    saving = false
  },
}))

const submitSave = () => {
  if (saving || missing.length) return
  saving = true
  save.mutate()
}

let offboarding = $state(false)
let lastDay = $state(isoDate())
let offboardReason = $state('')

const offboard = createMutation(() => ({
  mutationFn: () =>
    api.people.offboard({
      workspaceId,
      personId,
      on: lastDay,
      reason: offboardReason.trim() || undefined,
    }),
  onSuccess: (updated) => {
    toast.success(t('person_offboarded', { name: updated.displayName }))
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
    offboarding = false
  },
  onError: (error) => toast.error(explainRefusal(error, t('person_offboard_error'))),
  onSettled: () => {
    ending = false
  },
}))

const submitOffboard = () => {
  if (ending) return
  ending = true
  offboard.mutate()
}

/**
 * The clock where this person works, in the reader's language.
 *
 * `formatDate` rather than a bare `Intl` call: an interface in Persian writes its own digits, and
 * a time in Latin ones beside them is the one thing on the panel that did not get translated. The
 * zone comes from the office record, so it is guarded — an unknown one must not take the panel
 * down with it.
 */
function officeTime(timezone: string): string {
  try {
    return formatDate(new Date().toISOString(), {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

const canManage = $derived(canHr('personManage'))
const left = $derived(person?.status === 'terminated')

/**
 * Whether the server withheld this person's personnel fields from this reader.
 *
 * The four it nulls arrive as nulls, so an empty phone row on this panel says "no phone number" —
 * a different and wrong fact. The record carries the answer (`personnelHidden`, set where the
 * nulling happens), so this is a read rather than an inference; the panel then explains itself once
 * below the list rather than once per field.
 */
const withheld = $derived(person ? personnelWithheld(person) : false)
/**
 * And only where something on *this* panel is actually blank because of it. The two are the same
 * thing while the client and the server agree about the reader's keys; tying the sentence to what
 * is on screen means a disagreement leaves a stale sentence over nothing rather than over a value
 * the reader can plainly see.
 */
const hiddenHere = $derived(withheld && (!person?.phone || !person?.hiredOn))
</script>

{#snippet hiddenValue()}
  <!-- A value in its own right, not an absence: the row stays, and says what it is. -->
  <span class="withheld"><Icon name="eye-off" size={12} strokeWidth={1.8} />{t('person_hidden')}</span>
{/snippet}

{#snippet footerActions()}
  <div class="actions">
    <!-- Disabled with the reason beside it, not hidden: the button was there a moment ago, and a
         control that vanishes after an action reads as a bug rather than as a finished job. -->
    {#if left}<span class="note">{t('offboard_already')}</span>{/if}
    <Button size="sm" variant="secondary" onclick={() => (editing = true)}>{t('edit_person')}</Button>
    <Button size="sm" variant="danger" disabled={left} onclick={() => (offboarding = true)}>
      {t('offboard')}
    </Button>
  </div>
{/snippet}

<RightPanel
  onClose={close}
  title={person?.displayName ?? t('person_panel')}
  footer={canManage && person ? footerActions : undefined}
>
  {#if personQuery.isLoading}
    <div class="pad">
      <div class="head">
        <Skeleton width="56px" height="56px" radius="50%" />
        <Skeleton width="150px" height="14px" />
      </div>
      <Skeleton lines={4} />
    </div>
  {:else if person}
    <div class="pad">
    <div class="head">
      <Avatar name={person.displayName} id={person.id} size={56} />
      <div>
        <h2>{person.displayName}</h2>
        {#if person.workEmail}<p class="meta">{person.workEmail}</p>{/if}
      </div>
    </div>

    <dl class:tight={hiddenHere}>
      {#if resolution?.primaryOfficeName}
        <dt>{t('office')}</dt>
        <dd>{resolution.primaryOfficeName}</dd>
      {/if}
      {#if resolution?.timezone}
        <dt>{t('local_time')}</dt>
        <dd>
          {officeTime(resolution.timezone)}
          <span class="meta">{resolution.timezone}</span>
        </dd>
      {/if}
      {#if person.employeeNo}
        <dt>{t('employee_no')}</dt>
        <dd>{person.employeeNo}</dd>
      {/if}
      <!--
        Two of the four fields the server redacts. A withheld one keeps its row and is marked, so
        that "we are not showing you this" cannot be read as "there is nothing here"; one that is
        merely empty keeps the behaviour it had, and drops out of the list.
      -->
      {#if person.hiredOn || withheld}
        <dt>{t('started')}</dt>
        <dd>
          {#if person.hiredOn}{formatDate(`${person.hiredOn}T00:00:00`)}{:else}{@render hiddenValue()}{/if}
        </dd>
      {/if}
      {#if person.phone || withheld}
        <dt>{t('phone')}</dt>
        <dd>
          {#if person.phone}{person.phone}{:else}{@render hiddenValue()}{/if}
        </dd>
      {/if}
      {#if resolution?.orgUnitPath}
        <dt>{t('department')}</dt>
        <dd>{resolution.orgUnitPath}</dd>
      {/if}
      {#if managerQuery.data}
        <dt>{t('manager')}</dt>
        <dd>{managerQuery.data.displayName}</dd>
      {/if}
    </dl>

    <!--
      Once for the panel, never once per field. The same sentence beside every marked row is a
      lecture; the marks say *which* fields, and this says why, once, under all of them.
    -->
    {#if hiddenHere}
      <p class="hint">{t('person_hidden_hint')}</p>
    {/if}

    <!--
      The workspace's own fields, by section, and only the ones with something in them: a row
      reading "T-shirt size: —" on every person is a form, not a profile. Sensitive ones are not
      here — they sit inside the section below that `hr.person.view_sensitive` gates.
    -->
    {#each customRows as group (group.section)}
      <div class="custom">
        <h3 class="csec">{sectionLabel(group.section)}</h3>
        <dl>
          {#each group.rows as row (row.def.id)}
            <dt>{row.def.name}</dt>
            {#if row.def.type === 'url'}
              <dd class="ltr">
                <a href={row.text} target="_blank" rel="noopener noreferrer">{row.text}</a>
              </dd>
            {:else}
              <dd>{row.text}</dd>
            {/if}
          {/each}
        </dl>
      </div>
    {/each}

    <Badge tone={person.status === 'active' ? 'active' : person.status === 'on_leave' ? 'upcoming' : 'grey'}
      >{person.status === 'active'
        ? t('status_active')
        : person.status === 'on_leave'
          ? t('status_on_leave')
          : person.status === 'onboarding'
            ? t('status_onboarding')
            : person.status === 'offboarding'
              ? t('status_offboarding')
              : t('status_terminated')}</Badge
    >

    <PersonJobSection {personId} {workspaceId} personName={person.displayName} />
    <PersonSensitiveSection
      {personId}
      {workspaceId}
      personName={person.displayName}
      custom={person.custom}
      fields={sensitiveFields}
    />
    <PersonAccessLogSection {personId} {workspaceId} userId={person.userId} personName={person.displayName} />
    <PersonDocumentsSection {personId} {workspaceId} personName={person.displayName} />
    </div>
  {:else if personQuery.isError}
    <!--
      The panel used to draw nothing here: an untitled 440px column with a close button and no
      word in it, which reads as a record that is empty rather than as one that failed to load.
      The other two queries are details on the record, so they stay silent when they fail; this
      one is the record.
    -->
    <div class="pad">
      <EmptyState compact icon="triangle-alert" title={t('person_error')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void personQuery.refetch()}>
            {t('retry')}
          </Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <!--
      No workspace yet. The query is disabled until one arrives, and a disabled query is not
      "loading" — so without this branch the panel is briefly a blank column on every first paint.
    -->
    <div class="pad">
      <div class="head">
        <Skeleton width="56px" height="56px" radius="50%" />
        <Skeleton width="150px" height="14px" />
      </div>
    </div>
  {/if}
</RightPanel>

<Dialog bind:open={editing} title={t('edit_person')}>
  <div class="form">
    <Field label={t('display_name')} id="hr-edit-name" required>
      {#snippet children(id)}
        <Input {id} bind:value={displayName} autocomplete="name" />
      {/snippet}
    </Field>
    <Field label={t('work_email')} id="hr-edit-work" hint={t('common.optional')}>
      {#snippet children(id)}
        <Input {id} type="email" bind:value={workEmail} autocomplete="email" />
      {/snippet}
    </Field>
    <Field label={t('personal_email')} id="hr-edit-personal" hint={t('common.optional')}>
      {#snippet children(id)}
        <Input {id} type="email" bind:value={personalEmail} />
      {/snippet}
    </Field>
    <Field label={t('phone')} id="hr-edit-phone" hint={t('common.optional')}>
      {#snippet children(id)}
        <Input {id} type="tel" bind:value={phone} autocomplete="tel" />
      {/snippet}
    </Field>
    {#if plainFields.length}
      <CustomFieldsForm defs={plainFields} bind:values={custom} idPrefix="hr-edit" />
    {/if}
  </div>
  {#snippet footer()}
    {#if missing.length}
      <span class="note">{t('field_required_missing', { name: missing[0]!.name })}</span>
    {/if}
    <Button variant="ghost" onclick={() => (editing = false)}>{t('common.cancel')}</Button>
    <Button
      onclick={submitSave}
      disabled={displayName.trim().length === 0 || saving || missing.length > 0}
      loading={save.isPending}>{t('common.save')}</Button
    >
  {/snippet}
</Dialog>

<Dialog
  bind:open={offboarding}
  title={t('offboard_title', { name: person?.displayName ?? '' })}
  description={t('offboard_body')}
  size="sm"
>
  <div class="form">
    <Field label={t('offboard_date')} id="hr-offboard-on" required>
      {#snippet children(id)}
        <Input {id} type="date" bind:value={lastDay} />
      {/snippet}
    </Field>
    <Field label={t('offboard_reason')} id="hr-offboard-reason" hint={t('common.optional')}>
      {#snippet children(id)}
        <Input {id} bind:value={offboardReason} />
      {/snippet}
    </Field>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (offboarding = false)}>{t('common.cancel')}</Button>
    <Button variant="danger" onclick={submitOffboard} disabled={!lastDay || ending} loading={offboard.isPending}
      >{t('offboard')}</Button
    >
  {/snippet}
</Dialog>

<style>
.pad {
  padding: 18px 20px;
}
.head {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-block-end: 16px;
}
h2 {
  margin: 0;
  font-size: 15px;
}
.meta {
  color: var(--kern-ink-500);
  font-size: 12px;
  margin: 0;
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  margin: 0 0 16px;
}
/* The sentence below the list belongs to it, so the list gives up its own gap to keep them one
   block rather than two things that happen to follow each other. */
dl.tight {
  margin-block-end: 8px;
}
dt {
  color: var(--kern-ink-500);
  font-size: 12px;
}
dd {
  margin: 0;
}
/* A colour and a smaller size, never opacity — a faded value is unreadable whatever token it
   names, and this one has to be read to be believed. */
.withheld {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--kern-ink-500);
  font-size: 12px;
}
.hint {
  margin: 0 0 16px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--kern-ink-500);
}
.custom {
  margin-block-end: 16px;
}
.csec {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.custom dl {
  margin: 0;
}
.custom dd {
  min-width: 0;
  overflow-wrap: anywhere;
}
/* An address reads left to right whatever the interface direction. */
.ltr {
  direction: ltr;
  unicode-bidi: isolate;
}
.ltr a {
  color: var(--kern-accent-text);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: end;
}
/* A colour, not opacity: opacity fades text against the panel whatever token it names. */
.note {
  margin-inline-end: auto;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.form {
  display: grid;
  gap: 14px;
}
</style>
