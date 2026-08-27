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

// No union helper over the three person-visibility keys. There has been one here twice —
// `canSeeOthers`, then `canSeeFullRecords` — and both were dead the whole time, because the question
// a screen actually has is "was *this* record withheld", and the answer to that is on the record:
// `Person.personnelHidden`, set by the server at the one place that does the nulling. A client-side
// union can only say "the reader holds one of three keys somewhere", which is never enough to decide
// what to draw over one person's phone number. See `components/redaction.ts`.
