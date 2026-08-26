import { describe, expect, it } from 'vitest'
import { ar, de, en, fa, hrMessageBundles, tr } from './messages.js'

/**
 * The bundles, structurally — and the counted messages, behaviourally.
 *
 * Nothing else looks at these. A key present in English and missing in Persian type-checks, builds,
 * lints and ships, and the first person to see it is the one reading `hr.leave_none` on a screen.
 */
const BUNDLES = { en, ar, de, fa, tr } as const
type Locale = keyof typeof BUNDLES

const placeholders = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))
const forms = (v: unknown): string[] => (typeof v === 'string' ? [v] : Object.values(v as object))

describe('bundles', () => {
  it('declares every locale the module claims to ship', () => {
    expect(Object.keys(hrMessageBundles).sort()).toEqual(['ar', 'de', 'en', 'fa', 'tr'])
  })

  it('has the same key set in every locale', () => {
    const keys = Object.keys(en).sort()
    for (const [locale, bundle] of Object.entries(BUNDLES)) {
      expect({ locale, keys: Object.keys(bundle).sort() }).toEqual({ locale, keys })
    }
  })

  it('namespaces every key, so two modules cannot collide in the merged map', () => {
    for (const key of Object.keys(en)) expect(key.startsWith('hr.')).toBe(true)
  })

  /**
   * A plural form may drop `{count}` — "يوم واحد" and "one day" both read better without the
   * numeral — but dropping any *other* placeholder loses information. The Arabic `one` form of the
   * approval summary that forgot `{range}` would render "one day," and nothing else.
   */
  it('keeps every non-count placeholder in every plural form', () => {
    for (const [key, value] of Object.entries(en)) {
      const expected = placeholders(forms(value).join(' '))
      expected.delete('count')
      for (const [locale, bundle] of Object.entries(BUNDLES)) {
        for (const form of forms(bundle[key as keyof typeof bundle])) {
          const got = placeholders(form)
          got.delete('count')
          expect({ key, locale, form, got: [...got].sort() }).toEqual({
            key,
            locale,
            form,
            got: [...expected].sort(),
          })
        }
      }
    }
  })

  it('never invents a placeholder the English string does not have', () => {
    for (const [key, value] of Object.entries(en)) {
      const allowed = placeholders(forms(value).join(' '))
      for (const [locale, bundle] of Object.entries(BUNDLES))
        for (const form of forms(bundle[key as keyof typeof bundle]))
          for (const name of placeholders(form))
            expect({ key, locale, name, known: allowed.has(name) }).toEqual({
              key,
              locale,
              name,
              known: true,
            })
    }
  })

  /** Arabic inflects six ways. A bundle with only one/other picks `other` for two, and reads wrong. */
  it('gives every Arabic plural all six CLDR categories', () => {
    const wanted = new Intl.PluralRules('ar').resolvedOptions().pluralCategories.sort()
    for (const [key, value] of Object.entries(ar)) {
      if (typeof value === 'string') continue
      expect({ key, cats: Object.keys(value).sort() }).toEqual({ key, cats: wanted })
    }
  })

  it('makes a plural of a key wherever English has one', () => {
    for (const [key, value] of Object.entries(en)) {
      if (typeof value === 'string') continue
      for (const [locale, bundle] of Object.entries(BUNDLES))
        expect({ key, locale, plural: typeof bundle[key as keyof typeof bundle] }).toEqual({
          key,
          locale,
          plural: 'object',
        })
    }
  })
})

/**
 * The counted messages, resolved the way the runtime resolves them.
 *
 * `t()` lives in `@kernhq/ui`, whose entry point pulls in Svelte components this package's test
 * setup cannot transform — and adding a compiler plugin here to reach one function is a dependency
 * and a lockfile refresh for very little. So these drive the *data* through the same
 * `Intl.PluralRules` selection `selectPlural` performs, and `t()` itself is tested where it lives
 * (`packages/ui/src/lib/i18n.test.ts`), which is the honest split.
 */
describe('counted messages', () => {
  const pick = (locale: Locale, key: string, count: number): string => {
    const value = BUNDLES[locale][key as keyof (typeof BUNDLES)[Locale]] as
      | string
      | Partial<Record<Intl.LDMLPluralRule, string>>
    if (typeof value === 'string') return value
    const category = new Intl.PluralRules(locale).select(count)
    const form = value[category] ?? value.other
    if (form === undefined) throw new Error(`${locale} ${key} has no form for ${count}`)
    return form.replace(/\{count\}/g, new Intl.NumberFormat(locale).format(count))
  }

  /**
   * The bug this describe block exists for: the approvals inbox read "1 days, Aug 6, 2026".
   * The message was a flat string with a `{days}` placeholder, so nothing could select a form, and
   * the count arrived pre-formatted as text so the digits stayed Latin on a Persian screen too.
   */
  it('says "1 day" and "2 days" in English', () => {
    expect(pick('en', 'hr.days', 1)).toBe('day')
    expect(pick('en', 'hr.days', 2)).toBe('days')
    expect(pick('en', 'hr.leave_would_cost', 1)).toBe('1 working day')
    expect(pick('en', 'hr.leave_would_cost', 3)).toBe('3 working days')
  })

  it('says "1 Tag" and "2 Tage" in German', () => {
    expect(pick('de', 'hr.days', 1)).toBe('Tag')
    expect(pick('de', 'hr.days', 2)).toBe('Tage')
  })

  it('follows Arabic numeral agreement rather than one-or-many', () => {
    // Singular, dual, 3-10 and 11-99 each take a different form in Modern Standard Arabic.
    expect(pick('ar', 'hr.days', 1)).toBe('يوم')
    expect(pick('ar', 'hr.days', 2)).toBe('يومان')
    expect(pick('ar', 'hr.days', 5)).toBe('أيام')
    expect(pick('ar', 'hr.days', 11)).toBe('يومًا')
  })

  it('does not inflect the noun after a numeral in Turkish or Persian', () => {
    // "5 gün", not "5 günler" — the plural suffix is wrong once a number is present.
    expect(pick('tr', 'hr.days', 1)).toBe(pick('tr', 'hr.days', 5))
    expect(pick('fa', 'hr.days', 1)).toBe(pick('fa', 'hr.days', 5))
  })

  it('formats the number in the reader\u2019s own digits', () => {
    expect(pick('fa', 'hr.leave_would_cost', 5)).toContain('۵')
    expect(pick('en', 'hr.leave_would_cost', 5)).toContain('5')
  })

  it('keeps the date range when the singular form drops the numeral', () => {
    expect(pick('ar', 'hr.approval_summary_leave', 1)).toContain('{range}')
    expect(pick('en', 'hr.approval_summary_leave', 1)).toBe('1 day, {range}')
  })
})
