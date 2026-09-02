import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Tx } from '@kernhq/kernel'
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { people, rosterAssignments, rosterOverrides, rosterPatterns, rosterShifts } from '../schema.js'
import {
  assignmentOn,
  cycleIndexFor,
  dayNumber,
  daysBetween,
  patternShiftIdsOn,
  RosterService,
  type RosterShiftRow,
  rosterFingerprint,
  rosterPlan,
  rosterRefusal,
  toShiftSpec,
} from './rosters.js'

/**
 * A rotation is arithmetic, and this is where the arithmetic is pinned.
 *
 * Everything above the database section runs without one, because every way a roster gets a person's
 * day wrong is a pure function getting it wrong: an index that goes negative before the anchor, a
 * cycle computed from instants so it slips an hour twice a year, an override that loses to the
 * rotation it was written to overrule. None of those throws and none of them fails a type-check —
 * each one renders as a shift somebody either turns up for or does not.
 *
 * The database section below is not optional either, and it is not testing drizzle. It is testing
 * the four statements this feature adds that only Postgres can answer: the `::date - 1` trim, the
 * upsert on the override's unique index, the exclusion constraint that makes two rotations in force
 * impossible, and row-level security on four new tables.
 */

const EARLY = '11111111-1111-4111-8111-111111111111'
const LATE = '22222222-2222-4222-8222-222222222222'
const NIGHT = '33333333-3333-4333-8333-333333333333'

/** A 4-on-4-off cycle: four Early days, four rest days. The rotation a week cannot express. */
const FOUR_ON_FOUR_OFF = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  anchorDate: '2026-01-01',
  days: [[EARLY], [EARLY], [EARLY], [EARLY], [], [], [], []],
}

const shiftRow = (over: Partial<RosterShiftRow> & { id: string }): RosterShiftRow => ({
  workspaceId: randomUUID(),
  name: 'Early',
  code: 'E',
  startTime: '06:00',
  endTime: '14:00',
  breakMinutes: 30,
  graceInMinutes: 5,
  graceOutMinutes: 5,
  color: null,
  archivedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
})

describe('civil-date arithmetic, with no instant anywhere near it', () => {
  it('counts days from the epoch exactly', () => {
    expect(dayNumber('1970-01-01')).toBe(0)
    expect(dayNumber('1970-01-02')).toBe(1)
    expect(dayNumber('1969-12-31')).toBe(-1)
    expect(dayNumber('2000-03-01') - dayNumber('2000-02-28')).toBe(2)
  })

  it('knows which Februaries have 29 days', () => {
    // 2026 is not a leap year, 2028 is, and 2100 is not despite being divisible by four.
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1)
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2)
    expect(daysBetween('2100-02-28', '2100-03-01')).toBe(1)
    expect(daysBetween('2000-02-28', '2000-03-01')).toBe(2)
  })

  it('crosses a year end and runs backwards', () => {
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1)
    expect(daysBetween('2026-01-01', '2025-12-31')).toBe(-1)
  })

  /**
   * The reason this is not `new Date(iso).getTime() / 86_400_000`.
   *
   * A daylight-saving day is 23 or 25 hours long, so dividing elapsed milliseconds rounds to the
   * wrong integer on exactly those two days a year — and a cycle index off by one puts a whole crew
   * on the wrong shift for the rest of the rotation. Both European transition weekends are here.
   */
  it('treats a daylight-saving day as one day, because it is one day', () => {
    expect(daysBetween('2026-03-28', '2026-03-29')).toBe(1)
    expect(daysBetween('2026-10-24', '2026-10-25')).toBe(1)
    expect(daysBetween('2026-03-01', '2026-11-01')).toBe(245)
  })
})

describe('where a date falls in a rotation', () => {
  it('starts the cycle on the anchor and repeats', () => {
    expect(cycleIndexFor(FOUR_ON_FOUR_OFF, '2026-01-01')).toBe(0)
    expect(cycleIndexFor(FOUR_ON_FOUR_OFF, '2026-01-05')).toBe(4)
    expect(cycleIndexFor(FOUR_ON_FOUR_OFF, '2026-01-09')).toBe(0)
    expect(cycleIndexFor(FOUR_ON_FOUR_OFF, '2027-06-14')).toBe(cycleIndexFor(FOUR_ON_FOUR_OFF, '2027-06-06'))
  })

  /**
   * The bug this exists to prevent: JavaScript's `%` keeps the sign of the dividend, so a date
   * before the anchor gives a negative index, `days[-3]` is `undefined`, and a roster asked about
   * last month reports that everybody was off. It does not throw and it does not look wrong.
   */
  it('answers for dates before the anchor rather than reporting a rest day', () => {
    expect(cycleIndexFor(FOUR_ON_FOUR_OFF, '2025-12-31')).toBe(7)
    expect(cycleIndexFor(FOUR_ON_FOUR_OFF, '2025-12-24')).toBe(0)
    expect(patternShiftIdsOn(FOUR_ON_FOUR_OFF, '2025-12-24')).toEqual([EARLY])
  })

  it('puts a second crew out of phase with an offset instead of a second rotation', () => {
    // Crew B at offset 4 works exactly the days crew A is off, on one shared cycle.
    for (const date of ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-02-17']) {
      const a = patternShiftIdsOn(FOUR_ON_FOUR_OFF, date, 0)
      const b = patternShiftIdsOn(FOUR_ON_FOUR_OFF, date, 4)
      expect(a?.length === 0).toBe(b?.length === 1)
    }
  })

  it('reports a rotation with no cycle as nothing rather than as a rest day', () => {
    expect(cycleIndexFor({ anchorDate: '2026-01-01', days: [] }, '2026-01-01')).toBe(-1)
    expect(patternShiftIdsOn({ anchorDate: '2026-01-01', days: [] }, '2026-01-01')).toBeNull()
  })
})

describe('which assignment is in force', () => {
  const march = { patternId: 'p1', effectiveFrom: '2026-03-01', effectiveTo: '2026-05-31', cycleOffset: 0 }
  const june = { patternId: 'p2', effectiveFrom: '2026-06-01', effectiveTo: null, cycleOffset: 2 }

  it('picks the one covering the date, inclusive at both ends', () => {
    expect(assignmentOn([march, june], '2026-03-01')).toBe(march)
    expect(assignmentOn([march, june], '2026-05-31')).toBe(march)
    expect(assignmentOn([march, june], '2026-06-01')).toBe(june)
    expect(assignmentOn([march, june], '2027-01-01')).toBe(june)
  })

  it('answers null before anything started', () => {
    expect(assignmentOn([march, june], '2026-02-28')).toBeNull()
    expect(assignmentOn([], '2026-03-01')).toBeNull()
  })

  /**
   * The exclusion constraint makes two-in-force impossible in the database, so this is not
   * resolving a conflict — it is refusing to let row order decide. `schedule_assignments` did let
   * it, for five migrations, and the symptom was a day sheet whose figures moved between one
   * recomputation and the next on a locked payroll period.
   */
  it('is deterministic if two rows ever are in force', () => {
    const older = { patternId: 'old', effectiveFrom: '2026-01-01', effectiveTo: null, cycleOffset: 0 }
    const newer = { patternId: 'new', effectiveFrom: '2026-03-01', effectiveTo: null, cycleOffset: 0 }
    expect(assignmentOn([older, newer], '2026-06-01')?.patternId).toBe('new')
    expect(assignmentOn([newer, older], '2026-06-01')?.patternId).toBe('new')
  })
})

describe('expanding a roster over a range', () => {
  const patterns = new Map([[FOUR_ON_FOUR_OFF.id, FOUR_ON_FOUR_OFF]])
  const assignments = [
    { patternId: FOUR_ON_FOUR_OFF.id, effectiveFrom: '2026-01-01', effectiveTo: null, cycleOffset: 0 },
  ]
  const dates = [
    '2026-01-01',
    '2026-01-02',
    '2026-01-03',
    '2026-01-04',
    '2026-01-05',
    '2026-01-06',
    '2026-01-07',
    '2026-01-08',
    '2026-01-09',
  ]

  it('computes the rotation rather than reading stored days', () => {
    const plan = rosterPlan({ dates, assignments, patterns, overrides: [] })
    expect(plan.map((d) => d.shiftIds.length)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 1])
    expect(plan.every((d) => d.source === 'pattern')).toBe(true)
  })

  it('lets an override win, including an override that says off', () => {
    const plan = rosterPlan({
      dates,
      assignments,
      patterns,
      overrides: [{ businessDate: '2026-01-02', shiftIds: [], note: 'Swapped with Deniz' }],
    })
    const tuesday = plan.find((d) => d.businessDate === '2026-01-02')
    expect(tuesday).toEqual({
      businessDate: '2026-01-02',
      shiftIds: [],
      source: 'override',
      note: 'Swapped with Deniz',
    })
    // The one that matters: the rotation must not speak over the top of the correction.
    expect(tuesday?.shiftIds).toEqual([])
  })

  it('lets an override add a shift to a rest day', () => {
    const plan = rosterPlan({
      dates,
      assignments,
      patterns,
      overrides: [{ businessDate: '2026-01-06', shiftIds: [NIGHT], note: null }],
    })
    expect(plan.find((d) => d.businessDate === '2026-01-06')).toMatchObject({
      shiftIds: [NIGHT],
      source: 'override',
    })
  })

  it('keeps a split shift in the order it was written', () => {
    const split = {
      id: 'split',
      anchorDate: '2026-01-01',
      days: [[EARLY, LATE]],
    }
    const plan = rosterPlan({
      dates: ['2026-01-01'],
      assignments: [{ patternId: 'split', effectiveFrom: '2026-01-01', effectiveTo: null, cycleOffset: 0 }],
      patterns: new Map([['split', split]]),
      overrides: [],
    })
    expect(plan[0]?.shiftIds).toEqual([EARLY, LATE])
  })

  /**
   * `none` and a rest day render differently on purpose. A planned day off is somebody's decision;
   * a day nothing rosters is the absence of one, and a screen that draws them the same tells an
   * employee their absence was intended.
   */
  it('separates nothing-rosters-this-person from a planned rest day', () => {
    const plan = rosterPlan({
      dates: ['2025-12-31', '2026-01-05'],
      assignments,
      patterns,
      overrides: [],
    })
    expect(plan[0]).toMatchObject({ source: 'none', shiftIds: [] })
    expect(plan[1]).toMatchObject({ source: 'pattern', shiftIds: [] })
  })

  it('reports nothing when the assignment points at a rotation that is gone', () => {
    const plan = rosterPlan({ dates: ['2026-01-01'], assignments, patterns: new Map(), overrides: [] })
    expect(plan[0]).toMatchObject({ source: 'none', shiftIds: [] })
  })
})

describe('what a rostered day was, as a fingerprint', () => {
  const early = shiftRow({ id: EARLY })

  /**
   * `hashSchedule` keys a day sheet's `policy_hash` on the schedule id and the rounding policy. That
   * is enough while a schedule only changes when its row does; it is not enough once one Tuesday can
   * change, because the id either side of the change is identical and a stale sheet would have
   * nothing able to notice it.
   */
  it('changes when the shift moves, even though the id does not', () => {
    const before = rosterFingerprint({ source: 'pattern', shifts: [early] })
    const after = rosterFingerprint({
      source: 'pattern',
      shifts: [shiftRow({ id: EARLY, startTime: '07:00' })],
    })
    expect(after).not.toBe(before)
  })

  it('changes when a rest day becomes a shift, and when a day is overridden to the same shift', () => {
    expect(rosterFingerprint({ source: 'pattern', shifts: [] })).not.toBe(
      rosterFingerprint({ source: 'pattern', shifts: [early] }),
    )
    expect(rosterFingerprint({ source: 'override', shifts: [early] })).not.toBe(
      rosterFingerprint({ source: 'pattern', shifts: [early] }),
    )
  })

  it('is stable for the same day', () => {
    expect(rosterFingerprint({ source: 'pattern', shifts: [early] })).toBe(
      rosterFingerprint({ source: 'pattern', shifts: [shiftRow({ id: EARLY })] }),
    )
  })
})

describe('handing a rostered shift to the working-time layer', () => {
  it('carries the grace with it, which is why grace lives on the shift', () => {
    expect(
      toShiftSpec(shiftRow({ id: NIGHT, startTime: '22:00', endTime: '06:00', graceInMinutes: 15 })),
    ).toEqual({ start: '22:00', end: '06:00', breakMinutes: 30, graceInMinutes: 15, graceOutMinutes: 5 })
  })
})

describe('refusing a range, in a sentence', () => {
  it('says which way round the dates are', () => {
    expect(rosterRefusal({ from: '2026-03-01', to: '2026-02-01', coverage: false })).toContain(
      'before the start date',
    )
  })

  it('names the ceiling and the number asked for', () => {
    const refusal = rosterRefusal({ from: '2026-01-01', to: '2027-01-01', coverage: false })
    expect(refusal).toContain('186')
    // Inclusive at both ends: 2026 has 365 days and both new year's days are in the range.
    expect(refusal).toContain('366')
  })

  it('lets a whole rotation through', () => {
    expect(rosterRefusal({ from: '2026-01-01', to: '2026-03-01', coverage: false })).toBeNull()
    expect(rosterRefusal({ from: '2026-01-01', to: '2026-01-28', coverage: true, population: 80 })).toBeNull()
  })

  it('counts person-days for a coverage grid, not only days', () => {
    const refusal = rosterRefusal({ from: '2026-01-01', to: '2026-02-08', coverage: true, population: 400 })
    expect(refusal).toContain('person-days')
  })
})

// =================================================================================================
// against a real Postgres
// =================================================================================================

const BASE = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB = `kern_hr_rosters_${Date.now().toString(36)}`
const RLS_ROLE = `kern_hr_roster_rls_${Date.now().toString(36)}`
const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations')

const WS = randomUUID()
const OTHER_WS = randomUUID()
const AYSE = randomUUID()
const DENIZ = randomUUID()

let admin: pg.Client
let pool: pg.Pool
let db: NodePgDatabase<Record<string, never>>
const rosters = new RosterService()

/** The kernel's `withWorkspace`, small enough to inline: a transaction with the RLS setting on it. */
const inWs = <T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`)
    return fn(tx as Tx)
  })

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE })
  await admin.connect()
  await admin.query(`create database "${DB}"`)
  const url = new URL(BASE)
  url.pathname = `/${DB}`
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  await client.query('create schema if not exists mod_hr')
  for (const file of readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    for (const statement of readFileSync(join(DIR, file), 'utf8').split('--> statement-breakpoint'))
      if (statement.trim()) await client.query(statement)
  // A role that is neither the owner nor a superuser, so the RLS probe at the end of this file is
  // actually testing a policy rather than a bypass.
  await client.query(`create role "${RLS_ROLE}" login password 'probe'`)
  await client.query(`grant usage on schema mod_hr to "${RLS_ROLE}"`)
  await client.query(`grant select on all tables in schema mod_hr to "${RLS_ROLE}"`)
  await client.end()

  pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  // `drop database ... with (force)` in afterAll SIGTERMs every backend still attached to the scratch
  // database, and `pool.end()` destroys a client's socket as soon as it has sent Terminate — so a backend
  // that has not reaped its socket yet can still land a terminating FATAL (57P01) in the buffer of an
  // idle pooled client. pg-pool re-emits an idle client's error on the pool, and an unlistened 'error'
  // event fails the entire vitest run after every test in it has already passed. The database is on its
  // way out by then, so there is nothing to do but swallow it.
  pool.on('error', () => undefined)
  db = drizzle(pool)

  await inWs(WS, async (tx) => {
    await tx.insert(people).values([
      { id: AYSE, workspaceId: WS, displayName: 'Ayşe Yılmaz' },
      { id: DENIZ, workspaceId: WS, displayName: 'Deniz Kaya' },
    ])
    await tx.insert(rosterShifts).values([
      { id: EARLY, workspaceId: WS, name: 'Early', code: 'E', startTime: '06:00', endTime: '14:00' },
      { id: LATE, workspaceId: WS, name: 'Late', code: 'L', startTime: '14:00', endTime: '22:00' },
      { id: NIGHT, workspaceId: WS, name: 'Night', code: 'N', startTime: '22:00', endTime: '06:00' },
    ])
    await tx.insert(rosterPatterns).values({
      id: FOUR_ON_FOUR_OFF.id,
      workspaceId: WS,
      name: '4 on, 4 off',
      anchorDate: FOUR_ON_FOUR_OFF.anchorDate,
      days: FOUR_ON_FOUR_OFF.days,
    })
  })
}, 180_000)

afterAll(async () => {
  await pool?.end().catch(() => undefined)
  await admin?.query(`drop database if exists "${DB}" with (force)`).catch(() => undefined)
  await admin?.query(`drop role if exists "${RLS_ROLE}"`).catch(() => undefined)
  await admin?.end().catch(() => undefined)
}, 60_000)

describe('the roster against the database it actually runs on', () => {
  it('expands a rotation for a crew in one round trip each', async () => {
    await inWs(WS, async (tx) => {
      await tx.insert(rosterAssignments).values([
        {
          id: randomUUID(),
          workspaceId: WS,
          personId: AYSE,
          patternId: FOUR_ON_FOUR_OFF.id,
          effectiveFrom: '2026-01-01',
          cycleOffset: 0,
        },
        {
          id: randomUUID(),
          workspaceId: WS,
          personId: DENIZ,
          patternId: FOUR_ON_FOUR_OFF.id,
          effectiveFrom: '2026-01-01',
          cycleOffset: 4,
        },
      ])
      const plan = await rosters.plan(tx, WS, [AYSE, DENIZ], ['2026-01-01', '2026-01-05'])
      expect(plan.get(AYSE)?.map((d) => d.shifts.map((s) => s.name))).toEqual([['Early'], []])
      // The crew on the other half of the cycle, from the same pattern row.
      expect(plan.get(DENIZ)?.map((d) => d.shifts.map((s) => s.name))).toEqual([[], ['Early']])
    })
  })

  it('reads a contiguous range for one person', async () => {
    await inWs(WS, async (tx) => {
      const days = await rosters.forPerson(tx, WS, AYSE, '2026-01-01', '2026-01-09')
      expect(days).toHaveLength(9)
      expect(days.map((d) => d.shifts.length)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 1])
      expect(days[0]?.shifts[0]?.startTime).toBe('06:00')
    })
  })

  /**
   * The upsert the override procedure runs, twice, on the unique index that makes one override per
   * person-day the database's promise rather than the handler's.
   */
  it('replaces an override rather than adding a second row for the same day', async () => {
    await inWs(WS, async (tx) => {
      for (const shiftIds of [[LATE], []])
        await tx
          .insert(rosterOverrides)
          .values({
            id: randomUUID(),
            workspaceId: WS,
            personId: AYSE,
            businessDate: '2026-01-02',
            shiftIds,
            note: shiftIds.length ? 'Covering Deniz' : 'Swapped away',
            createdBy: DENIZ,
          })
          .onConflictDoUpdate({
            target: [rosterOverrides.workspaceId, rosterOverrides.personId, rosterOverrides.businessDate],
            set: {
              shiftIds,
              note: shiftIds.length ? 'Covering Deniz' : 'Swapped away',
              updatedAt: new Date(),
            },
          })

      const rows = await tx
        .select()
        .from(rosterOverrides)
        .where(and(eq(rosterOverrides.workspaceId, WS), eq(rosterOverrides.personId, AYSE)))
      expect(rows).toHaveLength(1)

      const [day] = await rosters.forPerson(tx, WS, AYSE, '2026-01-02', '2026-01-02')
      expect(day).toMatchObject({ source: 'override', note: 'Swapped away' })
      expect(day?.shifts).toEqual([])
    })
  })

  /** The trim `assign` runs before it inserts. A bound date minus a day, in SQL, on a date column. */
  it('closes a running assignment the day before the new one starts', async () => {
    const from = '2026-04-01'
    await inWs(WS, async (tx) => {
      await tx
        .update(rosterAssignments)
        .set({ effectiveTo: sql`${from}::date - 1` })
        .where(
          and(
            eq(rosterAssignments.workspaceId, WS),
            inArray(rosterAssignments.personId, [AYSE]),
            lte(rosterAssignments.effectiveFrom, sql`${from}::date - 1`),
            or(isNull(rosterAssignments.effectiveTo), gte(rosterAssignments.effectiveTo, from)),
          ),
        )
      const [row] = await tx
        .select()
        .from(rosterAssignments)
        .where(and(eq(rosterAssignments.workspaceId, WS), eq(rosterAssignments.personId, AYSE)))
      expect(row?.effectiveTo).toBe('2026-03-31')
    })
  })

  it('refuses a second rotation in force on the same day, in the database', async () => {
    await expect(
      inWs(WS, (tx) =>
        tx.insert(rosterAssignments).values({
          id: randomUUID(),
          workspaceId: WS,
          personId: DENIZ,
          patternId: FOUR_ON_FOUR_OFF.id,
          effectiveFrom: '2026-06-01',
          cycleOffset: 0,
        }),
      ),
      // Deniz already has an open assignment from 2026-01-01, so this overlaps it. Drizzle wraps
      // the driver's error, so the SQLSTATE is on `cause` — asserting on the wrapper's own shape
      // would pass for any failure at all, which is the opposite of what this is checking.
    ).rejects.toMatchObject({ cause: { code: '23P01' } })
  })

  it('allows the same person a later rotation once the first one is closed', async () => {
    await inWs(WS, async (tx) => {
      await tx
        .update(rosterAssignments)
        .set({ effectiveTo: '2026-05-31' })
        .where(and(eq(rosterAssignments.workspaceId, WS), eq(rosterAssignments.personId, DENIZ)))
      await tx.insert(rosterAssignments).values({
        id: randomUUID(),
        workspaceId: WS,
        personId: DENIZ,
        patternId: FOUR_ON_FOUR_OFF.id,
        effectiveFrom: '2026-06-01',
        cycleOffset: 0,
      })
      const rows = await tx
        .select()
        .from(rosterAssignments)
        .where(and(eq(rosterAssignments.workspaceId, WS), eq(rosterAssignments.personId, DENIZ)))
      expect(rows).toHaveLength(2)
    })
  })

  it('refuses a rotation that names a shift the workspace does not have', async () => {
    await expect(
      inWs(WS, (tx) => rosters.assertShiftsExist(tx, WS, [EARLY, '44444444-4444-4444-8444-444444444444'])),
    ).rejects.toThrow(/does not have/)
  })

  /** The distinct scan `coverage` runs to find the rostered population. */
  it('finds the people a rotation covers over a range', async () => {
    await inWs(WS, async (tx) => {
      const rows = await tx
        .selectDistinct({ personId: rosterAssignments.personId })
        .from(rosterAssignments)
        .where(
          and(
            eq(rosterAssignments.workspaceId, WS),
            lte(rosterAssignments.effectiveFrom, '2026-01-31'),
            or(isNull(rosterAssignments.effectiveTo), gte(rosterAssignments.effectiveTo, '2026-01-01')),
          ),
        )
      expect(rows.map((r) => r.personId).sort()).toEqual([AYSE, DENIZ].sort())
    })
  })

  it('answers another workspace nothing, from the query rather than only from the policy', async () => {
    await inWs(OTHER_WS, async (tx) => {
      expect(await rosters.forPerson(tx, OTHER_WS, AYSE, '2026-01-01', '2026-01-02')).toEqual([
        { businessDate: '2026-01-01', shifts: [], source: 'none', note: null },
        { businessDate: '2026-01-02', shifts: [], source: 'none', note: null },
      ])
    })
  })

  /**
   * Row-level security, probed by a role that is not the owner and is not a superuser.
   *
   * The connection the rest of this file uses cannot test this: `kern` on a development machine is
   * a superuser, and a superuser bypasses RLS whatever `force row level security` says — so the
   * four assertions below would have passed against tables with no policy at all. That is exactly
   * the shape of test that reports a workspace boundary nobody has.
   */
  it('hides all four roster tables from a role with no workspace set', async () => {
    const url = new URL(BASE)
    url.pathname = `/${DB}`
    url.username = RLS_ROLE
    url.password = 'probe'
    const plain = new pg.Client({ connectionString: url.toString() })
    await plain.connect()
    try {
      for (const table of ['roster_shifts', 'roster_patterns', 'roster_assignments', 'roster_overrides']) {
        const blind = await plain.query<{ n: string }>(`select count(*)::text as n from mod_hr.${table}`)
        expect(Number(blind.rows[0]?.n), `${table} is readable with no workspace set`).toBe(0)
        await plain.query('select set_config($1, $2, false)', ['app.workspace_id', WS])
        const seeing = await plain.query<{ n: string }>(`select count(*)::text as n from mod_hr.${table}`)
        // Not just "zero everywhere": a policy that matches nothing at all would pass the first
        // assertion and mean the feature is broken rather than secure.
        expect(Number(seeing.rows[0]?.n), `${table} is empty even inside its own workspace`).toBeGreaterThan(
          0,
        )
        await plain.query('select set_config($1, $2, false)', ['app.workspace_id', ''])
      }
    } finally {
      await plain.end()
    }
  })
})
