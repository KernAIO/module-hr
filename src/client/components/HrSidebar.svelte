<script lang="ts">
import { coreApi, keys, SidebarGroup, SidebarItem, session } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import type { CoreApi } from '../core-api.js'
import { t } from '../i18n.js'
import { HR_CAPABILITIES, HR_PERMISSIONS } from '../permissions.js'

/**
 * HR's own column.
 *
 * The rail switches modules and the sidebar holds the one you are in, so the module fills the whole
 * column rather than reaching into a shell that happens to leave a gap.
 *
 * Rows are filtered on the workspace's capabilities — a company that never switched attendance on
 * has no attendance row, the same way it has no attendance route and no attendance API. Read
 * through the same `capabilitiesOf` the shell uses, on the same query key, so this shares the
 * layout's cached result rather than fetching it again.
 */
interface Props {
  workspaceId: string
  workspaceSlug: string
  pathname: string
}
const { workspaceId, workspaceSlug, pathname }: Props = $props()

const api = coreApi<CoreApi>()

const modulesQuery = createQuery(() => ({
  queryKey: keys.modules(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.workspaces.modules.list({ workspaceId }),
}))

const capabilities = $derived(session.capabilities)
const has = (id: string) => capabilities.has(`hr.${id}`)

const href = (path: string) => `/${workspaceSlug}${path}`
const active = (path: string) => pathname === `/${workspaceSlug}${path}`
</script>

<SidebarGroup>
  <SidebarItem href={href('/hr')} icon="users" active={active('/hr')} label={t('title')} />
  {#if has(HR_CAPABILITIES.leave)}
    <SidebarItem
      href={href('/hr/leave')}
      icon="tree-palm"
      active={active('/hr/leave')}
      label={t('leave_title')}
    />
  {/if}
  {#if has(HR_CAPABILITIES.attendance)}
    <SidebarItem
      href={href('/hr/attendance')}
      icon="timer"
      active={active('/hr/attendance')}
      label={t('attendance_title')}
    />
  {/if}
  {#if has(HR_CAPABILITIES.rosters)}
    <SidebarItem
      href={href('/hr/rosters')}
      icon="layout-grid"
      active={active('/hr/rosters')}
      label={t('rosters_title')}
    />
  {/if}
  <SidebarItem
    href={href('/hr/approvals')}
    icon="check-check"
    active={active('/hr/approvals')}
    label={t('approvals_title')}
  />
  <!-- Everybody holds `hr.checklist.view`; what they see inside is the server's decision, so the
       row is gated on the workspace's switch alone. -->
  {#if has(HR_CAPABILITIES.checklists)}
    <SidebarItem
      href={href('/hr/checklists')}
      icon="list-checks"
      active={active('/hr/checklists')}
      label={t('checklists_title')}
    />
  {/if}
  <!--
    A permission gate, not a capability one: `hr.report.view` is a separate grant that ships to
    nobody by default, and a row leading to a page that answers 403 is worse than no row. The page
    itself hides each report whose capability is off, and says which switches it needs when all of
    them are — so the route stays reachable with either `attendance` or `leave` on.
  -->
  {#if session.can(HR_PERMISSIONS.reportView)}
    <SidebarItem
      href={href('/hr/reports')}
      icon="chart-column"
      active={active('/hr/reports')}
      label={t('reports_title')}
    />
  {/if}
  {#if has(HR_CAPABILITIES.offices)}
    <SidebarItem
      href={href('/hr/offices')}
      icon="building"
      active={active('/hr/offices')}
      label={t('offices_title')}
    />
  {/if}
  <!--
    No capability: departments and positions belong to the module's always-on core, and
    `hr.org.view` is a default member permission — the chart is the HR screen most of a company
    opens. A route with no entry here is reachable only by typing its URL, which is the same as not
    shipping it.
  -->
  <SidebarItem href={href('/hr/org')} icon="git-branch" active={active('/hr/org')} label={t('org_title')} />
</SidebarGroup>
