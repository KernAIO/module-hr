<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  formatCount,
  formatDate,
  Icon,
  IconButton,
  Input,
  ProgressBar,
  SectionLabel,
  Select,
  Skeleton,
  session,
  toast,
  uploadFile,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { HR_CAPABILITIES } from '../capabilities.js'
import { t } from '../i18n.js'
import type { PersonDocument } from '../index.js'
import { canHr } from '../permissions.js'
import { isoDate } from '../query.js'
import { explainRefusal } from './refusal.js'

/**
 * The contracts, identity documents and certificates kept against one person.
 *
 * `documents` is a capability and `hr.document.view` / `hr.document.manage` are two permissions
 * nobody holds by default, and all three led nowhere until this section existed —
 * `src/contract/capabilities.ts` says out loud that a switch which changes nothing is worse than a
 * missing switch, and this is the switch.
 *
 * Off means **absent**, not refused: the API answers 404 for a workspace that never enabled
 * documents, so a section saying "you may not see this" would contradict both the server and a
 * shell that already hid the feature.
 *
 * The bytes never pass through HR. `uploadFile` presigns against core, PUTs to object storage and
 * marks the file ready; `documents.attach` then records the file id against the person. A file
 * uploaded but never attached is a stray file, so the attach follows the upload in one action.
 */
interface Props {
  personId: string
  workspaceId: string
  personName: string
}
const { personId, workspaceId, personName }: Props = $props()

const api = getHrApi()
const queryClient = useQueryClient()

const enabled = $derived(session.hasCapability('hr', HR_CAPABILITIES.documents))
const mayView = $derived(canHr('documentView'))
const mayManage = $derived(canHr('documentManage'))

const documentsQuery = createQuery(() => ({
  queryKey: ['hr', 'person', workspaceId, 'documents', personId] as const,
  enabled: enabled && mayView && Boolean(workspaceId && personId),
  queryFn: () => api.documents.list({ workspaceId, personId }),
}))
const documents = $derived(documentsQuery.data ?? [])

/**
 * The kinds offered, and the words for them.
 *
 * The contract takes any string up to 48 characters, so a kind written by an import or by a later
 * version of this screen falls through to itself rather than to nothing.
 */
const KIND_KEYS: Record<string, string> = {
  contract: 'doc_kind_contract',
  id: 'doc_kind_id',
  certificate: 'doc_kind_certificate',
  payslip: 'doc_kind_payslip',
  other: 'doc_kind_other',
}
const kindLabel = (kind: string) => (KIND_KEYS[kind] ? t(KIND_KEYS[kind]) : kind)
const kindOptions = Object.keys(KIND_KEYS).map((kind) => ({ value: kind, label: kindLabel(kind) }))

/**
 * A calendar date, read in the reader's language.
 *
 * The `T00:00:00` is not decoration: `new Date('2026-03-01')` is parsed as *UTC* midnight, so west
 * of Greenwich a document issued on the first of March would be shown as expiring in February.
 */
const dateLabel = (iso: string): string => formatDate(`${iso}T00:00:00`)

/**
 * Whether a document has run out, or is about to.
 *
 * The reason a work permit or a right-to-work check is worth keeping here at all is that somebody
 * has to notice before it lapses, and a list of names and dates does not make anybody notice.
 */
const SOON_DAYS = 60
function expiry(row: PersonDocument): 'expired' | 'soon' | null {
  if (!row.expiresOn) return null
  const today = isoDate()
  if (row.expiresOn < today) return 'expired'
  const limit = new Date(`${today}T00:00:00`)
  limit.setDate(limit.getDate() + SOON_DAYS)
  return row.expiresOn <= isoDate(limit) ? 'soon' : null
}

// ---------------------------------------------------------------- attaching

let picker = $state<HTMLInputElement | null>(null)
let chosen = $state<File | null>(null)
let docName = $state('')
let docKind = $state('other')
let issuedOn = $state('')
let expiresOn = $state('')
/** Null while the browser is not reporting progress, which is what an unknown-length body does. */
let progress = $state<number | null>(null)
let attachError = $state<string | null>(null)

function pick(files: FileList | null) {
  const file = files?.[0]
  if (!file) return
  chosen = file
  // The file's own name is what somebody would type, so it is the default rather than an empty box.
  docName = file.name.replace(/\.[^.]+$/, '').slice(0, 200)
  docKind = 'other'
  issuedOn = ''
  expiresOn = ''
  progress = null
  attachError = null
}

/**
 * `attaching` rather than `attach.isPending`: the disabled attribute only reaches the button on the
 * next render, so two quick clicks are one render apart — and here that is the same file uploaded
 * twice and attached twice.
 */
let attaching = $state(false)

const attach = createMutation(() => ({
  mutationFn: async () => {
    const file = chosen
    if (!file) throw new Error('no file')
    progress = 0
    const uploaded = await uploadFile({
      workspaceId,
      file,
      name: file.name,
      mimeType: file.type || undefined,
      // What the file belongs to, recorded with the file itself: core can then answer "what is this
      // file" without HR, which is what makes an orphan findable.
      attachedTo: { module: 'hr', type: 'person', id: personId },
      onProgress: ({ ratio }) => {
        progress = ratio
      },
    })
    return api.documents.attach({
      workspaceId,
      personId,
      fileId: uploaded.id,
      name: docName.trim(),
      kind: docKind,
      issuedOn: issuedOn || null,
      expiresOn: expiresOn || null,
    })
  },
  onSuccess: (row) => {
    toast.success(t('doc_attached', { name: row.name }))
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
    chosen = null
  },
  onError: (error) => {
    // The dialog stays open with the file still chosen: the failure is almost always the network or
    // a size limit, and making somebody find the file again to retry is a punishment for both.
    attachError = explainRefusal(error, t('doc_attach_error'))
    progress = null
  },
  onSettled: () => {
    attaching = false
  },
}))

const submitAttach = () => {
  if (attaching) return
  attaching = true
  attachError = null
  attach.mutate()
}

// ---------------------------------------------------------------- removing

let removing = $state<PersonDocument | null>(null)
let deleting = $state(false)

const remove = createMutation(() => ({
  mutationFn: (row: PersonDocument) => api.documents.remove({ workspaceId, personId, documentId: row.id }),
  onSuccess: (_ok, row: PersonDocument) => {
    toast.success(t('doc_removed', { name: row.name }))
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
    removing = null
  },
  onError: (error) => toast.error(explainRefusal(error, t('doc_remove_error'))),
  onSettled: () => {
    deleting = false
  },
}))

const submitRemove = () => {
  if (deleting || !removing) return
  deleting = true
  remove.mutate(removing)
}

const canAttach = $derived(Boolean(chosen) && docName.trim().length > 0 && mayManage && !attaching)
</script>

<!-- A capability that is off is not a locked door: nothing is drawn, and the API answers 404. -->
{#if enabled && mayView}
  <section class="sec">
    <SectionLabel label={t('docs_title')} count={documents.length ? formatCount(documents.length, 999) : null}>
      {#snippet trailing()}
        <!-- Hidden rather than disabled: `hr.document.manage` is a permission somebody either has
             or will never have here, and a dead button explains nothing. -->
        {#if mayManage}
          <input
            bind:this={picker}
            type="file"
            hidden
            onchange={(e) => {
              pick(e.currentTarget.files)
              e.currentTarget.value = ''
            }}
          />
          <Button size="sm" variant="secondary" icon="paperclip" onclick={() => picker?.click()}>
            {t('doc_attach')}
          </Button>
        {/if}
      {/snippet}
    </SectionLabel>

    <!--
      Held data outranks the error: every write in this module drops the whole HR cache, so a failed
      background refetch leaves the query in `error` with a good list still in hand — and an error
      branch above this one would blank it.
    -->
    {#if documentsQuery.isLoading}
      <div class="rows">
        {#each [1, 2] as n (n)}<Skeleton height="44px" />{/each}
      </div>
    {:else if documents.length}
      <ul class="docs">
        {#each documents as row (row.id)}
          {@const lapse = expiry(row)}
          <li>
            <span class="ic"><Icon name="file-text" size={14} strokeWidth={1.7} /></span>
            <span class="name" title={row.name}>{row.name}</span>
            <span class="chips">
              <Badge tone="grey">{kindLabel(row.kind)}</Badge>
              {#if lapse === 'expired'}
                <Badge tone="danger">{t('doc_expired')}</Badge>
              {:else if lapse === 'soon'}
                <Badge tone="warning">{t('doc_expiring')}</Badge>
              {/if}
            </span>
            <span class="dates">
              {#if row.expiresOn}
                {t('doc_expires_on', { date: dateLabel(row.expiresOn) })}
              {:else if row.issuedOn}
                {t('doc_issued_on', { date: dateLabel(row.issuedOn) })}
              {:else}
                {t('doc_added_on', { date: dateLabel(row.createdAt) })}
              {/if}
            </span>
            {#if mayManage}
              <IconButton
                icon="trash-2"
                size={26}
                label={t('doc_remove_label', { name: row.name })}
                onclick={() => (removing = row)}
              />
            {/if}
          </li>
        {/each}
      </ul>
    {:else if documentsQuery.isError}
      <EmptyState compact icon="triangle-alert" title={t('docs_error')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void documentsQuery.refetch()}>
            {t('retry')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <EmptyState compact icon="file-text" title={t('docs_none')} description={t('docs_none_desc')}>
        {#snippet actions()}
          {#if mayManage}
            <Button size="sm" icon="paperclip" onclick={() => picker?.click()}>{t('doc_attach')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {/if}
  </section>

  <Dialog
    open={chosen !== null}
    size="sm"
    title={t('doc_attach_title', { name: personName })}
    description={t('doc_attach_body')}
    onOpenChange={(open) => {
      if (!open && !attaching) chosen = null
    }}
  >
    <div class="form">
      {#if chosen}
        <p class="file">
          <Icon name="paperclip" size={13} strokeWidth={1.8} />
          <span class="name" title={chosen.name}>{chosen.name}</span>
        </p>
      {/if}

      <Field label={t('doc_name')} id="hr-doc-name" required>
        {#snippet children(id)}
          <Input {id} bind:value={docName} maxlength={200} />
        {/snippet}
      </Field>

      <Field label={t('doc_kind')} id="hr-doc-kind">
        {#snippet children(id)}
          <Select
            {id}
            value={docKind}
            onValueChange={(v) => (docKind = v)}
            options={kindOptions}
            ariaLabel={t('doc_kind')}
          />
        {/snippet}
      </Field>

      <div class="pair">
        <Field label={t('doc_issued')} hint={t('common.optional')} id="hr-doc-issued">
          {#snippet children(id)}
            <Input {id} type="date" value={issuedOn} oninput={(e) => (issuedOn = e.currentTarget.value)} />
          {/snippet}
        </Field>
        <Field label={t('doc_expires')} hint={t('doc_expires_hint')} id="hr-doc-expires">
          {#snippet children(id)}
            <Input {id} type="date" value={expiresOn} oninput={(e) => (expiresOn = e.currentTarget.value)} />
          {/snippet}
        </Field>
      </div>

      {#if attaching}
        <div class="progress">
          <ProgressBar
            value={progress === null ? 0 : progress * 100}
            label={t('doc_uploading', { name: chosen?.name ?? '' })}
          />
          <span class="muted">{t('doc_uploading', { name: chosen?.name ?? '' })}</span>
        </div>
      {/if}
      {#if attachError}
        <p class="err" role="alert">{attachError}</p>
      {/if}
    </div>

    {#snippet footer()}
      <Button variant="secondary" onclick={() => (chosen = null)} disabled={attaching}>
        {t('common.cancel')}
      </Button>
      <Button loading={attach.isPending} disabled={!canAttach} onclick={submitAttach}>
        {t('doc_attach')}
      </Button>
    {/snippet}
  </Dialog>

  <Dialog
    open={removing !== null}
    size="sm"
    title={removing ? t('doc_remove_title', { name: removing.name }) : ''}
    description={t('doc_remove_body', { person: personName })}
    onOpenChange={(open) => {
      if (!open) removing = null
    }}
  >
    {#if removing}
      <p class="body">
        <span class="strong">{removing.name}</span>
        <span class="muted">&nbsp;— {kindLabel(removing.kind)}</span>
      </p>
    {/if}

    {#snippet footer()}
      <Button variant="secondary" onclick={() => (removing = null)} disabled={remove.isPending}>
        {t('common.cancel')}
      </Button>
      <Button variant="danger" loading={remove.isPending} disabled={deleting} onclick={submitRemove}>
        {t('common.remove')}
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
.docs {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.docs li {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 8px;
  padding: 8px 6px 8px 8px;
  border-radius: var(--kern-r-md);
  font-size: 13px;
}
 /* `surface-hover`, not `surface-raised`: the panel this list sits in is already raised, so a
    raised hover is white on white and the row gives no feedback at all. */
.docs li:hover {
  background: var(--kern-surface-hover);
}
.ic {
  color: var(--kern-ink-500);
  display: flex;
}
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.chips,
.dates {
  grid-column: 2;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
/* A colour, not opacity: opacity fades text against the panel whatever token it names. */
.dates,
.muted {
  color: var(--kern-ink-500);
  font-size: 12px;
}
.form {
  display: grid;
  gap: 14px;
}
.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 14px;
}
.file {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  min-width: 0;
  color: var(--kern-ink-500);
  font-size: 12.5px;
}
.progress {
  display: grid;
  gap: 6px;
}
.err {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}
.body {
  margin: 0 0 4px;
  font-size: 13.5px;
}
.strong {
  font-weight: 500;
}
</style>
