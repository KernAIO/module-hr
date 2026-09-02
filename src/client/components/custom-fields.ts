import type { CustomFieldDef } from '../index.js'

/**
 * What every screen that reads or writes `people.custom` has to agree on.
 *
 * The server stores `custom` as an untyped map and `people.update` *replaces* it — it validates
 * nothing against the definitions, so the type of a value, whether a required one is present and
 * what a select may hold are decided here, on the way in, and nowhere else. A `.ts` module rather
 * than a component so the rules can be tested without a Svelte compiler.
 */

export type FieldSection = CustomFieldDef['section']
export type FieldType = CustomFieldDef['type']
export type CustomValues = Record<string, unknown>

/** In the order a form and a panel show them. */
export const FIELD_SECTIONS: readonly FieldSection[] = ['profile', 'employment', 'other']

export const FIELD_TYPES: readonly FieldType[] = [
  'text',
  'number',
  'date',
  'select',
  'multi_select',
  'boolean',
  'url',
]

/** The contract's own rule for a key, repeated so the form can refuse before the server does. */
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]*$/
export const FIELD_KEY_MAX = 48

export const hasOptions = (type: FieldType) => type === 'select' || type === 'multi_select'

/** `T-shirt size` → `t_shirt_size`: the key is a machine name, not a sentence. */
export const slugifyKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, FIELD_KEY_MAX)

/** Live definitions first by section, then by the order an admin arranged, then by name. */
export function bySection(defs: readonly CustomFieldDef[]): Record<FieldSection, CustomFieldDef[]> {
  const out: Record<FieldSection, CustomFieldDef[]> = { profile: [], employment: [], other: [] }
  for (const def of [...defs].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)))
    out[def.section].push(def)
  return out
}

/**
 * The options editor's text: one option per line, `value | label`, and a line with no bar is both.
 *
 * Two inputs per row would be the richer editor; a textarea is the one a keyboard user can fill in
 * without leaving it, and it pastes. Blank lines and duplicate values are dropped rather than
 * refused — a select with the same value twice is a select the form cannot tell apart.
 */
export function parseOptions(text: string): { value: string; label: string }[] {
  const seen = new Set<string>()
  const out: { value: string; label: string }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const bar = line.indexOf('|')
    const value = (bar >= 0 ? line.slice(0, bar) : line).trim()
    const label = (bar >= 0 ? line.slice(bar + 1) : line).trim() || value
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push({ value, label })
  }
  return out
}

export const optionsText = (options: readonly { value: string; label: string }[] | null): string =>
  (options ?? []).map((o) => (o.label === o.value ? o.value : `${o.value} | ${o.label}`)).join('\n')

/** A value nobody entered: null, undefined, an empty string, or an empty list. */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** The required definitions with nothing in them — what stops a form from saving. */
export const missingRequired = (defs: readonly CustomFieldDef[], values: CustomValues): CustomFieldDef[] =>
  defs.filter((def) => def.required && isBlank(values[def.key]))

/**
 * What a stored value looks like as the text of a control, and back.
 *
 * Every control edits a string (or a list of strings, or a boolean) and the stored value is typed:
 * a number field must not save `"12"`, because a report that sums it would concatenate. The stored
 * shape per type is the one `formatValue` reads and the one the mock seeds.
 */
export function toControl(def: CustomFieldDef, value: unknown): string | string[] | boolean {
  switch (def.type) {
    case 'boolean':
      return value === true
    case 'multi_select':
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
    default:
      return typeof value === 'string' ? value : ''
  }
}

export function fromControl(def: CustomFieldDef, raw: string | string[] | boolean): unknown {
  switch (def.type) {
    case 'boolean':
      return raw === true
    case 'multi_select':
      return Array.isArray(raw) ? raw : []
    case 'number': {
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (text === '') return null
      const n = Number(text)
      return Number.isFinite(n) ? n : null
    }
    default: {
      const text = typeof raw === 'string' ? raw.trim() : ''
      return text === '' ? null : text
    }
  }
}

/**
 * A stored value as a sentence for a panel, or null when there is nothing to show.
 *
 * The words for yes and no and the date formatter are handed in rather than imported: `t()` and
 * `formatDate` live in `@kernhq/ui`, whose entry point this test-bare module must not reach.
 * A select shows its option's *label*, and falls back to the raw value for an option that was
 * since removed — a value somebody entered does not vanish because the list changed.
 */
export function formatValue(
  def: CustomFieldDef,
  value: unknown,
  ctx: { locale: string; yes: string; no: string; date: (iso: string) => string },
): string | null {
  if (def.type === 'boolean') return value === true ? ctx.yes : value === false ? ctx.no : null
  if (isBlank(value)) return null
  const label = (v: unknown) => def.options?.find((o) => o.value === v)?.label ?? String(v)
  switch (def.type) {
    case 'number':
      return typeof value === 'number' ? new Intl.NumberFormat(ctx.locale).format(value) : String(value)
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? ctx.date(value) : String(value)
    case 'select':
      return label(value)
    case 'multi_select':
      return Array.isArray(value)
        ? new Intl.ListFormat(ctx.locale, { style: 'long', type: 'conjunction' }).format(value.map(label))
        : String(value)
    default:
      return String(value)
  }
}

/** The values a form sends, over what the record already had — the server replaces the whole map. */
export function mergeCustom(existing: CustomValues, edited: CustomValues): CustomValues {
  return { ...existing, ...edited }
}

/** Whether the two maps differ, so an untouched form does not write a history row. */
export function sameCustom(a: CustomValues, b: CustomValues): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (isBlank(x) && isBlank(y)) continue
    if (JSON.stringify(x) !== JSON.stringify(y)) return false
  }
  return true
}
