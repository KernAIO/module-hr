import { describe, expect, it } from 'vitest'
import { COUNTRY_PACKS, packDays, packFor } from './index.js'

/**
 * The country packs, and the one question that must never be answered with a shrug.
 *
 * `calendars.pack.apply` is the only operation in this module that deletes rows a customer did not
 * name. Everything about the feature — the preview, the `keptCustom` list, the per-day `source`
 * column — exists so that a pack upgrade can never take a company's own holidays. None of that
 * protects the pack's *own* days, and those are the national holidays a country's whole leave
 * calendar is counted against.
 */
describe('country packs', () => {
  it('publishes the six countries the module claims to ship', () => {
    expect(Object.keys(COUNTRY_PACKS).sort()).toEqual(['DE', 'GB', 'IR', 'NL', 'TR', 'US'])
  })

  /**
   * The casing is load-bearing, not a style choice. The editor derives a pack key from the
   * calendar's country when it has none of its own, and derived `tr` where the pack is `TR` — so a
   * calendar made by hand proposed a key nobody publishes.
   */
  it('keys every pack by the ISO code exactly as ISO writes it', () => {
    for (const key of Object.keys(COUNTRY_PACKS)) expect(key).toBe(key.toUpperCase())
  })

  it('gives a real pack its days', () => {
    const days = packDays('TR', 2026)
    expect(days.length).toBeGreaterThan(0)
    expect(days.every((d) => d.date.startsWith('2026-'))).toBe(true)
  })

  /**
   * The defect this file exists for.
   *
   * `packDays` answering `[]` for an unknown key is fine in itself — a pack that publishes nothing
   * for a year is a real state. What is not fine is a caller reading that as a pack. The diff did:
   * an unknown key produced "add nothing, change nothing, remove every national holiday", with the
   * apply button live and `keptCustom` truthfully promising the company's own days were safe, which
   * was true and entirely beside the point.
   */
  it('answers an unknown key with nothing, which is why a deleting caller must not ask it', () => {
    expect(packDays('tr', 2026)).toEqual([])
    expect(packDays('ZZ', 2026)).toEqual([])
  })

  it('refuses an unknown key outright when something is about to delete on the strength of it', () => {
    expect(() => packFor('ZZ')).toThrow(/No holiday pack is published for "ZZ"/)
    // The lower-cased ISO code is the one a person actually reaches, so it is named here too.
    expect(() => packFor('tr')).toThrow(/No holiday pack is published for "tr"/)
  })

  it('names the packs that do exist, so the refusal is actionable', () => {
    expect(() => packFor('ZZ')).toThrow(/DE, GB, IR, NL, TR, US/)
  })

  it('returns the pack itself for a key that exists', () => {
    expect(packFor('TR').name).toBe('Türkiye')
  })
})
