import { session } from '@kernhq/ui'
import { HR_CAPABILITIES, HR_PERMISSIONS } from './index.js'

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
 * Whether the viewer can see anybody's record but their own.
 *
 * Three widths that do not imply one another — a country HR manager must not silently become a
 * global one — so "can this person open somebody else's page" is asked once, here.
 */
export const canSeeOthers = (): boolean =>
  canHr('personViewTeam') || canHr('personViewOffice') || canHr('personViewAll')
