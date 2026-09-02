import { describe, expect, it } from 'vitest'
import { crossesMidnight, rosterColorKey, shiftCode, shiftNetMinutes } from './roster-shifts.js'

describe('roster shifts', () => {
  it('agrees with working-time on what an overnight shift is', () => {
    expect(crossesMidnight({ start: '22:00', end: '06:00' })).toBe(true)
    expect(crossesMidnight({ start: '09:00', end: '09:00' })).toBe(true)
    expect(crossesMidnight({ start: '06:00', end: '14:00' })).toBe(false)
  })

  it('wraps an overnight shift past midnight before taking the break off', () => {
    expect(shiftNetMinutes({ start: '22:00', end: '06:00', breakMinutes: 30 })).toBe(450)
    expect(shiftNetMinutes({ start: '06:00', end: '14:00', breakMinutes: 0 })).toBe(480)
    // A break longer than the shift is a misconfiguration, not a negative number of hours.
    expect(shiftNetMinutes({ start: '06:00', end: '07:00', breakMinutes: 90 })).toBe(0)
  })

  it('falls back to the first letter of the name for an uncoded shift', () => {
    expect(shiftCode({ name: 'Early', code: 'E1' })).toBe('E1')
    expect(shiftCode({ name: 'Early', code: null })).toBe('E')
    expect(shiftCode({ name: 'Early', code: '  ' })).toBe('E')
    // The first *character*, which is not the first UTF-16 unit for a name that starts outside
    // the BMP.
    expect(shiftCode({ name: 'شب', code: null })).toBe('ش')
  })

  it('names a palette colour whatever its case, and nothing else', () => {
    expect(rosterColorKey('#2563eb')).toBe('blue')
    expect(rosterColorKey('#2563EB')).toBe('blue')
    expect(rosterColorKey('#123456')).toBeNull()
    expect(rosterColorKey(null)).toBeNull()
  })
})
