import { describe, expect, it } from 'vitest'
import { formatDays, formatDuration, hrKeys, monthRange } from './query.js'

const words = { hours: (n: string) => `${n}h`, minutes: (n: string) => `${n}m` }

describe('hrKeys', () => {
  it('scopes a balance by person, so two people do not share a cache entry', () => {
    expect(hrKeys.leaveBalance('ws', 'alice')).not.toEqual(hrKeys.leaveBalance('ws', 'bob'))
    // No person means "me", and that must be its own entry rather than colliding with a named one.
    expect(hrKeys.leaveBalance('ws', undefined)).toEqual(['hr', 'leave-balance', 'ws', 'me'])
  })

  it('scopes attendance by range, so changing the month refetches', () => {
    expect(hrKeys.attendanceDays('ws', 'a', '2026-01-01', '2026-01-31')).not.toEqual(
      hrKeys.attendanceDays('ws', 'a', '2026-02-01', '2026-02-28'),
    )
  })

  it('starts every key with the module, so one invalidation can clear all of HR', () => {
    for (const key of [
      hrKeys.people('ws'),
      hrKeys.offices('ws'),
      hrKeys.clockState('ws'),
      hrKeys.approvalInbox('ws'),
    ])
      expect(key[0]).toBe('hr')
  })
})

describe('monthRange', () => {
  it('covers a whole 31-day month', () => {
    expect(monthRange(new Date(2026, 0, 15))).toEqual({ from: '2026-01-01', to: '2026-01-31' })
  })
  it('covers February in a leap year and a common one', () => {
    expect(monthRange(new Date(2024, 1, 10)).to).toBe('2024-02-29')
    expect(monthRange(new Date(2026, 1, 10)).to).toBe('2026-02-28')
  })
  it('covers a 30-day month', () => {
    expect(monthRange(new Date(2026, 3, 5))).toEqual({ from: '2026-04-01', to: '2026-04-30' })
  })
})

describe('formatDuration', () => {
  it('shows hours and minutes together', () => {
    expect(formatDuration(495, words, 'en')).toBe('8h 15m')
  })
  it('drops an empty part', () => {
    expect(formatDuration(480, words, 'en')).toBe('8h')
    expect(formatDuration(45, words, 'en')).toBe('45m')
    expect(formatDuration(0, words, 'en')).toBe('0m')
  })
  it('keeps a negative readable', () => {
    expect(formatDuration(-90, words, 'en')).toBe('-1h 30m')
  })
  it('uses the locale’s digits', () => {
    // A Persian screen with Latin numerals in the one place a number appears looks broken.
    expect(formatDuration(480, words, 'fa')).toBe('۸h')
  })
})

describe('formatDays', () => {
  it('keeps halves and drops trailing zeros', () => {
    expect(formatDays(20, 'en')).toBe('20')
    expect(formatDays(19.5, 'en')).toBe('19.5')
    expect(formatDays(19.25, 'en')).toBe('19.25')
  })
  it('uses the locale’s digits', () => {
    expect(formatDays(20, 'fa')).toBe('۲۰')
  })
})
