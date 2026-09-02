import { describe, expect, it } from 'vitest'
import type { CustomFieldDef } from '../index.js'
import {
  bySection,
  formatValue,
  fromControl,
  missingRequired,
  parseOptions,
  sameCustom,
  slugifyKey,
  toControl,
} from './custom-fields.js'

/**
 * The rules every person screen applies to `people.custom`, which the server does not: it stores
 * the map it is sent. So a wrong type, a missing required value or a select holding a value that
 * is not one of its options would each ship silently without these.
 */
const def = (over: Partial<CustomFieldDef>): CustomFieldDef => ({
  id: over.key ?? 'f',
  workspaceId: 'ws' as CustomFieldDef['workspaceId'],
  key: 'f',
  name: 'Field',
  type: 'text',
  options: null,
  required: false,
  sensitive: false,
  section: 'profile',
  order: 0,
  archivedAt: null,
  ...over,
})

const ctx = { locale: 'en', yes: 'Yes', no: 'No', date: (iso: string) => `date:${iso}` }

describe('parseOptions', () => {
  it('reads value | label per line, and a bare line as both', () => {
    expect(parseOptions('s | Small\nm|Medium\nxl')).toEqual([
      { value: 's', label: 'Small' },
      { value: 'm', label: 'Medium' },
      { value: 'xl', label: 'xl' },
    ])
  })

  it('drops blank lines and a repeated value', () => {
    expect(parseOptions('\na | A\n\na | Again\n')).toEqual([{ value: 'a', label: 'A' }])
  })
})

describe('slugifyKey', () => {
  it('turns a name into a key the contract accepts', () => {
    expect(slugifyKey('T-shirt size')).toBe('t_shirt_size')
    expect(slugifyKey('  Desk #2 ')).toBe('desk_2')
  })
})

describe('controls', () => {
  it('stores a number as a number and an empty one as null', () => {
    const n = def({ type: 'number' })
    expect(fromControl(n, '12.5')).toBe(12.5)
    expect(fromControl(n, '')).toBeNull()
    expect(fromControl(n, 'twelve')).toBeNull()
    expect(toControl(n, 12.5)).toBe('12.5')
    expect(toControl(n, '12')).toBe('')
  })

  it('stores a boolean as a boolean and a multi-select as a list', () => {
    expect(fromControl(def({ type: 'boolean' }), true)).toBe(true)
    expect(fromControl(def({ type: 'multi_select' }), ['a', 'b'])).toEqual(['a', 'b'])
    expect(toControl(def({ type: 'multi_select' }), ['a', 3])).toEqual(['a'])
  })

  it('trims text and stores nothing rather than an empty string', () => {
    expect(fromControl(def({ type: 'text' }), '  hi ')).toBe('hi')
    expect(fromControl(def({ type: 'text' }), '   ')).toBeNull()
  })
})

describe('missingRequired', () => {
  it('names the required fields with nothing in them', () => {
    const defs = [
      def({ key: 'a', required: true }),
      def({ key: 'b', required: true, type: 'multi_select' }),
      def({ key: 'c', required: false }),
    ]
    expect(missingRequired(defs, { a: 'x', b: [] }).map((d) => d.key)).toEqual(['b'])
    expect(missingRequired(defs, { a: ' ', b: ['x'] }).map((d) => d.key)).toEqual(['a'])
  })
})

describe('formatValue', () => {
  it('shows an option by its label, and a removed option by its value', () => {
    const s = def({ type: 'select', options: [{ value: 'm', label: 'Medium' }] })
    expect(formatValue(s, 'm', ctx)).toBe('Medium')
    expect(formatValue(s, 'gone', ctx)).toBe('gone')
  })

  it('joins a multi-select in the reader’s language', () => {
    const m = def({
      type: 'multi_select',
      options: [
        { value: 'a', label: 'Arabic' },
        { value: 'b', label: 'Bengali' },
      ],
    })
    expect(formatValue(m, ['a', 'b'], ctx)).toBe('Arabic and Bengali')
  })

  it('says yes or no for a boolean, and nothing for one never set', () => {
    const b = def({ type: 'boolean' })
    expect(formatValue(b, true, ctx)).toBe('Yes')
    expect(formatValue(b, false, ctx)).toBe('No')
    expect(formatValue(b, undefined, ctx)).toBeNull()
  })

  it('hands a date to the formatter and a number to Intl', () => {
    expect(formatValue(def({ type: 'date' }), '2026-03-01', ctx)).toBe('date:2026-03-01')
    expect(formatValue(def({ type: 'number' }), 1234.5, ctx)).toBe('1,234.5')
  })
})

describe('bySection and sameCustom', () => {
  it('groups by section, ordered by order then name', () => {
    const grouped = bySection([
      def({ key: 'z', section: 'other', order: 1 }),
      def({ key: 'b', name: 'B', section: 'profile', order: 0 }),
      def({ key: 'a', name: 'A', section: 'profile', order: 0 }),
    ])
    expect(grouped.profile.map((d) => d.key)).toEqual(['a', 'b'])
    expect(grouped.employment).toEqual([])
    expect(grouped.other.map((d) => d.key)).toEqual(['z'])
  })

  it('treats an absent key and a blank value as the same thing', () => {
    expect(sameCustom({ a: 'x' }, { a: 'x', b: null })).toBe(true)
    expect(sameCustom({ a: 'x' }, { a: 'y' })).toBe(false)
    expect(sameCustom({ a: [1] }, { a: [1] })).toBe(true)
  })
})
