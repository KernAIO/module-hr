<script lang="ts">
import { Checkbox, Field, Input, Select } from '@kernhq/ui'
import { t } from '../i18n.js'
import type { CustomFieldDef } from '../index.js'
import { bySection, type CustomValues, FIELD_SECTIONS, fromControl, toControl } from './custom-fields.js'

/**
 * One control per custom field, grouped the way the definitions are.
 *
 * Shared by the hire dialog, the person editor and the sensitive-details editor, which each hand
 * in the definitions they are allowed to write: the non-sensitive ones on the first two, the
 * sensitive ones on the third. The component draws what it is given and knows nothing about who
 * may see what — that decision belongs to the screen holding the permission.
 *
 * `values` is the parent's map and is edited in place, typed per field on the way in
 * (`fromControl`), so what reaches the server is a number for a number field and a list for a
 * multi-select rather than whatever the input element held.
 */
interface Props {
  defs: CustomFieldDef[]
  values: CustomValues
  /** Keeps two forms on one page from sharing an element id. */
  idPrefix: string
  /** Section headings are noise when every field on the form is in one section. */
  headings?: boolean
}

let { defs, values = $bindable(), idPrefix, headings = true }: Props = $props()

const grouped = $derived(bySection(defs))
const sections = $derived(FIELD_SECTIONS.filter((section) => grouped[section].length > 0))
const showHeadings = $derived(headings && sections.length > 1)

const sectionLabel = (section: CustomFieldDef['section']): string =>
  section === 'profile'
    ? t('field_section_profile')
    : section === 'employment'
      ? t('field_section_employment')
      : t('field_section_other')

const text = (def: CustomFieldDef): string => {
  const v = toControl(def, values[def.key])
  return typeof v === 'string' ? v : ''
}
const list = (def: CustomFieldDef): string[] => {
  const v = toControl(def, values[def.key])
  return Array.isArray(v) ? v : []
}
const flag = (def: CustomFieldDef): boolean => toControl(def, values[def.key]) === true

const set = (def: CustomFieldDef, raw: string | string[] | boolean) => {
  values[def.key] = fromControl(def, raw)
}

const toggleOption = (def: CustomFieldDef, option: string, on: boolean) => {
  const current = list(def)
  const next = on ? [...current.filter((v) => v !== option), option] : current.filter((v) => v !== option)
  // Keep the order the definition lists them in, so two people who ticked the same boxes store
  // the same list.
  const order = (def.options ?? []).map((o) => o.value)
  set(
    def,
    next.sort((a, b) => order.indexOf(a) - order.indexOf(b)),
  )
}

const selectOptions = (def: CustomFieldDef) =>
  (def.options ?? []).map((o) => ({ value: o.value, label: o.label }))
</script>

{#each sections as section (section)}
  <div class="group">
    {#if showHeadings}
      <h3 class="heading">{sectionLabel(section)}</h3>
    {/if}
    {#each grouped[section] as def (def.id)}
      {@const id = `${idPrefix}-${def.key}`}
      {#if def.type === 'boolean'}
        <!-- A checkbox is its own label; wrapping it in a Field would name it twice. -->
        <Checkbox {id} checked={flag(def)} label={def.name} onCheckedChange={(on) => set(def, on)} />
      {:else if def.type === 'multi_select'}
        <fieldset class="multi">
          <legend class="legend">
            {def.name}{#if def.required}<span class="req" aria-hidden="true">*</span>{/if}
          </legend>
          {#if (def.options ?? []).length === 0}
            <p class="none">{t('field_no_options')}</p>
          {:else}
            <div class="boxes">
              {#each def.options ?? [] as option (option.value)}
                <Checkbox
                  id={`${id}-${option.value}`}
                  checked={list(def).includes(option.value)}
                  label={option.label}
                  onCheckedChange={(on) => toggleOption(def, option.value, on)}
                />
              {/each}
            </div>
          {/if}
        </fieldset>
      {:else}
        <Field label={def.name} {id} required={def.required} hint={def.required ? undefined : t('common.optional')}>
          {#snippet children(fieldId)}
            {#if def.type === 'select'}
              <Select
                id={fieldId}
                value={text(def)}
                options={selectOptions(def)}
                placeholder={t('field_pick_one')}
                allowDeselect={!def.required}
                ariaLabel={def.name}
                onValueChange={(next) => set(def, next)}
              />
            {:else if def.type === 'number'}
              <Input
                id={fieldId}
                type="number"
                step="any"
                inputmode="decimal"
                value={text(def)}
                oninput={(e) => set(def, e.currentTarget.value)}
              />
            {:else if def.type === 'date'}
              <Input id={fieldId} type="date" value={text(def)} oninput={(e) => set(def, e.currentTarget.value)} />
            {:else if def.type === 'url'}
              <!-- An address reads left to right whatever the interface direction. -->
              <Input
                id={fieldId}
                type="url"
                dir="ltr"
                inputmode="url"
                placeholder="https://"
                value={text(def)}
                oninput={(e) => set(def, e.currentTarget.value)}
              />
            {:else}
              <Input id={fieldId} value={text(def)} oninput={(e) => set(def, e.currentTarget.value)} />
            {/if}
          {/snippet}
        </Field>
      {/if}
    {/each}
  </div>
{/each}

<style>
.group {
  display: grid;
  gap: 14px;
}
.heading {
  margin: 4px 0 -4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.multi {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.legend {
  padding: 0;
  margin-block-end: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--kern-ink-600);
}
.req {
  margin-inline-start: 3px;
  color: var(--kern-danger);
}
.boxes {
  display: grid;
  gap: 8px;
}
/* A colour, not opacity: opacity fades text against the dialog whatever token it names. */
.none {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-500);
}
</style>
