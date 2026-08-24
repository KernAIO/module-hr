import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineModule, defineServerModule, type Kernel, packageVersion, uuidv7 } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import {
  HrSettings,
  hrCapabilities,
  hrContract,
  hrEvents,
  hrPermissions,
  MODULE_ID,
} from '../contract/index.js'
import { COUNTRY_PACKS, packDays } from './packs/index.js'
import { implement_ } from './router.js'
import { calendarDays, calendars, offices, people, schema } from './schema.js'

export const hrModule = defineServerModule({
  definition: defineModule({
    id: MODULE_ID,
    name: 'People',
    version: packageVersion(import.meta.url),
    description: 'Staff directory, offices, org chart and holiday calendars',
    icon: 'users',
    permissions: hrPermissions,
    capabilities: hrCapabilities,
    events: hrEvents,
    settings: HrSettings,
    objectTypes: [
      { type: 'person', label: 'Person', icon: 'user', channelable: false },
      { type: 'office', label: 'Office', icon: 'building', channelable: false },
    ],
  }),
  /** Attached so the developer panel can check the router against what was promised. */
  contract: hrContract,
  schema,
  migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '../../migrations'),
  router: implement_,

  /**
   * A workspace that switches HR on gets one office and the calendar for its country.
   *
   * This is what lets the `offices` capability be a *reveal* rather than a migration. The concept
   * exists from the first second — every person is assigned to this office, the resolution ladder
   * always has a rung to land on, and nothing in the module needs a "no office" branch. A workspace
   * that only ever has one place of work never sees the word.
   *
   * Idempotent: it runs again when somebody switches HR off and back on, and must not make a second
   * default office.
   */
  onWorkspaceEnabled: async (workspaceId: string, kernel: Kernel) => {
    const settings = await kernel.settings.module(workspaceId, MODULE_ID, HrSettings)
    await kernel.database.withWorkspace(workspaceId, async (tx) => {
      const existing = await tx.select().from(offices).where(eq(offices.workspaceId, workspaceId)).limit(1)
      if (existing.length) return

      const country = settings.country
      const pack = COUNTRY_PACKS[country]
      let calendarId: string | null = null
      if (pack) {
        const [calendar] = await tx
          .insert(calendars)
          .values({
            id: uuidv7(),
            workspaceId,
            name: pack.name,
            country,
            workingWeek: pack.workingWeek,
            source: 'pack',
            packKey: country,
          })
          .returning()
        calendarId = calendar!.id
        const year = new Date().getUTCFullYear()
        const days = packDays(country, year)
        if (days.length)
          await tx.insert(calendarDays).values(
            days.map((d) => ({
              id: uuidv7(),
              workspaceId,
              calendarId: calendar!.id,
              date: d.date,
              kind: d.kind,
              name: d.name,
              workingFraction: String(d.workingFraction),
              source: 'pack' as const,
              paid: true,
            })),
          )
      }

      await tx.insert(offices).values({
        id: uuidv7(),
        workspaceId,
        name: 'Head office',
        kind: 'head_office',
        country,
        // The instance's zone would be an accident of deployment; the pack's country is a decision.
        timezone: DEFAULT_TIMEZONE_FOR[country] ?? 'UTC',
        calendarId,
        isDefault: true,
      })
    })
  },

  /**
   * Answers other modules may ask, without reaching into `mod_hr`.
   *
   * A join across schemas is the thing the module boundary exists to prevent, so anything chat, a
   * future calendar or payroll wants goes through here with its own principal — which means a
   * permission check still applies rather than being bypassed by the shape of the query.
   */
  procedures: {
    'person.byUserId': {
      handler: async (input: { workspaceId: string; userId: string }, { kernel }) =>
        kernel.database.withWorkspace(input.workspaceId, async (tx) => {
          const [row] = await tx
            .select({ id: people.id, displayName: people.displayName, status: people.status })
            .from(people)
            .where(eq(people.userId, input.userId))
            .limit(1)
          return row ?? null
        }),
    },
  },

  subscriptions: {
    /**
     * A member leaving the workspace does **not** delete their HR record.
     *
     * Employment history outlives an account: payroll, tax and labour law all require it to, and
     * "she left, so we deleted her file" is the answer that fails an audit. The link is cleared so
     * the record stops pointing at an account that is gone.
     */
    'core.member.removed': async (event, kernel) => {
      const { workspaceId, userId } = event.payload as { workspaceId: string; userId: string }
      await kernel.database.withWorkspace(workspaceId, (tx) =>
        tx.update(people).set({ userId: null }).where(eq(people.userId, userId)),
      )
    },
  },
})

/**
 * A sensible zone per country pack, used only to build the first office.
 *
 * Every one of these is somewhere an administrator can change in a single click, so being wrong is
 * cheap; being *absent* is not, because a workspace with no zone attributes everybody's day in UTC.
 * Countries spanning several zones get their most populous one.
 */
const DEFAULT_TIMEZONE_FOR: Record<string, string> = {
  TR: 'Europe/Istanbul',
  DE: 'Europe/Berlin',
  GB: 'Europe/London',
  US: 'America/New_York',
  NL: 'Europe/Amsterdam',
  IR: 'Asia/Tehran',
}

export default hrModule
