<script lang="ts">
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  navigation,
  RightPanel,
  Skeleton,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { hrKeys, isoDate } from '../query.js'

/**
 * One person, beside the directory rather than instead of it.
 *
 * A panel rather than a route because picking somebody out of a list and going back to it is the
 * whole interaction — a full page navigation loses the list's scroll position and the search term,
 * and both are how the person got here.
 *
 * The record is editable here: name and contact, and ending employment. Those APIs existed before
 * this panel did; showing three fields and no actions was not a finished screen.
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

const close = () =>
  void navigation.go(`/${workspaceSlug}/hr`, { replaceState: true, keepFocus: true, noScroll: true })

let editing = $state(false)
let displayName = $state('')
let workEmail = $state('')
let personalEmail = $state('')
let phone = $state('')

$effect(() => {
  if (editing && person) {
    displayName = person.displayName
    workEmail = person.workEmail ?? ''
    personalEmail = person.personalEmail ?? ''
    phone = person.phone ?? ''
  }
})

const save = createMutation(() => ({
  mutationFn: () =>
    api.people.update({
      workspaceId,
      personId,
      displayName: displayName.trim(),
      workEmail: workEmail.trim() || null,
      personalEmail: personalEmail.trim() || null,
      phone: phone.trim() || null,
    }),
  onSuccess: () => {
    toast.success(t('person_updated'))
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
    editing = false
  },
  onError: (error: Error) => toast.error(error.message),
}))

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
  onError: (error: Error) => toast.error(error.message),
}))

/**
 * The employment types the server can send, as words.
 *
 * A map rather than a chain: the parameter used to be called `t`, which shadowed the message
 * function and turned every branch into a call on a string. An unknown value falls through to
 * itself, so a type added on the server shows up as its raw name rather than as nothing.
 */
const EMPLOYMENT_KEYS: Record<string, string> = {
  full_time: 'employment_full_time',
  part_time: 'employment_part_time',
  contract: 'employment_contract',
  intern: 'employment_intern',
  temporary: 'employment_temporary',
  freelance: 'employment_freelance',
}
const typeLabel = (value: string) => (EMPLOYMENT_KEYS[value] ? t(EMPLOYMENT_KEYS[value]) : value)

const canManage = $derived(canHr('personManage'))
const left = $derived(person?.status === 'terminated')
</script>

<RightPanel onClose={close} title={person?.displayName ?? ''}>
  {#if personQuery.isLoading}
    <div class="pad"><Skeleton height="120px" /></div>
  {:else if person}
    <div class="pad">
    <div class="head">
      <Avatar name={person.displayName} id={person.id} size={56} />
      <div>
        <h2>{person.displayName}</h2>
        {#if person.workEmail}<p class="meta">{person.workEmail}</p>{/if}
      </div>
    </div>

    <dl>
      {#if resolution?.primaryOfficeName}
        <dt>{t('office')}</dt>
        <dd>{resolution.primaryOfficeName}</dd>
      {/if}
      {#if resolution?.timezone}
        <dt>{t('local_time')}</dt>
        <dd>
          {new Intl.DateTimeFormat(undefined, {
            timeZone: resolution.timezone,
            hour: 'numeric',
            minute: '2-digit',
          }).format(new Date())}
          <span class="meta">{resolution.timezone}</span>
        </dd>
      {/if}
      {#if person.employeeNo}
        <dt>{t('employee_no')}</dt>
        <dd>{person.employeeNo}</dd>
      {/if}
      {#if person.hiredOn}
        <dt>{t('started')}</dt>
        <dd>
          {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
            new Date(`${person.hiredOn}T00:00:00`),
          )}
        </dd>
      {/if}
      {#if person.phone}
        <dt>{t('phone')}</dt>
        <dd>{person.phone}</dd>
      {/if}
      {#if resolution?.orgUnitPath}
        <dt>{t('department')}</dt>
        <dd>{resolution.orgUnitPath}</dd>
      {/if}
      {#if managerQuery.data}
        <dt>{t('manager')}</dt>
        <dd>{managerQuery.data.displayName}</dd>
      {/if}
      {#if employment}
        <dt>{t('employment')}</dt>
        <dd>{typeLabel(employment.employmentType)}</dd>
      {/if}
    </dl>

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
    </div>
  {/if}

  {#snippet footer()}
    {#if canManage && person && !left}
      <div class="actions">
        <Button size="sm" variant="secondary" onclick={() => (editing = true)}>{t('edit_person')}</Button>
        <Button size="sm" variant="danger" onclick={() => (offboarding = true)}>{t('offboard')}</Button>
      </div>
    {/if}
  {/snippet}
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
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editing = false)}>{t('common.cancel')}</Button>
    <Button
      onclick={() => save.mutate()}
      disabled={displayName.trim().length === 0}
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
    <Button variant="danger" onclick={() => offboard.mutate()} loading={offboard.isPending}
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
dt {
  color: var(--kern-ink-500);
  font-size: 12px;
}
dd {
  margin: 0;
}
.actions {
  display: flex;
  gap: 8px;
  justify-content: end;
}
.form {
  display: grid;
  gap: 14px;
}
</style>
