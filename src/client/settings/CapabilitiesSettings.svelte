<script lang="ts">
import { Card, coreApi, keys, navigation, SettingsPage, Skeleton, Switch, session } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { CoreApi } from '../core-api.js'
import { t } from '../i18n.js'

/**
 * Which parts of HR this workspace has.
 *
 * The switchboard the whole module is built around: turning one off removes its navigation, its
 * widgets, its commands, its settings pages and its API — and destroys nothing, so turning it back
 * on restores exactly what was there.
 *
 * Reads the definitions from the module's own manifest rather than a list kept here. A capability
 * added on the server appears in this screen without anybody editing it, which is the point of
 * declaring them as data.
 */
const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const api = coreApi<CoreApi>()
const queryClient = useQueryClient()

const modulesQuery = createQuery(() => ({
  queryKey: keys.modules(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.workspaces.modules.list({ workspaceId }),
}))

const hr = $derived(modulesQuery.data?.find((entry) => entry.manifest.id === 'hr'))
const definitions = $derived(hr?.manifest.capabilities ?? [])
const enabled = $derived(new Set(hr?.state.capabilities ?? []))

const setCapability = createMutation(() => ({
  mutationFn: async (vars: { id: string; on: boolean }) => {
    const stored = ((hr?.state.settings as Record<string, unknown>)?.$capabilities ?? {}) as Record<
      string,
      boolean
    >
    // The reserved key is sent whole. Core lifts it out before the module's own settings schema
    // sees it, which is what stops a zod object stripping every switch on the way past.
    return api.workspaces.modules.updateSettings({
      workspaceId,
      moduleId: 'hr',
      settings: { $capabilities: { ...stored, [vars.id]: vars.on } },
    })
  },
  onSuccess: () => {
    // Navigation, widgets and routes are all derived from this, so the whole shell needs to re-read.
    void queryClient.invalidateQueries({ queryKey: keys.modules(workspaceId) })
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
}))

const nameOf = (id: string): string =>
  definitions.find((d: { id: string; label: string }) => d.id === id)?.label ?? id

/** A capability whose dependency is off cannot be switched on — the server would prune it anyway. */
const blockedBy = (deps: string[]) => deps.filter((d) => !enabled.has(d))
</script>

<SettingsPage title={t('settings_capabilities')} description={t('capabilities_desc')}>

{#if modulesQuery.isLoading}
  <Skeleton height="220px" />
{:else}
  <div class="list">
    {#each definitions as capability (capability.id)}
      {@const missing = blockedBy(capability.dependsOn)}
      <Card>
        <div class="row">
          <div class="what">
            <span class="name">{capability.label}</span>
            {#if capability.description}
              <span class="meta">{capability.description}</span>
            {/if}
            {#if missing.length}
              <span class="meta">
                {t('capability_requires', { name: missing.map(nameOf).join(', ') })}
              </span>
            {/if}
          </div>
          <!-- The module's own foundation is always on, and a capability whose dependency is off
               cannot be switched on: the server prunes it anyway, so the control says so. -->
          <Switch
            checked={enabled.has(capability.id)}
            disabled={capability.required || missing.length > 0 || setCapability.isPending}
            onCheckedChange={(on) => setCapability.mutate({ id: capability.id, on })}
            label={capability.label}
          />
        </div>
      </Card>
    {/each}
  </div>
{/if}
</SettingsPage>

<style>
.list {
  display: grid;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.what {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.name {
  font-weight: 500;
}
.meta {
  color: var(--kern-ink-500);
  font-size: 12px;
}
</style>
