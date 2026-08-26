<script lang="ts">
import {
  Button,
  coreApi,
  Dialog,
  EmptyState,
  Field,
  Icon,
  Input,
  keys,
  messageLocale,
  navigation,
  Select,
  type SelectOption,
  SettingsPage,
  SettingsSection,
  Skeleton,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { HrSettings } from '../../contract/settings.js'
import type { CoreApi } from '../core-api.js'
import { t } from '../i18n.js'

/**
 * The two workspace-wide facts HR keeps: where it was set up, and how employee numbers are issued.
 *
 * Settings live in core, not in this module's own schema, so they are read from
 * `workspaces.modules.list` and written with `workspaces.modules.updateSettings` — the same
 * mechanism the capabilities screen uses, and the reason the module never needs a settings table.
 *
 * **The write carries the whole `HrSettings` object.** Core merges a partial write now, but this
 * page owns every field in that schema and sending it whole is what makes the round trip
 * self-evident: nothing here can be a field somebody forgot to carry forward.
 *
 * `directoryVisibleToMembers` is in the schema and is deliberately *not* on this page. Nothing in
 * `src/server` reads it, so a switch for it would promise a rule the API does not enforce. It is
 * carried through the write unchanged until it is either enforced or removed.
 */
const api = coreApi<CoreApi>()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/** The permission core actually enforces on `workspaces.modules.updateSettings`. */
const canManage = $derived(session.can('core.modules.manage'))

const modulesQuery = createQuery(() => ({
  queryKey: keys.modules(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.workspaces.modules.list({ workspaceId }),
}))

const hr = $derived(modulesQuery.data?.find((entry) => entry.manifest.id === 'hr'))

/**
 * What is stored, with the schema's defaults applied and `$capabilities` stripped by the parse.
 *
 * `safeParse` rather than `parse`: a settings blob written before a field existed must not take the
 * page down, and every field has a default, so the fallback is the same shape a new workspace has.
 */
const stored = $derived.by(() => {
  const parsed = HrSettings.safeParse(hr?.state.settings ?? {})
  return parsed.success ? parsed.data : HrSettings.parse({})
})

let country = $state('')
let prefix = $state('')
/**
 * The counter is held as text, not a number: an input somebody is half-way through clearing is
 * empty, and `bind:value` on a number input turns that into `undefined` — which reads as "no
 * change" and would save the old value behind their back.
 */
let nextNumber = $state('')
let loaded = $state(false)

$effect(() => {
  if (loaded || !hr) return
  country = stored.country
  prefix = stored.employeeNumberPrefix
  nextNumber = String(stored.employeeNumberNext)
  loaded = true
})

/** Discard and re-seed are the same act: drop the edits and let the effect above refill them. */
function discard() {
  loaded = false
}

const prefixError = $derived(prefix.length > 8 ? t('general_prefix_too_long') : null)

/**
 * A Persian keyboard produces ۱۲۳ and an Arabic one ١٢٣, and `Number` reads neither — so a person
 * typing the digits of their own language into a counter would be told their input is not a whole
 * number. They are folded to ASCII before parsing; the field keeps what was actually typed.
 */
const toLatinDigits = (value: string) =>
  value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))

/** Nine digits at most, so `Number` cannot silently round a pasted counter into a different one. */
const nextDigits = $derived(toLatinDigits(nextNumber.trim()))
const parsedNext = $derived(/^\d{1,9}$/.test(nextDigits) ? Number(nextDigits) : Number.NaN)
const nextError = $derived(parsedNext >= 1 ? null : t('general_next_invalid'))
const valid = $derived(!prefixError && !nextError)

const dirty = $derived(
  loaded &&
    (country !== stored.country ||
      prefix !== stored.employeeNumberPrefix ||
      parsedNext !== stored.employeeNumberNext),
)

/**
 * No prefix and a counter of 1 is how the server spells "off" — `nextEmployeeNo` returns null and
 * the person is created without a number. It is a real state, not an empty form, so the page says
 * so rather than previewing a number nobody will be given.
 */
const numberingOff = $derived(prefix === '' && parsedNext === 1)
const preview = $derived(numberingOff || Number.isNaN(parsedNext) ? null : `${prefix}${parsedNext}`)

/** Moving the counter backwards re-issues numbers that may already belong to somebody. */
const rewinding = $derived(!Number.isNaN(parsedNext) && parsedNext < stored.employeeNumberNext)

let saving = $state(false)
let saveError = $state<string | null>(null)
let confirmRewind = $state(false)

const save = createMutation(() => ({
  mutationFn: () =>
    api.workspaces.modules.updateSettings({
      workspaceId,
      moduleId: 'hr',
      settings: {
        country,
        employeeNumberPrefix: prefix,
        employeeNumberNext: parsedNext,
        // Not editable here, and carried through rather than dropped: omitting it would leave the
        // stored value to core's merge, which is a fact about core rather than about this page.
        directoryVisibleToMembers: stored.directoryVisibleToMembers,
      },
    }),
  onSuccess: () => {
    confirmRewind = false
    saveError = null
    // Re-seed from whatever the server stored: the counter moves on its own every time somebody is
    // hired, so what came back is the truth and what is in the form is only what was sent.
    loaded = false
    void queryClient.invalidateQueries({ queryKey: keys.modules(workspaceId) })
    toast.success(t('general_saved'))
  },
  onError: (err) => {
    saveError = err instanceof Error && err.message ? err.message : t('general_save_error')
  },
  onSettled: () => {
    saving = false
  },
}))

/**
 * `disabled={save.isPending}` reaches the button a render too late, and two quick clicks are one
 * render apart — so the guard is a plain flag set in the same tick as the click.
 */
function runSave() {
  if (saving) return
  saving = true
  saveError = null
  save.mutate()
}

function requestSave() {
  if (saving || !dirty || !valid) return
  if (rewinding) {
    confirmRewind = true
    return
  }
  runSave()
}

/**
 * Every country the runtime can name, in the reader's own language.
 *
 * The same technique the offices screen uses, and deliberately the same: there is no
 * `Intl.supportedValuesOf('region')`, so the set comes from asking `DisplayNames` about all 676
 * two-letter codes and keeping the ones it answers with a name. Two country lists in one module
 * would eventually disagree with each other, and a table of codes in this file goes stale the next
 * time a country changes its name.
 */
const COUNTRY_CACHE = new Map<string, SelectOption[]>()
/** Codes `DisplayNames` names that ISO 3166-1 does not: unions, outlying areas, reserved codes. */
const NOT_COUNTRIES = new Set(['AC', 'CP', 'DG', 'EA', 'EU', 'EZ', 'IC', 'QO', 'TA', 'UN', 'XA', 'XB', 'ZZ'])

function countryOptions(locale: string): SelectOption[] {
  const cached = COUNTRY_CACHE.get(locale)
  if (cached) return cached
  const options: SelectOption[] = []
  try {
    const names = new Intl.DisplayNames(locale, { type: 'region' })
    for (let first = 65; first <= 90; first++) {
      for (let second = 65; second <= 90; second++) {
        const code = String.fromCharCode(first, second)
        if (NOT_COUNTRIES.has(code)) continue
        const label = names.of(code)
        if (!label || label === code) continue
        options.push({ value: code, label })
      }
    }
    options.sort((a, b) => a.label.localeCompare(b.label, locale))
  } catch {
    // A runtime without region display names must not take the form down with it; the stored code
    // is still a valid answer, and the branch below keeps it selectable.
  }
  COUNTRY_CACHE.set(locale, options)
  return options
}

const countries = $derived.by((): SelectOption[] => {
  const list = countryOptions(messageLocale())
  // A stored country the runtime cannot name has to stay selectable, or opening this page and
  // saving anything else would quietly change it to whatever happened to be first.
  if (country && !list.some((o) => o.value === country)) return [{ value: country, label: country }, ...list]
  return list
})
</script>

{#snippet saveBar()}
  <Button size="sm" variant="secondary" onclick={discard} disabled={!dirty || saving}>
    {t('common.discard')}
  </Button>
  <Button size="sm" onclick={requestSave} disabled={!dirty || !valid} loading={saving}>
    {t('common.save')}
  </Button>
{/snippet}

<SettingsPage title={t('settings_general')} description={t('settings_general_desc')}>
  {#if modulesQuery.isLoading}
    <Skeleton height="150px" radius="10px" />
    <Skeleton height="260px" radius="10px" />
  {:else if modulesQuery.isError}
    <EmptyState icon="triangle-alert" title={t('general_error')} description={t('general_error_desc')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void modulesQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if !hr}
    <EmptyState icon="users" title={t('general_not_enabled')} description={t('general_not_enabled_desc')} />
  {:else}
    {#if !canManage}
      <p class="readonly">{t('general_readonly')}</p>
    {/if}

    <SettingsSection
      title={t('office_country')}
      description={t('general_country_desc')}
      footer={canManage ? saveBar : undefined}
    >
      <Field inline label={t('office_country')} hint={t('general_country_hint')}>
        {#snippet children(id)}
          <Select
            {id}
            bind:value={country}
            options={countries}
            placeholder={t('office_country')}
            disabled={!canManage}
            width="280px"
          />
        {/snippet}
      </Field>
    </SettingsSection>

    <SettingsSection
      title={t('general_numbering')}
      description={t('general_numbering_desc')}
      footer={canManage ? saveBar : undefined}
    >
      <div class="rows">
        <Field inline label={t('general_prefix')} hint={t('general_prefix_hint')} error={prefixError}>
          {#snippet children(id)}
            <div class="narrow">
              <Input {id} bind:value={prefix} maxlength={8} mono disabled={!canManage} />
            </div>
          {/snippet}
        </Field>

        <Field inline label={t('general_next')} hint={t('general_next_hint')} error={nextError}>
          {#snippet children(id)}
            <div class="narrow">
              <Input
                {id}
                bind:value={nextNumber}
                inputmode="numeric"
                maxlength={9}
                mono
                disabled={!canManage}
              />
            </div>
          {/snippet}
        </Field>

        <div class="preview">
          <span class="preview-label">{t('general_preview')}</span>
          <!--
            The number is interpolated as text on purpose. It is an identifier the server builds by
            concatenation, so a Persian reader has to see the same characters their colleague's
            badge carries — this is the one place on the page where localised digits would be wrong.
          -->
          <span class="preview-value">{preview ?? '—'}</span>
        </div>

        {#if numberingOff}
          <p class="note">{t('general_numbering_off')}</p>
        {/if}
        {#if rewinding}
          <p class="note warn">
            <Icon name="triangle-alert" size={14} strokeWidth={1.7} />
            <span>{t('general_rewind_warning', { value: String(parsedNext) })}</span>
          </p>
        {/if}
      </div>
    </SettingsSection>

    {#if saveError}
      <p class="save-error" role="alert">{saveError}</p>
    {/if}
  {/if}
</SettingsPage>

<Dialog
  open={confirmRewind}
  size="sm"
  title={t('general_rewind_title')}
  onOpenChange={(open) => {
    if (!open) confirmRewind = false
  }}
>
  <p class="dialog-body">{t('general_rewind_body', { value: String(parsedNext) })}</p>
  {#snippet footer()}
    <Button size="sm" variant="secondary" onclick={() => (confirmRewind = false)} disabled={saving}>
      {t('common.cancel')}
    </Button>
    <Button size="sm" variant="danger" onclick={runSave} loading={saving}>
      {t('general_rewind_confirm')}
    </Button>
  {/snippet}
</Dialog>

<style>
.readonly {
  margin: 0;
  font-size: 12.5px;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-500);
}
.rows {
  display: grid;
  gap: 14px;
}
.narrow {
  max-inline-size: 180px;
}
.preview {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-chip);
}
.preview-label {
  font-size: 12.5px;
  color: var(--kern-ink-500);
}
.preview-value {
  font-family: var(--kern-font-mono);
  font-size: 14px;
  font-weight: 500;
  color: var(--kern-ink-900);
  /* An employee number is read digit by digit, so the glyphs line up rather than reflow. */
  font-variant-numeric: tabular-nums;
  /* The identifier stays left-to-right inside a Persian or Arabic sentence. */
  direction: ltr;
  unicode-bidi: isolate;
}
.note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--kern-ink-500);
}
.note.warn {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--kern-r-md);
  /* Measured: #925e22 on #f7e9d8 is 4.58:1, #d59548 on #3a2c1c is 5.28:1. */
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
}
/* The icon comes from a component, so the scoped selector cannot reach its svg without this. */
.note.warn :global(svg) {
  flex: none;
  margin-block-start: 1px;
}
.save-error {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}
.dialog-body {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kern-ink-700);
}
</style>
