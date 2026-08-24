import type { CalendarDayKind, WorkingWeek } from '../../contract/index.js'

/**
 * Country packs: a working week and a year's public holidays, as **data**.
 *
 * These are defaults a workspace can edit, not a claim about the law. Kern does not give legal
 * advice, and the workspace owner is responsible for their own configuration — the documentation
 * says so, and so should any screen that offers to apply one.
 *
 * Three things worth knowing before editing this file:
 *
 * - **Fixed-date holidays only, for now.** Anything that moves — Easter, and every Islamic holiday,
 *   which follows the lunar Hijri calendar and drifts about eleven days a year against this one —
 *   has to be published per year rather than computed. `movable: true` marks a pack that is
 *   therefore incomplete beyond the years listed, and the preview says so rather than quietly
 *   returning a short list.
 * - **A pack applies to one year at a time.** That is deliberate: a refresh is an operation an
 *   administrator performs and reviews, not something that happens to them.
 * - **Every day here lands as `source: 'pack'`.** That is what lets an upgrade replace them and
 *   leave days HR added alone.
 */

export interface PackDay {
  /** `MM-DD` for a fixed holiday; a full `YYYY-MM-DD` for one that moves. */
  on: string
  name: string
  kind: CalendarDayKind
  workingFraction?: number
}

export interface CountryPack {
  name: string
  workingWeek: WorkingWeek
  /** Holidays on the same date every year. */
  fixed: PackDay[]
  /** Holidays that move, listed per year. Absent years yield the fixed set alone. */
  movableByYear?: Record<string, PackDay[]>
  /** True when this country has holidays that move and are not listed for every year. */
  movable: boolean
  /** Where the dates came from, so a wrong one can be traced rather than argued about. */
  source: string
}

const MON_FRI: WorkingWeek = { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 }

export const COUNTRY_PACKS: Record<string, CountryPack> = {
  TR: {
    name: 'Türkiye',
    workingWeek: MON_FRI,
    source: 'Law 2429 on National Holidays and General Holidays',
    // Ramazan and Kurban Bayramı follow the Hijri calendar and are not listed here.
    movable: true,
    fixed: [
      { on: '01-01', name: 'Yılbaşı', kind: 'public_holiday' },
      { on: '04-23', name: 'Ulusal Egemenlik ve Çocuk Bayramı', kind: 'public_holiday' },
      { on: '05-01', name: 'Emek ve Dayanışma Günü', kind: 'public_holiday' },
      { on: '05-19', name: 'Atatürk’ü Anma, Gençlik ve Spor Bayramı', kind: 'public_holiday' },
      { on: '07-15', name: 'Demokrasi ve Millî Birlik Günü', kind: 'public_holiday' },
      { on: '08-30', name: 'Zafer Bayramı', kind: 'public_holiday' },
      { on: '10-29', name: 'Cumhuriyet Bayramı', kind: 'public_holiday' },
    ],
  },

  DE: {
    name: 'Deutschland',
    workingWeek: MON_FRI,
    // Bavaria, Baden-Württemberg and Saxony each add their own; an office carries a `region`
    // precisely so a per-state pack can be added without changing anything here.
    source: 'Federal (bundeseinheitliche) public holidays; states add their own',
    movable: true,
    fixed: [
      { on: '01-01', name: 'Neujahr', kind: 'public_holiday' },
      { on: '05-01', name: 'Tag der Arbeit', kind: 'public_holiday' },
      { on: '10-03', name: 'Tag der Deutschen Einheit', kind: 'public_holiday' },
      { on: '12-25', name: 'Erster Weihnachtstag', kind: 'public_holiday' },
      { on: '12-26', name: 'Zweiter Weihnachtstag', kind: 'public_holiday' },
    ],
  },

  GB: {
    name: 'United Kingdom',
    workingWeek: MON_FRI,
    // England and Wales only. Scotland and Northern Ireland differ, and the substitute-day rule
    // (a holiday on a weekend moves to the next weekday) is not applied here.
    source: 'GOV.UK bank holidays, England and Wales',
    movable: true,
    fixed: [
      { on: '01-01', name: "New Year's Day", kind: 'public_holiday' },
      { on: '12-25', name: 'Christmas Day', kind: 'public_holiday' },
      { on: '12-26', name: 'Boxing Day', kind: 'public_holiday' },
    ],
  },

  US: {
    name: 'United States',
    workingWeek: MON_FRI,
    // Federal holidays only. There is no federal minimum paid leave, and state sick-leave law
    // differs sharply — which is why this pack deliberately carries no leave defaults at all.
    source: '5 U.S.C. §6103, federal holidays',
    movable: true,
    fixed: [
      { on: '01-01', name: "New Year's Day", kind: 'public_holiday' },
      { on: '06-19', name: 'Juneteenth', kind: 'public_holiday' },
      { on: '07-04', name: 'Independence Day', kind: 'public_holiday' },
      { on: '11-11', name: 'Veterans Day', kind: 'public_holiday' },
      { on: '12-25', name: 'Christmas Day', kind: 'public_holiday' },
    ],
  },

  NL: {
    name: 'Nederland',
    workingWeek: MON_FRI,
    source: 'Algemeen erkende feestdagen',
    movable: true,
    fixed: [
      { on: '01-01', name: 'Nieuwjaarsdag', kind: 'public_holiday' },
      { on: '04-27', name: 'Koningsdag', kind: 'public_holiday' },
      { on: '05-05', name: 'Bevrijdingsdag', kind: 'public_holiday' },
      { on: '12-25', name: 'Eerste Kerstdag', kind: 'public_holiday' },
      { on: '12-26', name: 'Tweede Kerstdag', kind: 'public_holiday' },
    ],
  },

  IR: {
    name: 'ایران',
    // Friday is the weekend and Thursday is commonly a half day. This is the pack that proves the
    // working week has to be data: a Monday-to-Friday assumption is wrong for a whole country.
    workingWeek: { sat: 1, sun: 1, mon: 1, tue: 1, wed: 1, thu: 0.5, fri: 0 },
    // Nowruz is fixed against the Persian solar calendar, so its Gregorian date shifts by a day
    // across leap years; every religious holiday follows the lunar Hijri calendar and moves by
    // about eleven days a year. Neither is computed here.
    source: 'Iranian national and religious holidays',
    movable: true,
    fixed: [
      { on: '03-20', name: 'نوروز', kind: 'public_holiday' },
      { on: '03-21', name: 'نوروز', kind: 'public_holiday' },
      { on: '03-22', name: 'نوروز', kind: 'public_holiday' },
      { on: '03-23', name: 'نوروز', kind: 'public_holiday' },
      { on: '04-01', name: 'روز جمهوری اسلامی', kind: 'public_holiday' },
      { on: '04-02', name: 'روز طبیعت', kind: 'public_holiday' },
    ],
  },
}

/** A pack's days for one year, as concrete dates. */
export function packDays(
  packKey: string,
  year: number,
): Array<{ date: string; name: string; kind: CalendarDayKind; workingFraction: number }> {
  const pack = COUNTRY_PACKS[packKey]
  if (!pack) return []
  const fixed = pack.fixed.map((d) => ({
    date: `${year}-${d.on}`,
    name: d.name,
    kind: d.kind,
    workingFraction: d.workingFraction ?? 0,
  }))
  const movable = (pack.movableByYear?.[String(year)] ?? []).map((d) => ({
    date: d.on,
    name: d.name,
    kind: d.kind,
    workingFraction: d.workingFraction ?? 0,
  }))
  return [...fixed, ...movable].sort((a, b) => a.date.localeCompare(b.date))
}

/** True when this pack cannot be complete for the year — the caller should say so before applying. */
export const packIsIncompleteFor = (packKey: string, year: number): boolean => {
  const pack = COUNTRY_PACKS[packKey]
  if (!pack) return false
  return pack.movable && !pack.movableByYear?.[String(year)]
}
