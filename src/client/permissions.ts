import { session } from '@kernhq/ui'
import { HR_PERMISSIONS } from '../contract/permissions.js'
import { HR_CAPABILITIES } from './capabilities.js'

/**
 * What this module lets somebody do, and what this workspace has switched on.
 *
 * Two different questions, and the screens have to keep them apart:
 *
 * - a **permission** is about the person. Hide what they may never do; disable — with a reason —
 *   what they cannot do right now. Somebody else in the same workspace may well see it.
 * - a **capability** is about the workspace. When it is off the feature is not there for anyone,
 *   the shell never renders the contribution, and the API answers 404 rather than 403.
 *
 * The server checks both again regardless. This is about not offering a door that will not open.
 */
export { HR_CAPABILITIES, HR_PERMISSIONS }

export type HrPermission = keyof typeof HR_PERMISSIONS

export function canHr(permission: HrPermission): boolean {
  return session.can(HR_PERMISSIONS[permission])
}

/**
 * Whether the viewer reads the personnel record behind a directory card, for anybody but themselves.
 *
 * Not "can they open somebody else's page" — everybody can, and should. `hr.person.view` is a
 * `member` default and the directory is meant to be read. What the three widening keys decide is
 * how much of each person comes back: personal email, phone, hire date and termination date are the
 * personnel record, and the server nulls all four for anybody outside the reader's scope.
 *
 * The three do not imply one another — a country HR manager must not silently become a global one —
 * so a screen asks the union once, here. It is only a hint: which *people* fall inside a team or an
 * office is resolved on the server from the org chart, so a screen may not conclude from `true`
 * that a particular person's record is readable. Render what came back; use this to decide whether
 * a "personal details" section is worth offering at all.
 */
export const canSeeFullRecords = (): boolean =>
  canHr('personViewTeam') || canHr('personViewOffice') || canHr('personViewAll')
