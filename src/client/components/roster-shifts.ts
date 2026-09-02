import type { RosterShift } from '../../contract/rosters.js'

/**
 * What both roster screens need to say about a shift, kept apart from either so the settings page
 * and the coverage grid cannot drift into two spellings of "06:00–14:00 (+1)".
 *
 * Pure on purpose — no `@kernhq/ui` import — so `roster-shifts.test.ts` can load it without a Svelte
 * compiler, the same split `query.ts` keeps.
 */

/**
 * The colours a shift may wear.
 *
 * A fixed palette rather than a free colour input: a coverage grid with eleven hand-picked hues is
 * a grid nobody can read, and the palette is also what lets the swatch carry a *name* a screen
 * reader can announce — `hr.roster_color_<key>` — instead of a hex code. The hex is what is stored,
 * so a workspace whose shifts were coloured by the API still renders; an unknown value simply has
 * no name and is shown as itself.
 */
export const ROSTER_COLORS = [
  { key: 'blue', hex: '#2563EB' },
  { key: 'teal', hex: '#0D9488' },
  { key: 'amber', hex: '#D97706' },
  { key: 'red', hex: '#DC2626' },
  { key: 'violet', hex: '#7C3AED' },
  { key: 'pink', hex: '#DB2777' },
  { key: 'green', hex: '#65A30D' },
  { key: 'slate', hex: '#475569' },
] as const

export type RosterColorKey = (typeof ROSTER_COLORS)[number]['key']

export const rosterColorKey = (hex: string | null): RosterColorKey | null =>
  ROSTER_COLORS.find((c) => c.hex.toLowerCase() === hex?.toLowerCase())?.key ?? null

export const wallToMinutes = (wall: string): number => {
  const [h, m] = wall.split(':')
  return Number(h) * 60 + Number(m)
}

/**
 * `working-time.ts` calls a shift overnight when its end is at or before its start, so 22:00–06:00
 * is eight hours and 09:00–09:00 is a full twenty-four. Both roster screens have to agree with it
 * exactly, or the hours a shift promises are not the hours attendance measures.
 */
export const crossesMidnight = (shift: Pick<RosterShift, 'start' | 'end'>): boolean =>
  wallToMinutes(shift.end) <= wallToMinutes(shift.start)

/** Paid minutes on the shift: the span, wrapped past midnight when it has to be, less the break. */
export function shiftNetMinutes(shift: Pick<RosterShift, 'start' | 'end' | 'breakMinutes'>): number {
  const raw = wallToMinutes(shift.end) - wallToMinutes(shift.start)
  return Math.max((raw > 0 ? raw : raw + 1440) - shift.breakMinutes, 0)
}

/**
 * The one- or two-letter code a dense grid shows, falling back to the name's first letter so a
 * shift somebody never coded still has a mark on the cycle editor's chips.
 */
export const shiftCode = (shift: Pick<RosterShift, 'name' | 'code'>): string =>
  shift.code?.trim() || [...shift.name.trim()][0]?.toLocaleUpperCase() || '?'

export const WALL_CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 2024-01-01 was a Monday. A shift's readings are wall-clock strings, and the only way to hand
 * them to a range formatter is to pin them to a date — the second day is what the end lands on
 * when the shift crosses midnight, which is what makes the formatter print "+1" territory as a
 * range rather than as an end before its start.
 */
export const anchorDay = (index: number): string => `2024-01-0${index + 1}`
