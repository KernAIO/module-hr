import type { WorkspaceId } from '@kernhq/contracts'
import {
  KernError,
  type Kernel,
  type RequestContext,
  requires,
  requiresCapability,
  type Tx,
  uuidv7,
  workspaceScoped,
} from '@kernhq/kernel'
import { implement } from '@orpc/server'
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, sql } from 'drizzle-orm'
import { HrSettings, hrContract, hrEvents, MODULE_ID, type WorkingWeek } from '../contract/index.js'
import { countWorkingDays, workingDays } from '../policy/calendar.js'
import { COUNTRY_PACKS, packDays } from './packs/index.js'
import {
  calendarDays,
  calendars,
  costCenters,
  customFieldDefs,
  employments,
  legalEntities,
  officeAssignments,
  offices,
  orgUnits,
  people,
  peopleSensitive,
  personDocuments,
  personHistory,
  positions,
} from './schema.js'
import { inForceOn, todayIso } from './services/db.js'
import { PeopleService } from './services/people.js'
import { DEFAULT_WORKING_WEEK, ResolveService } from './services/resolve.js'

const os = implement(hrContract).$context<RequestContext>()

/**
 * The router.
 *
 * Three middlewares, and `module.test.ts` fails if any is missing where it belongs:
 * `workspaceScoped` (a real membership, HR switched on for that workspace), `requiresCapability`
 * for anything behind a capability, and `requires` for the permission the call needs — in that
 * order, so a workspace with HR off is refused before anything reveals which capabilities it has.
 *
 * Every tenant query runs inside `withWorkspace`, which sets `app.workspace_id` for the transaction.
 * Outside it the RLS policy matches nothing and the query returns no rows — which is the failure
 * mode to expect if a new query mysteriously finds nothing.
 */
export function implement_(kernel: Kernel) {
  const scoped = os.use(workspaceScoped(MODULE_ID))
  const cap = (id: string) => requiresCapability(MODULE_ID, id)
  const resolve = new ResolveService()
  const svc = new PeopleService(kernel)
  const db = kernel.database
  const settingsOf = (workspaceId: string) => kernel.settings.module(workspaceId, MODULE_ID, HrSettings)

  const changed = (workspaceId: string, entity: string, id: string, op: 'created' | 'updated' | 'deleted') =>
    kernel.realtime.change(workspaceId, { module: MODULE_ID, entity, id, op })

  return os.router({
    // ================================================================= people
    people: {
      list: scoped.people.list.use(requires('hr.person.view')).handler(({ input }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const where = [eq(people.workspaceId, input.workspaceId)]
          if (input.q) where.push(ilike(people.displayName, `%${input.q}%`))
          if (input.status?.length) where.push(inArray(people.status, input.status))

          if (input.officeId) {
            const here = await tx
              .select({ personId: officeAssignments.personId })
              .from(officeAssignments)
              .where(
                and(
                  eq(officeAssignments.workspaceId, input.workspaceId),
                  eq(officeAssignments.officeId, input.officeId),
                  isNull(officeAssignments.effectiveTo),
                ),
              )
            // An empty list must match nothing, not everything — `inArray(col, [])` is a false
            // predicate in drizzle, but spelling it out beats relying on that.
            where.push(
              here.length
                ? inArray(
                    people.id,
                    here.map((r) => r.personId),
                  )
                : sql`false`,
            )
          }

          if (input.orgUnitId) {
            const ids = await unitMemberIds(tx, input.workspaceId, input.orgUnitId, input.includeDescendants)
            where.push(ids.length ? inArray(people.id, ids) : sql`false`)
          }

          if (input.positionId) {
            const holders = await tx
              .select({ personId: employments.personId })
              .from(employments)
              .where(
                and(
                  eq(employments.workspaceId, input.workspaceId),
                  eq(employments.positionId, input.positionId),
                  isNull(employments.effectiveTo),
                ),
              )
            where.push(
              holders.length
                ? inArray(
                    people.id,
                    holders.map((r) => r.personId),
                  )
                : sql`false`,
            )
          }

          const rows = await tx
            .select()
            .from(people)
            .where(and(...where))
            .orderBy(asc(people.displayName))
            .limit(input.limit)
          const [total] = await tx
            .select({ n: count() })
            .from(people)
            .where(and(...where))
          return { items: rows.map(PeopleService.toPerson), nextCursor: null, total: total?.n ?? 0 }
        }),
      ),

      get: scoped.people.get
        .use(requires('hr.person.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) =>
            PeopleService.toPerson(await svc.load(tx, input.workspaceId, input.personId)),
          ),
        ),

      /**
       * No permission check: everybody may read their own record, and a permission nobody can lack
       * is noise in the role editor. Returns null rather than 404 when the signed-in user has no HR
       * record — plenty of members are not employees, and that is an answer, not a failure.
       */
      me: scoped.people.me.handler(({ input, context }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const userId = context.principal.userId
          if (!userId) return null
          const row = await svc.byUserId(tx, input.workspaceId, userId)
          return row ? PeopleService.toPerson(row) : null
        }),
      ),

      create: scoped.people.create.use(requires('hr.person.manage')).handler(async ({ input, context }) => {
        const settings = await settingsOf(input.workspaceId)
        const row = await db.withWorkspace(input.workspaceId, async (tx) => {
          const employeeNo = input.employeeNo ?? (await svc.nextEmployeeNo(input.workspaceId, settings))
          const [person] = await tx
            .insert(people)
            .values({
              id: uuidv7(),
              workspaceId: input.workspaceId,
              userId: input.userId ?? null,
              employeeNo,
              displayName: input.displayName,
              workEmail: input.workEmail ?? null,
              hiredOn: input.hiredOn ?? null,
              status: input.hiredOn && input.hiredOn > todayIso() ? 'onboarding' : 'active',
            })
            .returning()

          const from = input.hiredOn ?? todayIso()
          await svc.changeEmployment(tx, input.workspaceId, person!.id, from, {
            orgUnitId: input.orgUnitId ?? null,
            positionId: input.positionId ?? null,
            managerPersonId: input.managerPersonId ?? null,
            employmentType: input.employmentType,
          })

          // Everybody lands in an office, even when the workspace has never heard the word: the
          // default office is what the calendar, timezone and every policy hang off.
          const office = input.officeId ?? (await resolve.defaultOffice(tx, input.workspaceId))?.id
          if (office) await svc.assignOffice(tx, input.workspaceId, person!.id, office, true, from, 'created')

          await svc.record(tx, input.workspaceId, person!.id, context.principal.userId ?? null, [
            { field: 'created', from: null, to: input.displayName },
          ])
          return person!
        })

        await kernel.emit(
          hrEvents.personCreated,
          { personId: row.id, workspaceId: input.workspaceId, userId: row.userId },
          { workspaceId: input.workspaceId, actorId: context.principal.userId },
        )
        await changed(input.workspaceId, 'person', row.id, 'created')
        return PeopleService.toPerson(row)
      }),

      update: scoped.people.update.use(requires('hr.person.manage')).handler(async ({ input, context }) => {
        const { workspaceId, personId, ...patch } = input
        const row = await db.withWorkspace(workspaceId, async (tx) => {
          const before = await svc.load(tx, workspaceId, personId)
          const set: Record<string, unknown> = { updatedAt: new Date() }
          const history: Array<{ field: string; from: unknown; to: unknown }> = []
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) continue
            set[k] = v
            history.push({ field: k, from: (before as Record<string, unknown>)[k] ?? null, to: v })
          }
          const [updated] = await tx
            .update(people)
            .set(set)
            .where(and(eq(people.workspaceId, workspaceId), eq(people.id, personId)))
            .returning()
          await svc.record(tx, workspaceId, personId, context.principal.userId ?? null, history)
          return { updated: updated!, fields: history.map((h) => h.field) }
        })
        await kernel.emit(
          hrEvents.personUpdated,
          { personId, workspaceId, fields: row.fields },
          { workspaceId, actorId: context.principal.userId },
        )
        await changed(workspaceId, 'person', personId, 'updated')
        return PeopleService.toPerson(row.updated)
      }),

      /** Ends employment and keeps the record. A terminated person is history, not a deletion. */
      offboard: scoped.people.offboard
        .use(requires('hr.person.manage'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const before = await svc.load(tx, input.workspaceId, input.personId)
            const [updated] = await tx
              .update(people)
              .set({ status: 'terminated', terminatedOn: input.on, updatedAt: new Date() })
              .where(and(eq(people.workspaceId, input.workspaceId), eq(people.id, input.personId)))
              .returning()
            await tx
              .update(employments)
              .set({ effectiveTo: input.on })
              .where(
                and(
                  eq(employments.workspaceId, input.workspaceId),
                  eq(employments.personId, input.personId),
                  isNull(employments.effectiveTo),
                ),
              )
            await tx
              .update(officeAssignments)
              .set({ effectiveTo: input.on })
              .where(
                and(
                  eq(officeAssignments.workspaceId, input.workspaceId),
                  eq(officeAssignments.personId, input.personId),
                  isNull(officeAssignments.effectiveTo),
                ),
              )
            await svc.record(tx, input.workspaceId, input.personId, context.principal.userId ?? null, [
              { field: 'status', from: before.status, to: 'terminated' },
              { field: 'terminatedOn', from: before.terminatedOn, to: input.on },
            ])
            return { before, updated: updated! }
          })
          await kernel.emit(
            hrEvents.personStatusChanged,
            {
              personId: input.personId,
              workspaceId: input.workspaceId,
              from: row.before.status,
              to: 'terminated',
              on: input.on,
            },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return PeopleService.toPerson(row.updated)
        }),

      history: scoped.people.history.use(requires('hr.person.view')).handler(({ input }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const rows = await tx
            .select()
            .from(personHistory)
            .where(
              and(
                eq(personHistory.workspaceId, input.workspaceId),
                eq(personHistory.personId, input.personId),
              ),
            )
            .orderBy(desc(personHistory.at))
            .limit(input.limit)
          return {
            items: rows.map((r) => ({
              id: r.id,
              field: r.field,
              from: r.from ?? null,
              to: r.to ?? null,
              at: r.at.toISOString(),
              actorId: r.actorId,
              source: r.source,
            })),
            nextCursor: null,
          }
        }),
      ),

      sensitive: {
        get: scoped.people.sensitive.get.use(requires('hr.person.view_sensitive')).handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const [row] = await tx
              .select()
              .from(peopleSensitive)
              .where(
                and(
                  eq(peopleSensitive.workspaceId, input.workspaceId),
                  eq(peopleSensitive.personId, input.personId),
                ),
              )
              .limit(1)
            return {
              personId: input.personId,
              workspaceId: input.workspaceId,
              nationalId: row?.nationalIdEnc ? await kernel.secrets.decrypt(row.nationalIdEnc) : null,
              birthDate: row?.birthDate ?? null,
              iban: row?.ibanEnc ? await kernel.secrets.decrypt(row.ibanEnc) : null,
              emergencyContact: (row?.emergencyContact as never) ?? null,
            }
          }),
        ),

        update: scoped.people.sensitive.update
          .use(requires('hr.person.manage_sensitive'))
          .handler(async ({ input, context }) => {
            const { workspaceId, personId } = input
            await db.withWorkspace(workspaceId, async (tx) => {
              const set: Record<string, unknown> = { workspaceId, personId, updatedAt: new Date() }
              if (input.nationalId !== undefined)
                set.nationalIdEnc = input.nationalId ? await kernel.secrets.encrypt(input.nationalId) : null
              if (input.iban !== undefined)
                set.ibanEnc = input.iban ? await kernel.secrets.encrypt(input.iban) : null
              if (input.birthDate !== undefined) set.birthDate = input.birthDate
              if (input.emergencyContact !== undefined) set.emergencyContact = input.emergencyContact
              await tx
                .insert(peopleSensitive)
                .values(set as never)
                .onConflictDoUpdate({ target: peopleSensitive.personId, set })
              // The values never enter the audit trail — only that they changed. An audit log that
              // records a national identity number defeats the reason this table is separate.
              await svc.record(tx, workspaceId, personId, context.principal.userId ?? null, [
                { field: 'sensitive', from: null, to: Object.keys(input).filter((k) => k !== 'workspaceId') },
              ])
            })
            return {
              personId,
              workspaceId,
              nationalId: input.nationalId ?? null,
              birthDate: input.birthDate ?? null,
              iban: input.iban ?? null,
              emergencyContact: (input.emergencyContact as never) ?? null,
            }
          }),
      },
    },

    // ================================================================= employment
    employment: {
      current: scoped.employment.current.use(requires('hr.employment.view')).handler(({ input }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const on = input.on ?? todayIso()
          const [row] = await tx
            .select()
            .from(employments)
            .where(
              and(
                eq(employments.workspaceId, input.workspaceId),
                eq(employments.personId, input.personId),
                inForceOn(employments.effectiveFrom, employments.effectiveTo, on),
              ),
            )
            .limit(1)
          return row ? PeopleService.toEmployment(row) : null
        }),
      ),

      history: scoped.employment.history.use(requires('hr.employment.view')).handler(({ input }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const rows = await tx
            .select()
            .from(employments)
            .where(
              and(eq(employments.workspaceId, input.workspaceId), eq(employments.personId, input.personId)),
            )
            .orderBy(desc(employments.effectiveFrom))
          return rows.map(PeopleService.toEmployment)
        }),
      ),

      change: scoped.employment.change
        .use(requires('hr.employment.manage'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, (tx) =>
            svc.changeEmployment(tx, input.workspaceId, input.personId, input.effectiveFrom, {
              orgUnitId: input.orgUnitId ?? undefined,
              positionId: input.positionId ?? undefined,
              legalEntityId: input.legalEntityId ?? undefined,
              costCenterId: input.costCenterId ?? undefined,
              managerPersonId: input.managerPersonId ?? undefined,
              employmentType: input.employmentType,
              fte: input.fte === undefined ? undefined : String(input.fte),
              contractHoursWeek:
                input.contractHoursWeek === undefined || input.contractHoursWeek === null
                  ? undefined
                  : String(input.contractHoursWeek),
              reason: input.reason ?? null,
            }),
          )
          await kernel.emit(
            hrEvents.employmentChanged,
            {
              personId: input.personId,
              workspaceId: input.workspaceId,
              employmentId: row.id,
              effectiveFrom: input.effectiveFrom,
            },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return PeopleService.toEmployment(row)
        }),
    },

    // ================================================================= org
    org: {
      units: {
        tree: scoped.org.units.tree.use(requires('hr.org.view')).handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(orgUnits.workspaceId, input.workspaceId)]
            if (!input.includeArchived) where.push(isNull(orgUnits.archivedAt))
            const rows = await tx
              .select()
              .from(orgUnits)
              .where(and(...where))
              .orderBy(asc(orgUnits.path))
            // Headcount per unit in one grouped query rather than one per node: an org chart with
            // two hundred departments would otherwise be two hundred round trips to draw.
            const counts = await tx
              .select({ unitId: employments.orgUnitId, n: count() })
              .from(employments)
              .where(and(eq(employments.workspaceId, input.workspaceId), isNull(employments.effectiveTo)))
              .groupBy(employments.orgUnitId)
            const byUnit = new Map(counts.map((c) => [c.unitId, c.n]))
            return rows.map((r) => ({
              ...r,
              archivedAt: r.archivedAt?.toISOString() ?? null,
              headcount: byUnit.get(r.id) ?? 0,
            }))
          }),
        ),

        create: scoped.org.units.create.use(requires('hr.org.manage')).handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const id = uuidv7()
            const path = await childPath(tx, input.workspaceId, input.parentId ?? null, id)
            const [created] = await tx
              .insert(orgUnits)
              .values({
                id,
                workspaceId: input.workspaceId,
                parentId: input.parentId ?? null,
                path,
                name: input.name,
                code: input.code ?? null,
                headPersonId: input.headPersonId ?? null,
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'org_unit', row.id, 'created')
          return { ...row, archivedAt: null }
        }),

        update: scoped.org.units.update.use(requires('hr.org.manage')).handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const set: Record<string, unknown> = { updatedAt: new Date() }
            if (input.name !== undefined) set.name = input.name
            if (input.code !== undefined) set.code = input.code
            if (input.headPersonId !== undefined) set.headPersonId = input.headPersonId
            const [updated] = await tx
              .update(orgUnits)
              .set(set)
              .where(and(eq(orgUnits.workspaceId, input.workspaceId), eq(orgUnits.id, input.unitId)))
              .returning()
            if (!updated) throw KernError.notFound('Department')
            return updated
          })
          await changed(input.workspaceId, 'org_unit', row.id, 'updated')
          return { ...row, archivedAt: row.archivedAt?.toISOString() ?? null }
        }),

        /**
         * Reparent a unit and rewrite the ltree path of everything beneath it.
         *
         * One `UPDATE` over the subtree rather than a walk, and it refuses to move a unit under its
         * own descendant — which would detach that whole branch from the root and is the one way an
         * ltree hierarchy can be corrupted beyond repair by an ordinary drag.
         */
        move: scoped.org.units.move.use(requires('hr.org.manage')).handler(async ({ input }) => {
          const rows = await db.withWorkspace(input.workspaceId, async (tx) => {
            const [unit] = await tx
              .select()
              .from(orgUnits)
              .where(and(eq(orgUnits.workspaceId, input.workspaceId), eq(orgUnits.id, input.unitId)))
              .limit(1)
            if (!unit) throw KernError.notFound('Department')

            const newParentPath = await parentPath(tx, input.workspaceId, input.parentId)
            if (input.parentId) {
              const [target] = await tx
                .select({ path: orgUnits.path })
                .from(orgUnits)
                .where(and(eq(orgUnits.workspaceId, input.workspaceId), eq(orgUnits.id, input.parentId)))
                .limit(1)
              if (!target) throw KernError.notFound('Department')
              if (target.path === unit.path || target.path.startsWith(`${unit.path}.`))
                throw KernError.badRequest('A department cannot be moved underneath itself.')
            }

            const label = unit.path.split('.').pop()!
            const nextPath = newParentPath ? `${newParentPath}.${label}` : label
            await tx.execute(sql`
              update ${orgUnits}
                 set path = ${nextPath}::ltree || subpath(path, nlevel(${unit.path}::ltree)),
                     updated_at = now()
               where workspace_id = ${input.workspaceId}
                 and path <@ ${unit.path}::ltree
            `)
            await tx.update(orgUnits).set({ parentId: input.parentId }).where(eq(orgUnits.id, input.unitId))

            return tx
              .select()
              .from(orgUnits)
              .where(and(eq(orgUnits.workspaceId, input.workspaceId), sql`path <@ ${nextPath}::ltree`))
              .orderBy(asc(orgUnits.path))
          })
          await changed(input.workspaceId, 'org_unit', input.unitId, 'updated')
          return rows.map((r) => ({ ...r, archivedAt: r.archivedAt?.toISOString() ?? null }))
        }),

        archive: scoped.org.units.archive.use(requires('hr.org.manage')).handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const [held] = await tx
              .select({ n: count() })
              .from(employments)
              .where(
                and(
                  eq(employments.workspaceId, input.workspaceId),
                  eq(employments.orgUnitId, input.unitId),
                  isNull(employments.effectiveTo),
                ),
              )
            if ((held?.n ?? 0) > 0)
              throw KernError.conflict(
                `${held?.n} people still report into this department. Move them first.`,
              )
            await tx
              .update(orgUnits)
              .set({ archivedAt: new Date() })
              .where(and(eq(orgUnits.workspaceId, input.workspaceId), eq(orgUnits.id, input.unitId)))
          })
          await changed(input.workspaceId, 'org_unit', input.unitId, 'deleted')
          return { ok: true as const }
        }),
      },

      positions: {
        list: scoped.org.positions.list.use(requires('hr.org.view')).handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(positions.workspaceId, input.workspaceId)]
            if (!input.includeArchived) where.push(isNull(positions.archivedAt))
            const rows = await tx
              .select()
              .from(positions)
              .where(and(...where))
              .orderBy(asc(positions.title))
            return rows.map((r) => ({ ...r, archivedAt: r.archivedAt?.toISOString() ?? null }))
          }),
        ),
        create: scoped.org.positions.create.use(requires('hr.org.manage')).handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const [created] = await tx
              .insert(positions)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                title: input.title,
                code: input.code ?? null,
                jobFamily: input.jobFamily ?? null,
                level: input.level ?? null,
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'position', row.id, 'created')
          return { ...row, archivedAt: null }
        }),
        update: scoped.org.positions.update.use(requires('hr.org.manage')).handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const set: Record<string, unknown> = {}
            if (input.title !== undefined) set.title = input.title
            if (input.code !== undefined) set.code = input.code
            if (input.jobFamily !== undefined) set.jobFamily = input.jobFamily
            if (input.level !== undefined) set.level = input.level
            const [updated] = await tx
              .update(positions)
              .set(set)
              .where(and(eq(positions.workspaceId, input.workspaceId), eq(positions.id, input.positionId)))
              .returning()
            if (!updated) throw KernError.notFound('Position')
            return updated
          })
          await changed(input.workspaceId, 'position', row.id, 'updated')
          return { ...row, archivedAt: row.archivedAt?.toISOString() ?? null }
        }),
        archive: scoped.org.positions.archive.use(requires('hr.org.manage')).handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, (tx) =>
            tx
              .update(positions)
              .set({ archivedAt: new Date() })
              .where(and(eq(positions.workspaceId, input.workspaceId), eq(positions.id, input.positionId))),
          )
          await changed(input.workspaceId, 'position', input.positionId, 'deleted')
          return { ok: true as const }
        }),
      },
    },

    // ================================================================= offices
    offices: {
      list: scoped.offices.list
        .use(cap('offices'))
        .use(requires('hr.office.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(offices.workspaceId, input.workspaceId)]
            if (!input.includeArchived) where.push(isNull(offices.archivedAt))
            const rows = await tx
              .select()
              .from(offices)
              .where(and(...where))
              .orderBy(desc(offices.isDefault), asc(offices.name))
            const counts = await tx
              .select({ officeId: officeAssignments.officeId, n: count() })
              .from(officeAssignments)
              .where(
                and(
                  eq(officeAssignments.workspaceId, input.workspaceId),
                  eq(officeAssignments.isPrimary, true),
                  isNull(officeAssignments.effectiveTo),
                ),
              )
              .groupBy(officeAssignments.officeId)
            const byOffice = new Map(counts.map((c) => [c.officeId, c.n]))
            return rows.map((r) => ({ ...toOffice(r), headcount: byOffice.get(r.id) ?? 0 }))
          }),
        ),

      get: scoped.offices.get
        .use(cap('offices'))
        .use(requires('hr.office.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => toOffice(await loadOffice(tx, input))),
        ),

      create: scoped.offices.create
        .use(cap('offices'))
        .use(requires('hr.office.manage'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            let calendarId: string | null = null
            if (input.seedCalendarFromPack) {
              // The office's own calendar *extends* the country pack rather than copying it, so a
              // pack refresh reaches this office without reconciling a copy — and days HR add here
              // stay `custom` and survive that refresh untouched.
              const base = await packCalendar(tx, input.workspaceId, input.country)
              const [own] = await tx
                .insert(calendars)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  name: input.name,
                  extendsId: base?.id ?? null,
                  country: input.country,
                  region: input.region ?? null,
                  workingWeek: (base?.workingWeek as Record<string, number>) ?? DEFAULT_WORKING_WEEK,
                  source: 'custom',
                })
                .returning()
              calendarId = own!.id
            }
            const [created] = await tx
              .insert(offices)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                name: input.name,
                kind: input.kind,
                code: input.code ?? null,
                parentOfficeId: input.parentOfficeId ?? null,
                legalEntityId: input.legalEntityId ?? null,
                country: input.country,
                region: input.region ?? null,
                city: input.city ?? null,
                timezone: input.timezone,
                calendarId,
                isDefault: false,
              })
              .returning()
            return created!
          })
          await kernel.emit(
            hrEvents.officeCreated,
            { officeId: row.id, workspaceId: input.workspaceId, country: row.country },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'office', row.id, 'created')
          return toOffice(row)
        }),

      update: scoped.offices.update
        .use(cap('offices'))
        .use(requires('hr.office.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const { workspaceId, officeId, ...patch } = input
            const set: Record<string, unknown> = { updatedAt: new Date() }
            for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v
            const [updated] = await tx
              .update(offices)
              .set(set)
              .where(and(eq(offices.workspaceId, workspaceId), eq(offices.id, officeId)))
              .returning()
            if (!updated) throw KernError.notFound('Office')
            return updated
          })
          await changed(input.workspaceId, 'office', row.id, 'updated')
          return toOffice(row)
        }),

      archive: scoped.offices.archive
        .use(cap('offices'))
        .use(requires('hr.office.manage'))
        .handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const office = await loadOffice(tx, input)
            // The default office is where everyone without an assignment lands and where the
            // resolution ladder bottoms out. Archiving it would leave people with no calendar and no
            // timezone, so it has to be handed over first.
            if (office.isDefault)
              throw KernError.conflict(
                'This is the default office. Make another office the default before archiving it.',
              )
            const [held] = await tx
              .select({ n: count() })
              .from(officeAssignments)
              .where(
                and(
                  eq(officeAssignments.workspaceId, input.workspaceId),
                  eq(officeAssignments.officeId, input.officeId),
                  isNull(officeAssignments.effectiveTo),
                ),
              )
            if ((held?.n ?? 0) > 0)
              throw KernError.conflict(`${held?.n} people still work here. Move them first.`)
            await tx
              .update(offices)
              .set({ archivedAt: new Date() })
              .where(and(eq(offices.workspaceId, input.workspaceId), eq(offices.id, input.officeId)))
          })
          await changed(input.workspaceId, 'office', input.officeId, 'deleted')
          return { ok: true as const }
        }),

      setDefault: scoped.offices.setDefault
        .use(cap('offices'))
        .use(requires('hr.office.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            // Clear first, then set. A partial unique index enforces one default per workspace, so
            // the other order fails on the constraint rather than doing the obvious thing.
            await tx
              .update(offices)
              .set({ isDefault: false })
              .where(and(eq(offices.workspaceId, input.workspaceId), eq(offices.isDefault, true)))
            const [updated] = await tx
              .update(offices)
              .set({ isDefault: true, updatedAt: new Date() })
              .where(and(eq(offices.workspaceId, input.workspaceId), eq(offices.id, input.officeId)))
              .returning()
            if (!updated) throw KernError.notFound('Office')
            return updated
          })
          await changed(input.workspaceId, 'office', row.id, 'updated')
          return toOffice(row)
        }),

      people: scoped.offices.people
        .use(cap('offices'))
        .use(requires('hr.office.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [
              eq(officeAssignments.workspaceId, input.workspaceId),
              eq(officeAssignments.officeId, input.officeId),
              isNull(officeAssignments.effectiveTo),
            ]
            if (input.primaryOnly) where.push(eq(officeAssignments.isPrimary, true))
            const assignments = await tx
              .select()
              .from(officeAssignments)
              .where(and(...where))
              .limit(input.limit)
            if (!assignments.length) return { items: [], nextCursor: null, total: 0 }
            const rows = await tx
              .select()
              .from(people)
              .where(
                and(
                  eq(people.workspaceId, input.workspaceId),
                  inArray(
                    people.id,
                    assignments.map((a) => a.personId),
                  ),
                ),
              )
              .orderBy(asc(people.displayName))
            const primaryHere = new Set(assignments.filter((a) => a.isPrimary).map((a) => a.personId))
            return {
              items: rows.map((r) => ({
                ...PeopleService.toPerson(r),
                isPrimaryHere: primaryHere.has(r.id),
              })),
              nextCursor: null,
              total: rows.length,
            }
          }),
        ),

      assign: scoped.offices.assign
        .use(cap('offices'))
        .use(requires('hr.office.assign'))
        .handler(async ({ input, context }) => {
          const rows = await db.withWorkspace(input.workspaceId, async (tx) => {
            await loadOffice(tx, input)
            return svc.assignOffice(
              tx,
              input.workspaceId,
              input.personId,
              input.officeId,
              input.isPrimary,
              input.effectiveFrom,
              input.reason ?? null,
            )
          })
          await kernel.emit(
            hrEvents.officeAssignmentChanged,
            {
              personId: input.personId,
              workspaceId: input.workspaceId,
              officeId: input.officeId,
              isPrimary: input.isPrimary,
              effectiveFrom: input.effectiveFrom,
            },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return rows.map(PeopleService.toAssignment)
        }),

      unassign: scoped.offices.unassign
        .use(cap('offices'))
        .use(requires('hr.office.assign'))
        .handler(async ({ input, context }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const [row] = await tx
              .select()
              .from(officeAssignments)
              .where(
                and(
                  eq(officeAssignments.workspaceId, input.workspaceId),
                  eq(officeAssignments.officeId, input.officeId),
                  eq(officeAssignments.personId, input.personId),
                  isNull(officeAssignments.effectiveTo),
                ),
              )
              .limit(1)
            if (!row) throw KernError.notFound('Office assignment')
            // Removing somebody's *primary* office leaves them with no calendar, no timezone and no
            // policy — a person in that state is what the resolution ladder cannot answer for. Make
            // another office primary first.
            if (row.isPrimary)
              throw KernError.conflict(
                'This is their primary office. Assign another office as primary first.',
              )
            await tx
              .update(officeAssignments)
              .set({ effectiveTo: input.effectiveTo })
              .where(eq(officeAssignments.id, row.id))
          })
          await kernel.emit(
            hrEvents.officeAssignmentChanged,
            {
              personId: input.personId,
              workspaceId: input.workspaceId,
              officeId: input.officeId,
              isPrimary: false,
              effectiveFrom: input.effectiveTo,
            },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return { ok: true as const }
        }),

      /**
       * Not behind the `offices` capability, deliberately.
       *
       * A workspace with one office still has a ladder, and this is the first thing anybody reaches
       * for when a holiday or a timezone looks wrong. Gating it on the capability would mean the
       * support answer is only available to workspaces that already understand the model.
       */
      resolveFor: scoped.offices.resolveFor
        .use(requires('hr.person.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, (tx) =>
            resolve.forPerson(tx, input.workspaceId, input.personId, input.on),
          ),
        ),
    },

    // ================================================================= legal entities
    entities: {
      list: scoped.entities.list
        .use(cap('legal_entities'))
        .use(requires('hr.entity.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(legalEntities.workspaceId, input.workspaceId)]
            if (!input.includeArchived) where.push(isNull(legalEntities.archivedAt))
            const rows = await tx
              .select()
              .from(legalEntities)
              .where(and(...where))
              .orderBy(asc(legalEntities.name))
            return rows.map(toEntity)
          }),
        ),
      get: scoped.entities.get
        .use(cap('legal_entities'))
        .use(requires('hr.entity.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const [row] = await tx
              .select()
              .from(legalEntities)
              .where(
                and(eq(legalEntities.workspaceId, input.workspaceId), eq(legalEntities.id, input.entityId)),
              )
              .limit(1)
            if (!row) throw KernError.notFound('Legal entity')
            return toEntity(row)
          }),
        ),
      create: scoped.entities.create
        .use(cap('legal_entities'))
        .use(requires('hr.entity.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const [created] = await tx
              .insert(legalEntities)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                name: input.name,
                country: input.country,
                registrationNo: input.registrationNo ?? null,
                taxNo: input.taxNo ?? null,
                currency: input.currency ?? null,
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'legal_entity', row.id, 'created')
          return toEntity(row)
        }),
      update: scoped.entities.update
        .use(cap('legal_entities'))
        .use(requires('hr.entity.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const { workspaceId, entityId, ...patch } = input
            const set: Record<string, unknown> = { updatedAt: new Date() }
            for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v
            const [updated] = await tx
              .update(legalEntities)
              .set(set)
              .where(and(eq(legalEntities.workspaceId, workspaceId), eq(legalEntities.id, entityId)))
              .returning()
            if (!updated) throw KernError.notFound('Legal entity')
            return updated
          })
          await changed(input.workspaceId, 'legal_entity', row.id, 'updated')
          return toEntity(row)
        }),
      archive: scoped.entities.archive
        .use(cap('legal_entities'))
        .use(requires('hr.entity.manage'))
        .handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, (tx) =>
            tx
              .update(legalEntities)
              .set({ archivedAt: new Date() })
              .where(
                and(eq(legalEntities.workspaceId, input.workspaceId), eq(legalEntities.id, input.entityId)),
              ),
          )
          await changed(input.workspaceId, 'legal_entity', input.entityId, 'deleted')
          return { ok: true as const }
        }),

      costCenters: {
        list: scoped.entities.costCenters.list
          .use(cap('legal_entities'))
          .use(requires('hr.entity.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [eq(costCenters.workspaceId, input.workspaceId)]
              if (!input.includeArchived) where.push(isNull(costCenters.archivedAt))
              const rows = await tx
                .select()
                .from(costCenters)
                .where(and(...where))
                .orderBy(asc(costCenters.code))
              return rows.map((r) => ({ ...r, archivedAt: r.archivedAt?.toISOString() ?? null }))
            }),
          ),
        create: scoped.entities.costCenters.create
          .use(cap('legal_entities'))
          .use(requires('hr.entity.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const [created] = await tx
                .insert(costCenters)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  code: input.code,
                  name: input.name,
                  officeId: input.officeId ?? null,
                  orgUnitId: input.orgUnitId ?? null,
                  legalEntityId: input.legalEntityId ?? null,
                })
                .returning()
              return created!
            })
            await changed(input.workspaceId, 'cost_center', row.id, 'created')
            return { ...row, archivedAt: null }
          }),
        archive: scoped.entities.costCenters.archive
          .use(cap('legal_entities'))
          .use(requires('hr.entity.manage'))
          .handler(async ({ input }) => {
            await db.withWorkspace(input.workspaceId, (tx) =>
              tx
                .update(costCenters)
                .set({ archivedAt: new Date() })
                .where(
                  and(eq(costCenters.workspaceId, input.workspaceId), eq(costCenters.id, input.costCenterId)),
                ),
            )
            await changed(input.workspaceId, 'cost_center', input.costCenterId, 'deleted')
            return { ok: true as const }
          }),
      },
    },

    // ================================================================= calendars
    calendars: {
      list: scoped.calendars.list
        .use(cap('calendars'))
        .use(requires('hr.calendar.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const where = [eq(calendars.workspaceId, input.workspaceId)]
            if (!input.includeArchived) where.push(isNull(calendars.archivedAt))
            const rows = await tx
              .select()
              .from(calendars)
              .where(and(...where))
              .orderBy(asc(calendars.name))
            const used = await tx
              .select({ calendarId: offices.calendarId, officeId: offices.id })
              .from(offices)
              .where(eq(offices.workspaceId, input.workspaceId))
            return rows.map((r) => ({
              ...toCalendar(r),
              officeIds: used.filter((u) => u.calendarId === r.id).map((u) => u.officeId),
            }))
          }),
        ),

      get: scoped.calendars.get
        .use(cap('calendars'))
        .use(requires('hr.calendar.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) =>
            toCalendar(await loadCalendar(tx, input.workspaceId, input.calendarId)),
          ),
        ),

      create: scoped.calendars.create
        .use(cap('calendars'))
        .use(requires('hr.calendar.manage'))
        .handler(async ({ input }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            if (input.extendsId) await assertChainDepth(tx, input.workspaceId, input.extendsId)
            const [created] = await tx
              .insert(calendars)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                name: input.name,
                extendsId: input.extendsId ?? null,
                country: input.country ?? null,
                region: input.region ?? null,
                workingWeek: (input.workingWeek as Record<string, number>) ?? DEFAULT_WORKING_WEEK,
                source: 'custom',
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'calendar', row.id, 'created')
          return toCalendar(row)
        }),

      update: scoped.calendars.update
        .use(cap('calendars'))
        .use(requires('hr.calendar.manage'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            if (input.extendsId) {
              if (input.extendsId === input.calendarId)
                throw KernError.badRequest('A calendar cannot extend itself.')
              await assertChainDepth(tx, input.workspaceId, input.extendsId, input.calendarId)
            }
            const set: Record<string, unknown> = { updatedAt: new Date() }
            if (input.name !== undefined) set.name = input.name
            if (input.workingWeek !== undefined) set.workingWeek = input.workingWeek
            if (input.extendsId !== undefined) set.extendsId = input.extendsId
            const [updated] = await tx
              .update(calendars)
              .set(set)
              .where(and(eq(calendars.workspaceId, input.workspaceId), eq(calendars.id, input.calendarId)))
              .returning()
            if (!updated) throw KernError.notFound('Calendar')
            return updated
          })
          await emitCalendarChanged(input.workspaceId, input.calendarId, null, null, context.principal.userId)
          return toCalendar(row)
        }),

      archive: scoped.calendars.archive
        .use(cap('calendars'))
        .use(requires('hr.calendar.manage'))
        .handler(async ({ input }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const [used] = await tx
              .select({ n: count() })
              .from(offices)
              .where(
                and(eq(offices.workspaceId, input.workspaceId), eq(offices.calendarId, input.calendarId)),
              )
            if ((used?.n ?? 0) > 0)
              throw KernError.conflict(
                `${used?.n} offices use this calendar. Point them at another one first.`,
              )
            await tx
              .update(calendars)
              .set({ archivedAt: new Date() })
              .where(and(eq(calendars.workspaceId, input.workspaceId), eq(calendars.id, input.calendarId)))
          })
          await changed(input.workspaceId, 'calendar', input.calendarId, 'deleted')
          return { ok: true as const }
        }),

      days: {
        list: scoped.calendars.days.list
          .use(cap('calendars'))
          .use(requires('hr.calendar.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, (tx) =>
              composedDays(tx, input.workspaceId, input.calendarId, input.from, input.to),
            ),
          ),

        add: scoped.calendars.days.add
          .use(cap('calendars'))
          .use(requires('hr.calendar.manage'))
          .handler(async ({ input, context }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              await loadCalendar(tx, input.workspaceId, input.calendarId)
              const [created] = await tx
                .insert(calendarDays)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  calendarId: input.calendarId,
                  date: input.date,
                  kind: input.kind,
                  name: input.name,
                  workingFraction: String(input.workingFraction),
                  // Always `custom`. A day HR adds is theirs, and a pack upgrade must never
                  // overwrite or remove it — that is the whole point of tracking source per day.
                  source: 'custom',
                  paid: input.paid,
                  note: input.note ?? null,
                })
                .onConflictDoUpdate({
                  target: [calendarDays.calendarId, calendarDays.date, calendarDays.kind],
                  set: {
                    name: input.name,
                    workingFraction: String(input.workingFraction),
                    paid: input.paid,
                    note: input.note ?? null,
                    source: 'custom',
                  },
                })
                .returning()
              return created!
            })
            await emitCalendarChanged(
              input.workspaceId,
              input.calendarId,
              input.date,
              input.date,
              context.principal.userId,
            )
            return toResolvedDay(row, input.calendarId, '', false)
          }),

        update: scoped.calendars.days.update
          .use(cap('calendars'))
          .use(requires('hr.calendar.manage'))
          .handler(async ({ input, context }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const set: Record<string, unknown> = {}
              if (input.name !== undefined) set.name = input.name
              if (input.kind !== undefined) set.kind = input.kind
              if (input.workingFraction !== undefined) set.workingFraction = String(input.workingFraction)
              if (input.paid !== undefined) set.paid = input.paid
              if (input.note !== undefined) set.note = input.note
              // Editing a pack day makes it the workspace's own. Leaving it `pack` would mean the
              // next upgrade silently reverted the edit.
              set.source = 'custom'
              const [updated] = await tx
                .update(calendarDays)
                .set(set)
                .where(and(eq(calendarDays.workspaceId, input.workspaceId), eq(calendarDays.id, input.dayId)))
                .returning()
              if (!updated) throw KernError.notFound('Calendar day')
              return updated
            })
            await emitCalendarChanged(
              input.workspaceId,
              input.calendarId,
              row.date,
              row.date,
              context.principal.userId,
            )
            return toResolvedDay(row, input.calendarId, '', false)
          }),

        /**
         * A `custom` day is deleted. A `pack` day cannot be — it belongs to the pack and the next
         * upgrade would bring it straight back — so this writes a suppressing `working_override`
         * over it and says so, rather than appearing to work and silently undoing itself in January.
         */
        remove: scoped.calendars.days.remove
          .use(cap('calendars'))
          .use(requires('hr.calendar.manage'))
          .handler(async ({ input, context }) => {
            const result = await db.withWorkspace(input.workspaceId, async (tx) => {
              const [row] = await tx
                .select()
                .from(calendarDays)
                .where(and(eq(calendarDays.workspaceId, input.workspaceId), eq(calendarDays.id, input.dayId)))
                .limit(1)
              if (!row) throw KernError.notFound('Calendar day')

              if (row.source === 'custom' && row.calendarId === input.calendarId) {
                await tx.delete(calendarDays).where(eq(calendarDays.id, row.id))
                return { date: row.date, suppressed: false }
              }

              await tx
                .insert(calendarDays)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  calendarId: input.calendarId,
                  date: row.date,
                  kind: 'working_override',
                  name: row.name,
                  workingFraction: '1',
                  source: 'custom',
                  paid: false,
                  note: 'Worked despite the calendar it extends',
                })
                .onConflictDoNothing()
              return { date: row.date, suppressed: true }
            })
            await emitCalendarChanged(
              input.workspaceId,
              input.calendarId,
              result.date,
              result.date,
              context.principal.userId,
            )
            return { ok: true as const, suppressed: result.suppressed }
          }),
      },

      pack: {
        preview: scoped.calendars.pack.preview
          .use(cap('calendars'))
          .use(requires('hr.calendar.manage'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, (tx) =>
              diffPack(tx, input.workspaceId, input.calendarId, input.packKey, input.year),
            ),
          ),

        apply: scoped.calendars.pack.apply
          .use(cap('calendars'))
          .use(requires('hr.calendar.manage'))
          .handler(async ({ input, context }) => {
            const result = await db.withWorkspace(input.workspaceId, async (tx) => {
              const diff = await diffPack(tx, input.workspaceId, input.calendarId, input.packKey, input.year)
              const from = `${input.year}-01-01`
              const to = `${input.year}-12-31`
              // Only `pack` rows are touched. Everything HR added stays exactly as it is — which is
              // the promise the preview made, and the one thing this operation must never break.
              await tx
                .delete(calendarDays)
                .where(
                  and(
                    eq(calendarDays.workspaceId, input.workspaceId),
                    eq(calendarDays.calendarId, input.calendarId),
                    eq(calendarDays.source, 'pack'),
                    gte(calendarDays.date, from),
                    lte(calendarDays.date, to),
                  ),
                )
              const pack = packDays(input.packKey, input.year)
              if (pack.length)
                await tx
                  .insert(calendarDays)
                  .values(
                    pack.map((d) => ({
                      id: uuidv7(),
                      workspaceId: input.workspaceId,
                      calendarId: input.calendarId,
                      date: d.date,
                      kind: d.kind,
                      name: d.name,
                      workingFraction: String(d.workingFraction),
                      source: 'pack' as const,
                      paid: true,
                    })),
                  )
                  .onConflictDoNothing()
              await tx
                .update(calendars)
                .set({ packKey: input.packKey, packVersion: String(input.year), updatedAt: new Date() })
                .where(eq(calendars.id, input.calendarId))
              return diff
            })
            await emitCalendarChanged(
              input.workspaceId,
              input.calendarId,
              `${input.year}-01-01`,
              `${input.year}-12-31`,
              context.principal.userId,
            )
            return {
              ok: true as const,
              added: result.added.length,
              changed: result.changed.length,
              removed: result.removed.length,
            }
          }),
      },

      workingDays: scoped.calendars.workingDays
        .use(cap('calendars'))
        .use(requires('hr.calendar.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            let calendarId = input.calendarId ?? null
            let week: WorkingWeek = DEFAULT_WORKING_WEEK
            if (input.personId) {
              const r = await resolve.forPerson(tx, input.workspaceId, input.personId, input.from)
              calendarId = r.calendarId
              week = r.workingWeek
            } else if (calendarId) {
              week = (await loadCalendar(tx, input.workspaceId, calendarId))
                .workingWeek as unknown as WorkingWeek
            }
            const days = calendarId
              ? await composedDays(tx, input.workspaceId, calendarId, input.from, input.to)
              : []
            const results = workingDays(
              input.from,
              input.to,
              week,
              days.map((d) => ({ date: d.date, name: d.name, workingFraction: d.workingFraction })),
            )
            return { days: countWorkingDays(results), breakdown: results }
          }),
        ),
    },

    // ================================================================= documents
    documents: {
      list: scoped.documents.list
        .use(cap('documents'))
        .use(requires('hr.document.view'))
        .handler(({ input }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const rows = await tx
              .select()
              .from(personDocuments)
              .where(
                and(
                  eq(personDocuments.workspaceId, input.workspaceId),
                  eq(personDocuments.personId, input.personId),
                ),
              )
              .orderBy(desc(personDocuments.createdAt))
            return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
          }),
        ),
      attach: scoped.documents.attach
        .use(cap('documents'))
        .use(requires('hr.document.manage'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const [created] = await tx
              .insert(personDocuments)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                personId: input.personId,
                fileId: input.fileId,
                name: input.name,
                kind: input.kind,
                issuedOn: input.issuedOn ?? null,
                expiresOn: input.expiresOn ?? null,
                uploadedBy: context.principal.userId ?? null,
              })
              .returning()
            // The document's *existence* is audited, never its contents.
            await svc.record(tx, input.workspaceId, input.personId, context.principal.userId ?? null, [
              { field: 'document.attached', from: null, to: input.name },
            ])
            return created!
          })
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return { ...row, createdAt: row.createdAt.toISOString() }
        }),
      remove: scoped.documents.remove
        .use(cap('documents'))
        .use(requires('hr.document.manage'))
        .handler(async ({ input, context }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const [row] = await tx
              .select()
              .from(personDocuments)
              .where(
                and(
                  eq(personDocuments.workspaceId, input.workspaceId),
                  eq(personDocuments.id, input.documentId),
                ),
              )
              .limit(1)
            if (!row) throw KernError.notFound('Document')
            await tx.delete(personDocuments).where(eq(personDocuments.id, row.id))
            await svc.record(tx, input.workspaceId, input.personId, context.principal.userId ?? null, [
              { field: 'document.removed', from: row.name, to: null },
            ])
          })
          await changed(input.workspaceId, 'person', input.personId, 'updated')
          return { ok: true as const }
        }),
    },

    // ================================================================= custom fields
    fields: {
      list: scoped.fields.list.use(requires('hr.person.view')).handler(({ input }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const where = [eq(customFieldDefs.workspaceId, input.workspaceId)]
          if (!input.includeArchived) where.push(isNull(customFieldDefs.archivedAt))
          const rows = await tx
            .select()
            .from(customFieldDefs)
            .where(and(...where))
            .orderBy(asc(customFieldDefs.order), asc(customFieldDefs.name))
          return rows.map(toField)
        }),
      ),
      create: scoped.fields.create.use(requires('hr.field.manage')).handler(async ({ input }) => {
        const row = await db.withWorkspace(input.workspaceId, async (tx) => {
          const [created] = await tx
            .insert(customFieldDefs)
            .values({
              id: uuidv7(),
              workspaceId: input.workspaceId,
              key: input.key,
              name: input.name,
              type: input.type,
              options: input.options ?? null,
              required: input.required,
              sensitive: input.sensitive,
              section: input.section,
            })
            .returning()
          return created!
        })
        await changed(input.workspaceId, 'field', row.id, 'created')
        return toField(row)
      }),
      update: scoped.fields.update.use(requires('hr.field.manage')).handler(async ({ input }) => {
        const row = await db.withWorkspace(input.workspaceId, async (tx) => {
          const { workspaceId, fieldId, ...patch } = input
          const set: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v
          const [updated] = await tx
            .update(customFieldDefs)
            .set(set)
            .where(and(eq(customFieldDefs.workspaceId, workspaceId), eq(customFieldDefs.id, fieldId)))
            .returning()
          if (!updated) throw KernError.notFound('Field')
          return updated
        })
        await changed(input.workspaceId, 'field', row.id, 'updated')
        return toField(row)
      }),
      archive: scoped.fields.archive.use(requires('hr.field.manage')).handler(async ({ input }) => {
        // Archived, never dropped: the values stay in `people.custom`, so re-enabling the field
        // brings back what everybody had rather than a column of blanks.
        await db.withWorkspace(input.workspaceId, (tx) =>
          tx
            .update(customFieldDefs)
            .set({ archivedAt: new Date() })
            .where(
              and(eq(customFieldDefs.workspaceId, input.workspaceId), eq(customFieldDefs.id, input.fieldId)),
            ),
        )
        await changed(input.workspaceId, 'field', input.fieldId, 'deleted')
        return { ok: true as const }
      }),
    },
  })

  // ------------------------------------------------------------------ helpers
  // Closures over `kernel` and `db`, kept at the bottom so the router above reads as a list of
  // procedures rather than a list of procedures interrupted by plumbing.

  async function loadOffice(tx: Tx, input: { workspaceId: string; officeId: string }) {
    const [row] = await tx
      .select()
      .from(offices)
      .where(and(eq(offices.workspaceId, input.workspaceId), eq(offices.id, input.officeId)))
      .limit(1)
    if (!row) throw KernError.notFound('Office')
    return row
  }

  async function loadCalendar(tx: Tx, workspaceId: string, calendarId: string) {
    const [row] = await tx
      .select()
      .from(calendars)
      .where(and(eq(calendars.workspaceId, workspaceId), eq(calendars.id, calendarId)))
      .limit(1)
    if (!row) throw KernError.notFound('Calendar')
    return row
  }

  /** The workspace's calendar for a country pack, created on first use so offices can share one. */
  async function packCalendar(tx: Tx, workspaceId: string, country: string) {
    const [existing] = await tx
      .select()
      .from(calendars)
      .where(
        and(
          eq(calendars.workspaceId, workspaceId),
          eq(calendars.source, 'pack'),
          eq(calendars.packKey, country),
        ),
      )
      .limit(1)
    if (existing) return existing
    const pack = COUNTRY_PACKS[country]
    if (!pack) return undefined
    const [created] = await tx
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
    const year = new Date().getUTCFullYear()
    const days = packDays(country, year)
    if (days.length)
      await tx.insert(calendarDays).values(
        days.map((d) => ({
          id: uuidv7(),
          workspaceId,
          calendarId: created!.id,
          date: d.date,
          kind: d.kind,
          name: d.name,
          workingFraction: String(d.workingFraction),
          source: 'pack' as const,
          paid: true,
        })),
      )
    return created
  }

  /**
   * Walk `extends` and refuse a chain deeper than three, or one that would close a cycle.
   *
   * A cycle here does not throw anywhere obvious — it makes every calendar read spin, so the first
   * symptom is a report that never returns. Checked on write, where it is cheap and the person who
   * caused it is still looking at the screen.
   */
  async function assertChainDepth(tx: Tx, workspaceId: string, startId: string, selfId?: string) {
    let cursor: string | null = startId
    for (let depth = 0; depth < 4; depth++) {
      if (!cursor) return
      if (selfId && cursor === selfId)
        throw KernError.badRequest('That would make the calendars extend each other in a circle.')
      const row: { extendsId: string | null } | undefined = (
        await tx
          .select({ extendsId: calendars.extendsId })
          .from(calendars)
          .where(and(eq(calendars.workspaceId, workspaceId), eq(calendars.id, cursor)))
          .limit(1)
      )[0]
      cursor = row?.extendsId ?? null
    }
    throw KernError.badRequest('Calendars may only be built on three levels.')
  }

  /** The chain nearest-first: this calendar, then whatever it extends. */
  async function calendarChain(tx: Tx, workspaceId: string, calendarId: string) {
    const chain: Array<typeof calendars.$inferSelect> = []
    let cursor: string | null = calendarId
    for (let depth = 0; depth < 4 && cursor; depth++) {
      const row = await loadCalendar(tx, workspaceId, cursor)
      chain.push(row)
      cursor = row.extendsId
    }
    return chain
  }

  /**
   * The composed calendar over a range: this calendar's days over the ones it extends.
   *
   * Nearest wins per date and kind, and a day that shadows one from a calendar further down is
   * marked `overrides` so the editor can show what it is replacing — which is what makes "we work
   * through this national holiday" legible rather than looking like a missing holiday.
   */
  async function composedDays(tx: Tx, workspaceId: string, calendarId: string, from: string, to: string) {
    const chain = await calendarChain(tx, workspaceId, calendarId)
    const rows = await tx
      .select()
      .from(calendarDays)
      .where(
        and(
          eq(calendarDays.workspaceId, workspaceId),
          inArray(
            calendarDays.calendarId,
            chain.map((c) => c.id),
          ),
          gte(calendarDays.date, from),
          lte(calendarDays.date, to),
        ),
      )
    const nameById = new Map(chain.map((c) => [c.id, c.name]))
    const seen = new Map<string, ReturnType<typeof toResolvedDay>>()
    const datesFromNearest = new Set<string>()
    for (const cal of chain) {
      for (const row of rows.filter((r) => r.calendarId === cal.id)) {
        const key = `${row.date}:${row.kind}`
        if (seen.has(key)) continue
        const overrides = cal.id !== calendarId ? false : datesFromNearest.has(row.date)
        seen.set(key, toResolvedDay(row, cal.id, nameById.get(cal.id) ?? '', overrides))
        if (cal.id === calendarId) datesFromNearest.add(row.date)
      }
    }
    // Second pass: a nearest-calendar day covering a date the base also has *is* an override, and
    // the first pass cannot know that until the base has been read.
    const baseDates = new Set(rows.filter((r) => r.calendarId !== calendarId).map((r) => r.date))
    return [...seen.values()]
      .map((d) => ({ ...d, overrides: d.fromCalendarId === calendarId && baseDates.has(d.date) }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  /**
   * What applying a pack would do — and, just as importantly, what it would leave alone.
   *
   * The "kept" list is not decoration. The single most damaging thing this module could do is eat a
   * company's own holidays during a routine yearly refresh, silently, months before anyone notices.
   * Showing exactly which days survive is how an administrator can believe the operation.
   */
  async function diffPack(tx: Tx, workspaceId: string, calendarId: string, packKey: string, year: number) {
    const from = `${year}-01-01`
    const to = `${year}-12-31`
    const existing = await tx
      .select()
      .from(calendarDays)
      .where(
        and(
          eq(calendarDays.workspaceId, workspaceId),
          eq(calendarDays.calendarId, calendarId),
          gte(calendarDays.date, from),
          lte(calendarDays.date, to),
        ),
      )
    const currentPack = new Map(existing.filter((d) => d.source === 'pack').map((d) => [d.date, d]))
    const custom = existing.filter((d) => d.source === 'custom')
    const incoming = packDays(packKey, year)
    const incomingByDate = new Map(incoming.map((d) => [d.date, d]))

    return {
      packKey,
      packVersion: String(year),
      added: incoming.filter((d) => !currentPack.has(d.date)).map((d) => ({ date: d.date, name: d.name })),
      changed: incoming
        .filter((d) => currentPack.has(d.date) && currentPack.get(d.date)!.name !== d.name)
        .map((d) => ({ date: d.date, name: d.name, was: currentPack.get(d.date)!.name })),
      removed: [...currentPack.values()]
        .filter((d) => !incomingByDate.has(d.date))
        .map((d) => ({ date: d.date, name: d.name })),
      keptCustom: custom.map((d) => ({ date: d.date, name: d.name })),
    }
  }

  /** People in a department, optionally including everything beneath it. */
  async function unitMemberIds(
    tx: Tx,
    workspaceId: string,
    unitId: string,
    includeDescendants: boolean,
  ): Promise<string[]> {
    let unitIds = [unitId]
    if (includeDescendants) {
      const [unit] = await tx
        .select({ path: orgUnits.path })
        .from(orgUnits)
        .where(and(eq(orgUnits.workspaceId, workspaceId), eq(orgUnits.id, unitId)))
        .limit(1)
      if (!unit) return []
      // One GiST index lookup for the whole subtree, rather than a recursive walk.
      const subtree = await tx
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(and(eq(orgUnits.workspaceId, workspaceId), sql`path <@ ${unit.path}::ltree`))
      unitIds = subtree.map((u) => u.id)
    }
    if (!unitIds.length) return []
    const rows = await tx
      .select({ personId: employments.personId })
      .from(employments)
      .where(
        and(
          eq(employments.workspaceId, workspaceId),
          inArray(employments.orgUnitId, unitIds),
          isNull(employments.effectiveTo),
        ),
      )
    return rows.map((r) => r.personId)
  }

  async function parentPath(tx: Tx, workspaceId: string, parentId: string | null) {
    if (!parentId) return null
    const [row] = await tx
      .select({ path: orgUnits.path })
      .from(orgUnits)
      .where(and(eq(orgUnits.workspaceId, workspaceId), eq(orgUnits.id, parentId)))
      .limit(1)
    return row?.path ?? null
  }

  /**
   * An ltree label for a new unit.
   *
   * The id with dashes stripped, not the name: ltree labels allow only letters, digits and
   * underscores, and a department called "R&D — Europe" would otherwise be unrepresentable. Names
   * change too, and a path built from one would have to be rewritten on every rename.
   */
  async function childPath(tx: Tx, workspaceId: string, parentId: string | null, id: string) {
    const label = `u${id.replace(/-/g, '')}`
    const parent = await parentPath(tx, workspaceId, parentId)
    return parent ? `${parent}.${label}` : label
  }

  async function emitCalendarChanged(
    workspaceId: WorkspaceId,
    calendarId: string,
    from: string | null,
    to: string | null,
    actorId: string | null | undefined,
  ) {
    await kernel.emit(
      hrEvents.calendarChanged,
      { calendarId, workspaceId, from, to },
      { workspaceId, actorId },
    )
    await changed(workspaceId, 'calendar', calendarId, 'updated')
  }
}

// ---------------------------------------------------------------------- serialisers

const toOffice = (r: typeof offices.$inferSelect) => ({
  ...r,
  kind: r.kind as never,
  address: (r.address as Record<string, string> | null) ?? null,
  archivedAt: r.archivedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
})

const toEntity = (r: typeof legalEntities.$inferSelect) => ({
  ...r,
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toCalendar = (r: typeof calendars.$inferSelect) => ({
  ...r,
  workingWeek: r.workingWeek as unknown as WorkingWeek,
  source: r.source as 'pack' | 'custom',
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toField = (r: typeof customFieldDefs.$inferSelect) => ({
  ...r,
  type: r.type as never,
  section: r.section as never,
  options: r.options ?? null,
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toResolvedDay = (
  r: typeof calendarDays.$inferSelect,
  fromCalendarId: string,
  fromCalendarName: string,
  overrides: boolean,
) => ({
  ...r,
  kind: r.kind as never,
  source: r.source as 'pack' | 'custom',
  workingFraction: Number.parseFloat(r.workingFraction),
  fromCalendarId,
  fromCalendarName,
  overrides,
})
