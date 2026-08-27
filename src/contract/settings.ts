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
  /*
   * `directoryVisibleToMembers` was declared here and removed. The idea is sound — some companies
   * publish their org chart to everyone and some treat it as HR-only, which is coarser than
   * `hr.person.view` and would sit above it — but nothing read the field, and no route in shell
   * renders a module settings schema, so it could not be flipped through the product either. A
   * setting whose documented rule nothing enforces teaches an administrator that settings do not
   * mean anything, which is the same failure as a capability nothing checks.
   *
   * Bringing it back honestly needs both halves in the change that declares it: an enforcement site
   * (`people.list` and `people.get` in `src/server/services/people.ts`, refusing a caller who has
   * only `hr.person.view` while the flag is off), and a way for an administrator to reach it —
   * a control on `src/client/settings/GeneralSettings.svelte`, which is already routed.
   */
})
export type HrSettings = z.infer<typeof HrSettings>
