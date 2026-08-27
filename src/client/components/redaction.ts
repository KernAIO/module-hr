import { session } from '@kernhq/ui'
import { canHr, canSeeFullRecords } from '../permissions.js'

/**
 * Whether the personnel fields on a card were withheld, or are genuinely empty.
 *
 * `HrAccessService` nulls four of them — personal email, phone, hire date, termination date — for
 * anybody outside the reader's record scope, and nulls them **in place**: a redacted card parses as
 * an ordinary `Person`, so a blank phone number arrives at a screen meaning either "we are not
 * showing you this" or "this person never gave us one". Those are two different facts about a
 * colleague, and printing the second when the first is true is the defect this exists to stop.
 *
 * Nothing on the record says which it is, so this reconstructs what it can from the reader's own
 * keys — and answers `unknown` rather than guessing where it cannot:
 *
 * - `full` — nothing was withheld from this reader. `hr.person.view_all` reads the workspace, and
 *   `hr.person.manage` is unbounded for the same reason the server makes it so: the edit form is
 *   populated from the record it saves back, so a writer handed a redacted card would blank the
 *   fields they could not see. Everybody reads their own record besides, holding nothing at all.
 * - `withheld` — the reader holds none of the three widening keys, so every card but their own came
 *   back with all four nulled. Certain, and the common case: `hr.person.view` is a member default
 *   and most colleagues hold nothing above it.
 * - `unknown` — the reader holds `view_team` or `view_office`. **Which** people those cover is
 *   resolved on the server from the org chart — headship of a unit or an office, direct reports, as
 *   of today — and none of that reaches the client. A screen renders the field exactly as it
 *   arrived rather than labelling a genuinely empty phone number "Hidden".
 *
 * That third answer is the hole, and it is the server's to close: one boolean set where `forViewer`
 * already nulls the four would make every card say for itself, and every caller here collapses to
 * reading it. Until then a manager sees no marking on the people outside their team — the same
 * blank they see today, never a wrong sentence about it.
 */
export type PersonnelVisibility = 'full' | 'withheld' | 'unknown'

/** Enough of a person to answer for — a directory row, a whole record, an office roster entry. */
export interface PersonnelSubject {
  /** The Kern account behind the record, when there is one: how a reader recognises their own. */
  userId: string | null
}

export function personnelVisibility(person: PersonnelSubject): PersonnelVisibility {
  // The two grants the server treats as unbounded, asked in the order it asks them.
  if (canHr('personViewAll') || canHr('personManage')) return 'full'
  // Identity, never a grant. Plenty of employees have no account, so a null on either side is
  // nobody's match rather than everybody's.
  const userId = session.user?.id
  if (userId && person.userId === userId) return 'full'
  // `view_all` is answered above, so what is left of that union is team-or-office scope: a set of
  // people only the server can name.
  return canSeeFullRecords() ? 'unknown' : 'withheld'
}
