<script lang="ts">
import { Button, EmptyState, formatDateTime, SectionLabel, Skeleton, session } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import type { SensitiveAccess, SensitiveAccessVia } from '../../contract/privacy.js'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { hrKeys } from '../query.js'
import PersonInline from './PersonInline.svelte'

/**
 * Who has read this person's identity number, birth date or bank details.
 *
 * Two readers may see it, and they see it for different reasons. The **subject** may always read
 * their own log — the server puts no permission on that, because being denied sight of who has been
 * looking at your bank details is not a state the product should be able to express. A holder of
 * `hr.privacy.manage` sees anybody's, because answering a subject-access request starts with this
 * list. Everyone else gets nothing: not an empty state, not a locked one — this is not a door to
 * rattle.
 *
 * Whether the panel's person *is* the viewer is answered two ways, and both are needed. The record
 * carries `userId` where somebody has an account, which is the direct answer; `people.me` is the
 * server's own resolution, and it is asked only where the first answer is no, so a directory of
 * five hundred people costs nothing extra to browse.
 *
 * Newest first, twenty at a time. Paging is accumulated by hand rather than through an infinite
 * query: the first page follows the cache and its realtime invalidation, the rest are appended
 * beneath it, and the join is de-duplicated so a refetch of page one cannot draw a row twice.
 */
interface Props {
  personId: string
  workspaceId: string
  /** The Kern account behind the record, or null — plenty of employees never sign in. */
  userId: string | null
  personName: string
}
const { personId, workspaceId, userId, personName }: Props = $props()

const api = getHrApi()

const mayManage = $derived(canHr('privacyManage'))
const ownAccount = $derived(userId !== null && userId === session.user?.id)

const meQuery = createQuery(() => ({
  queryKey: hrKeys.me(workspaceId),
  enabled: Boolean(workspaceId) && !mayManage && !ownAccount,
  queryFn: () => api.people.me({ workspaceId }),
}))
const isSelf = $derived(ownAccount || meQuery.data?.id === personId)
const shown = $derived(isSelf || mayManage)

const PAGE = 20

const firstPage = createQuery(() => ({
  queryKey: hrKeys.accessLog(workspaceId, personId),
  enabled: shown && Boolean(workspaceId && personId),
  queryFn: () => api.privacy.accessLog.list({ workspaceId, personId, limit: PAGE }),
}))

let more = $state<SensitiveAccess[]>([])
/** `undefined` until a second page has been asked for; then whatever the last page said. */
let moreCursor = $state<string | null | undefined>(undefined)
let loadingMore = $state(false)
let moreError = $state(false)

const entries = $derived.by(() => {
  const seen = new Set<string>()
  const out: SensitiveAccess[] = []
  for (const row of [...(firstPage.data?.items ?? []), ...more]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  return out
})
const nextCursor = $derived(moreCursor === undefined ? (firstPage.data?.nextCursor ?? null) : moreCursor)

async function loadMore() {
  if (loadingMore || !nextCursor) return
  loadingMore = true
  moreError = false
  try {
    const page = await api.privacy.accessLog.list({ workspaceId, personId, limit: PAGE, cursor: nextCursor })
    more = [...more, ...page.items]
    moreCursor = page.nextCursor
  } catch {
    moreError = true
  } finally {
    loadingMore = false
  }
}

/** The four fields the log can name, under the labels the sensitive section already uses. */
const FIELD_LABELS: Record<string, () => string> = {
  nationalId: () => t('sensitive_national_id'),
  birthDate: () => t('sensitive_birth_date'),
  iban: () => t('sensitive_iban'),
  emergencyContact: () => t('sensitive_contact_name'),
}
const fieldLabel = (field: string): string => FIELD_LABELS[field]?.() ?? field

const VIA_LABELS: Record<SensitiveAccessVia, () => string> = {
  ui: () => t('privacy_via_ui'),
  api: () => t('privacy_via_api'),
  export: () => t('privacy_via_export'),
}

/** Between who, how and when on one line. A middle dot reads the same in every direction. */
const separator = ' · '
</script>

{#if shown}
  <section class="sec">
    <SectionLabel label={t('privacy_log_title')} />
    <p class="hint">{isSelf ? t('privacy_log_hint_self') : t('privacy_log_hint', { name: personName })}</p>

    {#if firstPage.isLoading}
      <div class="rows"><Skeleton lines={3} /></div>
    {:else if firstPage.isError}
      <EmptyState compact icon="triangle-alert" title={t('privacy_log_error')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void firstPage.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if entries.length === 0}
      <EmptyState compact icon="eye-off" title={t('privacy_log_none')} description={t('privacy_log_none_desc')} />
    {:else}
      <ol class="log">
        {#each entries as entry (entry.id)}
          <li class="entry">
            <div class="who">
              {#if entry.actorUserId === session.user?.id}
                <span class="you">{t('privacy_log_you')}</span>
              {:else if entry.actorPersonId}
                <PersonInline id={entry.actorPersonId} {workspaceId} />
              {:else}
                <span class="muted">{t('privacy_log_no_person')}</span>
              {/if}
              <span class="meta">{separator}{VIA_LABELS[entry.via]()}{separator}{formatDateTime(entry.at)}</span>
            </div>
            <div class="fields">
              {#if entry.fields.length}
                {#each entry.fields as field, i (field)}
                  <span class="field">{fieldLabel(field)}</span>{#if i < entry.fields.length - 1}<span class="muted">, </span>{/if}
                {/each}
              {:else}
                <span class="muted">{t('privacy_log_no_fields')}</span>
              {/if}
            </div>
            {#if entry.purpose}
              <p class="purpose">{t('privacy_log_purpose', { purpose: entry.purpose })}</p>
            {/if}
          </li>
        {/each}
      </ol>
      {#if nextCursor}
        <div class="more">
          <Button size="sm" variant="secondary" onclick={loadMore} loading={loadingMore}>
            {t('privacy_log_more')}
          </Button>
          {#if moreError}<span class="err">{t('privacy_log_error')}</span>{/if}
        </div>
      {/if}
    {/if}
  </section>
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
  margin: 8px 0 10px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--kern-ink-500);
}
.log {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}
.entry {
  display: grid;
  gap: 3px;
  padding: 10px 0;
  border-block-start: 1px solid var(--kern-border-hairline);
}
.entry:first-child {
  border-block-start: 0;
  padding-block-start: 0;
}
.who {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  font-size: 13px;
  font-weight: 500;
  color: var(--kern-ink-800);
}
.you {
  font-weight: 600;
}
.meta {
  font-weight: 400;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.fields {
  font-size: 12.5px;
  color: var(--kern-ink-700);
}
/* A colour, not opacity: opacity fades text against the panel whatever token it names. */
.muted {
  color: var(--kern-ink-500);
}
.purpose {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--kern-ink-500);
}
.more {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-block-start: 8px;
}
.err {
  font-size: 12px;
  color: var(--kern-danger);
}
</style>
