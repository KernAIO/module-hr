/**
 * Query keys for HR.
 *
 * `[module, entity, …scope]`, so a realtime `change` event invalidates precisely what it touched.
 * The scope is part of the key wherever a screen can ask the same question about different subjects
 * — a balance for me and a balance for somebody I manage are different answers, and sharing a key
 * would serve one person the other's numbers from cache.
 */
export const hrKeys = {
  people: (ws: string, filters?: Record<string, unknown>) =>
    filters ? (['hr', 'people', ws, filters] as const) : (['hr', 'people', ws] as const),
  person: (ws: string, id: string) => ['hr', 'person', ws, id] as const,
  me: (ws: string) => ['hr', 'me', ws] as const,
  resolution: (ws: string, personId: string) => ['hr', 'resolution', ws, personId] as const,
  employment: (ws: string, personId: string) => ['hr', 'employment', ws, personId] as const,
  orgUnits: (ws: string) => ['hr', 'org-units', ws] as const,
  offices: (ws: string) => ['hr', 'offices', ws] as const,
  calendars: (ws: string) => ['hr', 'calendars', ws] as const,
  calendarDays: (ws: string, calendarId: string, from: string, to: string) =>
    ['hr', 'calendar-days', ws, calendarId, from, to] as const,
  leaveTypes: (ws: string) => ['hr', 'leave-types', ws] as const,
  leaveBalance: (ws: string, personId: string | undefined) =>
    ['hr', 'leave-balance', ws, personId ?? 'me'] as const,
  leaveRequests: (ws: string, personId: string | undefined) =>
    ['hr', 'leave-requests', ws, personId ?? 'me'] as const,
  leaveCalendar: (ws: string, from: string, to: string) => ['hr', 'leave-calendar', ws, from, to] as const,
  clockState: (ws: string) => ['hr', 'clock-state', ws] as const,
  attendanceDays: (ws: string, personId: string | undefined, from: string, to: string) =>
    ['hr', 'attendance-days', ws, personId ?? 'me', from, to] as const,
  schedules: (ws: string) => ['hr', 'schedules', ws] as const,
  approvalInbox: (ws: string) => ['hr', 'approvals', ws] as const,
} as const

/** `YYYY-MM-DD` for a date, in the viewer's own zone rather than UTC. */
export const isoDate = (d: Date = new Date()): string => new Intl.DateTimeFormat('en-CA').format(d)

/** The first and last day of the month containing `d`, as ISO dates. */
export function monthRange(d: Date = new Date()): { from: string; to: string } {
  const y = d.getFullYear()
  const mo = d.getMonth()
  const last = new Date(y, mo + 1, 0).getDate()
  const p = (n: number) => String(n).padStart(2, '0')
  return { from: `${y}-${p(mo + 1)}-01`, to: `${y}-${p(mo + 1)}-${p(last)}` }
}

/**
 * Minutes as a duration somebody reads.
 *
 * Takes the wording as parameters rather than importing `$msg`, because a `.ts` module that imports
 * `$msg` cannot be unit-tested — SvelteKit's aliases come from a plugin vitest does not run.
 */
export function formatDuration(
  minutes: number,
  words: { hours: (n: string) => string; minutes: (n: string) => string },
  locale?: string,
): string {
  const sign = minutes < 0 ? '-' : ''
  const abs = Math.abs(Math.round(minutes))
  const h = Math.floor(abs / 60)
  const mi = abs % 60
  const n = (v: number) => new Intl.NumberFormat(locale).format(v)
  if (h && mi) return `${sign}${words.hours(n(h))} ${words.minutes(n(mi))}`
  if (h) return `${sign}${words.hours(n(h))}`
  return `${sign}${words.minutes(n(mi))}`
}

/** Days, in the viewer's digits, with halves kept and trailing zeros dropped. */
export const formatDays = (days: number, locale?: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(days)
