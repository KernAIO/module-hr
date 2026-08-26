import { formatDate, formatDateRange } from '@kernhq/ui'
import type { ApprovalRequest } from '../contract/index.js'
import { t } from './i18n.js'

/**
 * The request line, in the reader's language.
 *
 * `summaryParams` is the sentence as data; `summary` is the English the server composed before that
 * existed and is the fallback for those rows. Rendering the fallback is better than rendering
 * nothing — an inbox row with no subject cannot be decided at all.
 *
 * Lives beside neither page that uses it: an inbox row and its confirmation dialog must say the
 * same sentence, or approving looks like an action on something else.
 */
export function summarise(request: ApprovalRequest): string {
  const p = request.summaryParams
  if (!p) return request.summary
  if (request.subjectType === 'leave' && p.from && p.to)
    return t('approval_summary_leave', {
      // A number, not a string: `count` is what selects the plural form, and passing it as text
      // rendered "1 days" and left the digits Latin on a Persian screen. `t()` formats it.
      count: Number(p.days ?? 0),
      range: dateRange(String(p.from), String(p.to)),
    })
  if (request.subjectType === 'regularization' && p.date)
    return t('approval_summary_regularization', { date: day(String(p.date)) })
  if (request.subjectType === 'overtime' && p.date)
    return t('approval_summary_overtime', { date: day(String(p.date)) })
  return request.summary
}

/**
 * `formatDate`, not a bare `Intl.DateTimeFormat(undefined, …)`.
 *
 * `undefined` means the browser's locale, which is not the one the reader chose — so the date half
 * of a sentence came out in Latin digits while `t()` rendered the word half in Persian ones, in the
 * same line. The shared helper passes `messageLocale()`, and it is the same call underneath.
 * This matters wherever it is used, and `summarise()` is what all three approvals surfaces render.
 */
export const day = (iso: string) => formatDate(iso)

/** One range, not two dates and a dash — the separator is the locale's, and RTL needs its own. */
export const dateRange = (from: string, to: string) => (from === to ? day(from) : formatDateRange(from, to))
