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
      days: String(p.days ?? ''),
      range: dateRange(String(p.from), String(p.to)),
    })
  if (request.subjectType === 'regularization' && p.date)
    return t('approval_summary_regularization', { date: day(String(p.date)) })
  if (request.subjectType === 'overtime' && p.date)
    return t('approval_summary_overtime', { date: day(String(p.date)) })
  return request.summary
}

export const day = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso))

/** One range, not two dates and a dash — the separator is the locale's, and RTL needs its own. */
export const dateRange = (from: string, to: string) =>
  from === to
    ? day(from)
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).formatRange(new Date(from), new Date(to))
