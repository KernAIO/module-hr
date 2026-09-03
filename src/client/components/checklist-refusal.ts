import { t } from '../i18n.js'
import { checklistRefusal } from './checklists.js'

/**
 * What a refused checklist write says to the person who made it.
 *
 * A known reason gets this module's own sentence in the reader's language; a refusal the router
 * wrote a sentence for but this module has no key for is repeated verbatim, because it is the only
 * thing that says what happened; everything else — a network drop, a 500, `Forbidden` — falls back
 * to the caller's own string. The same shape as `ApprovalsPage.svelte`'s `decideFailure`, kept in
 * its own file because three screens tick the same items.
 */
export function explainChecklistRefusal(error: unknown, fallback: string): string {
  const refusal = checklistRefusal(error)
  if (!refusal) return fallback
  if ('sentence' in refusal) return refusal.sentence || fallback
  // `t()` answers a key it has no string for with the key itself, so a key whose string has not
  // been merged lands on the fallback rather than putting `hr.checklist_refused_…` on screen.
  const translated = t(refusal.key)
  return translated && translated !== refusal.key ? translated : fallback
}
