import type { JobDef, Kernel } from '@kernhq/kernel'
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { attendanceDays, offices, punches, schedules } from './schema.js'
import { AttendanceService } from './services/attendance.js'
import { todayIn } from './services/db.js'
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
