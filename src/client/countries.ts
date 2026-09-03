/**
 * The countries and the currencies a form may offer, in the reader's own language.
 *
 * Pure on purpose — no `@kernhq/ui` import — so `countries.test.ts` can load it without a Svelte
 * compiler, the same split `query.ts` keeps. The returned shape is `SelectOption`'s two required
 * fields, which is what lets a `<Select options={…}>` take it without this module importing the
 * design system to name the type.
 *
 * Both lists come from the runtime's own CLDR data rather than a table in this file, for the same
 * reason: a table goes stale the next time a country is renamed or a currency is redenominated, and
 * nothing would notice. Both are cached per locale, because building either costs a few hundred
 * `DisplayNames` lookups and every dialog on a settings page asks again.
 */

/** `SelectOption`'s two required fields, named here so this module imports nothing. */
export interface NamedCode {
  value: string
  label: string
}

/** Codes `DisplayNames` names that ISO 3166-1 does not: unions, outlying areas, reserved codes. */
export const NOT_COUNTRIES = new Set([
  'AC',
  'CP',
  'DG',
  'EA',
  'EU',
  'EZ',
  'IC',
  'QO',
  'TA',
  'UN',
  'XA',
  'XB',
  'ZZ',
])

const COUNTRY_CACHE = new Map<string, NamedCode[]>()
const CURRENCY_CACHE = new Map<string, NamedCode[]>()

/**
 * Every country the runtime can name.
 *
 * There is no `Intl.supportedValuesOf('region')`, so the set is found by asking `DisplayNames`
 * about all 676 two-letter codes and keeping the ones it answers with a name rather than handing
 * the code back. That costs a fraction of a millisecond once per locale.
 *
 * A runtime without region display names answers with an empty list rather than throwing: the code
 * a record already holds is still a valid answer, and a form that cannot offer a country must not
 * take the dialog down with it.
 */
export function countryOptions(locale: string): NamedCode[] {
  const cached = COUNTRY_CACHE.get(locale)
  if (cached) return cached
  const options: NamedCode[] = []
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
    // see the note above: an empty list, never a thrown dialog
  }
  COUNTRY_CACHE.set(locale, options)
  return options
}

/**
 * Every ISO 4217 currency the runtime knows, labelled `TRY — Turkish Lira`.
 *
 * The code leads because it is what is stored and what a payroll file carries, and it is what
 * somebody looking for one types; the name follows so a reader who does not know the code can still
 * find theirs. Unlike regions there *is* a supported-values list, so the codes are asked for rather
 * than enumerated.
 */
export function currencyOptions(locale: string): NamedCode[] {
  const cached = CURRENCY_CACHE.get(locale)
  if (cached) return cached
  const options: NamedCode[] = []
  try {
    const names = new Intl.DisplayNames(locale, { type: 'currency' })
    for (const code of Intl.supportedValuesOf('currency')) {
      const label = names.of(code)
      options.push({ value: code, label: label && label !== code ? `${code} — ${label}` : code })
    }
    options.sort((a, b) => a.value.localeCompare(b.value))
  } catch {
    // as above
  }
  CURRENCY_CACHE.set(locale, options)
  return options
}

/**
 * `options` with `code` forced in, so a record's own value survives a runtime that cannot name it.
 *
 * A country or a currency the runtime has never heard of — an old code, a trimmed ICU build — would
 * otherwise be missing from the list, the `<Select>` would render empty, and saving the form would
 * quietly rewrite the field to something else. This is the same guard the office timezone picker
 * makes for a retired IANA zone.
 */
export function withCode(options: NamedCode[], code: string): NamedCode[] {
  if (!code || options.some((option) => option.value === code)) return options
  return [{ value: code, label: code }, ...options]
}
