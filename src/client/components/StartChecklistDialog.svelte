<script lang="ts">
import { Button, Dialog, EmptyState, Field, Input, Select, Skeleton, toast } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { Checklist } from '../../contract/checklists.js'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { hrKeys } from '../query.js'
import { explainChecklistRefusal } from './checklist-refusal.js'
import PersonInline from './PersonInline.svelte'

/**
 * Start a checklist from a template, for a person, dated from an anchor.
 *
 * Shared by the checklists page and the person panel: from the page the person is chosen here,
 * from the panel the person is the one the panel is about and only the template and the date are
 * asked. The anchor is optional on purpose — the server counts from the hire date or the leaving
 * date when it is left empty, which is the right answer almost every time, and the hint says so.
 *
 * Only live templates are offered. An archived one is refused by the server with
 * `hr.checklist.template_archived`, and offering a choice that can only fail teaches nothing.
 */
interface Props {
  open: boolean
  workspaceId: string
  /** Fixed when the dialog opens from a person's panel; chosen here when null. */
  personId?: string | null
  onClose: () => void
  /** The new list, so the caller can open it. */
  onStarted?: (checklist: Checklist) => void
}
const { open, workspaceId, personId = null, onClose, onStarted }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

const templatesQuery = createQuery(() => ({
  queryKey: hrKeys.checklistTemplates(workspaceId),
  enabled: open && Boolean(workspaceId),
  queryFn: () => api.checklists.templates.list({ workspaceId }),
}))
const templates = $derived(templatesQuery.data ?? [])

const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forChecklists: true }),
  enabled: open && Boolean(workspaceId) && personId === null,
  queryFn: () =>
    api.people.list({ workspaceId, limit: 200, status: ['active', 'onboarding', 'offboarding'] }),
}))
const people = $derived(peopleQuery.data?.items ?? [])

let chosenPersonId = $state('')
let templateId = $state('')
let anchorDate = $state('')
let formError = $state<string | null>(null)

/** Reset on open, so the second checklist somebody starts does not inherit the first one's form. */
$effect(() => {
  if (open) {
    chosenPersonId = ''
    templateId = ''
    anchorDate = ''
    formError = null
  }
})

const kindLabel = (kind: 'onboarding' | 'offboarding') =>
  kind === 'onboarding' ? t('checklist_kind_onboarding') : t('checklist_kind_offboarding')

const targetPersonId = $derived(personId ?? chosenPersonId)
const canSubmit = $derived(Boolean(targetPersonId) && Boolean(templateId))

/**
 * `starting` rather than `start.isPending`: the disabled attribute only reaches the button on the
 * next render, so two quick clicks would start two lists for one joiner.
 */
let starting = $state(false)

const start = createMutation(() => ({
  mutationFn: () =>
    api.checklists.start({
      workspaceId,
      personId: targetPersonId,
      templateId,
      anchorDate: anchorDate || undefined,
    }),
  onSuccess: (created) => {
    toast.success(t('checklist_started', { name: created.name }))
    queryClient.setQueryData(hrKeys.checklist(workspaceId, created.id), created)
    void queryClient.invalidateQueries({ queryKey: ['hr', 'checklist'] })
    onStarted?.(created)
    onClose()
  },
  onError: (error) => {
    formError = explainChecklistRefusal(error, t('checklist_start_error'))
    // The template may have been archived since the list was drawn; re-read it.
    void queryClient.invalidateQueries({ queryKey: hrKeys.checklistTemplates(workspaceId) })
  },
  onSettled: () => {
    starting = false
  },
}))

const submit = () => {
  if (!canSubmit || starting) return
  starting = true
  start.mutate()
}
</script>

<Dialog
  {open}
  size="sm"
  title={t('checklist_start_title')}
  description={t('checklist_start_desc')}
  onOpenChange={(o) => {
    if (!o) onClose()
  }}
>
  {#if templatesQuery.isLoading}
    <div class="rows"><Skeleton lines={3} /></div>
  {:else if templatesQuery.isError}
    <EmptyState compact icon="triangle-alert" title={t('checklist_templates_error')}>
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={() => void templatesQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if templates.length === 0}
    <!-- Where the template comes from, not just that there is none: the reader is a manager and
         the fix is one settings page away. -->
    <EmptyState compact icon="list-checks" title={t('checklist_templates_none')} description={t('checklist_templates_none_desc')} />
  {:else}
    <form
      class="form"
      onsubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {#if personId}
        <div class="fact">
          <span class="lbl">{t('checklist_person')}</span>
          <PersonInline id={personId} {workspaceId} />
        </div>
      {:else}
        <Field label={t('checklist_person')} id="hr-checklist-person" required>
          {#snippet children(id)}
            <Select
              {id}
              bind:value={chosenPersonId}
              disabled={peopleQuery.isLoading}
              placeholder={t('checklist_person_pick')}
              options={people.map((p) => ({ value: p.id, label: p.displayName }))}
            />
          {/snippet}
        </Field>
      {/if}
      <Field label={t('checklist_template')} id="hr-checklist-template" required>
        {#snippet children(id)}
          <Select
            {id}
            bind:value={templateId}
            placeholder={t('checklist_template_pick')}
            options={templates.map((tpl) => ({
              value: tpl.id,
              label: tpl.name,
              description: kindLabel(tpl.kind),
            }))}
          />
        {/snippet}
      </Field>
      <Field label={t('checklist_anchor')} id="hr-checklist-anchor" hint={t('checklist_anchor_hint')} error={formError}>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={anchorDate} />
        {/snippet}
      </Field>
    </form>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose}>{t('common.cancel')}</Button>
    {#if templates.length > 0}
      <Button onclick={submit} disabled={!canSubmit || starting} loading={start.isPending}>
        {t('checklist_start')}
      </Button>
    {/if}
  {/snippet}
</Dialog>

<style>
.rows {
  display: grid;
  gap: 6px;
}
.form {
  display: grid;
  gap: 14px;
}
.fact {
  display: grid;
  gap: 4px;
  font-size: 13.5px;
}
.lbl {
  font-size: 12px;
  color: var(--kern-ink-500);
}
</style>
