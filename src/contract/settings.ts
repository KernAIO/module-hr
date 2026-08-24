import { z } from 'zod'
import { CountryCode } from './models.js'

/**
 * Workspace-level settings for HR.
 *
 * Deliberately small. Almost everything an administrator can configure belongs to an office, a
 * calendar or a policy record, because those are the things that differ between two groups of people
 * in the same company. What is left here is genuinely workspace-wide.
 *
 * Note what is *not* here: the capability switches. Those live under a reserved `$capabilities` key
 * that the platform owns, not in this schema — which is why turning one off cannot collide with a
 * settings field and cannot be dropped by a settings round-trip.
 */
export const HrSettings = z.object({
  /**
   * The country the first office is built from, and the default for the next one.
   *
   * A seed, not a constraint. Once offices exist, each carries its own country and this is only
   * consulted when creating one — a workspace headquartered in Turkey with a Dutch branch is
   * ordinary, and nothing about the Dutch branch consults this value.
   */
  country: CountryCode.default('TR'),
  /** Employee numbers are generated from this when a person is created without one. */
  employeeNumberPrefix: z.string().max(8).default(''),
  employeeNumberNext: z.number().int().min(1).default(1),
  /**
   * Whether a member who is not in HR can see the directory at all.
   *
   * Some companies publish their org chart to everyone; some treat it as HR-only. This is coarser
   * than the permission and sits above it: off, and `hr.person.view` is not enough on its own.
   */
  directoryVisibleToMembers: z.boolean().default(true),
})
export type HrSettings = z.infer<typeof HrSettings>
