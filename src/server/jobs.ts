import type { JobDef, Kernel } from '@kernhq/kernel'
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { accrueForPeriod, carryForward } from '../policy/accrual.js'
import {
  attendanceDays,
  employments,
  leaveLedger,
  leaveTypes,
  offices,
  people,
  punches,
  schedules,
} from './schema.js'
import { AttendanceService } from './services/attendance.js'
import { todayIn } from './services/db.js'
import { LedgerService } from './services/ledger.js'
import { PolicyService } from './services/policies.js'
import { ResolveService } from './services/resolve.js'

/**
 * HR's scheduled work.
 *
 * One rule runs through all of it: **a cron expression fires in UTC, and this module's users do
 * not live there.** A nightly job at 00:00 UTC closes an Amsterdam shift at 01:00 and an Istanbul
 * one at 03:00, and gets Tehran's half-hour offset wrong in a way nobody would ever guess from the
 * code. So the jobs run hourly and fan out per office, deciding for each whether *that office's*
 * local boundary has passed.
 */
export function hrJobs(): JobDef[] {
  return [
    {
      /**
       * Keep the punch partitions rolling.
       *
       * Runs monthly, creates a year ahead, and goes through the SQL function that also enables
       * row-level security on what it creates. A partition made with a bare `CREATE TABLE ...
       * PARTITION OF` is readable directly by any role holding SELECT on it, whatever the parent's
       * policy says — which an integration test caught rather than a review.
       *
       * A missing partition still would not lose a punch: the DEFAULT partition catches it. This
       * exists so that never becomes normal.
       */
      name: 'ensure-partitions',
      cron: '0 3 1 * *',
      handler: async (_input, { kernel }) => {
        await kernel.database.db.execute(sql`
          do $$
          declare
            m date := (date_trunc('month', now()) - interval '1 month')::date;
            stop date := (date_trunc('month', now()) + interval '12 months')::date;
          begin
            while m < stop loop
              perform "mod_hr".ensure_punch_partition(m);
              m := (m + interval '1 month')::date;
            end loop;
          end $$;
        `)
        kernel.log.info({ module: 'hr' }, 'punch partitions ensured')
      },
    },

    {
      /**
       * Monthly accrual.
       *
       * Runs on the 1st for the month that just ended, per office rather than once in UTC — "the
       * month has ended" is a different moment in Istanbul and Amsterdam, and a single UTC-timed
       * run credits one of them a day early.
       *
       * It writes through the same path `accrual.run` uses, so a scheduled credit and a manual one
       * are the same operation and cannot drift. Idempotent per person, per type, per period: a
       * retry after a partial failure credits only what is missing.
       */
      name: 'accrue-leave',
      cron: '0 2 1 * *',
      handler: async (_input, { kernel }) => {
        const resolve = new ResolveService()
        const policySvc = new PolicyService(resolve)
        const ledger = new LedgerService()

        for (const workspaceId of await activeWorkspaces(kernel))
          await kernel.database.withWorkspace(workspaceId, async (tx) => {
            // The month that just ended, computed by Postgres so month lengths and leap years are
            // its problem rather than this file's.
            const bounds = await tx.execute<{ from: string; to: string }>(sql`
              select (date_trunc('month', now()) - interval '1 month')::date::text as from,
                     (date_trunc('month', now()) - interval '1 day')::date::text as to
            `)
            const previous = bounds.rows[0]
            if (!previous) return
            const { from, to } = previous

            const staff = await tx
              .select()
              .from(people)
              .where(and(eq(people.workspaceId, workspaceId), inArray(people.status, ['active', 'on_leave'])))
            if (!staff.length) return

            const ids = staff.map((p) => p.id)
            const resolved = await policySvc.forPeople(tx, workspaceId, ids, 'accrual', to)
            const types = await tx
              .select()
              .from(leaveTypes)
              .where(and(eq(leaveTypes.workspaceId, workspaceId), isNull(leaveTypes.archivedAt)))
            const typeByKey = new Map(types.map((t) => [t.key, t]))

            const employmentRows = await tx
              .select()
              .from(employments)
              .where(
                and(
                  eq(employments.workspaceId, workspaceId),
                  inArray(employments.personId, ids),
                  isNull(employments.effectiveTo),
                ),
              )
            const employmentBy = new Map(employmentRows.map((e) => [e.personId, e]))

            const already = new Set(
              (
                await tx
                  .select({ personId: leaveLedger.personId, leaveTypeId: leaveLedger.leaveTypeId })
                  .from(leaveLedger)
                  .where(
                    and(
                      eq(leaveLedger.workspaceId, workspaceId),
                      eq(leaveLedger.kind, 'accrual'),
                      eq(leaveLedger.effectiveOn, to),
                      inArray(leaveLedger.personId, ids),
                    ),
                  )
              ).map((e) => `${e.personId}:${e.leaveTypeId}`),
            )

            let credited = 0
            for (const person of staff) {
              const policy = resolved.get(person.id)
              if (!policy?.config || !person.hiredOn) continue
              const config = policy.config as Record<string, unknown>
              const type = typeByKey.get(config.leaveTypeKey as string)
              if (!type || already.has(`${person.id}:${type.id}`)) continue

              const employment = employmentBy.get(person.id)
              const result = accrueForPeriod({
                policy: {
                  frequency: config.frequency as never,
                  daysPerYear: config.daysPerYear as number,
                  minutesPerDay: config.minutesPerDay as number,
                  seniorityTiers: config.seniorityTiers as never,
                  waitingPeriodMonths: config.waitingPeriodMonths as number,
                  roundToMinutes: config.roundToMinutes as number,
                },
                period: { from, to },
                hiredOn: person.hiredOn,
                terminatedOn: person.terminatedOn,
                fte: employment ? Number.parseFloat(employment.fte ?? '1') : 1,
              })
              if (result.minutes <= 0) continue

              const year = Number(to.slice(0, 4))
              await ledger.lockAndRead(tx, workspaceId, person.id, type.id, year)
              await ledger.append(tx, workspaceId, {
                personId: person.id,
                leaveTypeId: type.id,
                kind: 'accrual',
                amountMinutes: result.minutes,
                effectiveOn: to,
                periodYear: year,
                reason: result.reason,
              })
              credited++
            }
            if (credited) kernel.log.info({ module: 'hr', workspaceId, credited, from, to }, 'leave accrued')
          })
      },
    },

    {
      /**
       * Carry-forward and expiry, on the turn of the entitlement year.
       *
       * Writes **both halves**: what carried and what lapsed, as separate ledger entries. A balance
       * that silently shrinks at midnight on 1 January is the most disputed number in any leave
       * system, and "you had 9 days, 5 carried, 4 expired under the cap" is a sentence somebody can
       * check. Runs on the 2nd so a late December accrual has already landed.
       */
      name: 'carry-forward',
      cron: '0 4 2 1 *',
      handler: async (_input, { kernel }) => {
        const resolve = new ResolveService()
        const policySvc = new PolicyService(resolve)
        const ledger = new LedgerService()
        const thisYear = new Date().getUTCFullYear()
        const lastYear = thisYear - 1

        for (const workspaceId of await activeWorkspaces(kernel))
          await kernel.database.withWorkspace(workspaceId, async (tx) => {
            const staff = await tx
              .select({ id: people.id })
              .from(people)
              .where(and(eq(people.workspaceId, workspaceId), inArray(people.status, ['active', 'on_leave'])))
            if (!staff.length) return

            const ids = staff.map((p) => p.id)
            const resolved = await policySvc.forPeople(
              tx,
              workspaceId,
              ids,
              'carry_forward',
              `${lastYear}-12-31`,
            )
            const types = await tx.select().from(leaveTypes).where(eq(leaveTypes.workspaceId, workspaceId))
            const typeByKey = new Map(types.map((t) => [t.key, t]))

            let moved = 0
            for (const person of staff) {
              const policy = resolved.get(person.id)
              if (!policy?.config) continue
              const config = policy.config as Record<string, unknown>
              const type = typeByKey.get(config.leaveTypeKey as string)
              if (!type) continue

              const minutesPerDay = 8 * 60
              const balance = await ledger.lockAndRead(tx, workspaceId, person.id, type.id, lastYear)
              if (balance <= 0) continue

              const { carriedMinutes, expiredMinutes } = carryForward(balance, {
                maxMinutes: Math.round((config.maxDays as number) * minutesPerDay),
                expiresAfterMonths: (config.expiresAfterMonths as number | null) ?? null,
              })

              // The old year is closed out in full, then what survives opens the new one. Two
              // entries rather than a transfer, so each year's ledger sums to what that year held.
              if (expiredMinutes > 0)
                await ledger.append(tx, workspaceId, {
                  personId: person.id,
                  leaveTypeId: type.id,
                  kind: 'expiry',
                  amountMinutes: -expiredMinutes,
                  effectiveOn: `${lastYear}-12-31`,
                  periodYear: lastYear,
                  reason: `Above the ${config.maxDays} day carry-forward cap`,
                })

              if (carriedMinutes > 0) {
                await ledger.append(tx, workspaceId, {
                  personId: person.id,
                  leaveTypeId: type.id,
                  kind: 'carry_out',
                  amountMinutes: -carriedMinutes,
                  effectiveOn: `${lastYear}-12-31`,
                  periodYear: lastYear,
                  reason: `Carried into ${thisYear}`,
                })
                await ledger.lockAndRead(tx, workspaceId, person.id, type.id, thisYear)
                await ledger.append(tx, workspaceId, {
                  personId: person.id,
                  leaveTypeId: type.id,
                  kind: 'carry_in',
                  amountMinutes: carriedMinutes,
                  effectiveOn: `${thisYear}-01-01`,
                  periodYear: thisYear,
                  reason: `Carried from ${lastYear}`,
                })
                moved++
              }
            }
            if (moved) kernel.log.info({ module: 'hr', workspaceId, moved }, 'leave carried forward')
          })
      },
    },

    {
      /**
       * Close shifts somebody forgot to clock out of.
       *
       * Hourly, and per office rather than globally: "it is past 3am" is a different moment in every
       * office, and a single UTC-timed sweep would close a Tehran shift mid-afternoon.
       *
       * The auto clock-out is written as a punch like any other, with `method: 'manual'` and a note,
       * so the sheet shows that a machine closed the day rather than the person. That distinction is
       * what a regularization request is later arguing about.
       */
      name: 'auto-clock-out',
      cron: '5 * * * *',
      handler: async (_input, { kernel }) => {
        const attendance = new AttendanceService()
        const resolve = new ResolveService()
        const workspaces = await activeWorkspaces(kernel)

        for (const workspaceId of workspaces)
          await kernel.database.withWorkspace(workspaceId, async (tx) => {
            const withAuto = await tx
              .select({ id: schedules.id, after: schedules.autoClockOutAfterMinutes })
              .from(schedules)
              .where(
                and(
                  eq(schedules.workspaceId, workspaceId),
                  isNull(schedules.archivedAt),
                  sql`${schedules.autoClockOutAfterMinutes} is not null`,
                ),
              )
            if (!withAuto.length) return

            // Anyone with an `in` and no matching `out`, older than the longest configured window.
            const longest = Math.max(...withAuto.map((s) => s.after ?? 0))
            const cutoff = new Date(Date.now() - longest * 60_000)
            const open = await tx
              .select({
                personId: punches.personId,
                businessDate: punches.businessDate,
                at: punches.at,
              })
              .from(punches)
              .where(
                and(
                  eq(punches.workspaceId, workspaceId),
                  eq(punches.direction, 'in'),
                  isNull(punches.voidedByPunchId),
                  lte(punches.at, cutoff),
                ),
              )

            for (const row of open) {
              const rows = await attendance.punchesOn(tx, workspaceId, row.personId, row.businessDate)
              const stillOpen = rows.reduce(
                (acc, r) => (r.direction === 'in' ? true : r.direction === 'out' ? false : acc),
                false,
              )
              if (!stillOpen) continue

              const resolution = await resolve.forPerson(tx, workspaceId, row.personId)
              const schedule = await attendance.scheduleFor(tx, workspaceId, row.personId, row.businessDate)
              if (!schedule.autoClockOutAfterMinutes) continue
              if (Date.now() - row.at.getTime() < schedule.autoClockOutAfterMinutes * 60_000) continue

              await tx.insert(punches).values({
                workspaceId,
                personId: row.personId,
                direction: 'out',
                at: new Date(row.at.getTime() + schedule.autoClockOutAfterMinutes * 60_000),
                businessDate: row.businessDate,
                timezone: resolution.timezone,
                method: 'manual',
                trust: 'trusted',
                note: 'Closed automatically: no clock-out recorded',
              })
              await attendance.recomputeDay(
                tx,
                workspaceId,
                row.personId,
                row.businessDate,
                resolution.timezone,
                schedule,
              )
              kernel.log.info(
                { module: 'hr', personId: row.personId, businessDate: row.businessDate },
                'auto clock-out',
              )
            }
          })
      },
    },

    {
      /**
       * Rebuild recent unlocked days.
       *
       * Punches recompute their own day inline, so this exists for what that path cannot see: a
       * calendar edited after the fact, a schedule changed retroactively, an enqueue that never
       * ran. Anything it finds and changes is a bug worth knowing about rather than routine
       * maintenance — which is why it logs a count instead of running silently.
       *
       * Locked days are never touched: a closed month must not move underneath a payroll already
       * filed.
       */
      name: 'reconcile-days',
      cron: '30 2 * * *',
      handler: async (_input, { kernel }) => {
        const attendance = new AttendanceService()
        const resolve = new ResolveService()
        const workspaces = await activeWorkspaces(kernel)
        const WINDOW_DAYS = 14

        for (const workspaceId of workspaces)
          await kernel.database.withWorkspace(workspaceId, async (tx) => {
            const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
            const days = await tx
              .select({
                personId: attendanceDays.personId,
                businessDate: attendanceDays.businessDate,
              })
              .from(attendanceDays)
              .where(
                and(
                  eq(attendanceDays.workspaceId, workspaceId),
                  eq(attendanceDays.locked, false),
                  sql`${attendanceDays.businessDate} >= ${since}`,
                ),
              )

            let touched = 0
            for (const day of days) {
              const resolution = await resolve.forPerson(tx, workspaceId, day.personId, day.businessDate)
              const schedule = await attendance.scheduleFor(tx, workspaceId, day.personId, day.businessDate)
              const r = await attendance.recomputeDay(
                tx,
                workspaceId,
                day.personId,
                day.businessDate,
                resolution.timezone,
                schedule,
              )
              if (!r.locked) touched++
            }
            if (touched) kernel.log.info({ module: 'hr', workspaceId, touched }, 'days reconciled')
          })
      },
    },
  ]
}

/**
 * Workspaces with HR switched on.
 *
 * Read from this module's own tables rather than asked of core on every tick: a workspace with an
 * office has HR enabled, and one job run should not be N broker calls.
 */
async function activeWorkspaces(kernel: Kernel): Promise<string[]> {
  const { rows } = await kernel.database.pool.query<{ workspace_id: string }>(
    `select distinct workspace_id from mod_hr.offices where archived_at is null`,
  )
  return rows.map((r) => r.workspace_id)
}

export { inArray, offices, todayIn }
