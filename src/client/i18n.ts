/**
 * Hr's own strings, in every locale the platform ships.
 *
 * A module ships separately from the app, so Paraglide cannot compile these — the shell merges
 * them into the framework's message runtime when it registers this module, and `t()` resolves
 * against the merged map. Keys are namespaced by module id, which is what keeps two modules from
 * colliding in that one map.
 *
 * Bundles are thunks so a locale is only fetched when it is the one in use; English is the
 * fallback and is therefore always loaded.
 *
 * The strings themselves live in `messages.ts`, which imports nothing at runtime — see the note
 * there. This file is the runtime half, and importing it costs you `@kernhq/ui`.
 */
import { scopedT } from '@kernhq/ui'

export { ar, de, en, fa, type HrMessageKey, hrMessageBundles, tr } from './messages.js'

/** `t('settings_nav')` — the module id is implied. */
export const t = scopedT('hr')
