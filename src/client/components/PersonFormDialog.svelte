<script lang="ts">
import { Button, Dialog, Field, Input, navigation, Select, toast } from '@kernhq/ui'
import { createMutation, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { isoDate } from '../query.js'

/**
 * Hire someone into the directory.
 *
 * The Add person button already went to `?new=1`; this is the screen that URL was promising.
 * Office is optional: a workspace that never switched offices on still has a default one, and the
 * server assigns it. Asking for an office on that workspace would offer a feature it does not have.
 */
interface OfficeOpt {
  id: string
  name: string
}

interface Props {
  open: boolean
  workspaceId: string
  workspaceSlug: string
  offices: OfficeOpt[]
  showOffice: boolean
}

let { open, workspaceId, workspaceSlug, offices, showOffice }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

/** Local so the dialog can close before the URL has dropped `?new=1`. */
let shown = $state(false)
/** Set when create succeeded, so closing the dialog does not wipe the person we just opened. */
let createdId = $state<string | null>(null)
$effect(() => {
  if (open) {
    shown = true
    createdId = null
  }
})

let displayName = $state('')
let workEmail = $state('')
let employeeNo = $state('')
let hiredOn = $state(isoDate())
let officeId = $state('')
let employmentType = $state('full_time')

const typeOptions = [
  { value: 'full_time', label: t('employment_full_time') },
  { value: 'part_time', label: t('employment_part_time') },
  { value: 'contract', label: t('employment_contract') },
  { value: 'intern', label: t('employment_intern') },
  { value: 'temporary', label: t('employment_temporary') },
  { value: 'freelance', label: t('employment_freelance') },
]

const officeOptions = $derived(offices.map((o) => ({ value: o.id, label: o.name })))

$effect(() => {
  if (open && !officeId && offices[0]) officeId = offices[0].id
})

const dismiss = () => {
  if (createdId) {
    void navigation.go(`/${workspaceSlug}/hr?person=${createdId}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    })
    return
  }
  void navigation.go(`/${workspaceSlug}/hr`, { replaceState: true, keepFocus: true, noScroll: true })
}

const reset = () => {
  displayName = ''
  workEmail = ''
  employeeNo = ''
  hiredOn = isoDate()
  officeId = offices[0]?.id ?? ''
  employmentType = 'full_time'
}

/**
 * The sentence to put in front of somebody when the hire is refused.
 *
 * A refusal arrives as two pieces: a machine-readable `reason` a module translates, and the
 * English sentence the router wrote for a reader. `people.create` sends no reason today — an
 * employee number already taken and a field the server will not take are what it refuses on — so
 * this uses the second, and only for the codes that carry a sentence somebody wrote. A network
 * drop, a 500 and a gateway carry machine text, and `Forbidden` is one word; a toast is the last
 * place to paste any of them, so they fall back to this module's own string.
 *
 * When `people.create` does grow a reason, it is read the way `ClockControls.svelte` reads a
 * punch's — keyed by the code, never by the sentence.
 */
const READABLE = new Set(['BAD_REQUEST', 'CONFLICT', 'NOT_FOUND'])
function explain(error: unknown, fallback: string): string {
  const failure = error as { code?: unknown; message?: string }
  const readable = typeof failure.code === 'string' && READABLE.has(failure.code)
  return (readable ? failure.message : '') || fallback
}

/**
 * `creating` rather than `create.isPending`: the disabled attribute only reaches the button on the
 * next render, so two quick clicks both fire — and here that is two people in the directory with
 * the same name and two employee numbers.
 */
let creating = $state(false)

const create = createMutation(() => ({
  mutationFn: () =>
    api.people.create({
      workspaceId,
      displayName: displayName.trim(),
      workEmail: workEmail.trim() || null,
      employeeNo: employeeNo.trim() || null,
      hiredOn: hiredOn || null,
      officeId: showOffice && officeId ? officeId : null,
      employmentType: employmentType as
        | 'full_time'
        | 'part_time'
        | 'contract'
        | 'intern'
        | 'temporary'
        | 'freelance',
    }),
  onSuccess: (person) => {
    createdId = person.id
    toast.success(t('person_created', { name: person.displayName }))
    void queryClient.invalidateQueries({ queryKey: ['hr', 'people'] })
    reset()
    shown = false
    dismiss()
  },
  onError: (error) => toast.error(explain(error, t('person_create_error'))),
  onSettled: () => {
    creating = false
  },
}))

const submit = () => {
  if (creating) return
  creating = true
  create.mutate()
}

const canManage = $derived(canHr('personManage'))
const canSubmit = $derived(displayName.trim().length > 0 && canManage && !creating)
</script>

<Dialog
  bind:open={shown}
  title={t('add_person')}
  description={t('add_person_desc')}
  onOpenChange={(next) => {
    if (!next) {
      shown = false
      dismiss()
    }
  }}
>
  <div class="form">
    <Field label={t('display_name')} id="hr-person-name" required>
      {#snippet children(id)}
        <Input {id} bind:value={displayName} autocomplete="name" />
      {/snippet}
    </Field>
    <Field label={t('work_email')} id="hr-person-email" hint={t('common.optional')}>
      {#snippet children(id)}
        <Input {id} type="email" bind:value={workEmail} autocomplete="email" />
      {/snippet}
    </Field>
    <Field label={t('employee_no')} id="hr-person-no" hint={t('common.optional')}>
      {#snippet children(id)}
        <Input {id} bind:value={employeeNo} />
      {/snippet}
    </Field>
    <Field label={t('hired_on')} id="hr-person-hired">
      {#snippet children(id)}
        <Input {id} type="date" bind:value={hiredOn} />
      {/snippet}
    </Field>
    {#if showOffice && officeOptions.length}
      <Field label={t('office')} id="hr-person-office">
        {#snippet children(id)}
          <Select {id} bind:value={officeId} options={officeOptions} />
        {/snippet}
      </Field>
    {/if}
    <Field label={t('employment')} id="hr-person-type">
      {#snippet children(id)}
        <Select {id} bind:value={employmentType} options={typeOptions} />
      {/snippet}
    </Field>
  </div>

  {#snippet footer()}
    <!--
      The URL reaches this dialog whether or not the person may use it — the Add person button is
      gated, a pasted `?new=1` is not — so the submit says why it is dead rather than looking
      broken.
    -->
    {#if !canManage}<span class="note">{t('person_manage_denied')}</span>{/if}
    <Button
      variant="ghost"
      onclick={() => {
        shown = false
        dismiss()
      }}>{t('common.cancel')}</Button
    >
    <Button onclick={submit} disabled={!canSubmit} loading={create.isPending}>
      {t('add_person')}
    </Button>
  {/snippet}
</Dialog>

<style>
.form {
  display: grid;
  gap: 14px;
}
/* A colour, not opacity: opacity fades text against the dialog whatever token it names. */
.note {
  margin-inline-end: auto;
  align-self: center;
  font-size: 12px;
  color: var(--kern-ink-500);
}
</style>
