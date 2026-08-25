<script lang="ts">
import { Badge, Button, Card, EmptyState, navigation, Page, PageHeader, Skeleton, session } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { hrKeys } from '../query.js'

/**
 * Everything waiting on me, across every kind of request.
 *
 * One inbox rather than one per feature, because the approval engine is keyed by subject type — a
 * leave request and an attendance correction arrive here the same way, and so will overtime and
 * timesheets when they exist.
 *
 * No permission gate: an inbox of what *you* must decide is yours by definition, and the server only
 * ever lists steps you are named on.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const inboxQuery = createQuery(() => ({
  queryKey: hrKeys.approvalInbox(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.approvals.inbox({ workspaceId, limit: 50, includeDecided: false }),
}))
const items = $derived(inboxQuery.data?.items ?? [])

const decide = createMutation(() => ({
  mutationFn: (vars: { requestId: string; decision: 'approve' | 'reject' }) =>
    api.approvals.decide({ workspaceId, ...vars }),
  onSuccess: () => {
    // Deciding changes a balance and a day sheet as well as the inbox, so the whole module's cache
    // is invalidated rather than guessing which keys moved.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
}))

const subjectLabel = (subjectType: string) =>
  subjectType === 'leave' ? t('leave_title') : t('attendance_title')

const when = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
</script>

<PageHeader
  crumbs={[{ label: workspace?.name ?? '' }, { label: t('approvals_title') }]}
  title={t('approvals_title')}
/>

<Page>
  {#if inboxQuery.isLoading}
    <Skeleton height="140px" />
  {:else if items.length === 0}
    <EmptyState
      icon="check-check"
      title={t('approvals_none')}
      description={t('approvals_none_desc')}
    />
  {:else}
    <ul>
      {#each items as item (item.id)}
        <li>
          <Card>
            <div class="row">
              <div class="what">
                <Badge tone="upcoming">{subjectLabel(item.subjectType)}</Badge>
                <span class="summary">{item.summary}</span>
                <span class="meta">{when(item.requestedAt)}</span>
              </div>
              <div class="actions">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={decide.isPending}
                  onclick={() => decide.mutate({ requestId: item.id, decision: 'reject' })}
                  >{t('reject')}</Button
                >
                <Button
                  size="sm"
                  disabled={decide.isPending}
                  onclick={() => decide.mutate({ requestId: item.id, decision: 'approve' })}
                  >{t('approve')}</Button
                >
              </div>
            </div>
          </Card>
        </li>
      {/each}
    </ul>
  {/if}
</Page>

<style>
ul {
  display: grid;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.what {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.summary {
  font-weight: 500;
}
.meta {
  color: var(--kern-ink-500);
  font-size: 12px;
}
.actions {
  display: flex;
  gap: 8px;
}
</style>
