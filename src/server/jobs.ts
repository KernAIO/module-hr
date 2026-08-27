import type { WorkspaceId } from '@kernhq/contracts'
import type { JobDef, Kernel, Tx } from '@kernhq/kernel'
import { and, eq, gt, gte, inArray, isNull, lte, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { hrEvents, MODULE_ID } from '../contract/index.js'
import { accrueForPeriod, carryExpiryDate, carryForward, carryHasLapsed } from '../policy/accrual.js'
import { daysInMonth } from '../policy/calendar.js'
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
import { ApprovalService } from './services/approvals.js'
import { AttendanceService } from './services/attendance.js'
import { todayIn } from './services/db.js'
import { LedgerService } from './services/ledger.js'
import { PolicyService } from './services/policies.js'
import { ResolveService } from './services/resolve.js'

/**
 * How far back the auto clock-out sweep looks.
 *
 * Comfortably longer than any `auto_clock_out_after_minutes` a schedule configures, and long enough
 * that the job having been down over a weekend still closes what it missed.
 */
const AUTO_CLOCK_OUT_LOOKBACK_DAYS = 3

/**
 * HR's scheduled work.
 *
 * One rule runs through all of it: **a cron expression fires in UTC, and this module's users do
 * not live there.** A nightly job at 00:00 UTC closes an Amsterdam shift at 01:00 and an Istanbul
 * one at 03:00, and gets Tehran's half-hour offset wrong in a way nobody would ever guess from the
 * code. So the two calendar jobs — `accrue-leave` and `carry-forward` — run hourly and fan out per
 * office, asking each whether *that office's* local boundary has passed.
 *
 * That was the comment for months while no handler read the offices table: `accrue-leave` fired
 * once a month and asked Postgres for `date_trunc('month', now())`, which is the database session's
 * timezone, so a New York office was credited January's accrual at 21:00 on 31 January local. A
 * boundary is a date in a zone, so it is `todayIn(office.timezone)` and nothing else.
 *
 * Running hourly means a handler is entered twenty-four times for every boundary it acts on, so
 * each is idempotent by construction rather than by scheduling: the ledger is asked what it already
 * holds before anything is written.
 *
 * `auto-clock-out` and `approval-timeouts` are the exceptions, and each says so where it lives: both
 * are counting an **elapsed duration**, and an hour is the same hour in every zone. An office
 * decides which *zone* a punch is stamped in, not when the sweep fires, and a 24-hour SLA is 24
 * hours in Tehran and in New York. Fanning those out per office would not make them more correct,
 * only slower — the fan-out is for boundaries that are a date in a calendar.
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
       * Monthly accrual, on each office's own first of the month.
       *
       * Hourly rather than monthly, because "the month has ended" is a different instant in Istanbul
       * and in New York and a cron expression only knows UTC. Every office is asked what date it is
       * standing on; the ones that have reached the 1st accrue the month behind them.
       *
       * Offices that turned the same month are one accrual, not one each: what a period grants
       * depends on the period, and the office decides only *when* that period ended. Which is also
       * why the month's bounds are arithmetic here rather than `date_trunc('month', now())` — that
       * asked the database session's timezone, which is an accident of deployment.
       *
       * It writes through the same path `accrual.run` uses, so a scheduled credit and a manual one
       * are the same operation and cannot drift. Idempotent per person, per type, per period: a
       * retry after a partial failure, and the twenty-three further ticks of the same local day,
       * credit only what is missing.
       */
      name: 'accrue-leave',
      cron: '0 * * * *',
      handler: async (_input, { kernel }) => {
        const resolve = new ResolveService()
        const policySvc = new PolicyService(resolve)
        const ledger = new LedgerService()
        const at = new Date()

        for (const workspaceId of await activeWorkspaces(kernel))
          await kernel.database.withWorkspace(workspaceId, async (tx) => {
            const turned = new Map<string, { from: string; to: string; officeIds: Set<string> }>()
            for (const office of await officeDays(tx, workspaceId, at)) {
              if (!office.today.endsWith('-01')) continue
              const { from, to } = monthBefore(office.today)
              const group = turned.get(to) ?? { from, to, officeIds: new Set<string>() }
              group.officeIds.add(office.id)
              turned.set(to, group)
            }
            if (!turned.size) return

            const staff = await tx
              .select()
              .from(people)
              .where(and(eq(people.workspaceId, workspaceId), inArray(people.status, ['active', 'on_leave'])))
            if (!staff.length) return
            const everyone = staff.map((p) => p.id)

            const types = await tx
              .select()
              .from(leaveTypes)
              .where(and(eq(leaveTypes.workspaceId, workspaceId), isNull(leaveTypes.archivedAt)))
            const typeByKey = new Map(types.map((t) => [t.key, t]))

            for (const { from, to, officeIds } of turned.values()) {
              // Resolved on the last day of the period, not today: somebody who transferred in
              // January accrues January against the office that actually employed them for it.
              const ids = await inOffices(resolve, tx, workspaceId, everyone, to, officeIds)
              if (!ids.length) continue
              const mine = new Set(ids)

              const resolved = await policySvc.forPeople(tx, workspaceId, ids, 'accrual', to)

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

              /**
               * Hours worked in the period, for the one frequency that accrues against them.
               *
               * `per_hour_worked` was implemented in the pure layer and fed by nobody: the two
               * callers passed neither figure, so `grantForPeriod` took its "nothing scheduled"
               * guard and returned zero for every person, and the job's `minutes <= 0` skipped them
               * without a word. The numbers were in `attendance_days` the whole time.
               *
               * Only queried where a policy actually asks for it — the other three frequencies
               * accrue against the calendar, and a sum over a month of day sheets for everybody is
               * not free.
               */
              const worksAgainstHours = [...resolved.values()].some(
                (p) => (p?.config as Record<string, unknown> | undefined)?.frequency === 'per_hour_worked',
              )
              const hoursBy = new Map<string, { workedMinutes: number; scheduledMinutes: number }>()
              if (worksAgainstHours) {
                const rows = await tx
                  .select({
                    personId: attendanceDays.personId,
                    worked: sql<string>`coalesce(sum(${attendanceDays.workedMinutes}), 0)`,
                    scheduled: sql<string>`coalesce(sum(${attendanceDays.scheduledMinutes}), 0)`,
                  })
                  .from(attendanceDays)
                  .where(
                    and(
                      eq(attendanceDays.workspaceId, workspaceId),
                      inArray(attendanceDays.personId, ids),
                      gte(attendanceDays.businessDate, from),
                      lte(attendanceDays.businessDate, to),
                    ),
                  )
                  .groupBy(attendanceDays.personId)
                for (const r of rows)
                  hoursBy.set(r.personId, {
                    workedMinutes: Number(r.worked),
                    scheduledMinutes: Number(r.scheduled),
                  })
              }

              let credited = 0
              for (const person of staff) {
                if (!mine.has(person.id)) continue
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
                  ...hoursBy.get(person.id),
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
              if (credited)
                kernel.log.info(
                  { module: 'hr', workspaceId, credited, from, to, offices: officeIds.size },
                  'leave accrued',
                )
            }
          })
      },
    },

    {
      /**
       * Carry-forward and expiry, on each office's own turn of the year.
       *
       * Two things, on the same hourly tick, because both are a date in an office's zone:
       *
       * 1. **The carry**, when an office reaches 2 January — the 2nd so a late December accrual has
       *    already landed. It writes **both halves**: what carried and what lapsed, as separate
       *    ledger entries. A balance that silently shrinks at midnight on 1 January is the most
       *    disputed number in any leave system, and "you had 9 days, 5 carried, 4 expired under the
       *    cap" is a sentence somebody can check.
       * 2. **The lapse**, on every other day of the year, for carried leave that has reached the
       *    date it expires on. The cap and the deadline are two different rules and only the first
       *    of them was ever written: a policy saying "three months to use it" took nothing away in
       *    April, so the deadline was a setting an admin could save and nothing would obey.
       *
       * The day length the cap converts at comes from the **accrual** policy, which is the only
       * place a working day is stated — `CarryForwardConfig` gives a cap in days and nothing to
       * multiply it by. Eight hours was assumed here for months, so on a seven-and-a-half-hour day
       * a five-day cap read as 2400 minutes against 2250 accrued and never bit at all.
       */
      name: 'carry-forward',
      cron: '0 * * * *',
      handler: async (_input, { kernel }) => {
        const resolve = new ResolveService()
        const policySvc = new PolicyService(resolve)
        const ledger = new LedgerService()
        const at = new Date()

        for (const workspaceId of await activeWorkspaces(kernel))
          await kernel.database.withWorkspace(workspaceId, async (tx) => {
            const days = await officeDays(tx, workspaceId, at)
            if (!days.length) return

            const staff = await tx
              .select({ id: people.id })
              .from(people)
              .where(and(eq(people.workspaceId, workspaceId), inArray(people.status, ['active', 'on_leave'])))
            if (!staff.length) return
            const everyone = staff.map((p) => p.id)

            const types = await tx.select().from(leaveTypes).where(eq(leaveTypes.workspaceId, workspaceId))
            const typeByKey = new Map(types.map((t) => [t.key, t]))

            // ---- the turn of the year, for the offices that have reached it
            const turning = new Map<number, Set<string>>()
            for (const office of days) {
              if (!office.today.endsWith('-01-02')) continue
              const year = Number(office.today.slice(0, 4))
              const group = turning.get(year) ?? new Set<string>()
              group.add(office.id)
              turning.set(year, group)
            }

            for (const [year, officeIds] of turning) {
              const lastYear = year - 1
              const closesOn = `${lastYear}-12-31`
              const opensOn = `${year}-01-01`
              const ids = await inOffices(resolve, tx, workspaceId, everyone, closesOn, officeIds)
              if (!ids.length) continue

              const carryPolicies = await policySvc.forPeople(tx, workspaceId, ids, 'carry_forward', closesOn)
              const accrualPolicies = await policySvc.forPeople(tx, workspaceId, ids, 'accrual', closesOn)

              let moved = 0
              for (const personId of ids) {
                const policy = carryPolicies.get(personId)
                if (!policy?.config) continue
                const config = policy.config as Record<string, unknown>
                const type = typeByKey.get(config.leaveTypeKey as string)
                if (!type) continue

                // A cap in days needs a day, and only the accrual policy states one. Without it the
                // honest move is to touch nothing and say so: guessing eight hours is how a cap
                // silently stops biting on a 7.5-hour week, and inventing one here would make the
                // carried figure disagree with every accrual that produced it.
                const accrual = accrualPolicies.get(personId)?.config as Record<string, unknown> | null
                const minutesPerDay = accrual?.minutesPerDay as number | undefined
                if (!minutesPerDay) {
                  kernel.log.warn(
                    { module: 'hr', workspaceId, personId, policyId: policy.policyId },
                    'carry-forward skipped: no accrual policy states the length of a working day',
                  )
                  continue
                }

                const balance = await ledger.lockAndRead(tx, workspaceId, personId, type.id, lastYear)
                if (balance <= 0) continue

                const { carriedMinutes, expiredMinutes, expiresOn } = carryForward(
                  balance,
                  {
                    maxDays: config.maxDays as number,
                    minutesPerDay,
                    expiresAfterMonths: (config.expiresAfterMonths as number | null) ?? null,
                  },
                  opensOn,
                )

                // The old year is closed out in full, then what survives opens the new one. Two
                // entries rather than a transfer, so each year's ledger sums to what that year held.
                if (expiredMinutes > 0)
                  await ledger.append(tx, workspaceId, {
                    personId,
                    leaveTypeId: type.id,
                    kind: 'expiry',
                    amountMinutes: -expiredMinutes,
                    effectiveOn: closesOn,
                    periodYear: lastYear,
                    reason: `Above the ${config.maxDays} day carry-forward cap`,
                  })

                if (carriedMinutes > 0) {
                  await ledger.append(tx, workspaceId, {
                    personId,
                    leaveTypeId: type.id,
                    kind: 'carry_out',
                    amountMinutes: -carriedMinutes,
                    effectiveOn: closesOn,
                    periodYear: lastYear,
                    reason: `Carried into ${year}`,
                  })
                  await ledger.lockAndRead(tx, workspaceId, personId, type.id, year)
                  await ledger.append(tx, workspaceId, {
                    personId,
                    leaveTypeId: type.id,
                    kind: 'carry_in',
                    amountMinutes: carriedMinutes,
                    effectiveOn: opensOn,
                    periodYear: year,
                    // The deadline is on the entry a person reads, not only in a policy screen they
                    // never open. The sweep below recomputes it rather than parsing it back.
                    reason: expiresOn
                      ? `Carried from ${lastYear} · use by ${dayBefore(expiresOn)}`
                      : `Carried from ${lastYear}`,
                  })
                  moved++
                }
              }
              if (moved)
                kernel.log.info(
                  { module: 'hr', workspaceId, year, moved, offices: officeIds.size },
                  'leave carried forward',
                )
            }

            // ---- carried leave that has reached its deadline, in each office's own calendar
            const local = new Map<string, Set<string>>()
            for (const office of days) {
              const group = local.get(office.today) ?? new Set<string>()
              group.add(office.id)
              local.set(office.today, group)
            }

            for (const [today, officeIds] of local) {
              const ids = await inOffices(resolve, tx, workspaceId, everyone, today, officeIds)
              if (!ids.length) continue
              const lapsed = await lapseCarriedLeave({
                tx,
                workspaceId,
                ledger,
                policySvc,
                today,
                personIds: ids,
                typeByKey,
              })
              if (lapsed)
                kernel.log.info({ module: 'hr', workspaceId, today, lapsed }, 'carried leave expired')
            }
          })
      },
    },

    {
      /**
       * Close shifts somebody forgot to clock out of.
       *
       * Hourly, and the one job here whose boundary is **not** a date in an office's calendar: a
       * shift closes `auto_clock_out_after_minutes` after the punch that opened it, and an elapsed
       * hour is the same hour everywhere. What the office decides is the **zone** — the zone of the
       * office the person worked in **on the day being closed**, not the one they work in today.
       * Somebody who transferred from Istanbul to Amsterdam has their forgotten Istanbul shift
       * closed in Istanbul time.
       *
       * So the ladder is walked once per business date rather than once per shift, which is the
       * batching `ResolveService` asks for and which a call per row quietly gave up.
       *
       * The auto clock-out is written as a punch like any other, and `method: 'auto'` is what says a
       * machine closed the day rather than the person. That distinction is what a regularization
       * request is later arguing about, so it has to survive as far as the employee's own timeline:
       * it used to be written as `'manual'` beside an English note, which the sheet rendered as
       * "Entered by hand" in every locale — the exact opposite of the fact, aimed at the one reader
       * with the most at stake in it.
       *
       * The note is gone with it. A sentence composed here is composed before anyone knows who will
       * read it, so it can only ever be English on a Persian screen; `att_method_auto` carries "a
       * machine closed this" in every locale the module ships, and the day's own `missing_clock_out`
       * anomaly — already on this panel, already translated — carries "nothing clocked you out".
       * Between them nothing is lost but the untranslatable half.
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
            // `at <= cutoff` with no lower bound asks for every `in` punch the instance has ever
            // recorded. Measured on 150,000 punches over five months: a sequential scan of every
            // populated partition, 100,000 rows and 2,462 buffers, with the index in place and
            // unused. With the two lower bounds it is a bitmap index scan of the one partition the
            // lookback covers — 2,000 rows, 1,041 buffers — because `at` is what the index can
            // answer and `business_date` is what prunes the partitions. The date bound is a day
            // earlier than the instant one: a night shift's punches carry the date the shift
            // *started*, which is the day before the morning they were made on.
            //
            // The cost of the bound is real and worth stating: a shift left open for longer than
            // the lookback is never closed automatically. That is close to true already — the
            // window a schedule configures is hours, not days — and three days leaves slack for the
            // job itself having been down.
            const since = new Date(cutoff.getTime() - AUTO_CLOCK_OUT_LOOKBACK_DAYS * 86_400_000)
            const sinceDate = dayBefore(since.toISOString().slice(0, 10))

            // "Still open" is a question about the punches of one person-day, and it used to be
            // answered here — a query per candidate row, before anything was known about the person
            // it belonged to. As an anti-join it costs nothing extra and the loop below only ever
            // sees shifts that really are open.
            //
            // The three predicates above it are the ones `hr_punches_open_idx` is built from and
            // must not move: `voided_by_punch_id is null` is the index's partial predicate because
            // drizzle emits `is null` literally and the planner can prove the implication, while
            // `direction` arrives as a bind parameter, which a predicate's constant cannot match.
            const closing = alias(punches, 'closing')
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
                  gte(punches.at, since),
                  gte(punches.businessDate, sinceDate),
                  notExists(
                    tx
                      .select({ closed: sql`1` })
                      .from(closing)
                      .where(
                        and(
                          eq(closing.workspaceId, workspaceId),
                          eq(closing.personId, punches.personId),
                          eq(closing.businessDate, punches.businessDate),
                          eq(closing.direction, 'out'),
                          isNull(closing.voidedByPunchId),
                          gt(closing.at, punches.at),
                          // Implied by the equality above, and stated anyway: without it nothing
                          // bounds the date on this side, and the planner then drives the anti-join
                          // from here — reading every populated partition for `out` punches to
                          // find the handful that close anything. Measured at 2,949 buffers
                          // against 865 with the bounds, on the same rows.
                          gte(closing.businessDate, sinceDate),
                          gte(closing.at, since),
                        ),
                      ),
                  ),
                ),
              )

            // One shift per person-day, not one per `in` punch. Somebody who clocked in twice and
            // never out has one open shift, and closing it twice would write two clock-outs for a
            // day that had one. Deduping here rather than with `distinct on` keeps the statement's
            // plan on the index above instead of on whatever answers the ordering cheapest.
            const shifts = new Map<string, (typeof open)[number]>()
            for (const row of open) {
              const key = `${row.personId}:${row.businessDate}`
              const seen = shifts.get(key)
              if (!seen || row.at > seen.at) shifts.set(key, row)
            }
            if (!shifts.size) return

            // One ladder walk per business date rather than one per shift. The resolution is what
            // says which office — and so which zone — the day belongs to, and it is asked **as of
            // that day**: a sweep that asks as of today closes a transferred employee's old shift
            // in their new office's time.
            const perDate = new Map<string, string[]>()
            for (const row of shifts.values())
              perDate.set(row.businessDate, [...(perDate.get(row.businessDate) ?? []), row.personId])
            const zones = new Map<string, string>()
            for (const [businessDate, personIds] of perDate)
              for (const [personId, r] of await resolve.forPeople(tx, workspaceId, personIds, businessDate))
                zones.set(`${personId}:${businessDate}`, r.timezone)

            for (const row of shifts.values()) {
              const schedule = await attendance.scheduleFor(tx, workspaceId, row.personId, row.businessDate)
              if (!schedule.autoClockOutAfterMinutes) continue
              if (Date.now() - row.at.getTime() < schedule.autoClockOutAfterMinutes * 60_000) continue
              const timezone = zones.get(`${row.personId}:${row.businessDate}`) ?? 'UTC'

              await tx.insert(punches).values({
                workspaceId,
                personId: row.personId,
                direction: 'out',
                at: new Date(row.at.getTime() + schedule.autoClockOutAfterMinutes * 60_000),
                businessDate: row.businessDate,
                timezone,
                method: 'auto',
                trust: 'trusted',
              })
              await attendance.recomputeDay(
                tx,
                workspaceId,
                row.personId,
                row.businessDate,
                timezone,
                schedule,
              )
              kernel.log.info(
                { module: 'hr', personId: row.personId, businessDate: row.businessDate, timezone },
                'auto clock-out',
              )
            }
          })
      },
    },

    {
      /**
       * Make a step's `slaHours` deadline mean something.
       *
       * The chain editor has offered a deadline and an `onTimeout` since the day it shipped, and
       * nothing read either one: a step with a 24-hour SLA waited exactly as long as a step with
       * none, which is the worst kind of setting — one an administrator saves, believes, and tells
       * their staff about. `ApprovalService.sweepTimeouts` is what answers it.
       *
       * Hourly, and **not** fanned out per office: an SLA is an elapsed duration, so its boundary
       * is the same instant everywhere. At :45 rather than on the hour, so it is not queued behind
       * the two calendar jobs and `auto-clock-out` on a small instance.
       *
       * The transaction ends before anything leaves the process. A notification is written by core
       * on its own connection, so one sent inside a transaction that then rolls back has already
       * arrived — telling an approver about a reminder that was undone, or a requester their leave
       * was granted when it was not. Everything the sweep decided is therefore reported, emitted
       * and delivered afterwards, out of what it returns.
       */
      name: 'approval-timeouts',
      cron: '45 * * * *',
      handler: async (_input, { kernel }) => {
        // No appliers, and that is the honest state of it: turning an approved request into booked
        // leave lives in the router's closure (`applyApproval`, `applyRegularization`) where a job
        // cannot reach it. So the sweep will escalate and remind, and it will auto-approve a step
        // that only advances the request — but it refuses to *complete* a request it cannot apply,
        // and reminds instead. Passing those two functions in here is the whole of what is missing.
        const approvals = new ApprovalService(kernel)
        const now = new Date()

        for (const workspaceId of await activeWorkspaces(kernel)) {
          const sweep = await kernel.database.withWorkspace(workspaceId, (tx) =>
            approvals.sweepTimeouts(tx, workspaceId, now),
          )
          if (!sweep.touchedRequestIds.length) continue

          for (const decision of sweep.decided)
            await kernel.emit(
              hrEvents.approvalDecided,
              {
                requestId: decision.requestId,
                workspaceId,
                subjectType: decision.subjectType,
                subjectId: decision.subjectId,
                status: decision.status,
              },
              // No actor, which is the point: the event stream is the other half of the audit trail
              // and it must not name somebody who did not decide this.
              { workspaceId, actorId: null },
            )

          for (const requestId of sweep.touchedRequestIds)
            await kernel.realtime.change(workspaceId, {
              module: MODULE_ID,
              entity: 'approval',
              id: requestId,
              op: 'updated',
            })

          const delivered = await approvals.deliverNotices(sweep.notices)
          kernel.log.info(
            {
              module: 'hr',
              workspaceId,
              reminded: sweep.reminded,
              escalated: sweep.escalated,
              autoApproved: sweep.autoApproved,
              delivered,
            },
            'approval deadlines swept',
          )
        }
      },
    },

    {
      /**
       * Rebuild every recent day a period does not close.
       *
       * Punches recompute their own day inline, so this exists for what that path cannot see: a
       * calendar edited after the fact, a schedule changed retroactively, an enqueue that never
       * ran. Anything it finds and changes is a bug worth knowing about rather than routine
       * maintenance — which is why it logs a count instead of running silently.
       *
       * A day a period really does close is still never touched — a filed payroll must not move
       * underneath itself — but that is `recomputeDay`'s answer to give, not this query's. `touched`
       * counts the days it actually rebuilt, so a window full of a closed month still logs nothing.
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
                  sql`${attendanceDays.businessDate} >= ${since}`,
                ),
              )

            let touched = 0
            for (const day of days) {
              const resolution = await resolve.forPerson(tx, workspaceId, day.personId, day.businessDate)
              const schedule = await attendance.scheduleFor(tx, workspaceId, day.personId, day.businessDate)
              // Every row in the window is offered, whatever its flag says. `locked` is a cache of
              // an answer only the period holds, and `recomputeDay` is the one place entitled to
              // read it — in both directions, since a flag repaired only upwards is a trapdoor
              // rather than a cache. Selecting `locked = false` here excluded exactly the rows the
              // downward repair exists for: a day stamped by a lock that has since been reopened,
              // or by somebody's employment being corrected underneath one, could never be visited
              // by anything a running instance does. A repair nothing reaches is not a repair.
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
async function activeWorkspaces(kernel: Kernel): Promise<WorkspaceId[]> {
  const { rows } = await kernel.database.pool.query<{ workspace_id: string }>(
    `select distinct workspace_id from mod_hr.offices where archived_at is null`,
  )
  // Branded once here rather than at each call. A driver hands back a string; the column *is* a
  // workspace id, and an event payload will not take one that has not said so.
  return rows.map((r) => r.workspace_id as WorkspaceId)
}

/** An office and the date it is currently standing on. */
interface OfficeDay {
  id: string
  name: string
  timezone: string
  today: string
}

/**
 * Every live office of a workspace, with the date it is on at `at`.
 *
 * The whole fan-out is this one function: a job asks which offices have crossed the boundary it
 * cares about instead of asking a cron expression, which only ever knows UTC.
 */
async function officeDays(tx: Tx, workspaceId: string, at: Date): Promise<OfficeDay[]> {
  const rows = await tx
    .select({ id: offices.id, name: offices.name, timezone: offices.timezone })
    .from(offices)
    .where(and(eq(offices.workspaceId, workspaceId), isNull(offices.archivedAt)))
  return rows.map((o) => ({ ...o, today: todayIn(o.timezone, at) }))
}

/**
 * Which of these people a set of offices decides for, on a date.
 *
 * Only the primary office votes, and `ResolveService` is the only implementation of that — so the
 * question is asked there rather than by joining `office_assignments` here and growing a second,
 * subtly different ladder. Nobody falls out of every group: a workspace always has a default
 * office, and it answers for anyone without an assignment of their own.
 */
async function inOffices(
  resolve: ResolveService,
  tx: Tx,
  workspaceId: string,
  personIds: string[],
  on: string,
  officeIds: Set<string>,
): Promise<string[]> {
  const resolutions = await resolve.forPeople(tx, workspaceId, personIds, on)
  return personIds.filter((id) => {
    const officeId = resolutions.get(id)?.primaryOfficeId
    return !!officeId && officeIds.has(officeId)
  })
}

/**
 * Take away carried leave that has passed its deadline, and say so on the record.
 *
 * The deadline is **recomputed** from the carry-forward policy in force on the 1st of January the
 * leave was carried into, rather than parsed back out of the entry that carried it: a policy is
 * effective-dated, so the same question asked of the same date gives the same answer for ever, and
 * a date encoded in a `reason` string is a column nobody declared.
 *
 * How much is left of the carry is a FIFO question — carried days are spent before the new year's
 * own accrual, so what lapses is the carry minus everything spent since, and never more than the
 * balance actually standing. That also makes the sweep idempotent without a marker: the entry it
 * writes is itself spending, so the second run finds nothing left to take.
 */
async function lapseCarriedLeave(args: {
  tx: Tx
  workspaceId: string
  ledger: LedgerService
  policySvc: PolicyService
  today: string
  personIds: string[]
  typeByKey: Map<string, { id: string }>
}): Promise<number> {
  const { tx, workspaceId, ledger, policySvc, today, personIds, typeByKey } = args
  const thisYear = Number(today.slice(0, 4))

  // Only the years that actually carried anything, and only as far back as a deadline can reach:
  // `expiresAfterMonths` is capped at 24 by the contract.
  const carriedYears = await tx
    .selectDistinct({ periodYear: leaveLedger.periodYear })
    .from(leaveLedger)
    .where(
      and(
        eq(leaveLedger.workspaceId, workspaceId),
        eq(leaveLedger.kind, 'carry_in'),
        inArray(leaveLedger.personId, personIds),
        gte(leaveLedger.periodYear, thisYear - 2),
        lte(leaveLedger.periodYear, thisYear),
      ),
    )
  if (!carriedYears.length) return 0

  let lapsed = 0
  for (const { periodYear } of carriedYears) {
    const yearStart = `${periodYear}-01-01`
    const policies = await policySvc.forPeople(tx, workspaceId, personIds, 'carry_forward', yearStart)

    const due = personIds.filter((personId) => {
      const config = policies.get(personId)?.config as Record<string, unknown> | null | undefined
      if (!config) return false
      const expiresOn = carryExpiryDate(yearStart, (config.expiresAfterMonths as number | null) ?? null)
      return carryHasLapsed(today, expiresOn)
    })
    if (!due.length) continue

    const sums = await tx
      .select({
        personId: leaveLedger.personId,
        leaveTypeId: leaveLedger.leaveTypeId,
        kind: leaveLedger.kind,
        total: sql<number>`sum(${leaveLedger.amountMinutes})::int`,
      })
      .from(leaveLedger)
      .where(
        and(
          eq(leaveLedger.workspaceId, workspaceId),
          eq(leaveLedger.periodYear, periodYear),
          inArray(leaveLedger.personId, due),
        ),
      )
      .groupBy(leaveLedger.personId, leaveLedger.leaveTypeId, leaveLedger.kind)

    const tally = new Map<string, { carriedIn: number; balance: number; spent: number }>()
    for (const row of sums) {
      const key = `${row.personId}:${row.leaveTypeId}`
      const t = tally.get(key) ?? { carriedIn: 0, balance: 0, spent: 0 }
      const total = Number(row.total)
      t.balance += total
      if (row.kind === 'carry_in') t.carriedIn += total
      if (total < 0) t.spent += -total
      tally.set(key, t)
    }

    for (const personId of due) {
      const config = policies.get(personId)?.config as Record<string, unknown>
      const type = typeByKey.get(config.leaveTypeKey as string)
      if (!type) continue
      const expiresOn = carryExpiryDate(yearStart, (config.expiresAfterMonths as number | null) ?? null)
      if (!expiresOn) continue

      const t = tally.get(`${personId}:${type.id}`)
      if (!t?.carriedIn) continue
      const remaining = Math.min(Math.max(0, t.carriedIn - t.spent), t.balance)
      if (remaining <= 0) continue

      await ledger.lockAndRead(tx, workspaceId, personId, type.id, periodYear)
      await ledger.append(tx, workspaceId, {
        personId,
        leaveTypeId: type.id,
        kind: 'expiry',
        amountMinutes: -remaining,
        effectiveOn: expiresOn,
        periodYear,
        reason: `Carried leave not used by ${dayBefore(expiresOn)}`,
      })
      lapsed++
    }
  }
  return lapsed
}

/** The month before the one a `YYYY-MM-01` names, as its own first and last day. */
function monthBefore(firstOfMonth: string): { from: string; to: string } {
  const [y, m] = firstOfMonth.split('-').map(Number) as [number, number]
  const year = m === 1 ? y - 1 : y
  const month = m === 1 ? 12 : m - 1
  const mm = String(month).padStart(2, '0')
  const last = String(daysInMonth(year, month)).padStart(2, '0')
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${last}` }
}

/**
 * The day before a `YYYY-MM-DD`.
 *
 * An expiry date is the first day the leave is *gone*, which is not the date to show somebody or to
 * bound a sweep with — "use by 31 March" and "expires 1 April" are the same rule and only one of
 * them reads as an instruction.
 */
function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
