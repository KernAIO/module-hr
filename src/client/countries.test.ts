import { describe, expect, it } from 'vitest'
import { countryOptions, currencyOptions, NOT_COUNTRIES, withCode } from './countries.js'

/**
 * The two lists the legal-entity and office forms are built from.
 *
 * Both are derived from the runtime's CLDR data rather than a table, which makes them checkable
 * facts rather than opinions — and one of them is only right by omission: `Intl.DisplayNames` names
 * a dozen codes ISO 3166-1 does not, so a picker built from it offers the European Union as a
 * country to register a company in. Nothing else in this package looks at that.
 */
describe('countryOptions', () => {
  const en = countryOptions('en')

  it('names the countries a form has to be able to offer', () => {
    expect(en.find((c) => c.value === 'TR')?.label).toBe('Türkiye')
    expect(en.find((c) => c.value === 'NL')?.label).toBe('Netherlands')
    // Enough of them that a trimmed ICU build cannot pass this by answering with a handful.
    expect(en.length).toBeGreaterThan(200)
  })

  it('leaves out the codes that are not countries', () => {
    for (const code of NOT_COUNTRIES) expect(en.some((c) => c.value === code)).toBe(false)
  })

  it('never hands back a bare code as a label', () => {
    for (const option of en) expect(option.label).not.toBe(option.value)
  })

  it('sorts by the name in the reader’s own language, not by the code', () => {
    const de = countryOptions('de')
    expect(de.map((c) => c.label)).toEqual(
      [...de.map((c) => c.label)].sort((a, b) => a.localeCompare(b, 'de')),
    )
    // "Germany" and "Deutschland" sort to different places, so the two locales cannot be one list.
    expect(de.findIndex((c) => c.value === 'DE')).not.toBe(en.findIndex((c) => c.value === 'DE'))
  })

  it('caches per locale, because every dialog on the page asks again', () => {
    expect(countryOptions('en')).toBe(en)
    expect(countryOptions('fa')).not.toBe(en)
  })
})

describe('currencyOptions', () => {
  const en = currencyOptions('en')

  it('leads with the code, which is what is stored and what somebody types', () => {
    expect(en.find((c) => c.value === 'TRY')?.label).toBe('TRY — Turkish Lira')
    expect(en.find((c) => c.value === 'EUR')?.label).toBe('EUR — Euro')
  })

  it('offers every code the contract would accept, in code order', () => {
    expect(en.length).toBeGreaterThan(100)
    for (const option of en) expect(option.value).toMatch(/^[A-Z]{3}$/)
    expect(en.map((c) => c.value)).toEqual([...en.map((c) => c.value)].sort())
  })
})

/**
 * The guard that keeps a save from rewriting a field nobody edited: a code the runtime cannot name
 * is missing from the list, so the `<Select>` renders empty and submitting the form silently moves
 * the record to whatever is picked instead.
 */
describe('withCode', () => {
  const options = [
    { value: 'NL', label: 'Netherlands' },
    { value: 'TR', label: 'Türkiye' },
  ]

  it('forces in a code the list does not have, labelled as itself', () => {
    expect(withCode(options, 'AN')[0]).toEqual({ value: 'AN', label: 'AN' })
  })

  it('leaves the list alone when the code is already there, or when there is none', () => {
    expect(withCode(options, 'TR')).toBe(options)
    expect(withCode(options, '')).toBe(options)
  })
})
