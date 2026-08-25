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
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { HrSettings, hrContract, hrEvents, MODULE_ID, type WorkingWeek } from '../contract/index.js'
import { countWorkingDays, workingDays } from '../policy/calendar.js'
import { businessDateFor } from '../policy/working-time.js'
import { COUNTRY_PACKS, packDays } from './packs/index.js'
import {
  approvalChains,
  approvalDecisions,
  approvalRequests,
  approvalSteps,
  attendanceDays,
  calendarDays,
  calendars,
  costCenters,
  customFieldDefs,
  delegations,
  employments,
  leaveLedger,
  leaveRequestDays,
  leaveRequests,
  leaveTypes,
  legalEntities,
  officeAssignments,
  offices,
  orgUnits,
  people,
  peopleSensitive,
  personDocuments,
  personHistory,
  positions,
  punches,
  regularizations,
  scheduleAssignments,
  schedules,
} from './schema.js'
import { ApprovalService } from './services/approvals.js'
import { AttendanceService } from './services/attendance.js'
import { inForceOn, todayIn, todayIso } from './services/db.js'
import { LedgerService, MINUTES_PER_DAY, yearOf } from './services/ledger.js'
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
  const ledger = new LedgerService()
  const approvals = new ApprovalService(kernel)
  const attendance = new AttendanceService()
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

          // One query for the whole page rather than a resolution per row: a directory of five
          // hundred people would otherwise be five hundred ladder walks.
          const assignments = rows.length
            ? await tx
                .select({
                  personId: officeAssignments.personId,
                  officeId: officeAssignments.officeId,
                  name: offices.name,
                })
                .from(officeAssignments)
                .innerJoin(offices, eq(offices.id, officeAssignments.officeId))
                .where(
                  and(
                    eq(officeAssignments.workspaceId, input.workspaceId),
                    inArray(
                      officeAssignments.personId,
                      rows.map((r) => r.id),
                    ),
                    eq(officeAssignments.isPrimary, true),
                    isNull(officeAssignments.effectiveTo),
                  ),
                )
            : []
          const officeBy = new Map(assignments.map((a) => [a.personId, a]))

          return {
            items: rows.map((r) => ({
              ...PeopleService.toPerson(r),
              // Spreading into a fresh literal drops the branded WorkspaceId that flowed through
              // `toPerson`, so it is restored rather than widened to `string`.
              workspaceId: r.workspaceId as WorkspaceId,
              officeId: officeBy.get(r.id)?.officeId ?? null,
              officeName: officeBy.get(r.id)?.name ?? null,
            })),
            nextCursor: null,
            total: total?.n ?? 0,
          }
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

    // ================================================================= attendance
    attendance: {
      state: scoped.attendance.state
        .use(cap('attendance'))
        .use(requires('hr.attendance.view'))
        .handler(({ input, context }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const personId = await personFor(tx, input.workspaceId, context, input.personId)
            const { timezone, businessDate, schedule } = await clockContext(tx, input.workspaceId, personId)
            const rows = await attendance.punchesOn(tx, input.workspaceId, personId, businessDate)

            let open: Date | null = null
            let onBreak = false
            let workedMs = 0
            let breakOpen: Date | null = null
            for (const r of rows) {
              if (r.direction === 'in') open = r.at
              else if (r.direction === 'out' && open) {
                workedMs += r.at.getTime() - open.getTime()
                open = null
              } else if (r.direction === 'break_start') {
                breakOpen = r.at
                onBreak = true
              } else if (r.direction === 'break_end' && breakOpen) {
                workedMs -= r.at.getTime() - breakOpen.getTime()
                breakOpen = null
                onBreak = false
              }
            }
            // An open span counts up to now, so the widget shows time accruing rather than freezing
            // at the last completed pair.
            if (open) workedMs += Date.now() - open.getTime()
            if (breakOpen) workedMs -= Date.now() - breakOpen.getTime()
            void schedule

            return {
              personId,
              businessDate,
              clockedIn: open !== null,
              onBreak,
              since: (open ?? breakOpen)?.toISOString() ?? null,
              workedMinutesToday: Math.max(0, Math.round(workedMs / 60000)),
              timezone,
            }
          }),
        ),

      clockIn: scoped.attendance.clockIn
        .use(cap('attendance'))
        .use(requires('hr.attendance.punch'))
        .handler(({ input, context }) => punch(input, context, 'in')),
      clockOut: scoped.attendance.clockOut
        .use(cap('attendance'))
        .use(requires('hr.attendance.punch'))
        .handler(({ input, context }) => punch(input, context, 'out')),
      breakStart: scoped.attendance.breakStart
        .use(cap('attendance'))
        .use(requires('hr.attendance.punch'))
        .handler(({ input, context }) => punch(input, context, 'break_start')),
      breakEnd: scoped.attendance.breakEnd
        .use(cap('attendance'))
        .use(requires('hr.attendance.punch'))
        .handler(({ input, context }) => punch(input, context, 'break_end')),

      punches: {
        list: scoped.attendance.punches.list
          .use(cap('attendance'))
          .use(requires('hr.attendance.view'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              const where = [
                eq(punches.workspaceId, input.workspaceId),
                eq(punches.personId, personId),
                gte(punches.businessDate, input.from),
                lte(punches.businessDate, input.to),
              ]
              if (!input.includeVoided) where.push(isNull(punches.voidedByPunchId))
              const rows = await tx
                .select()
                .from(punches)
                .where(and(...where))
                .orderBy(asc(punches.at))
                .limit(input.limit)
              return { items: rows.map(toPunch), nextCursor: null }
            }),
          ),

        void: scoped.attendance.punches.void
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input, context }) => {
            const affected = await db.withWorkspace(input.workspaceId, async (tx) => {
              const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
              const { original } = await attendance.voidPunch(
                tx,
                input.workspaceId,
                input.punchId,
                input.reason,
                me?.id ?? null,
              )
              // The day is derived, so voiding a punch means the sheet is stale until it is rebuilt.
              const { timezone, schedule } = await clockContext(tx, input.workspaceId, original.personId)
              await attendance.recomputeDay(
                tx,
                input.workspaceId,
                original.personId,
                original.businessDate,
                timezone,
                schedule,
              )
              return original
            })
            await changed(input.workspaceId, 'attendance_day', affected.personId, 'updated')
            return { ok: true as const }
          }),
      },

      days: {
        list: scoped.attendance.days.list
          .use(cap('attendance'))
          .use(requires('hr.attendance.view'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [
                eq(attendanceDays.workspaceId, input.workspaceId),
                gte(attendanceDays.businessDate, input.from),
                lte(attendanceDays.businessDate, input.to),
              ]
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
                // Reading a whole office needs the team permission; reading yourself does not.
                await kernel.authz.require(context.principal, 'hr.attendance.view_team', {
                  kind: 'workspace',
                  id: input.workspaceId,
                  workspaceId: input.workspaceId,
                })
                where.push(
                  here.length
                    ? inArray(
                        attendanceDays.personId,
                        here.map((h) => h.personId),
                      )
                    : sql`false`,
                )
              } else {
                const personId = await personFor(tx, input.workspaceId, context, input.personId)
                where.push(eq(attendanceDays.personId, personId))
              }
              const rows = await tx
                .select()
                .from(attendanceDays)
                .where(and(...where))
                .orderBy(asc(attendanceDays.businessDate))
                .limit(input.limit)
              return { items: rows.map(toAttendanceDay), nextCursor: null }
            }),
          ),

        recompute: scoped.attendance.days.recompute
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              const { timezone, schedule } = await clockContext(tx, input.workspaceId, personId)
              const dates = await attendance.datesWithPunches(
                tx,
                input.workspaceId,
                personId,
                input.from,
                input.to,
              )
              let recomputed = 0
              const skippedLocked: string[] = []
              for (const date of dates) {
                const r = await attendance.recomputeDay(
                  tx,
                  input.workspaceId,
                  personId,
                  date,
                  timezone,
                  schedule,
                )
                // Named rather than silently skipped: a recomputation that quietly declines to touch
                // a closed month looks identical to one that had nothing to do.
                if (r.locked) skippedLocked.push(date)
                else recomputed++
              }
              return { recomputed, skippedLocked }
            }),
          ),
      },

      schedules: {
        list: scoped.attendance.schedules.list
          .use(cap('attendance'))
          .use(requires('hr.attendance.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [eq(schedules.workspaceId, input.workspaceId)]
              if (!input.includeArchived) where.push(isNull(schedules.archivedAt))
              const rows = await tx
                .select()
                .from(schedules)
                .where(and(...where))
                .orderBy(asc(schedules.name))
              return rows.map(toSchedule)
            }),
          ),
        create: scoped.attendance.schedules.create
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const [created] = await tx
                .insert(schedules)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  name: input.name,
                  kind: input.kind,
                  week: input.week as unknown as Record<string, unknown>,
                  tzMode: input.tzMode,
                  tz: input.tz ?? null,
                  graceInMinutes: input.graceInMinutes,
                  graceOutMinutes: input.graceOutMinutes,
                  roundingStepMinutes: input.roundingStepMinutes,
                  roundingDirection: input.roundingDirection,
                  autoClockOutAfterMinutes: input.autoClockOutAfterMinutes ?? null,
                })
                .returning()
              return created!
            })
            await changed(input.workspaceId, 'schedule', row.id, 'created')
            return toSchedule(row)
          }),
        update: scoped.attendance.schedules.update
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const { workspaceId, scheduleId, ...patch } = input
              const set: Record<string, unknown> = { updatedAt: new Date() }
              for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v
              const [updated] = await tx
                .update(schedules)
                .set(set)
                .where(and(eq(schedules.workspaceId, workspaceId), eq(schedules.id, scheduleId)))
                .returning()
              if (!updated) throw KernError.notFound('Schedule')
              return updated
            })
            await changed(input.workspaceId, 'schedule', row.id, 'updated')
            return toSchedule(row)
          }),
        archive: scoped.attendance.schedules.archive
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            await db.withWorkspace(input.workspaceId, (tx) =>
              tx
                .update(schedules)
                .set({ archivedAt: new Date() })
                .where(and(eq(schedules.workspaceId, input.workspaceId), eq(schedules.id, input.scheduleId))),
            )
            await changed(input.workspaceId, 'schedule', input.scheduleId, 'deleted')
            return { ok: true as const }
          }),
        assign: scoped.attendance.schedules.assign
          .use(cap('attendance'))
          .use(requires('hr.attendance.manage'))
          .handler(async ({ input }) => {
            const rows = await db.withWorkspace(input.workspaceId, async (tx) => {
              // Effective-dated like everything else here: the old assignment is closed the day
              // before, so "which schedule was she on in March" stays answerable.
              await tx
                .update(scheduleAssignments)
                .set({ effectiveTo: sql`${input.effectiveFrom}::date - 1` })
                .where(
                  and(
                    eq(scheduleAssignments.workspaceId, input.workspaceId),
                    eq(scheduleAssignments.personId, input.personId),
                    isNull(scheduleAssignments.effectiveTo),
                  ),
                )
              await tx.insert(scheduleAssignments).values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                personId: input.personId,
                scheduleId: input.scheduleId,
                effectiveFrom: input.effectiveFrom,
              })
              return tx
                .select()
                .from(scheduleAssignments)
                .where(
                  and(
                    eq(scheduleAssignments.workspaceId, input.workspaceId),
                    eq(scheduleAssignments.personId, input.personId),
                  ),
                )
                .orderBy(desc(scheduleAssignments.effectiveFrom))
            })
            await changed(input.workspaceId, 'schedule', input.scheduleId, 'updated')
            return rows.map(toScheduleAssignment)
          }),
      },

      regularizations: {
        list: scoped.attendance.regularizations.list
          .use(cap('attendance'))
          .use(requires('hr.attendance.view'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              const where = [
                eq(regularizations.workspaceId, input.workspaceId),
                eq(regularizations.personId, personId),
              ]
              if (input.status?.length) where.push(inArray(regularizations.status, input.status))
              const rows = await tx
                .select()
                .from(regularizations)
                .where(and(...where))
                .orderBy(desc(regularizations.businessDate))
                .limit(input.limit)
              return { items: rows.map(toRegularization), nextCursor: null }
            }),
          ),

        request: scoped.attendance.regularizations.request
          .use(cap('attendance'))
          .use(requires('hr.attendance.punch'))
          .handler(async ({ input, context }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              const [created] = await tx
                .insert(regularizations)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  personId,
                  businessDate: input.businessDate,
                  punchId: input.punchId ?? null,
                  proposed: input.proposed as unknown as Array<Record<string, unknown>>,
                  reason: input.reason,
                  status: 'pending',
                })
                .returning()

              // The same engine leave uses. That reuse is the reason approvals were built keyed by
              // subject type rather than bolted onto leave_requests.
              const raised = await approvals.raise(tx, input.workspaceId, {
                subjectType: 'regularization',
                subjectId: created!.id,
                summary: `Correction for ${input.businessDate}`,
                requesterPersonId: personId,
                requestedBy: context.principal.userId ?? null,
                on: input.businessDate,
              })
              await tx
                .update(regularizations)
                .set({ approvalRequestId: raised.request.id })
                .where(eq(regularizations.id, created!.id))
              if (raised.autoApproved) await applyRegularization(tx, input.workspaceId, created!.id)

              const [fresh] = await tx
                .select()
                .from(regularizations)
                .where(eq(regularizations.id, created!.id))
              return fresh!
            })
            await changed(input.workspaceId, 'regularization', row.id, 'created')
            return toRegularization(row)
          }),
      },
    },

    // ================================================================= leave
    leave: {
      types: {
        list: scoped.leave.types.list
          .use(cap('leave'))
          .use(requires('hr.leave.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [eq(leaveTypes.workspaceId, input.workspaceId)]
              if (!input.includeArchived) where.push(isNull(leaveTypes.archivedAt))
              const rows = await tx
                .select()
                .from(leaveTypes)
                .where(and(...where))
                .orderBy(asc(leaveTypes.order), asc(leaveTypes.name))
              return rows.map(toLeaveType)
            }),
          ),
        create: scoped.leave.types.create
          .use(cap('leave'))
          .use(requires('hr.leave.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const [created] = await tx
                .insert(leaveTypes)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  key: input.key,
                  name: input.name,
                  paid: input.paid,
                  unit: input.unit,
                  color: input.color ?? null,
                  icon: input.icon ?? null,
                  requiresDocumentAfterDays: input.requiresDocumentAfterDays ?? null,
                  countsWorkingDaysOnly: input.countsWorkingDaysOnly,
                  allowNegative: input.allowNegative,
                  maxNegativeMinutes: input.maxNegativeMinutes,
                })
                .returning()
              return created!
            })
            await changed(input.workspaceId, 'leave_type', row.id, 'created')
            return toLeaveType(row)
          }),
        update: scoped.leave.types.update
          .use(cap('leave'))
          .use(requires('hr.leave.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const { workspaceId, leaveTypeId, ...patch } = input
              const set: Record<string, unknown> = { updatedAt: new Date() }
              for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v
              const [updated] = await tx
                .update(leaveTypes)
                .set(set)
                .where(and(eq(leaveTypes.workspaceId, workspaceId), eq(leaveTypes.id, leaveTypeId)))
                .returning()
              if (!updated) throw KernError.notFound('Leave type')
              return updated
            })
            await changed(input.workspaceId, 'leave_type', row.id, 'updated')
            return toLeaveType(row)
          }),
        archive: scoped.leave.types.archive
          .use(cap('leave'))
          .use(requires('hr.leave.manage'))
          .handler(async ({ input }) => {
            // Archived, never deleted: the ledger points at it, and a balance whose type has
            // vanished is a number nobody can explain.
            await db.withWorkspace(input.workspaceId, (tx) =>
              tx
                .update(leaveTypes)
                .set({ archivedAt: new Date() })
                .where(
                  and(eq(leaveTypes.workspaceId, input.workspaceId), eq(leaveTypes.id, input.leaveTypeId)),
                ),
            )
            await changed(input.workspaceId, 'leave_type', input.leaveTypeId, 'deleted')
            return { ok: true as const }
          }),
      },

      balance: {
        get: scoped.leave.balance.get
          .use(cap('leave'))
          .use(requires('hr.leave.view'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              const year = input.periodYear ?? new Date().getUTCFullYear()
              return ledger.balances(tx, input.workspaceId, personId, year)
            }),
          ),
      },

      ledger: {
        list: scoped.leave.ledger.list
          .use(cap('leave'))
          .use(requires('hr.leave.view_ledger'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [
                eq(leaveLedger.workspaceId, input.workspaceId),
                eq(leaveLedger.personId, input.personId),
              ]
              if (input.leaveTypeId) where.push(eq(leaveLedger.leaveTypeId, input.leaveTypeId))
              if (input.periodYear) where.push(eq(leaveLedger.periodYear, input.periodYear))
              const rows = await tx
                .select()
                .from(leaveLedger)
                .where(and(...where))
                .orderBy(desc(leaveLedger.effectiveOn), desc(leaveLedger.createdAt))
                .limit(input.limit)
              return { items: rows.map(toLedgerEntry), nextCursor: null }
            }),
          ),
      },

      adjust: scoped.leave.adjust
        .use(cap('leave'))
        .use(requires('hr.leave.adjust'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const year = yearOf(input.effectiveOn)
            await ledger.lockAndRead(tx, input.workspaceId, input.personId, input.leaveTypeId, year)
            return ledger.append(tx, input.workspaceId, {
              personId: input.personId,
              leaveTypeId: input.leaveTypeId,
              kind: input.kind,
              amountMinutes: input.amountMinutes,
              effectiveOn: input.effectiveOn,
              periodYear: year,
              reason: input.reason,
              createdBy: context.principal.userId ?? null,
            })
          })
          await kernel.emit(
            hrEvents.leaveBalanceChanged,
            {
              workspaceId: input.workspaceId,
              personId: input.personId,
              leaveTypeId: input.leaveTypeId,
              deltaMinutes: input.amountMinutes,
            },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, 'leave_balance', input.personId, 'updated')
          return toLedgerEntry(row)
        }),

      requests: {
        list: scoped.leave.requests.list
          .use(cap('leave'))
          .use(requires('hr.leave.view'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [eq(leaveRequests.workspaceId, input.workspaceId)]
              if (input.personId) where.push(eq(leaveRequests.personId, input.personId))
              else if (!context.principal.instanceAdmin) {
                // Without an explicit person, this is "my requests". Seeing everybody's by default
                // would leak the whole company's absences to any member with hr.leave.view.
                const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
                where.push(me ? eq(leaveRequests.personId, me.id) : sql`false`)
              }
              if (input.status?.length) where.push(inArray(leaveRequests.status, input.status))
              if (input.from) where.push(gte(leaveRequests.endsOn, input.from))
              if (input.to) where.push(lte(leaveRequests.startsOn, input.to))
              const rows = await tx
                .select()
                .from(leaveRequests)
                .where(and(...where))
                .orderBy(desc(leaveRequests.startsOn))
                .limit(input.limit)
              return { items: rows.map(toLeaveRequest), nextCursor: null }
            }),
          ),

        get: scoped.leave.requests.get
          .use(cap('leave'))
          .use(requires('hr.leave.view'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) =>
              toLeaveRequest(await loadRequest(tx, input.workspaceId, input.requestId)),
            ),
          ),

        simulate: scoped.leave.requests.simulate
          .use(cap('leave'))
          .use(requires('hr.leave.request'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)
              return simulate(tx, input.workspaceId, personId, input)
            }),
          ),

        create: scoped.leave.requests.create
          .use(cap('leave'))
          .use(requires('hr.leave.request'))
          .handler(async ({ input, context }) => {
            const result = await db.withWorkspace(input.workspaceId, async (tx) => {
              const personId = await personFor(tx, input.workspaceId, context, input.personId)

              // Everything that spends balance takes the cursor lock first, inside this
              // transaction. Two overlapping requests for the last day cannot both read "enough".
              const year = yearOf(input.startsOn)
              await ledger.lockAndRead(tx, input.workspaceId, personId, input.leaveTypeId, year)

              const sim = await simulate(tx, input.workspaceId, personId, input)
              if (sim.blockers.length)
                throw KernError.conflict(sim.blockers[0]!.message, `hr.leave.${sim.blockers[0]!.code}`)

              const [request] = await tx
                .insert(leaveRequests)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  personId,
                  leaveTypeId: input.leaveTypeId,
                  startsOn: input.startsOn,
                  endsOn: input.endsOn,
                  startPart: input.startPart,
                  endPart: input.endPart,
                  hours: input.hours === null || input.hours === undefined ? null : String(input.hours),
                  workingDays: String(sim.workingDays),
                  minutes: sim.minutes,
                  status: 'pending',
                  reason: input.reason ?? null,
                  documentFileId: input.documentFileId ?? null,
                  idempotencyKey: input.idempotencyKey ?? null,
                })
                .returning()

              // The exploded days are what the partial unique index guards, so this insert is what
              // actually refuses a double booking — before any approval happens.
              await tx.insert(leaveRequestDays).values(
                sim.days.map((d) => ({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  requestId: request!.id,
                  personId,
                  date: d.date,
                  fraction: String(d.fraction),
                  counted: d.counted,
                  status: 'pending',
                })),
              )

              const raised = await approvals.raise(tx, input.workspaceId, {
                subjectType: 'leave',
                subjectId: request!.id,
                summary: `${sim.workingDays} day(s) from ${input.startsOn}`,
                requesterPersonId: personId,
                requestedBy: context.principal.userId ?? null,
                on: input.startsOn,
              })

              await tx
                .update(leaveRequests)
                .set({ approvalRequestId: raised.request.id })
                .where(eq(leaveRequests.id, request!.id))

              // A chain that resolves to nobody approves immediately — a one-person company has no
              // manager and still has to be able to book time off.
              if (raised.autoApproved)
                await applyApproval(tx, input.workspaceId, request!.id, context.principal.userId ?? null)

              const [fresh] = await tx.select().from(leaveRequests).where(eq(leaveRequests.id, request!.id))
              return { request: fresh!, approvers: raised.firstStepApprovers, personId }
            })

            await kernel.emit(
              hrEvents.leaveRequested,
              {
                requestId: result.request.id,
                workspaceId: input.workspaceId,
                personId: result.personId,
                startsOn: input.startsOn,
                endsOn: input.endsOn,
              },
              { workspaceId: input.workspaceId, actorId: context.principal.userId },
            )
            await changed(input.workspaceId, 'leave_request', result.request.id, 'created')
            return toLeaveRequest(result.request)
          }),

        cancel: scoped.leave.requests.cancel
          .use(cap('leave'))
          .use(requires('hr.leave.request'))
          .handler(async ({ input, context }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const request = await loadRequest(tx, input.workspaceId, input.requestId)
              if (request.status === 'cancelled' || request.status === 'withdrawn')
                throw KernError.conflict('That request is already cancelled')

              const year = yearOf(request.startsOn)
              await ledger.lockAndRead(tx, input.workspaceId, request.personId, request.leaveTypeId, year)

              // Approved leave is *reversed*, not deleted. "She booked it and cancelled" and "she
              // never booked it" are different facts, and only one of them is true.
              if (request.status === 'approved')
                for (const entry of await ledger.entriesFor(tx, input.workspaceId, request.id))
                  if (entry.kind === 'consumption')
                    await ledger.reverse(
                      tx,
                      input.workspaceId,
                      entry.id,
                      input.reason ?? 'Leave cancelled',
                      context.principal.userId ?? null,
                      todayIso(),
                    )

              await approvals.cancel(tx, input.workspaceId, 'leave', request.id)
              const next = request.status === 'approved' ? 'withdrawn' : 'cancelled'
              await tx
                .update(leaveRequestDays)
                .set({ status: next })
                .where(eq(leaveRequestDays.requestId, request.id))
              const [updated] = await tx
                .update(leaveRequests)
                .set({ status: next, decidedAt: new Date(), updatedAt: new Date() })
                .where(eq(leaveRequests.id, request.id))
                .returning()
              return updated!
            })
            await kernel.emit(
              hrEvents.leaveDecided,
              {
                requestId: row.id,
                workspaceId: input.workspaceId,
                personId: row.personId,
                status: row.status,
                startsOn: row.startsOn,
                endsOn: row.endsOn,
              },
              { workspaceId: input.workspaceId, actorId: context.principal.userId },
            )
            await changed(input.workspaceId, 'leave_request', row.id, 'updated')
            return toLeaveRequest(row)
          }),
      },

      team: {
        calendar: scoped.leave.team.calendar
          .use(cap('leave'))
          .use(requires('hr.leave.view_team'))
          .handler(({ input, context }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const rows = await tx
                .select()
                .from(leaveRequests)
                .where(
                  and(
                    eq(leaveRequests.workspaceId, input.workspaceId),
                    inArray(leaveRequests.status, ['pending', 'approved']),
                    lte(leaveRequests.startsOn, input.to),
                    gte(leaveRequests.endsOn, input.from),
                  ),
                )
              if (!rows.length) return []

              const personIds = [...new Set(rows.map((r) => r.personId))]
              const persons = await tx
                .select({ id: people.id, displayName: people.displayName })
                .from(people)
                .where(and(eq(people.workspaceId, input.workspaceId), inArray(people.id, personIds)))
              const nameById = new Map(persons.map((p) => [p.id, p.displayName]))
              const types = await tx
                .select()
                .from(leaveTypes)
                .where(eq(leaveTypes.workspaceId, input.workspaceId))
              const typeById = new Map(types.map((t) => [t.id, t]))

              // Most companies want the team to know somebody is away without knowing it is sick
              // leave, so the type is named only for somebody who may read the ledger.
              const maySeeType = await kernel.authz.can(context.principal, 'hr.leave.view_ledger', {
                kind: 'workspace',
                id: input.workspaceId,
                workspaceId: input.workspaceId,
              })

              let filtered = rows
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
                const ids = new Set(here.map((h) => h.personId))
                filtered = filtered.filter((r) => ids.has(r.personId))
              }
              if (input.orgUnitId) {
                const ids = new Set(await unitMemberIds(tx, input.workspaceId, input.orgUnitId, true))
                filtered = filtered.filter((r) => ids.has(r.personId))
              }

              return filtered.map((r) => {
                const type = typeById.get(r.leaveTypeId)
                return {
                  personId: r.personId,
                  displayName: nameById.get(r.personId) ?? 'Unknown',
                  requestId: r.id,
                  startsOn: r.startsOn,
                  endsOn: r.endsOn,
                  status: r.status as never,
                  leaveTypeName: maySeeType ? (type?.name ?? null) : null,
                  color: type?.color ?? null,
                }
              })
            }),
          ),
      },
    },

    // ================================================================= approvals
    approvals: {
      /**
       * Everything waiting on the caller. No permission: an inbox of what *you* must decide is
       * yours by definition, and the engine only lists steps you are named on.
       */
      inbox: scoped.approvals.inbox.handler(({ input, context }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
          if (!me) return { items: [], nextCursor: null }
          const rows = await approvals.inboxFor(
            tx,
            input.workspaceId,
            me.id,
            input.includeDecided,
            input.limit,
          )
          const items = []
          for (const r of rows) items.push(await hydrateApproval(tx, r))
          return { items, nextCursor: null }
        }),
      ),

      get: scoped.approvals.get.handler(({ input }) =>
        db.withWorkspace(input.workspaceId, async (tx) => {
          const [row] = await tx
            .select()
            .from(approvalRequests)
            .where(
              and(
                eq(approvalRequests.workspaceId, input.workspaceId),
                eq(approvalRequests.id, input.requestId),
              ),
            )
            .limit(1)
          if (!row) throw KernError.notFound('Approval request')
          return hydrateApproval(tx, row)
        }),
      ),

      decide: scoped.approvals.decide.handler(async ({ input, context }) => {
        const outcome = await db.withWorkspace(input.workspaceId, async (tx) => {
          const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
          if (!me) throw KernError.forbidden('You have no employee record in this workspace')

          const result = await approvals.decide(
            tx,
            input.workspaceId,
            input.requestId,
            me.id,
            input.decision,
            input.comment ?? null,
            input.onBehalfOfId ?? null,
          )

          // The approval engine knows nothing about leave. Applying the decision to the subject is
          // the caller's job, which is what keeps the engine reusable for regularization and
          // overtime later.
          const request = result.request
          if (request.subjectType === 'leave') {
            if (result.status === 'approved')
              await applyApproval(tx, input.workspaceId, request.subjectId, context.principal.userId ?? null)
            else if (result.status === 'rejected')
              await tx
                .update(leaveRequests)
                .set({ status: 'rejected', decidedAt: new Date(), updatedAt: new Date() })
                .where(eq(leaveRequests.id, request.subjectId))
          } else if (request.subjectType === 'regularization') {
            if (result.status === 'approved')
              await applyRegularization(tx, input.workspaceId, request.subjectId)
            else if (result.status === 'rejected')
              await tx
                .update(regularizations)
                .set({ status: 'rejected' })
                .where(eq(regularizations.id, request.subjectId))
          }

          const [fresh] = await tx
            .select()
            .from(approvalRequests)
            .where(eq(approvalRequests.id, input.requestId))
          return { hydrated: await hydrateApproval(tx, fresh!), request: fresh! }
        })

        await kernel.emit(
          hrEvents.approvalDecided,
          {
            requestId: outcome.request.id,
            workspaceId: input.workspaceId,
            subjectType: outcome.request.subjectType,
            subjectId: outcome.request.subjectId,
            status: outcome.request.status,
          },
          { workspaceId: input.workspaceId, actorId: context.principal.userId },
        )
        await changed(input.workspaceId, 'approval', outcome.request.id, 'updated')
        return outcome.hydrated
      }),

      chains: {
        list: scoped.approvals.chains.list
          .use(cap('approvals'))
          .use(requires('hr.approval.manage'))
          .handler(({ input }) =>
            db.withWorkspace(input.workspaceId, async (tx) => {
              const where = [
                eq(approvalChains.workspaceId, input.workspaceId),
                isNull(approvalChains.archivedAt),
              ]
              if (input.subjectType) where.push(eq(approvalChains.subjectType, input.subjectType))
              const rows = await tx
                .select()
                .from(approvalChains)
                .where(and(...where))
                .orderBy(asc(approvalChains.name))
              return rows.map(toChain)
            }),
          ),
        create: scoped.approvals.chains.create
          .use(cap('approvals'))
          .use(requires('hr.approval.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              if (input.isDefault) await clearDefaultChain(tx, input.workspaceId, input.subjectType)
              const [created] = await tx
                .insert(approvalChains)
                .values({
                  id: uuidv7(),
                  workspaceId: input.workspaceId,
                  name: input.name,
                  subjectType: input.subjectType,
                  spec: input.spec as unknown as Record<string, unknown>,
                  isDefault: input.isDefault,
                })
                .returning()
              return created!
            })
            await changed(input.workspaceId, 'approval_chain', row.id, 'created')
            return toChain(row)
          }),
        update: scoped.approvals.chains.update
          .use(cap('approvals'))
          .use(requires('hr.approval.manage'))
          .handler(async ({ input }) => {
            const row = await db.withWorkspace(input.workspaceId, async (tx) => {
              const [existing] = await tx
                .select()
                .from(approvalChains)
                .where(
                  and(
                    eq(approvalChains.workspaceId, input.workspaceId),
                    eq(approvalChains.id, input.chainId),
                  ),
                )
                .limit(1)
              if (!existing) throw KernError.notFound('Approval chain')
              if (input.isDefault) await clearDefaultChain(tx, input.workspaceId, existing.subjectType)
              const set: Record<string, unknown> = { updatedAt: new Date() }
              if (input.name !== undefined) set.name = input.name
              if (input.spec !== undefined) set.spec = input.spec
              if (input.isDefault !== undefined) set.isDefault = input.isDefault
              const [updated] = await tx
                .update(approvalChains)
                .set(set)
                .where(eq(approvalChains.id, input.chainId))
                .returning()
              return updated!
            })
            await changed(input.workspaceId, 'approval_chain', row.id, 'updated')
            return toChain(row)
          }),
        archive: scoped.approvals.chains.archive
          .use(cap('approvals'))
          .use(requires('hr.approval.manage'))
          .handler(async ({ input }) => {
            // In-flight requests carry their own snapshot of the chain, so archiving one cannot
            // strand an approval half-signed.
            await db.withWorkspace(input.workspaceId, (tx) =>
              tx
                .update(approvalChains)
                .set({ archivedAt: new Date(), isDefault: false })
                .where(
                  and(
                    eq(approvalChains.workspaceId, input.workspaceId),
                    eq(approvalChains.id, input.chainId),
                  ),
                ),
            )
            await changed(input.workspaceId, 'approval_chain', input.chainId, 'deleted')
            return { ok: true as const }
          }),
      },

      delegations: scoped.approvals.delegations
        .use(cap('approvals'))
        .use(requires('hr.approval.delegate'))
        .handler(({ input, context }) =>
          db.withWorkspace(input.workspaceId, async (tx) => {
            const personId = await personFor(tx, input.workspaceId, context, input.personId)
            const rows = await tx
              .select()
              .from(delegations)
              .where(
                and(
                  eq(delegations.workspaceId, input.workspaceId),
                  or(eq(delegations.fromPersonId, personId), eq(delegations.toPersonId, personId)),
                ),
              )
              .orderBy(desc(delegations.startsOn))
            return rows.map(toDelegation)
          }),
        ),

      delegate: scoped.approvals.delegate
        .use(cap('approvals'))
        .use(requires('hr.approval.delegate'))
        .handler(async ({ input, context }) => {
          const row = await db.withWorkspace(input.workspaceId, async (tx) => {
            const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
            if (!me) throw KernError.forbidden('You have no employee record in this workspace')
            if (me.id === input.toPersonId)
              throw KernError.badRequest('You cannot delegate your approvals to yourself.')
            if (input.endsOn < input.startsOn)
              throw KernError.badRequest('A delegation cannot end before it starts.')
            const [created] = await tx
              .insert(delegations)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                fromPersonId: me.id,
                toPersonId: input.toPersonId,
                subjectType: input.subjectType ?? null,
                startsOn: input.startsOn,
                endsOn: input.endsOn,
                reason: input.reason ?? null,
              })
              .returning()
            return created!
          })
          await changed(input.workspaceId, 'delegation', row.id, 'created')
          return toDelegation(row)
        }),

      revokeDelegation: scoped.approvals.revokeDelegation
        .use(cap('approvals'))
        .use(requires('hr.approval.delegate'))
        .handler(async ({ input, context }) => {
          await db.withWorkspace(input.workspaceId, async (tx) => {
            const me = await svc.byUserId(tx, input.workspaceId, context.principal.userId ?? '')
            const [row] = await tx
              .select()
              .from(delegations)
              .where(
                and(eq(delegations.workspaceId, input.workspaceId), eq(delegations.id, input.delegationId)),
              )
              .limit(1)
            if (!row) throw KernError.notFound('Delegation')
            // Only the person who gave it away may take it back — otherwise a delegate could quietly
            // extend their own authority by revoking the competition.
            if (row.fromPersonId !== me?.id)
              throw KernError.forbidden('Only the person who delegated may revoke it')
            await tx.delete(delegations).where(eq(delegations.id, row.id))
          })
          await changed(input.workspaceId, 'delegation', input.delegationId, 'deleted')
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

  /**
   * The person a call is about: the one named, or the caller.
   *
   * Reading somebody else's balance needs `hr.leave.view_team`; reading your own needs nothing
   * beyond being an employee. Collapsing those into one permission would either hide your own
   * balance from you or show you everybody's.
   */
  async function personFor(
    tx: Tx,
    workspaceId: string,
    context: RequestContext,
    personId: string | undefined,
  ): Promise<string> {
    const me = await svc.byUserId(tx, workspaceId, context.principal.userId ?? '')
    if (!personId) {
      if (!me) throw KernError.notFound('Your employee record')
      return me.id
    }
    if (me && me.id === personId) return personId
    await kernel.authz.require(context.principal, 'hr.leave.view_team', {
      kind: 'workspace',
      id: workspaceId,
      workspaceId,
    })
    return personId
  }

  async function loadRequest(tx: Tx, workspaceId: string, requestId: string) {
    const [row] = await tx
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.workspaceId, workspaceId), eq(leaveRequests.id, requestId)))
      .limit(1)
    if (!row) throw KernError.notFound('Leave request')
    return row
  }

  /**
   * What a request would cost, and every reason it would be refused.
   *
   * Used by `simulate` *and* by `create`, deliberately: a preview that runs different code from the
   * submission is a preview that eventually lies. The blockers are returned rather than thrown here
   * so the screen can show all of them at once instead of one per round trip.
   */
  async function simulate(
    tx: Tx,
    workspaceId: string,
    personId: string,
    input: {
      leaveTypeId: string
      startsOn: string
      endsOn: string
      startPart: 'full' | 'morning' | 'afternoon'
      endPart: 'full' | 'morning' | 'afternoon'
      hours?: number | null
    },
  ) {
    const blockers: Array<{ code: string; message: string }> = []
    if (input.endsOn < input.startsOn)
      blockers.push({ code: 'range', message: 'The end date is before the start date.' })

    const [type] = await tx
      .select()
      .from(leaveTypes)
      .where(and(eq(leaveTypes.workspaceId, workspaceId), eq(leaveTypes.id, input.leaveTypeId)))
      .limit(1)
    if (!type) throw KernError.notFound('Leave type')
    if (type.archivedAt) blockers.push({ code: 'archived', message: `${type.name} is no longer available.` })

    const resolution = await resolve.forPerson(tx, workspaceId, personId, input.startsOn)
    const calendarDaysInRange = resolution.calendarId
      ? await composedDays(tx, workspaceId, resolution.calendarId, input.startsOn, input.endsOn)
      : []

    const results = workingDays(
      input.startsOn,
      input.endsOn,
      resolution.workingWeek,
      type.countsWorkingDaysOnly
        ? calendarDaysInRange.map((d) => ({
            date: d.date,
            name: d.name,
            workingFraction: d.workingFraction,
          }))
        : [],
    )

    // Half-days trim the ends. Applied after the calendar, so asking for a half day on a public
    // holiday still costs nothing rather than costing half of nothing.
    const days = results.map((r) => {
      let fraction = r.fraction
      if (r.date === input.startsOn && input.startPart === 'afternoon') fraction = Math.min(fraction, 0.5)
      if (r.date === input.endsOn && input.endPart === 'morning') fraction = Math.min(fraction, 0.5)
      return { date: r.date, fraction, counted: fraction > 0, reason: r.reason }
    })

    const workingDaysTotal = Math.round(days.reduce((sum, d) => sum + d.fraction, 0) * 100) / 100
    const minutes =
      type.unit === 'hour' && input.hours
        ? Math.round(input.hours * 60)
        : Math.round(workingDaysTotal * MINUTES_PER_DAY)

    if (minutes <= 0)
      blockers.push({
        code: 'empty',
        message: 'That range contains no working days.',
      })

    const year = yearOf(input.startsOn)
    const balances = await ledger.balances(tx, workspaceId, personId, year)
    const balance = balances.find((b) => b.leaveTypeId === input.leaveTypeId)
    const before = balance?.availableMinutes ?? 0
    const after = before - minutes
    if (after < 0 && !type.allowNegative)
      blockers.push({
        code: 'insufficient',
        message: `Not enough ${type.name}: this would leave ${Math.round((after / MINUTES_PER_DAY) * 100) / 100} days.`,
      })
    if (after < 0 && type.allowNegative && Math.abs(after) > type.maxNegativeMinutes)
      blockers.push({
        code: 'below_floor',
        message: `${type.name} cannot go further than ${Math.round(type.maxNegativeMinutes / MINUTES_PER_DAY)} days negative.`,
      })

    // Overlap is refused by a unique index as well; checking here turns a constraint violation into
    // a sentence naming the dates.
    const counted = days.filter((d) => d.counted).map((d) => d.date)
    if (counted.length) {
      const clash = await tx
        .select({ date: leaveRequestDays.date })
        .from(leaveRequestDays)
        .where(
          and(
            eq(leaveRequestDays.workspaceId, workspaceId),
            eq(leaveRequestDays.personId, personId),
            eq(leaveRequestDays.counted, true),
            inArray(leaveRequestDays.status, ['pending', 'approved']),
            inArray(leaveRequestDays.date, counted),
          ),
        )
        .limit(3)
      if (clash.length)
        blockers.push({
          code: 'overlap',
          message: `You already have leave booked on ${clash.map((c) => c.date).join(', ')}.`,
        })
    }

    if (type.requiresDocumentAfterDays !== null && workingDaysTotal > type.requiresDocumentAfterDays)
      blockers.push({
        code: 'document_required',
        message: `${type.name} longer than ${type.requiresDocumentAfterDays} days needs a document.`,
      })

    return {
      workingDays: workingDaysTotal,
      minutes,
      days,
      balanceBeforeMinutes: before,
      balanceAfterMinutes: after,
      blockers,
    }
  }

  /**
   * Turn an approved request into a ledger consumption.
   *
   * The working days are **recomputed here** rather than trusted from submission time: a holiday
   * can be added to the calendar between asking and approving, and the number that costs somebody
   * balance should be the one that was true when it was granted.
   */
  async function applyApproval(tx: Tx, workspaceId: string, leaveRequestId: string, actorId: string | null) {
    const request = await loadRequest(tx, workspaceId, leaveRequestId)
    if (request.status === 'approved') return

    const sim = await simulate(tx, workspaceId, request.personId, {
      leaveTypeId: request.leaveTypeId,
      startsOn: request.startsOn,
      endsOn: request.endsOn,
      startPart: request.startPart as 'full' | 'morning' | 'afternoon',
      endPart: request.endPart as 'full' | 'morning' | 'afternoon',
      hours: request.hours === null ? null : Number.parseFloat(request.hours),
    })

    await ledger.append(tx, workspaceId, {
      personId: request.personId,
      leaveTypeId: request.leaveTypeId,
      kind: 'consumption',
      amountMinutes: -sim.minutes,
      effectiveOn: request.startsOn,
      periodYear: yearOf(request.startsOn),
      requestId: request.id,
      reason: null,
      createdBy: actorId,
    })

    await tx
      .update(leaveRequestDays)
      .set({ status: 'approved' })
      .where(eq(leaveRequestDays.requestId, request.id))
    await tx
      .update(leaveRequests)
      .set({
        status: 'approved',
        minutes: sim.minutes,
        workingDays: String(sim.workingDays),
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(leaveRequests.id, request.id))
  }

  async function clearDefaultChain(tx: Tx, workspaceId: string, subjectType: string) {
    await tx
      .update(approvalChains)
      .set({ isDefault: false })
      .where(
        and(
          eq(approvalChains.workspaceId, workspaceId),
          eq(approvalChains.subjectType, subjectType),
          eq(approvalChains.isDefault, true),
        ),
      )
  }

  /** An approval request with its steps and decisions, which is the only useful shape. */
  async function hydrateApproval(tx: Tx, row: typeof approvalRequests.$inferSelect) {
    const steps = await tx
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.requestId, row.id))
      .orderBy(asc(approvalSteps.stepIndex))
    const stepIds = steps.map((s) => s.id)
    const decisions = stepIds.length
      ? await tx.select().from(approvalDecisions).where(inArray(approvalDecisions.stepId, stepIds))
      : []
    return {
      ...row,
      subjectType: row.subjectType as never,
      status: row.status as never,
      requestedAt: row.requestedAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      steps: steps.map((s) => ({
        ...s,
        mode: s.mode as never,
        status: s.status as never,
        dueAt: s.dueAt?.toISOString() ?? null,
        escalatedAt: s.escalatedAt?.toISOString() ?? null,
        decisions: decisions
          .filter((d) => d.stepId === s.id)
          .map((d) => ({
            ...d,
            decision: d.decision as 'approve' | 'reject',
            at: d.at.toISOString(),
          })),
      })),
    }
  }

  /**
   * Everything a punch needs: the person's zone, today's business date, and their schedule.
   *
   * The zone comes from the resolution ladder — their primary office unless they have an override —
   * so a punch made on a business trip still counts towards the month they are employed in.
   */
  async function clockContext(tx: Tx, workspaceId: string, personId: string) {
    const today = todayIso()
    const resolution = await resolve.forPerson(tx, workspaceId, personId, today)
    const schedule = await attendance.scheduleFor(tx, workspaceId, personId, today)
    const businessDate = businessDateFor(
      Date.now(),
      resolution.timezone,
      schedule.shiftFor(todayIn(resolution.timezone)),
    )
    return { timezone: resolution.timezone, businessDate, schedule, resolution }
  }

  /**
   * One punch, and the day rebuilt straight afterwards.
   *
   * Recomputing inline rather than in a background job: the clock widget shows a total, and a person
   * who clocks out wants to see it immediately. The day sheet is a projection, so doing it twice
   * costs nothing.
   */
  async function punch(
    input: {
      workspaceId: string
      personId?: string
      method?: string
      clientReportedAt?: string | null
      geo?: { lat: number; lng: number; accuracyM?: number } | null
      note?: string | null
      idempotencyKey?: string
    },
    context: RequestContext,
    direction: 'in' | 'out' | 'break_start' | 'break_end',
  ) {
    const row = await db.withWorkspace(input.workspaceId, async (tx) => {
      const personId = await personFor(tx, input.workspaceId, context, input.personId)
      const { timezone, businessDate, schedule, resolution } = await clockContext(
        tx,
        input.workspaceId,
        personId,
      )

      // Refuse the transitions that make no sense, with a sentence rather than a constraint error:
      // clocking in twice, or out when never in, is somebody double-tapping a button.
      const existing = await attendance.punchesOn(tx, input.workspaceId, personId, businessDate)
      const open = openState(existing)
      if (direction === 'in' && open.clockedIn) throw KernError.conflict('You are already clocked in.')
      if (direction === 'out' && !open.clockedIn) throw KernError.conflict('You are not clocked in.')
      if (direction === 'break_start' && !open.clockedIn)
        throw KernError.conflict('Clock in before starting a break.')
      if (direction === 'break_start' && open.onBreak) throw KernError.conflict('You are already on a break.')
      if (direction === 'break_end' && !open.onBreak) throw KernError.conflict('You are not on a break.')

      const punchRow = await attendance.record(
        tx,
        input.workspaceId,
        {
          personId,
          direction,
          timezone,
          method: input.method ?? 'web',
          clientReportedAt: input.clientReportedAt ?? null,
          officeId: resolution.primaryOfficeId,
          geo: input.geo ?? null,
          note: input.note ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
        },
        schedule,
      )

      await attendance.recomputeDay(
        tx,
        input.workspaceId,
        personId,
        punchRow.businessDate,
        timezone,
        schedule,
      )
      return punchRow
    })

    await kernel.emit(
      hrEvents.punchRecorded,
      {
        punchId: row.id,
        workspaceId: input.workspaceId as never,
        personId: row.personId,
        direction: row.direction,
        businessDate: row.businessDate,
      },
      { workspaceId: input.workspaceId, actorId: context.principal.userId },
    )
    await changed(input.workspaceId, 'attendance_day', row.personId, 'updated')
    return toPunch(row)
  }

  /** Whether a person is currently clocked in or on a break, from their punches so far. */
  function openState(rows: Array<{ direction: string }>) {
    let clockedIn = false
    let onBreak = false
    for (const r of rows) {
      if (r.direction === 'in') clockedIn = true
      else if (r.direction === 'out') {
        clockedIn = false
        onBreak = false
      } else if (r.direction === 'break_start') onBreak = true
      else if (r.direction === 'break_end') onBreak = false
    }
    return { clockedIn, onBreak }
  }

  /**
   * Apply an approved correction: write the proposed punches, void what they replace, rebuild.
   *
   * Nothing is edited. The original punch keeps its row and gains a pointer to what superseded it,
   * so a corrected timesheet and an edited one stay distinguishable — which is the entire reason
   * regularization exists rather than an update statement.
   */
  async function applyRegularization(tx: Tx, workspaceId: string, regularizationId: string) {
    const [row] = await tx
      .select()
      .from(regularizations)
      .where(and(eq(regularizations.workspaceId, workspaceId), eq(regularizations.id, regularizationId)))
      .limit(1)
    if (!row || row.status === 'approved') return

    if (row.punchId) await attendance.voidPunch(tx, workspaceId, row.punchId, 'Regularized', null)

    const { timezone, schedule } = await clockContext(tx, workspaceId, row.personId)
    for (const proposal of row.proposed as Array<{ direction: string; at: string }>)
      await tx.insert(punches).values({
        id: uuidv7(),
        workspaceId,
        personId: row.personId,
        direction: proposal.direction,
        at: new Date(proposal.at),
        businessDate: row.businessDate,
        timezone,
        method: 'manual',
        trust: 'trusted',
        note: `Regularization ${row.id}`,
      })

    await attendance.recomputeDay(tx, workspaceId, row.personId, row.businessDate, timezone, schedule)
    await tx
      .update(regularizations)
      .set({ status: 'approved', appliedAt: new Date() })
      .where(eq(regularizations.id, row.id))
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

const toLeaveType = (r: typeof leaveTypes.$inferSelect) => ({
  ...r,
  unit: r.unit as never,
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toLedgerEntry = (r: typeof leaveLedger.$inferSelect) => ({
  ...r,
  kind: r.kind as never,
  createdAt: r.createdAt.toISOString(),
})

const toLeaveRequest = (r: typeof leaveRequests.$inferSelect) => ({
  ...r,
  startPart: r.startPart as never,
  endPart: r.endPart as never,
  status: r.status as never,
  hours: r.hours === null ? null : Number.parseFloat(r.hours),
  workingDays: Number.parseFloat(r.workingDays),
  decidedAt: r.decidedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
})

const toChain = (r: typeof approvalChains.$inferSelect) => ({
  ...r,
  subjectType: r.subjectType as never,
  spec: r.spec as never,
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toDelegation = (r: typeof delegations.$inferSelect) => ({
  ...r,
  subjectType: (r.subjectType ?? null) as never,
  createdAt: r.createdAt.toISOString(),
})

const toPunch = (r: typeof punches.$inferSelect) => ({
  ...r,
  direction: r.direction as never,
  method: r.method as never,
  trust: r.trust as never,
  geo: (r.geo as { lat: number; lng: number } | null) ?? null,
  at: r.at.toISOString(),
  clientReportedAt: r.clientReportedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
})

const toAttendanceDay = (r: typeof attendanceDays.$inferSelect) => ({
  ...r,
  status: r.status as never,
  firstIn: r.firstIn?.toISOString() ?? null,
  lastOut: r.lastOut?.toISOString() ?? null,
  computedAt: r.computedAt.toISOString(),
})

const toSchedule = (r: typeof schedules.$inferSelect) => ({
  ...r,
  kind: r.kind as never,
  week: r.week as never,
  tzMode: r.tzMode as never,
  roundingDirection: r.roundingDirection as never,
  archivedAt: r.archivedAt?.toISOString() ?? null,
})

const toScheduleAssignment = (r: typeof scheduleAssignments.$inferSelect) => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
})

const toRegularization = (r: typeof regularizations.$inferSelect) => ({
  ...r,
  status: r.status as never,
  proposed: r.proposed as never,
  appliedAt: r.appliedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
})
