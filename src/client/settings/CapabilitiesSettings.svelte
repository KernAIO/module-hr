<script lang="ts">
import { type CapabilityDef, capabilityDependents } from '@kernhq/contracts'
import {
  Button,
  Card,
  coreApi,
  Dialog,
  EmptyState,
  keys,
  messageLocale,
  navigation,
  SettingsPage,
  Skeleton,
  Switch,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { capabilityDescriptionKey, capabilityLabelKey } from '../../contract/capabilities.js'
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

/** Core gates `modules.updateSettings` on this, and every control here is a write to it. */
const canManage = $derived(session.can('core.modules.manage'))

const api = coreApi<CoreApi>()
const queryClient = useQueryClient()

const modulesQuery = createQuery(() => ({
  queryKey: keys.modules(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.workspaces.modules.list({ workspaceId }),
}))

const hr = $derived(modulesQuery.data?.find((entry) => entry.manifest.id === 'hr'))
const definitions = $derived<CapabilityDef[]>(hr?.manifest.capabilities ?? [])
const enabled = $derived(new Set(hr?.state.capabilities ?? []))

/**
 * The switch that is waiting for an answer, and the last refused write.
 *
 * `busy` rather than `setCapability.isPending`: a disabled attribute only reaches the control on
 * the next render, and two quick clicks are one render apart — so the guard has to be set in the
 * same tick as the first one.
 */
let confirming = $state<CapabilityDef | null>(null)
let writeError = $state<string | null>(null)
let busy = $state(false)
/**
 * Which switch the write in flight belongs to, so that one alone stays live.
 *
 * `disabled` on all of them was the obvious way to hold the screen still, and it takes the focus
 * off the control the person is standing on: Chrome blurs a focused element the moment it is
 * disabled and gives it back to `<body>`, which nothing returns. Measured — `document.activeElement`
 * is `BODY` for the whole write and after it. So the others go inert and this one does not; the
 * second click on *this* one is caught by the guard in `toggle`, which is what was really stopping
 * it anyway.
 */
let pending = $state<string | null>(null)
/**
 * Bumped to put a switch back where the server has it.
 *
 * The track carries its own state — it moves the moment it is clicked, before anything is written
 * — and `checked` here is derived from the query, which a refused write leaves untouched. Nothing
 * would then re-assert it, so the switch would sit in a position the workspace is not in. Keying
 * the control on this remounts it against the truth.
 *
 * On this alone, and not on the enabled set beside it. A remount takes the focus with it: keying on
 * the value as well sent a keyboard user to the top of the page every time a switch answered them,
 * measured as `document.activeElement` landing on `<body>`. A value that really changed reaches the
 * track as a prop without a remount; only a write the server refused needs one, and that is this.
 */
let snapback = $state(0)

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
    confirming = null
    writeError = null
    // Navigation, widgets and routes are all derived from this, so the whole shell needs to re-read.
    void queryClient.invalidateQueries({ queryKey: keys.modules(workspaceId) })
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: () => {
    snapback++
    writeError = t('capability_write_error')
    // A refusal inside the dialog is answered in the dialog, where the button that failed still is.
    // Turning one *on* has no dialog to carry the message, so that one gets a toast.
    if (!confirming) toast.error(t('capability_write_error'))
  },
  onSettled: () => {
    busy = false
    pending = null
  },
}))

/**
 * The label and description a person reads.
 *
 * The manifest carries English literals, because core's module admin and the shell's mock parse it
 * with no HR bundle merged. The translation is looked up by convention from the capability's id,
 * and `t()` answering with the key itself is what says there is no string for this reader yet — in
 * which case the literal is what the manifest is for.
 */
function resolve(key: string, fallback: string): string {
  const translated = t(key)
  return translated === key ? fallback : translated
}
const labelOf = (def: CapabilityDef): string => resolve(capabilityLabelKey(def.id), def.label)
const describe = (def: CapabilityDef): string | undefined =>
  def.description ? resolve(capabilityDescriptionKey(def.id), def.description) : undefined

const nameOf = (id: string): string => {
  const def = definitions.find((d) => d.id === id)
  return def ? labelOf(def) : id
}

/** Arabic separates a list with '،' and German with 'und'; `join(', ')` gives every reader a comma. */
function listOf(parts: string[]): string {
  try {
    return new Intl.ListFormat(messageLocale(), { type: 'conjunction' }).format(parts)
  } catch {
    return parts.join(', ')
  }
}

/** A capability whose dependency is off cannot be switched on — the server would prune it anyway. */
const blockedBy = (deps: string[]) => deps.filter((d) => !enabled.has(d))

/**
 * What else goes out with the one being switched off.
 *
 * Only the dependants that are actually on: `calendars` carries leave, accrual and attendance in a
 * workspace that uses them and carries nothing in one that does not, and naming a feature the
 * workspace never had would read as a threat rather than a warning.
 */
const dependentsOf = (def: CapabilityDef): string[] =>
  capabilityDependents(definitions, def.id)
    .filter((id) => id !== def.id && enabled.has(id))
    .map(nameOf)

/**
 * The question the dialog asked, kept as it was asked.
 *
 * Everything in the panel used to be derived from `confirming` and `enabled`, and a successful
 * write clears the one and empties the other — a frame before the dialog has finished fading out,
 * so the heading and the list of what goes with it blanked while the box was still on screen. It is
 * only ever replaced by the next question, which is what carries it through the close.
 */
let asked = $state<{ name: string; losing: string[] } | null>(null)

function toggle(def: CapabilityDef, on: boolean) {
  if (busy) {
    // Swallowed — and the track moved itself on the way in, so it is now showing a position nobody
    // is going to write. This is the same repair a refused write needs.
    snapback++
    return
  }
  if (!on) {
    // Off is the direction that takes other features with it, so it is asked rather than written.
    // The track has already moved itself; put it back until the dialog has an answer.
    confirming = def
    asked = { name: labelOf(def), losing: dependentsOf(def) }
    writeError = null
    snapback++
    return
  }
  busy = true
  pending = def.id
  writeError = null
  setCapability.mutate({ id: def.id, on: true })
}

function confirmOff() {
  if (!confirming || busy) return
  busy = true
  pending = confirming.id
  writeError = null
  setCapability.mutate({ id: confirming.id, on: false })
}

/**
 * Closes the dialog; it does not stop a write already on its way, which is why the Cancel button
 * is disabled while one is. Escape is not, and cannot be — so this has to be safe to run mid-write:
 * clearing `confirming` is what sends the answer to a toast instead of to a dialog nobody can see.
 */
function cancelOff() {
  confirming = null
  writeError = null
}
</script>

<SettingsPage title={t('settings_capabilities')} description={t('capabilities_desc')}>

<!--
  Held definitions outrank the error. A background refetch fails on every core restart, and an error
  branch above the list would answer that by blanking the switchboard — telling an administrator
  that HR has no features, on a screen that had them a second ago. The error is only the whole frame
  when there is nothing else to draw; when there is, it is the line above the list.
-->
{#if modulesQuery.isLoading}
  <div class="list">
    {#each [1, 2, 3, 4] as n (n)}<Skeleton height="64px" radius="10px" />{/each}
  </div>
{:else if definitions.length > 0}
  {#if !canManage}
    <p class="readonly">{t('general_readonly')}</p>
  {/if}

  {#if modulesQuery.isError}
    <div class="stale" role="status">
      <span>{t('capabilities_stale')}</span>
      <Button size="sm" variant="secondary" onclick={() => void modulesQuery.refetch()}>
        {t('retry')}
      </Button>
    </div>
  {/if}

  <div class="list">
    {#each definitions as capability (capability.id)}
      {@const missing = blockedBy(capability.dependsOn)}
      {@const description = describe(capability)}
      <Card>
        <div class="row">
          <div class="what">
            <span class="name">{labelOf(capability)}</span>
            {#if description}
              <span class="meta">{description}</span>
            {/if}
            <!-- Both reasons a switch is dead are written down. A control that cannot be moved and
                 does not say why reads as a broken screen. -->
            {#if capability.required}
              <span class="meta">{t('capability_always_on')}</span>
            {:else if missing.length}
              <span class="meta">
                {t('capability_requires', { name: listOf(missing.map(nameOf)) })}
              </span>
            {/if}
          </div>
          <!-- `ariaLabel`, not `label`: `Switch` renders a visible `label` beside its track, and
               the name is already the first line of this row — so it was printed twice. A screen
               reader still needs it, and this is the way to give it one without a second copy. -->
          {#key snapback}
            <Switch
              checked={enabled.has(capability.id)}
              disabled={!canManage ||
                capability.required ||
                missing.length > 0 ||
                (busy && pending !== capability.id)}
              onCheckedChange={(on) => toggle(capability, on)}
              ariaLabel={labelOf(capability)}
            />
          {/key}
        </div>
      </Card>
    {/each}
  </div>
{:else if modulesQuery.isError}
  <EmptyState icon="triangle-alert" title={t('general_error')} description={t('general_error_desc')}>
    {#snippet actions()}
      <Button variant="secondary" onclick={() => void modulesQuery.refetch()}>{t('retry')}</Button>
    {/snippet}
  </EmptyState>
{:else if !hr}
  <EmptyState icon="users" title={t('general_not_enabled')} description={t('general_not_enabled_desc')} />
{:else}
  <EmptyState icon="toggle-left" title={t('capabilities_none')} description={t('capabilities_none_desc')} />
{/if}
</SettingsPage>

<!--
  What turning one off actually does, before it is done.
  The dependants are the half nobody expects: switching `calendars` off in a workspace that uses
  leave takes leave, accrual and attendance with it, in one click, and the only clue afterwards is
  three navigation rows that are gone.
-->
<Dialog
  open={Boolean(confirming)}
  size="sm"
  title={asked ? t('capability_off_title', { name: asked.name }) : ''}
  description={t('capability_off_body')}
  onOpenChange={(open) => {
    if (!open) cancelOff()
  }}
>
  {#if asked?.losing.length}
    <p class="also">{t('capability_off_also', { names: listOf(asked.losing) })}</p>
  {/if}
  {#if writeError}
    <p class="failed" role="alert">{writeError}</p>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={cancelOff} disabled={busy}>{t('cancel')}</Button>
    <Button variant="danger" loading={busy} onclick={confirmOff}>{t('capability_off_confirm')}</Button>
  {/snippet}
</Dialog>

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
.readonly {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--kern-ink-500);
}
.stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-block-end: 8px;
  padding: 8px 12px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-md);
  font-size: 12.5px;
  /* 5.23:1 on --kern-surface in light, 6.80:1 in dark — small text, so it has to clear 4.5. */
  color: var(--kern-warning);
}
.also {
  margin: 0 0 8px;
  font-size: 13.5px;
  font-weight: 500;
}
.failed {
  margin: 0;
  font-size: 13px;
  /* 6.33:1 on the dialog surface in light, 5.04:1 in dark. */
  color: var(--kern-danger);
}
</style>
