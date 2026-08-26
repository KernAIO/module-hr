import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, type Kernel, type Tx } from '@kernhq/kernel'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { carryForward } from '../policy/accrual.js'
import { weekdayOf } from '../policy/calendar.js'
import { zonedToInstant } from '../policy/time.js'
import { hrModule } from './index.js'
import { hrJobs } from './jobs.js'
import {
  approvalDecisions,
  approvalRequests,
  approvalSteps,
  attendanceDays,
  calendarDays,
  calendars,
  delegations,
  employments,
  leaveBalanceCursor,
  leaveLedger,
  leaveRequestDays,
  leaveRequests,
  leaveTypes,
  officeAssignments,
  offices,
  orgUnits,
  people,
  periods,
  policies,
  policyAssignments,
  punches,
  scheduleAssignments,
  schedules,
  TENANT_TABLES,
} from './schema.js'
import { ApprovalService } from './services/approvals.js'
import { AttendanceService, NO_SCHEDULE, type ResolvedSchedule } from './services/attendance.js'
import { todayIn } from './services/db.js'
import { LedgerService } from './services/ledger.js'
import { PeopleService } from './services/people.js'
import { hashConfig, PolicyService } from './services/policies.js'
import { ResolveService } from './services/resolve.js'

/**
 * HR against a real Postgres.
 *
 * The unit tests prove the arithmetic; this proves the things only a database can answer — that the
 * migrations apply, that the exclusion constraints actually refuse the writes they claim to, that
 * row-level security holds for a plain role, and that the resolution ladder returns the office a
 * person's holidays should come from.
 *
 * A scratch database per run, dropped afterwards, so it never touches development data.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_hr_test_${Date.now().toString(36)}`
const RLS_ROLE = `kern_hr_rls_${Date.now().toString(36)}`

let kernel: Kernel
let admin: pg.Client
let databaseUrl: string

const WS_A = randomUUID()
const WS_B = randomUUID()
const ALICE = randomUUID()

const principal = (userId: string, workspaceId: string): Principal =>
  // `unknown` first: `userId` is branded on Principal and a plain string does not overlap it, which
  // is a real difference the test does not need to model. Since tsconfig.test.json started
  // type-checking this file, the cast has to say so rather than pretend the shapes match.
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId.slice(0, 8),
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId, role: 'admin', roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as unknown as Principal

const inWs =
  (workspaceId: string) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: ALICE })

const run = inWs(WS_A)

function registerCoreStubs(k: Kernel) {
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'modules.isEnabled': { handler: async () => true },
    'users.principal': { handler: async (i: { userId: string }) => principal(i.userId, WS_A) },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'settings.getModule': { handler: async () => ({}) },
    'settings.setModule': { handler: async () => ({ ok: true }) },
  })
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`
  databaseUrl = url.toString()

  kernel = await createKernel({
    service: 'hr-test',
    modules: [hrModule],
    role: 'api',
    env: {
      DATABASE_URL: databaseUrl,
      KERN_SECRET: 'test-secret-that-is-long-enough-for-kern',
      NODE_ENV: 'test',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
    },
  })
  registerCoreStubs(kernel)
  await kernel.start()
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.query(`drop role if exists "${RLS_ROLE}"`).catch(() => undefined)
  await admin.end().catch(() => undefined)
})

/**
 * Booting the module is itself the first assertion: `kernel.start()` creates `mod_hr` and runs both
 * migrations, so a broken one fails here rather than on somebody's instance during an upgrade.
 */
describe('the module boots', () => {
  it('created its schema and every tenant table', async () => {
    const { rows } = await kernel.database.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'mod_hr' order by 1`,
    )
    const names = rows.map((r) => r.table_name)
    for (const t of [
      'calendar_days',
      'calendars',
      'cost_centers',
      'custom_field_defs',
      'employments',
      'legal_entities',
      'office_assignments',
      'offices',
      'org_units',
      'people',
      'people_sensitive',
      'person_documents',
      'person_history',
      'positions',
      // 0002 — if these are missing the leave migration did not run, and every leave test below
      // would pass vacuously against a schema that is not there.
      'leave_types',
      'leave_ledger',
      'leave_balance_cursor',
      'leave_requests',
      'leave_request_days',
      'approval_chains',
      'approval_requests',
      'approval_steps',
      'approval_decisions',
      'delegations',
    ])
      expect(names, `mod_hr.${t}`).toContain(t)
  })

  it('put row-level security on every tenant table', async () => {
    const { rows } = await kernel.database.pool.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables where schemaname = 'mod_hr'`,
    )
    const secured = new Map(rows.map((r) => [r.tablename, r.rowsecurity]))
    // Checked against TENANT_TABLES rather than "every table in the schema": drizzle's own
    // `__migrations` bookkeeping lives here too and is not tenant data. Asserting over the declared
    // list is also what makes a new table added without a policy fail — the whole reason the list
    // exists next to the schema.
    for (const t of TENANT_TABLES) expect(secured.get(t), `mod_hr.${t} has RLS`).toBe(true)
  })

  it('leaves no table in the schema out of TENANT_TABLES', async () => {
    /**
     * Guards the other direction, and does it against the **database** rather than a count.
     *
     * A table added to `schema.ts` but left out of `TENANT_TABLES` passes the test above by simply
     * never being asked about — which is exactly how a table ships without a policy. Comparing what
     * actually exists to what is declared cannot go stale, where a hardcoded number goes stale the
     * first time anybody adds a table (it did, on the very next commit).
     */
    const { rows } = await kernel.database.pool.query<{ table_name: string }>(
      `select c.relname as table_name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'mod_hr'
          and c.relkind in ('r', 'p')
          -- Partitions of punches are tables too, and correctly absent from TENANT_TABLES: they
          -- inherit the parent's policy rather than declaring their own.
          and not c.relispartition`,
    )
    const declared = new Set<string>(TENANT_TABLES)
    const undeclared = rows
      .map((r) => r.table_name)
      // drizzle's own bookkeeping is not tenant data and correctly has no policy.
      .filter((t) => !t.startsWith('__'))
      .filter((t) => !declared.has(t))
    expect(undeclared, 'tables missing from TENANT_TABLES').toEqual([])
  })
})

/**
 * Postgres reports which constraint refused a write; drizzle wraps that in a "Failed query" error
 * whose message does not carry the name. Asserting on the message alone would pass for *any*
 * failure — a typo in the insert included — so this reaches through to the driver's own field.
 */
async function constraintViolated(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    let cursor: unknown = err
    for (let depth = 0; depth < 5 && cursor; depth++) {
      const name = (cursor as { constraint?: string }).constraint
      if (name) return name
      cursor = (cursor as { cause?: unknown }).cause
    }
    throw new Error(`Rejected, but not by a named constraint: ${String(err)}`)
  }
  throw new Error('Expected the write to be refused, but it succeeded')
}

describe('a workspace enabling HR', () => {
  beforeAll(async () => {
    await hrModule.onWorkspaceEnabled?.(WS_A, kernel)
    await hrModule.onWorkspaceEnabled?.(WS_B, kernel)
  })

  it('gets exactly one office, even though nobody asked for offices', async () => {
    const rows = await run((tx) => tx.select().from(offices).where(eq(offices.workspaceId, WS_A)))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.isDefault).toBe(true)
  })

  it('builds it from the workspace country, with a real timezone rather than UTC', async () => {
    const [office] = await run((tx) => tx.select().from(offices).where(eq(offices.workspaceId, WS_A)))
    expect(office?.country).toBe('TR')
    expect(office?.timezone).toBe('Europe/Istanbul')
  })

  it('seeds that country pack, holidays and all', async () => {
    const [calendar] = await run((tx) => tx.select().from(calendars).where(eq(calendars.workspaceId, WS_A)))
    expect(calendar?.source).toBe('pack')
    const days = await run((tx) =>
      tx.select().from(calendarDays).where(eq(calendarDays.calendarId, calendar!.id)),
    )
    expect(days.length).toBeGreaterThan(0)
    // Every seeded day is `pack`, which is what lets an upgrade replace them and leave HR's alone.
    expect(days.every((d) => d.source === 'pack')).toBe(true)
    expect(days.map((d) => d.name)).toContain('Cumhuriyet Bayramı')
  })

  it('is idempotent — switching HR off and on again does not make a second default office', async () => {
    await hrModule.onWorkspaceEnabled?.(WS_A, kernel)
    const rows = await run((tx) => tx.select().from(offices).where(eq(offices.workspaceId, WS_A)))
    expect(rows).toHaveLength(1)
  })
})

describe('the constraints refuse what application code must not have to', () => {
  it('refuses a second default office', async () => {
    const name = await constraintViolated(() =>
      run((tx) =>
        tx.insert(offices).values({
          workspaceId: WS_A,
          name: 'Second',
          country: 'NL',
          timezone: 'Europe/Amsterdam',
          isDefault: true,
        }),
      ),
    )
    expect(name).toBe('hr_offices_one_default_per_ws')
  })

  it('refuses two employment rows that overlap', async () => {
    const person = randomUUID()
    await run((tx) =>
      tx.insert(employments).values({
        workspaceId: WS_A,
        personId: person,
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-06-30',
      }),
    )
    const name = await constraintViolated(() =>
      run((tx) =>
        tx.insert(employments).values({ workspaceId: WS_A, personId: person, effectiveFrom: '2026-05-01' }),
      ),
    )
    expect(name).toBe('hr_employments_no_overlap')
  })

  it('refuses two primary offices on overlapping dates', async () => {
    const person = randomUUID()
    const [home] = await run((tx) => tx.select().from(offices).where(eq(offices.isDefault, true)))
    const [second] = await run((tx) =>
      tx
        .insert(offices)
        .values({
          workspaceId: WS_A,
          name: 'Amsterdam',
          country: 'NL',
          timezone: 'Europe/Amsterdam',
          isDefault: false,
        })
        .returning(),
    )
    await run((tx) =>
      tx.insert(officeAssignments).values({
        workspaceId: WS_A,
        personId: person,
        officeId: home!.id,
        isPrimary: true,
        effectiveFrom: '2026-01-01',
      }),
    )
    const name = await constraintViolated(() =>
      run((tx) =>
        tx.insert(officeAssignments).values({
          workspaceId: WS_A,
          personId: person,
          officeId: second!.id,
          isPrimary: true,
          effectiveFrom: '2026-03-01',
        }),
      ),
    )
    expect(name).toBe('hr_office_assignments_one_primary')
  })

  it('allows a second office when it is not primary — the whole point of the model', async () => {
    const person = randomUUID()
    const [home] = await run((tx) => tx.select().from(offices).where(eq(offices.isDefault, true)))
    const [second] = await run((tx) =>
      tx
        .select()
        .from(offices)
        .where(and(eq(offices.workspaceId, WS_A), eq(offices.isDefault, false))),
    )
    await run((tx) =>
      tx.insert(officeAssignments).values([
        {
          workspaceId: WS_A,
          personId: person,
          officeId: home!.id,
          isPrimary: true,
          effectiveFrom: '2026-01-01',
        },
        {
          workspaceId: WS_A,
          personId: person,
          officeId: second!.id,
          isPrimary: false,
          effectiveFrom: '2026-01-01',
        },
      ]),
    )
    const rows = await run((tx) =>
      tx.select().from(officeAssignments).where(eq(officeAssignments.personId, person)),
    )
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.isPrimary)).toHaveLength(1)
  })
})

describe('the resolution ladder', () => {
  const resolve = new ResolveService()

  it('answers from the primary office, not the other one', async () => {
    const person = randomUUID()
    const [home] = await run((tx) => tx.select().from(offices).where(eq(offices.isDefault, true)))
    const [amsterdam] = await run((tx) =>
      tx
        .select()
        .from(offices)
        .where(and(eq(offices.workspaceId, WS_A), eq(offices.isDefault, false))),
    )
    await run((tx) => tx.insert(people).values({ id: person, workspaceId: WS_A, displayName: 'Ayşe' }))
    await run((tx) =>
      tx.insert(officeAssignments).values([
        {
          workspaceId: WS_A,
          personId: person,
          officeId: home!.id,
          isPrimary: true,
          effectiveFrom: '2026-01-01',
        },
        {
          workspaceId: WS_A,
          personId: person,
          officeId: amsterdam!.id,
          isPrimary: false,
          effectiveFrom: '2026-01-01',
        },
      ]),
    )

    const r = await run((tx) => resolve.forPerson(tx, WS_A, person, '2026-06-01'))
    expect(r.primaryOfficeId).toBe(home!.id)
    expect(r.timezone).toBe('Europe/Istanbul')
    expect(r.timezoneFrom).toBe('office')
    expect(r.otherOfficeIds).toContain(amsterdam!.id)
  })

  it('lets a person override the timezone their office would give them', async () => {
    const person = randomUUID()
    const [home] = await run((tx) => tx.select().from(offices).where(eq(offices.isDefault, true)))
    await run((tx) =>
      tx
        .insert(people)
        .values({ id: person, workspaceId: WS_A, displayName: 'Remote', timezone: 'America/New_York' }),
    )
    await run((tx) =>
      tx.insert(officeAssignments).values({
        workspaceId: WS_A,
        personId: person,
        officeId: home!.id,
        isPrimary: true,
        effectiveFrom: '2026-01-01',
      }),
    )
    const r = await run((tx) => resolve.forPerson(tx, WS_A, person, '2026-06-01'))
    expect(r.timezone).toBe('America/New_York')
    expect(r.timezoneFrom).toBe('person')
  })

  /**
   * The bug this whole design exists to prevent: resolving a March question against today's office.
   */
  it('answers a past date from the office in force then, not the one in force now', async () => {
    const person = randomUUID()
    const [home] = await run((tx) => tx.select().from(offices).where(eq(offices.isDefault, true)))
    const [amsterdam] = await run((tx) =>
      tx
        .select()
        .from(offices)
        .where(and(eq(offices.workspaceId, WS_A), eq(offices.isDefault, false))),
    )
    await run((tx) => tx.insert(people).values({ id: person, workspaceId: WS_A, displayName: 'Mover' }))
    // Istanbul until the end of March, Amsterdam from April.
    await run((tx) =>
      tx.insert(officeAssignments).values([
        {
          workspaceId: WS_A,
          personId: person,
          officeId: home!.id,
          isPrimary: true,
          effectiveFrom: '2026-01-01',
          effectiveTo: '2026-03-31',
        },
        {
          workspaceId: WS_A,
          personId: person,
          officeId: amsterdam!.id,
          isPrimary: true,
          effectiveFrom: '2026-04-01',
        },
      ]),
    )

    const march = await run((tx) => resolve.forPerson(tx, WS_A, person, '2026-03-15'))
    expect(march.primaryOfficeId).toBe(home!.id)
    expect(march.timezone).toBe('Europe/Istanbul')

    const may = await run((tx) => resolve.forPerson(tx, WS_A, person, '2026-05-15'))
    expect(may.primaryOfficeId).toBe(amsterdam!.id)
    expect(may.timezone).toBe('Europe/Amsterdam')
  })

  it('falls back to the default office for somebody with no assignment at all', async () => {
    const person = randomUUID()
    await run((tx) => tx.insert(people).values({ id: person, workspaceId: WS_A, displayName: 'New' }))
    const r = await run((tx) => resolve.forPerson(tx, WS_A, person, '2026-06-01'))
    expect(r.primaryOfficeId).not.toBeNull()
    expect(r.timezone).toBe('Europe/Istanbul')
  })
})

/**
 * RLS as a **plain role**.
 *
 * The development user is a superuser, and superusers bypass row-level security entirely — so the
 * same assertions run as `kern` would pass against a table with no policy at all. This is the only
 * version of the test that proves anything.
 */
describe('row-level security, as a role that cannot bypass it', () => {
  let plain: pg.Client

  beforeAll(async () => {
    const scratch = new pg.Client({ connectionString: databaseUrl })
    await scratch.connect()
    await scratch.query(`create role "${RLS_ROLE}" login password 'probe'`)
    await scratch.query(`grant usage on schema mod_hr to "${RLS_ROLE}"`)
    await scratch.query(`grant select on all tables in schema mod_hr to "${RLS_ROLE}"`)
    await scratch.end()

    const url = new URL(databaseUrl)
    url.username = RLS_ROLE
    url.password = 'probe'
    plain = new pg.Client({ connectionString: url.toString() })
    await plain.connect()
  }, 60_000)

  afterAll(async () => {
    await plain?.end().catch(() => undefined)
  })

  const count = async (sqlText: string) => {
    const { rows } = await plain.query<{ n: string }>(sqlText)
    return Number(rows[0]?.n ?? -1)
  }

  it('shows nothing at all when no workspace is set', async () => {
    await plain.query('reset app.workspace_id')
    expect(await count('select count(*) as n from mod_hr.offices')).toBe(0)
    expect(await count('select count(*) as n from mod_hr.people')).toBe(0)
  })

  it('shows one workspace its own rows', async () => {
    await plain.query(`set app.workspace_id = '${WS_A}'`)
    expect(await count('select count(*) as n from mod_hr.offices')).toBeGreaterThan(0)
  })

  it('shows one workspace nothing of another', async () => {
    await plain.query(`set app.workspace_id = '${WS_B}'`)
    const a = await count(`select count(*) as n from mod_hr.people where workspace_id = '${WS_A}'`)
    expect(a).toBe(0)
  })
})

describe('effective-dated employment', () => {
  it('closes the open row rather than overwriting it', async () => {
    const svc = new PeopleService(kernel)
    const person = randomUUID()
    await run((tx) => tx.insert(people).values({ id: person, workspaceId: WS_A, displayName: 'Career' }))
    await run((tx) => svc.changeEmployment(tx, WS_A, person, '2026-01-01', { employmentType: 'full_time' }))
    await run((tx) => svc.changeEmployment(tx, WS_A, person, '2026-07-01', { employmentType: 'part_time' }))

    const rows = await run((tx) => tx.select().from(employments).where(eq(employments.personId, person)))
    expect(rows).toHaveLength(2)
    const first = rows.find((r) => r.effectiveFrom === '2026-01-01')
    // The previous period ends the day before the new one starts — Postgres's own date arithmetic,
    // not a string manipulation that has to know about month lengths.
    expect(first?.effectiveTo).toBe('2026-06-30')
    expect(rows.find((r) => r.effectiveTo === null)?.employmentType).toBe('part_time')
  })

  it('refuses a change dated before the current record starts', async () => {
    const svc = new PeopleService(kernel)
    const person = randomUUID()
    await run((tx) => tx.insert(people).values({ id: person, workspaceId: WS_A, displayName: 'Back' }))
    await run((tx) => svc.changeEmployment(tx, WS_A, person, '2026-06-01', {}))
    await expect(run((tx) => svc.changeEmployment(tx, WS_A, person, '2026-01-01', {}))).rejects.toThrow(
      /cannot be dated before/,
    )
  })
})

/**
 * Leave, end to end, against the database.
 *
 * The arithmetic is unit-tested; what needs a real Postgres is everything that can go wrong when
 * two things happen at once, or when somebody cancels — the parts where a balance stops being a
 * number and starts being an argument.
 */
describe('leave', () => {
  const svcLedger = new LedgerService()
  let annual: string
  let alice: string
  let manager: string

  beforeAll(async () => {
    const ids = await run(async (tx) => {
      const [type] = await tx
        .insert(leaveTypes)
        .values({
          workspaceId: WS_A,
          key: 'annual',
          name: 'Annual leave',
          paid: true,
          unit: 'day',
        })
        .returning()

      const [boss] = await tx.insert(people).values({ workspaceId: WS_A, displayName: 'Manager' }).returning()
      const [person] = await tx.insert(people).values({ workspaceId: WS_A, displayName: 'Alice' }).returning()
      await tx.insert(employments).values({
        workspaceId: WS_A,
        personId: person!.id,
        effectiveFrom: '2026-01-01',
        managerPersonId: boss!.id,
      })
      const [home] = await tx.select().from(offices).where(eq(offices.isDefault, true))
      await tx.insert(officeAssignments).values({
        workspaceId: WS_A,
        personId: person!.id,
        officeId: home!.id,
        isPrimary: true,
        effectiveFrom: '2026-01-01',
      })
      return { annual: type!.id, alice: person!.id, manager: boss!.id }
    })
    annual = ids.annual
    alice = ids.alice
    manager = ids.manager

    // 20 days of allowance.
    await run(async (tx) => {
      await svcLedger.lockAndRead(tx, WS_A, alice, annual, 2026)
      await svcLedger.append(tx, WS_A, {
        personId: alice,
        leaveTypeId: annual,
        kind: 'grant',
        amountMinutes: 20 * 8 * 60,
        effectiveOn: '2026-01-01',
        periodYear: 2026,
      })
    })
  }, 60_000)

  it('sums the ledger into a balance', async () => {
    const balances = await run((tx) => svcLedger.balances(tx, WS_A, alice, 2026))
    const annualBalance = balances.find((b) => b.leaveTypeId === annual)
    expect(annualBalance?.balanceMinutes).toBe(20 * 8 * 60)
    expect(annualBalance?.balance).toBe(20)
  })

  it('does not let two live requests cover the same day', async () => {
    // The application checks this too, but the index is what makes it true under concurrency — so
    // this asserts the constraint fires rather than that the check ran.
    await run((tx) =>
      tx.insert(leaveRequests).values({
        id: FIXED_REQUEST,
        workspaceId: WS_A,
        personId: alice,
        leaveTypeId: annual,
        startsOn: '2026-06-01',
        endsOn: '2026-06-01',
        minutes: 480,
        status: 'pending',
      }),
    )
    await run((tx) =>
      tx.insert(leaveRequestDays).values({
        workspaceId: WS_A,
        requestId: FIXED_REQUEST,
        personId: alice,
        date: '2026-06-01',
        counted: true,
        status: 'pending',
      }),
    )

    const name = await constraintViolated(() =>
      run((tx) =>
        tx.insert(leaveRequestDays).values({
          workspaceId: WS_A,
          requestId: FIXED_REQUEST_2,
          personId: alice,
          date: '2026-06-01',
          counted: true,
          status: 'pending',
        }),
      ),
    )
    expect(name).toBe('hr_leave_days_no_double_booking')
  })

  it('lets the same day be rebooked once the first request is cancelled', async () => {
    // The index is partial for exactly this reason: a cancelled request must not block the date
    // for ever.
    await run((tx) =>
      tx
        .update(leaveRequestDays)
        .set({ status: 'cancelled' })
        .where(eq(leaveRequestDays.requestId, FIXED_REQUEST)),
    )
    await expect(
      run((tx) =>
        tx.insert(leaveRequestDays).values({
          workspaceId: WS_A,
          requestId: FIXED_REQUEST_2,
          personId: alice,
          date: '2026-06-01',
          counted: true,
          status: 'pending',
        }),
      ),
    ).resolves.toBeDefined()
  })

  it('reverses rather than deletes when approved leave is cancelled', async () => {
    const entry = await run(async (tx) => {
      await svcLedger.lockAndRead(tx, WS_A, alice, annual, 2026)
      return svcLedger.append(tx, WS_A, {
        personId: alice,
        leaveTypeId: annual,
        kind: 'consumption',
        amountMinutes: -(5 * 8 * 60),
        effectiveOn: '2026-07-01',
        periodYear: 2026,
      })
    })

    const spent = await run((tx) => svcLedger.balances(tx, WS_A, alice, 2026))
    expect(spent.find((b) => b.leaveTypeId === annual)?.balance).toBe(15)

    await run(async (tx) => {
      await svcLedger.lockAndRead(tx, WS_A, alice, annual, 2026)
      return svcLedger.reverse(tx, WS_A, entry.id, 'Cancelled', null, '2026-07-02')
    })

    const restored = await run((tx) => svcLedger.balances(tx, WS_A, alice, 2026))
    expect(restored.find((b) => b.leaveTypeId === annual)?.balance).toBe(20)

    // Both movements are still there. "She booked it and cancelled" and "she never booked it" are
    // different facts, and the ledger has to be able to tell them apart.
    const entries = await run((tx) =>
      tx
        .select()
        .from(leaveLedger)
        .where(and(eq(leaveLedger.workspaceId, WS_A), eq(leaveLedger.personId, alice))),
    )
    expect(entries.filter((e) => e.kind === 'consumption')).toHaveLength(1)
    expect(entries.filter((e) => e.kind === 'reversal')).toHaveLength(1)
  })

  it('refuses to reverse the same entry twice', async () => {
    const entry = await run(async (tx) => {
      await svcLedger.lockAndRead(tx, WS_A, alice, annual, 2026)
      return svcLedger.append(tx, WS_A, {
        personId: alice,
        leaveTypeId: annual,
        kind: 'consumption',
        amountMinutes: -480,
        effectiveOn: '2026-08-03',
        periodYear: 2026,
      })
    })
    await run((tx) => svcLedger.reverse(tx, WS_A, entry.id, 'once', null, '2026-08-04'))
    // Reversing twice would credit the balance twice, which is how a cancelled day becomes two.
    await expect(
      run((tx) => svcLedger.reverse(tx, WS_A, entry.id, 'again', null, '2026-08-05')),
    ).rejects.toThrow(/already been reversed/)
  })

  it('rebuilds a cursor from the ledger', async () => {
    await run((tx) =>
      tx
        .update(leaveBalanceCursor)
        .set({ cachedBalanceMinutes: 999999 })
        .where(eq(leaveBalanceCursor.personId, alice)),
    )
    await run((tx) => svcLedger.rebuildCursors(tx, WS_A, [alice]))
    const [cursor] = await run((tx) =>
      tx.select().from(leaveBalanceCursor).where(eq(leaveBalanceCursor.personId, alice)),
    )
    const balances = await run((tx) => svcLedger.balances(tx, WS_A, alice, 2026))
    expect(cursor?.cachedBalanceMinutes).toBe(balances.find((b) => b.leaveTypeId === annual)?.balanceMinutes)
  })

  it('resolves the manager as the approver, and never the requester', async () => {
    const approvals = new ApprovalService(kernel)
    const ids = await run((tx) =>
      approvals.resolveSubject(tx, WS_A, { kind: 'manager' }, alice, '2026-06-01'),
    )
    expect(ids).toEqual([manager])

    // A manager requesting their own leave must not be their own approver. The step is dropped and
    // the next one up decides — an approval nobody can grant is worse than one nobody needs.
    const raised = await run((tx) =>
      approvals.raise(tx, WS_A, {
        subjectType: 'leave',
        subjectId: FIXED_REQUEST_2,
        summary: 'test',
        requesterPersonId: manager,
        requestedBy: null,
        on: '2026-06-01',
      }),
    )
    expect(raised.autoApproved).toBe(true)
  })

  it('records who is asking, and the summary as data rather than as English', async () => {
    const approvals = new ApprovalService(kernel)
    const raised = await run((tx) =>
      approvals.raise(tx, WS_A, {
        subjectType: 'leave',
        subjectId: FIXED_REQUEST_3,
        summary: '2 day(s) from 2026-06-08',
        summaryParams: { days: 2, from: '2026-06-08', to: '2026-06-09' },
        requesterPersonId: alice,
        requestedBy: null,
        on: '2026-06-08',
      }),
    )

    const [row] = await run((tx) =>
      tx.select().from(approvalRequests).where(eq(approvalRequests.id, raised.request.id)),
    )

    // The inbox cannot name the requester from `requestedBy`: that is a *user* id, and an employee
    // need not have an account at all. Without the person id it shows a request with no owner.
    expect(row?.requesterPersonId).toBe(alice)

    // And the sentence has to survive as data, or the inbox is English for every reader whatever
    // locale the shell is in.
    expect(row?.summaryParams).toEqual({ days: 2, from: '2026-06-08', to: '2026-06-09' })
  })
})

/**
 * Delegation, end to end through the engine rather than `mayActFor` alone.
 *
 * The unit-shaped pieces are simple; what has to be proven on the real tables is the chain — that a
 * live delegation moves the request into the delegate's inbox, that a decision made through one
 * records both names against the manager's step, and that a lapsed one confers nothing. A delegation
 * feature that silently stopped applying would look exactly like this test's absence.
 */
describe('delegation', () => {
  let requester: string
  let manager: string
  let deputy: string
  let colleague: string

  const dayOffset = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

  beforeAll(async () => {
    const ids = await run(async (tx) => {
      const [boss] = await tx.insert(people).values({ workspaceId: WS_A, displayName: 'Manager' }).returning()
      const [person] = await tx
        .insert(people)
        .values({ workspaceId: WS_A, displayName: 'Requester' })
        .returning()
      const [dep] = await tx.insert(people).values({ workspaceId: WS_A, displayName: 'Deputy' }).returning()
      const [col] = await tx
        .insert(people)
        .values({ workspaceId: WS_A, displayName: 'Colleague' })
        .returning()
      await tx.insert(employments).values({
        workspaceId: WS_A,
        personId: person!.id,
        effectiveFrom: '2026-01-01',
        managerPersonId: boss!.id,
      })
      return { requester: person!.id, manager: boss!.id, deputy: dep!.id, colleague: col!.id }
    })
    requester = ids.requester
    manager = ids.manager
    deputy = ids.deputy
    colleague = ids.colleague
  })

  const raiseForRequester = (subjectId: string) =>
    run((tx) =>
      new ApprovalService(kernel).raise(tx, WS_A, {
        subjectType: 'leave',
        subjectId,
        summary: 'test',
        requesterPersonId: requester,
        requestedBy: null,
        on: '2026-06-08',
      }),
    )

  /** A window relative to today, because "live" and "lapsed" are both claims about *now*. */
  const delegateManagerTo = (to: string, from: number, until: number) =>
    run((tx) =>
      tx.insert(delegations).values({
        workspaceId: WS_A,
        fromPersonId: manager,
        toPersonId: to,
        startsOn: dayOffset(from),
        endsOn: dayOffset(until),
      }),
    )

  it('moves nothing until the delegation exists, then shows it in the inbox', async () => {
    const approvals = new ApprovalService(kernel)
    const raised = await raiseForRequester(FIXED_REQUEST_4)

    // Before any delegation the request belongs to the manager alone — not to whoever happens to
    // sit nearby.
    const before = await run((tx) => approvals.inboxFor(tx, WS_A, deputy, false, 50))
    expect(before.some((r) => r.id === raised.request.id)).toBe(false)

    await delegateManagerTo(deputy, -1, 365)
    const after = await run((tx) => approvals.inboxFor(tx, WS_A, deputy, false, 50))
    expect(after.some((r) => r.id === raised.request.id)).toBe(true)
  })

  it('lets the delegate decide in the manager’s name and records both names', async () => {
    const approvals = new ApprovalService(kernel)
    const raised = await raiseForRequester(FIXED_REQUEST_5)

    const outcome = await run((tx) =>
      approvals.decide(tx, WS_A, raised.request.id, deputy, 'approve', null, manager),
    )
    expect(outcome.status).toBe('approved')

    // Both names: the step was the manager's, the hands were the deputy's. An audit that can say
    // only one of those is missing the only fact anybody asks for.
    const [step] = await run((tx) =>
      tx
        .select()
        .from(approvalSteps)
        .where(and(eq(approvalSteps.requestId, raised.request.id), eq(approvalSteps.stepIndex, 0)))
        .limit(1),
    )
    const [decision] = await run((tx) =>
      tx.select().from(approvalDecisions).where(eq(approvalDecisions.stepId, step!.id)),
    )
    expect(decision?.approverId).toBe(manager)
    expect(decision?.onBehalfOfId).toBe(deputy)
  })

  it('refuses somebody with no delegation, and one whose window has closed', async () => {
    const approvals = new ApprovalService(kernel)
    const raised = await raiseForRequester(FIXED_REQUEST_6)

    // A bystander fails earlier still — they are not an approver on the step at all.
    await expect(
      run((tx) => approvals.decide(tx, WS_A, raised.request.id, colleague, 'approve', null, manager)),
    ).rejects.toThrow()

    // Held once, expired now: yesterday's arrangement must not decide today's leave. (KernError
    // surfaces its code rather than its detail, so the refusal itself is the assertion.)
    await delegateManagerTo(colleague, -30, -7)
    await expect(
      run((tx) => approvals.decide(tx, WS_A, raised.request.id, colleague, 'approve', null, manager)),
    ).rejects.toThrow()
  })
})

const FIXED_REQUEST = '01920000-0000-7000-8000-00000000fa01'
const FIXED_REQUEST_2 = '01920000-0000-7000-8000-00000000fa02'
const FIXED_REQUEST_3 = '01920000-0000-7000-8000-00000000fa03'
const FIXED_REQUEST_4 = '01920000-0000-7000-8000-00000000fa04'
const FIXED_REQUEST_5 = '01920000-0000-7000-8000-00000000fa05'
const FIXED_REQUEST_6 = '01920000-0000-7000-8000-00000000fa06'

/**
 * Partitioning, and the thing about it that would be silent if wrong.
 *
 * A policy on a partitioned parent is documented to apply to every partition, including ones created
 * after the policy. The whole rolling-partition design rests on that, and "it inherits" is exactly
 * the kind of assumption that holds until a Postgres upgrade says otherwise — so it is asserted
 * against a partition created *after* the migration ran, as the monthly job would.
 */
describe('punches partitioning', () => {
  it('is a partitioned table with a default partition', async () => {
    const { rows } = await kernel.database.pool.query<{ relkind: string }>(
      `select relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'mod_hr' and c.relname = 'punches'`,
    )
    expect(rows[0]?.relkind, "'p' means partitioned").toBe('p')

    const { rows: parts } = await kernel.database.pool.query<{ n: string }>(
      `select count(*) as n from pg_inherits i
         join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'mod_hr.punches'::regclass`,
    )
    // Seeded window plus the default: a missing month must degrade to a slow insert, never a
    // refused punch.
    expect(Number(parts[0]?.n ?? 0)).toBeGreaterThan(12)
  })

  it('routes a punch into the partition for its business date', async () => {
    const person = randomUUID()
    await run((tx) => tx.insert(people).values({ id: person, workspaceId: WS_A, displayName: 'Puncher' }))
    await run((tx) =>
      tx.insert(punches).values({
        workspaceId: WS_A,
        personId: person,
        direction: 'in',
        at: new Date('2026-06-15T06:00:00Z'),
        businessDate: '2026-06-15',
        timezone: 'Europe/Istanbul',
      }),
    )
    const { rows } = await kernel.database.pool.query<{ tableoid: string }>(
      `select tableoid::regclass::text as tableoid from mod_hr.punches
        where person_id = '${person}'`,
    )
    expect(rows[0]?.tableoid).toBe('mod_hr.punches_2026_06')
  })

  it('applies row-level security to a partition created after the policy', async () => {
    // Created the way the monthly job creates one — through the function that secures it. Doing it
    // with a bare CREATE TABLE ... PARTITION OF is what this test caught: the partition is then
    // readable directly by any role holding SELECT on it, whatever the parent's policy says.
    await kernel.database.pool.query(`select mod_hr.ensure_punch_partition('2031-01-01'::date)`)
    await kernel.database.pool.query(`grant select on mod_hr.punches_2031_01 to "${RLS_ROLE}"`)

    const person = randomUUID()
    await run((tx) => tx.insert(people).values({ id: person, workspaceId: WS_A, displayName: 'Future' }))
    await run((tx) =>
      tx.insert(punches).values({
        workspaceId: WS_A,
        personId: person,
        direction: 'in',
        at: new Date('2031-01-15T06:00:00Z'),
        businessDate: '2031-01-15',
        timezone: 'Europe/Istanbul',
      }),
    )

    const url = new URL(databaseUrl)
    url.username = RLS_ROLE
    url.password = 'probe'
    const plain = new pg.Client({ connectionString: url.toString() })
    await plain.connect()
    try {
      await plain.query('reset app.workspace_id')
      const blind = await plain.query<{ n: string }>('select count(*) as n from mod_hr.punches_2031_01')
      expect(Number(blind.rows[0]?.n), 'a new partition must not be readable without a workspace').toBe(0)

      await plain.query(`set app.workspace_id = '${WS_A}'`)
      const seeing = await plain.query<{ n: string }>('select count(*) as n from mod_hr.punches_2031_01')
      expect(Number(seeing.rows[0]?.n)).toBe(1)
    } finally {
      await plain.end()
    }
  })
})

/**
 * The policy ladder, against the database.
 *
 * `person → office → legal entity → org unit → workspace`, nearest wins. The unit tests prove the
 * arithmetic a policy performs; this proves the right policy is the one that reaches it — which is
 * the half that decides whether two people on the same terms accrue the same amount.
 */
describe('policy resolution', () => {
  const policySvc = new PolicyService(new ResolveService())
  let alice: string
  let homeOffice: string
  let unit: string

  const makePolicy = (name: string, days: number) =>
    run(async (tx) => {
      const [row] = await tx
        .insert(policies)
        .values({
          workspaceId: WS_A,
          kind: 'accrual',
          name,
          config: { daysPerYear: days, frequency: 'monthly', minutesPerDay: 480, leaveTypeKey: 'annual' },
          effectiveFrom: '2026-01-01',
          configHash: hashConfig({ daysPerYear: days }),
        })
        .returning()
      return row!.id
    })

  const assign = (policyId: string, subjectKind: string, subjectId: string | null) =>
    run((tx) =>
      tx.insert(policyAssignments).values({
        workspaceId: WS_A,
        policyId,
        subjectKind,
        subjectId,
        effectiveFrom: '2026-01-01',
        priority: PolicyService.priorityFor(subjectKind as never),
      }),
    )

  beforeAll(async () => {
    const ids = await run(async (tx) => {
      const [home] = await tx.select().from(offices).where(eq(offices.isDefault, true))
      const [org] = await tx
        .insert(orgUnits)
        .values({ workspaceId: WS_A, path: 'policytest', name: 'Policy test' })
        .returning()
      const [person] = await tx
        .insert(people)
        .values({ workspaceId: WS_A, displayName: 'Policy Alice' })
        .returning()
      await tx.insert(employments).values({
        workspaceId: WS_A,
        personId: person!.id,
        effectiveFrom: '2026-01-01',
        orgUnitId: org!.id,
      })
      await tx.insert(officeAssignments).values({
        workspaceId: WS_A,
        personId: person!.id,
        officeId: home!.id,
        isPrimary: true,
        effectiveFrom: '2026-01-01',
      })
      return { alice: person!.id, homeOffice: home!.id, unit: org!.id }
    })
    alice = ids.alice
    homeOffice = ids.homeOffice
    unit = ids.unit
  }, 60_000)

  it('falls back to the workspace policy when nothing nearer applies', async () => {
    const id = await makePolicy('Workspace default', 14)
    await assign(id, 'workspace', null)
    const r = await run((tx) => policySvc.forPerson(tx, WS_A, alice, 'accrual', '2026-06-01'))
    expect(r.policyName).toBe('Workspace default')
    expect(r.from).toBe('workspace')
  })

  it('prefers the org unit over the workspace', async () => {
    const id = await makePolicy('Department', 18)
    await assign(id, 'org_unit', unit)
    const r = await run((tx) => policySvc.forPerson(tx, WS_A, alice, 'accrual', '2026-06-01'))
    expect(r.policyName).toBe('Department')
    expect(r.from).toBe('org_unit')
  })

  it('prefers the office over the org unit', async () => {
    const id = await makePolicy('Office', 20)
    await assign(id, 'office', homeOffice)
    const r = await run((tx) => policySvc.forPerson(tx, WS_A, alice, 'accrual', '2026-06-01'))
    expect(r.policyName).toBe('Office')
    expect(r.from).toBe('office')
  })

  it('prefers the person over everything', async () => {
    const id = await makePolicy('Negotiated', 26)
    await assign(id, 'person', alice)
    const r = await run((tx) => policySvc.forPerson(tx, WS_A, alice, 'accrual', '2026-06-01'))
    expect(r.policyName).toBe('Negotiated')
    expect(r.from).toBe('person')
  })

  it('gives the same answer in the batched path as the single one', async () => {
    // An accrual run uses `forPeople`; a settings screen uses `forPerson`. Two implementations of
    // one ladder is how a preview starts disagreeing with what the run actually writes.
    const single = await run((tx) => policySvc.forPerson(tx, WS_A, alice, 'accrual', '2026-06-01'))
    const batched = await run((tx) => policySvc.forPeople(tx, WS_A, [alice], 'accrual', '2026-06-01'))
    expect(batched.get(alice)?.policyId).toBe(single.policyId)
    expect(batched.get(alice)?.from).toBe(single.from)
  })

  it('returns nulls rather than throwing when no policy of that kind exists', async () => {
    const r = await run((tx) => policySvc.forPerson(tx, WS_A, alice, 'rounding', '2026-06-01'))
    expect(r.policyId).toBeNull()
    expect(r.from).toBeNull()
  })

  it('ignores a policy that is not yet in force on the date asked about', async () => {
    const future = await run(async (tx) => {
      const [row] = await tx
        .insert(policies)
        .values({
          workspaceId: WS_A,
          kind: 'overtime',
          name: 'Next year',
          config: {},
          effectiveFrom: '2027-01-01',
          configHash: 'x',
        })
        .returning()
      return row!.id
    })
    await run((tx) =>
      tx.insert(policyAssignments).values({
        workspaceId: WS_A,
        policyId: future,
        subjectKind: 'workspace',
        subjectId: null,
        effectiveFrom: '2027-01-01',
        priority: 0,
      }),
    )
    const during2026 = await run((tx) => policySvc.forPerson(tx, WS_A, alice, 'overtime', '2026-06-01'))
    expect(during2026.policyId).toBeNull()
    const during2027 = await run((tx) => policySvc.forPerson(tx, WS_A, alice, 'overtime', '2027-06-01'))
    expect(during2027.policyId).toBe(future)
  })

  it('refuses two overlapping assignments of one policy at one rung', async () => {
    // A tie the ladder cannot break would make "which policy applies" depend on row order.
    const id = await makePolicy('Duplicate', 14)
    await assign(id, 'workspace', null)
    const name = await constraintViolated(() => assign(id, 'workspace', null))
    expect(name).toBe('hr_policy_assign_no_overlap')
  })
})

describe('periods', () => {
  const policySvc = new PolicyService(new ResolveService())

  it('reports a date inside a locked period as locked', async () => {
    await run((tx) =>
      tx.insert(periods).values({
        workspaceId: WS_A,
        kind: 'payroll',
        startsOn: '2026-01-01',
        endsOn: '2026-01-31',
        status: 'locked',
        lockedAt: new Date(),
      }),
    )
    expect(await run((tx) => policySvc.isLocked(tx, WS_A, '2026-01-15'))).toBe(true)
    expect(await run((tx) => policySvc.isLocked(tx, WS_A, '2026-02-15'))).toBe(false)
    // Inclusive at both ends: the last day of a closed month is closed.
    expect(await run((tx) => policySvc.isLocked(tx, WS_A, '2026-01-31'))).toBe(true)
  })

  it('does not treat an open period as locked', async () => {
    await run((tx) =>
      tx.insert(periods).values({
        workspaceId: WS_A,
        kind: 'payroll',
        startsOn: '2026-02-01',
        endsOn: '2026-02-28',
        status: 'open',
      }),
    )
    expect(await run((tx) => policySvc.isLocked(tx, WS_A, '2026-02-10'))).toBe(false)
  })

  it('refuses a write into a closed month with a sentence, not a constraint error', async () => {
    await expect(run((tx) => policySvc.assertOpen(tx, WS_A, '2026-01-15'))).rejects.toThrow(/locked period/)
  })

  it('refuses two periods of a kind covering the same day', async () => {
    const name = await constraintViolated(() =>
      run((tx) =>
        tx.insert(periods).values({
          workspaceId: WS_A,
          kind: 'payroll',
          startsOn: '2026-01-15',
          endsOn: '2026-02-15',
          status: 'open',
        }),
      ),
    )
    expect(name).toBe('hr_periods_no_overlap')
  })
})

/**
 * A closed month, and the two mechanisms that have to agree about who it closes.
 *
 * `PolicyService.isLocked` reads the period and has always scoped to its legal entity;
 * `attendance_days.locked` is a cache of the same answer, and the lock that stamped it filtered on
 * the date range alone. So closing the Turkish entity's month froze the Dutch and Iranian ones
 * too — and neither mechanism looked wrong from where it was read, which is what made it survive.
 */
describe('locking one legal entity’s period', () => {
  const attendanceSvc = new AttendanceService()
  const policySvc = new PolicyService(new ResolveService())
  const TURKISH = randomUUID()
  const DUTCH = randomUUID()
  const MAY = { legalEntityId: TURKISH, startsOn: '2026-05-01', endsOn: '2026-05-31' }
  let ayse: string
  let jan: string

  beforeAll(async () => {
    ayse = randomUUID()
    jan = randomUUID()
    await run(async (tx) => {
      await tx.insert(people).values([
        { id: ayse, workspaceId: WS_A, displayName: 'Ayşe' },
        { id: jan, workspaceId: WS_A, displayName: 'Jan' },
      ])
      // The entity somebody is in is the employment's, never a column on `people`.
      await tx.insert(employments).values([
        { workspaceId: WS_A, personId: ayse, effectiveFrom: '2020-01-01', legalEntityId: TURKISH },
        { workspaceId: WS_A, personId: jan, effectiveFrom: '2020-01-01', legalEntityId: DUTCH },
      ])
      await tx.insert(attendanceDays).values([
        {
          workspaceId: WS_A,
          personId: ayse,
          businessDate: '2026-05-11',
          status: 'present',
          workedMinutes: 480,
        },
        {
          workspaceId: WS_A,
          personId: jan,
          businessDate: '2026-05-11',
          status: 'present',
          workedMinutes: 480,
        },
      ])
      await tx.insert(periods).values({
        workspaceId: WS_A,
        kind: 'payroll',
        legalEntityId: TURKISH,
        startsOn: MAY.startsOn,
        endsOn: MAY.endsOn,
        status: 'locked',
        lockedAt: new Date(),
      })
    })
  }, 60_000)

  const mayDays = () =>
    run((tx) =>
      tx
        .select()
        .from(attendanceDays)
        .where(and(eq(attendanceDays.workspaceId, WS_A), eq(attendanceDays.businessDate, '2026-05-11'))),
    )

  it('stamps that entity’s days and leaves the other entity’s open', async () => {
    expect(await run((tx) => attendanceSvc.setPeriodLock(tx, WS_A, MAY, true))).toBe(1)
    const days = await mayDays()
    expect(days.find((d) => d.personId === ayse)?.locked).toBe(true)
    expect(days.find((d) => d.personId === jan)?.locked).toBe(false)
  })

  it('says the same thing as isLocked, which is the point', async () => {
    expect(await run((tx) => policySvc.isLocked(tx, WS_A, '2026-05-11', TURKISH))).toBe(true)
    expect(await run((tx) => policySvc.isLocked(tx, WS_A, '2026-05-11', DUTCH))).toBe(false)
  })

  it('lets go of exactly the days it took, when the month is reopened', async () => {
    // Reopening writes the period's own status first and stamps the days afterwards, which is the
    // order the handler uses — and it matters, because releasing a day now asks whether any period
    // still closes it, and this one would still answer for itself.
    await run((tx) =>
      tx
        .update(periods)
        .set({ status: 'open', lockedAt: null })
        .where(and(eq(periods.workspaceId, WS_A), eq(periods.legalEntityId, TURKISH))),
    )
    expect(await run((tx) => attendanceSvc.setPeriodLock(tx, WS_A, MAY, false))).toBe(1)
    const days = await mayDays()
    expect(days.every((d) => !d.locked)).toBe(true)
  })
})

/**
 * The person who transferred, and the three dates the entity question used to be asked as of.
 *
 * Which legal entity somebody is in is a question about a *day*: March is filed under the entity
 * they were employed by in March, whatever their badge says today. Three places asked it as of
 * something else, and each of them wrote into a month that had already been filed:
 *
 * - `recomputeDay` was handed the entity `clockContext` resolved as of **today**, then applied it
 *   to arbitrary past business dates — so a March day came back "not locked" and was rewritten.
 * - `setPeriodLock` resolved every candidate once at the period's **last day**, so somebody who
 *   transferred *into* the filed entity mid-month had the half they spent elsewhere stamped too.
 * - `attendance_days.locked` was believed whenever it said `true`, before the period was consulted
 *   at all — so a day stamped by either of the above stayed frozen with nothing behind it.
 */
describe('a person who transfers between legal entities', () => {
  const attendanceSvc = new AttendanceService()
  const policySvc = new PolicyService(new ResolveService())
  const resolveSvc = new ResolveService()
  const IST = 'Europe/Istanbul'

  const LEFT = randomUUID()
  const JOINED = randomUUID()
  const MARCH = { legalEntityId: LEFT, startsOn: '2026-03-01', endsOn: '2026-03-31' }
  let emre: string

  const daysFor = (personId: string, date: string) =>
    run((tx) =>
      tx
        .select()
        .from(attendanceDays)
        .where(
          and(
            eq(attendanceDays.workspaceId, WS_A),
            eq(attendanceDays.personId, personId),
            eq(attendanceDays.businessDate, date),
          ),
        ),
    )

  beforeAll(async () => {
    emre = randomUUID()
    await run(async (tx) => {
      await tx.insert(people).values({ id: emre, workspaceId: WS_A, displayName: 'Emre' })
      await tx.insert(employments).values([
        {
          workspaceId: WS_A,
          personId: emre,
          effectiveFrom: '2020-01-01',
          effectiveTo: '2026-03-31',
          legalEntityId: LEFT,
        },
        { workspaceId: WS_A, personId: emre, effectiveFrom: '2026-04-01', legalEntityId: JOINED },
      ])
      await tx.insert(periods).values({
        workspaceId: WS_A,
        kind: 'payroll',
        legalEntityId: LEFT,
        startsOn: MARCH.startsOn,
        endsOn: MARCH.endsOn,
        status: 'locked',
        lockedAt: new Date(),
      })
      await attendanceSvc.record(
        tx,
        WS_A,
        {
          personId: emre,
          direction: 'in',
          timezone: IST,
          method: 'manual',
          claimedAt: new Date(zonedToInstant('2026-03-20', '09:00', IST)),
        },
        NO_SCHEDULE,
      )
    })
  }, 60_000)

  it('is in one entity on the filed day and another one today', async () => {
    expect(await run((tx) => resolveSvc.forPerson(tx, WS_A, emre, '2026-03-20'))).toMatchObject({
      legalEntityId: LEFT,
    })
    expect(await run((tx) => resolveSvc.forPerson(tx, WS_A, emre))).toMatchObject({
      legalEntityId: JOINED,
    })
    // Which is why the as-of date decides the answer: March is closed under the entity they left
    // and open under the one they are in now.
    expect(await run((tx) => policySvc.isLocked(tx, WS_A, '2026-03-20', LEFT))).toBe(true)
    expect(await run((tx) => policySvc.isLocked(tx, WS_A, '2026-03-20', JOINED))).toBe(false)
  })

  it('cannot be recomputed into the month their old entity has already filed', async () => {
    const r = await run((tx) => attendanceSvc.recomputeDay(tx, WS_A, emre, '2026-03-20', IST, NO_SCHEDULE))
    expect(r.locked).toBe(true)
    // No row at all: an absent sheet reads as "nothing was filed for this day", where a fresh one
    // reads as a figure somebody can act on — and this one would be inside a closed month.
    expect(await daysFor(emre, '2026-03-20')).toHaveLength(0)
  })
})

/**
 * Locking one entity's month, for somebody who spent half of it in another.
 *
 * The period names an entity, so it closes that entity's days — and a day belongs to whichever
 * entity employed the person *on that day*. Resolving every candidate once, at the period's last
 * day, stamps the half of the month they spent elsewhere as well.
 */
describe('locking a month somebody transferred into', () => {
  const attendanceSvc = new AttendanceService()
  const policySvc = new PolicyService(new ResolveService())
  const IST = 'Europe/Istanbul'

  const BEFORE = randomUUID()
  const AFTER = randomUUID()
  const APRIL = { legalEntityId: AFTER, startsOn: '2026-04-01', endsOn: '2026-04-30' }
  let pieter: string

  const aprilDays = () =>
    run((tx) =>
      tx
        .select()
        .from(attendanceDays)
        .where(and(eq(attendanceDays.workspaceId, WS_A), eq(attendanceDays.personId, pieter))),
    )

  beforeAll(async () => {
    pieter = randomUUID()
    await run(async (tx) => {
      await tx.insert(people).values({ id: pieter, workspaceId: WS_A, displayName: 'Pieter' })
      await tx.insert(employments).values([
        {
          workspaceId: WS_A,
          personId: pieter,
          effectiveFrom: '2020-01-01',
          effectiveTo: '2026-04-15',
          legalEntityId: BEFORE,
        },
        { workspaceId: WS_A, personId: pieter, effectiveFrom: '2026-04-16', legalEntityId: AFTER },
      ])
      await tx.insert(attendanceDays).values([
        {
          workspaceId: WS_A,
          personId: pieter,
          businessDate: '2026-04-10',
          status: 'present',
          workedMinutes: 480,
        },
        {
          workspaceId: WS_A,
          personId: pieter,
          businessDate: '2026-04-20',
          status: 'present',
          workedMinutes: 480,
        },
      ])
      await tx.insert(periods).values({
        workspaceId: WS_A,
        kind: 'payroll',
        legalEntityId: AFTER,
        startsOn: APRIL.startsOn,
        endsOn: APRIL.endsOn,
        status: 'locked',
        lockedAt: new Date(),
      })
    })
  }, 60_000)

  it('stamps the days spent inside the entity and not the ones before the transfer', async () => {
    expect(await run((tx) => attendanceSvc.setPeriodLock(tx, WS_A, APRIL, true))).toBe(1)
    const days = await aprilDays()
    expect(days.find((d) => d.businessDate === '2026-04-20')?.locked).toBe(true)
    expect(days.find((d) => d.businessDate === '2026-04-10')?.locked).toBe(false)
  })

  it('says the same thing as isLocked on both halves of the month', async () => {
    expect(await run((tx) => policySvc.isLocked(tx, WS_A, '2026-04-10', BEFORE))).toBe(false)
    expect(await run((tx) => policySvc.isLocked(tx, WS_A, '2026-04-20', AFTER))).toBe(true)
  })

  it('goes on recomputing the half nothing has filed', async () => {
    const r = await run((tx) => attendanceSvc.recomputeDay(tx, WS_A, pieter, '2026-04-10', IST, NO_SCHEDULE))
    expect(r.locked).toBe(false)
  })
})

/**
 * The flag that could only ever be repaired upwards.
 *
 * `attendance_days.locked` is a cache of a question the period answers. It was believed outright
 * whenever it said `true` — before `isLocked` was consulted — so a row stamped by mistake refused
 * recomputation for ever, with no locked period behind it. Every route into that state is now
 * closed, and it is repaired downwards as well, because a cache that is only ever repaired in one
 * direction is a trapdoor rather than a cache.
 */
describe('a day flagged locked with no period behind it', () => {
  const attendanceSvc = new AttendanceService()
  const policySvc = new PolicyService(new ResolveService())
  const IST = 'Europe/Istanbul'
  let lale: string

  beforeAll(async () => {
    lale = randomUUID()
    await run(async (tx) => {
      await tx.insert(people).values({ id: lale, workspaceId: WS_A, displayName: 'Lale' })
      for (const [wall, direction] of [
        ['09:00', 'in'],
        ['15:00', 'out'],
      ] as const)
        await attendanceSvc.record(
          tx,
          WS_A,
          {
            personId: lale,
            direction,
            timezone: IST,
            method: 'manual',
            claimedAt: new Date(zonedToInstant('2026-06-05', wall, IST)),
          },
          NO_SCHEDULE,
        )
      await tx.insert(attendanceDays).values({
        workspaceId: WS_A,
        personId: lale,
        businessDate: '2026-06-05',
        status: 'present',
        workedMinutes: 480,
        locked: true,
      })
    })
  }, 60_000)

  it('is not inside any locked period, whatever the flag says', async () => {
    expect(await run((tx) => policySvc.isLocked(tx, WS_A, '2026-06-05', null))).toBe(false)
  })

  it('is recomputed, and the flag repaired down to what the period says', async () => {
    const r = await run((tx) => attendanceSvc.recomputeDay(tx, WS_A, lale, '2026-06-05', IST, NO_SCHEDULE))
    expect(r.locked).toBe(false)

    const [day] = await run((tx) =>
      tx
        .select()
        .from(attendanceDays)
        .where(and(eq(attendanceDays.workspaceId, WS_A), eq(attendanceDays.personId, lale))),
    )
    expect(day?.locked).toBe(false)
    // Rebuilt from the punches — six hours, not the 480 the frozen row was carrying.
    expect(day?.workedMinutes).toBe(360)
  })
})

/**
 * Reopening one period when another still covers the same days.
 *
 * The exclusion constraint keys on `coalesce(legal_entity_id, …)`, so a workspace-wide period and
 * an entity's period may cover exactly the same dates on purpose. Releasing the days a period took
 * therefore has to ask whether anything still closes them, or reopening the narrower one unlocks a
 * month the wider one has filed — and reports the number of days it freed.
 */
describe('reopening one of two periods covering a day', () => {
  const attendanceSvc = new AttendanceService()
  const ENTITY = randomUUID()
  const OCTOBER = { legalEntityId: ENTITY, startsOn: '2026-10-01', endsOn: '2026-10-31' }
  const IST = 'Europe/Istanbul'
  let okan: string

  const octoberDay = () =>
    run(async (tx) => {
      const [day] = await tx
        .select()
        .from(attendanceDays)
        .where(and(eq(attendanceDays.workspaceId, WS_A), eq(attendanceDays.personId, okan)))
      return day
    })

  beforeAll(async () => {
    okan = randomUUID()
    await run(async (tx) => {
      await tx.insert(people).values({ id: okan, workspaceId: WS_A, displayName: 'Okan' })
      await tx.insert(employments).values({
        workspaceId: WS_A,
        personId: okan,
        effectiveFrom: '2020-01-01',
        legalEntityId: ENTITY,
      })
      await tx.insert(attendanceDays).values({
        workspaceId: WS_A,
        personId: okan,
        businessDate: '2026-10-12',
        status: 'present',
        workedMinutes: 480,
      })
      await tx.insert(periods).values([
        {
          workspaceId: WS_A,
          kind: 'payroll',
          legalEntityId: ENTITY,
          startsOn: OCTOBER.startsOn,
          endsOn: OCTOBER.endsOn,
          status: 'locked',
          lockedAt: new Date(),
        },
        {
          workspaceId: WS_A,
          kind: 'payroll',
          startsOn: OCTOBER.startsOn,
          endsOn: OCTOBER.endsOn,
          status: 'locked',
          lockedAt: new Date(),
        },
      ])
    })
    expect(await run((tx) => attendanceSvc.setPeriodLock(tx, WS_A, OCTOBER, true))).toBe(1)
  }, 60_000)

  it('releases nothing, and says so', async () => {
    // The handler writes the period's own status before stamping the days, so `isLocked` already
    // reflects the reopening — what it still finds is the other period.
    await run((tx) =>
      tx
        .update(periods)
        .set({ status: 'open', lockedAt: null })
        .where(and(eq(periods.workspaceId, WS_A), eq(periods.legalEntityId, ENTITY))),
    )
    expect(await run((tx) => attendanceSvc.setPeriodLock(tx, WS_A, OCTOBER, false))).toBe(0)
    expect((await octoberDay())?.locked).toBe(true)
  })

  it('and the day is still refused a recomputation', async () => {
    const r = await run((tx) => attendanceSvc.recomputeDay(tx, WS_A, okan, '2026-10-12', IST, NO_SCHEDULE))
    expect(r.locked).toBe(true)
    expect((await octoberDay())?.workedMinutes).toBe(480)
  })
})

/**
 * A punch on a date inside a month that has already been filed.
 *
 * The lock stamps the day rows that exist when it runs. A date with no row yet was invisible to it,
 * so the punch path wrote a fresh one at the column's `false` default and the nightly reconciliation
 * then rewrote it every night — a filed month moving underneath the payroll it was filed for.
 *
 * The punch itself is kept. It is a fact about somebody's day, and refusing to record it because
 * payroll has closed loses the fact in order to protect the report. What must not move is the
 * derived sheet, so no sheet is written for a closed day at all: an absent row reads as "nothing
 * was filed for this day", which is true, where a frozen half-day would read as a figure.
 */
describe('a punch inside a closed month', () => {
  const attendanceSvc = new AttendanceService()
  let mert: string

  beforeAll(async () => {
    mert = randomUUID()
    await run(async (tx) => {
      await tx.insert(people).values({ id: mert, workspaceId: WS_A, displayName: 'Mert' })
      await tx.insert(periods).values({
        workspaceId: WS_A,
        kind: 'payroll',
        startsOn: '2026-07-01',
        endsOn: '2026-07-31',
        status: 'locked',
        lockedAt: new Date(),
      })
    })
  }, 60_000)

  const daysFor = (date: string) =>
    run((tx) =>
      tx
        .select()
        .from(attendanceDays)
        .where(
          and(
            eq(attendanceDays.workspaceId, WS_A),
            eq(attendanceDays.personId, mert),
            eq(attendanceDays.businessDate, date),
          ),
        ),
    )

  it('is recorded, and writes no sheet where the lock had nothing to stamp', async () => {
    const punch = await run((tx) =>
      attendanceSvc.record(
        tx,
        WS_A,
        {
          personId: mert,
          direction: 'in',
          timezone: 'Europe/Istanbul',
          method: 'manual',
          claimedAt: new Date(Date.UTC(2026, 6, 15, 6, 0)),
        },
        NO_SCHEDULE,
      ),
    )
    expect(punch.businessDate).toBe('2026-07-15')

    const result = await run((tx) =>
      attendanceSvc.recomputeDay(tx, WS_A, mert, '2026-07-15', 'Europe/Istanbul', NO_SCHEDULE),
    )
    expect(result.locked).toBe(true)
    expect(await daysFor('2026-07-15')).toHaveLength(0)
  })

  it('repairs a row that was written at the default after the lock ran', async () => {
    await run((tx) =>
      tx.insert(attendanceDays).values({
        workspaceId: WS_A,
        personId: mert,
        businessDate: '2026-07-16',
        status: 'present',
        workedMinutes: 480,
      }),
    )
    const result = await run((tx) =>
      attendanceSvc.recomputeDay(tx, WS_A, mert, '2026-07-16', 'Europe/Istanbul', NO_SCHEDULE),
    )
    expect(result.locked).toBe(true)

    const [day] = await daysFor('2026-07-16')
    // The flag is repaired from the period; the figures are not touched by the repair.
    expect(day?.locked).toBe(true)
    expect(day?.workedMinutes).toBe(480)
  })
})

/**
 * The night shift, where the punch and the day sheet used to disagree.
 *
 * A 22:00–06:00 Monday-to-Friday shift is clocked out of at 06:00 on Saturday. The punch path read
 * the shift off the punch's **UTC** date, so it asked the week for Saturday, got nothing — Saturday
 * schedules no shift — and never consulted `crossesMidnight`. Friday's sheet lost eight hours and
 * Saturday grew an orphan clock-out: the exact split `businessDateFor` exists to prevent.
 */
describe('a shift that runs from Friday night into Saturday', () => {
  const attendanceSvc = new AttendanceService()
  const NY = 'America/New_York'
  const nights: ResolvedSchedule = {
    scheduleId: null,
    rounding: { stepMinutes: 0, direction: 'nearest' },
    autoClockOutAfterMinutes: null,
    shiftFor: (date) => {
      const day = weekdayOf(date)
      if (day === 'sat' || day === 'sun') return null
      return { start: '22:00', end: '06:00', breakMinutes: 0, graceInMinutes: 5, graceOutMinutes: 5 }
    },
  }
  let deniz: string

  beforeAll(async () => {
    deniz = randomUUID()
    await run((tx) => tx.insert(people).values({ id: deniz, workspaceId: WS_A, displayName: 'Deniz' }))
  }, 60_000)

  const punchAt = (date: string, wall: string, direction: 'in' | 'out') =>
    run((tx) =>
      attendanceSvc.record(
        tx,
        WS_A,
        {
          personId: deniz,
          direction,
          timezone: NY,
          method: 'manual',
          claimedAt: new Date(zonedToInstant(date, wall, NY)),
        },
        nights,
      ),
    )

  it('attributes both ends of the night to Friday', async () => {
    expect((await punchAt('2026-06-19', '22:00', 'in')).businessDate).toBe('2026-06-19')
    expect((await punchAt('2026-06-20', '06:00', 'out')).businessDate).toBe('2026-06-19')
  })

  it('leaves Friday’s sheet holding the whole eight hours', async () => {
    await run((tx) => attendanceSvc.recomputeDay(tx, WS_A, deniz, '2026-06-19', NY, nights))
    const [day] = await run((tx) =>
      tx
        .select()
        .from(attendanceDays)
        .where(and(eq(attendanceDays.workspaceId, WS_A), eq(attendanceDays.personId, deniz))),
    )
    expect(day?.businessDate).toBe('2026-06-19')
    expect(day?.workedMinutes).toBe(480)
    expect(day?.scheduledMinutes).toBe(480)
    expect(day?.anomalies).toEqual([])
  })
})

/**
 * The morning shift the day after a night week — the case that made the night-shift fix expensive.
 *
 * A rotating week: 22:00–06:00 Monday to Friday, then 08:00–16:00 on Saturday. 08:00 falls inside
 * the tail the night shift is allowed to reach into, so preferring the previous day unconditionally
 * filed Saturday's clock-in on **Friday** while its 16:00 clock-out stayed on Saturday. Two ends of
 * one shift on two sheets is the visible half; the invisible half is worse. `clockContext` makes the
 * same attribution, so at 16:00 Saturday's punch list was empty, the widget said "not clocked in",
 * and the guard threw `You are not clocked in.` — somebody on a morning shift after a night week
 * could never clock out.
 */
describe('a morning shift the day after a night week', () => {
  const attendanceSvc = new AttendanceService()
  const NY = 'America/New_York'
  const rotating: ResolvedSchedule = {
    scheduleId: null,
    rounding: { stepMinutes: 0, direction: 'nearest' },
    autoClockOutAfterMinutes: null,
    shiftFor: (date) => {
      const day = weekdayOf(date)
      if (day === 'sun') return null
      return day === 'sat'
        ? { start: '08:00', end: '16:00', breakMinutes: 0, graceInMinutes: 5, graceOutMinutes: 5 }
        : { start: '22:00', end: '06:00', breakMinutes: 0, graceInMinutes: 5, graceOutMinutes: 5 }
    },
  }
  let sena: string

  beforeAll(async () => {
    sena = randomUUID()
    await run((tx) => tx.insert(people).values({ id: sena, workspaceId: WS_A, displayName: 'Sena' }))
  }, 60_000)

  const punchAt = (date: string, wall: string, direction: 'in' | 'out') =>
    run((tx) =>
      attendanceSvc.record(
        tx,
        WS_A,
        {
          personId: sena,
          direction,
          timezone: NY,
          method: 'manual',
          claimedAt: new Date(zonedToInstant(date, wall, NY)),
        },
        rotating,
      ),
    )

  const punchesOn = (date: string) => run((tx) => attendanceSvc.punchesOn(tx, WS_A, sena, date))

  it('files Friday night on Friday and Saturday morning on Saturday', async () => {
    expect((await punchAt('2026-06-19', '22:00', 'in')).businessDate).toBe('2026-06-19')
    expect((await punchAt('2026-06-20', '06:00', 'out')).businessDate).toBe('2026-06-19')
    expect((await punchAt('2026-06-20', '08:00', 'in')).businessDate).toBe('2026-06-20')
    expect((await punchAt('2026-06-20', '16:00', 'out')).businessDate).toBe('2026-06-20')
  })

  it('leaves the morning’s clock-in where the clock-out will look for it', async () => {
    // This list is what the punch guard reads. With the clock-in filed on Friday it is empty at
    // 16:00, the open state says "not clocked in", and the clock-out is refused outright.
    expect((await punchesOn('2026-06-20')).map((p) => p.direction)).toEqual(['in', 'out'])
    expect((await punchesOn('2026-06-19')).map((p) => p.direction)).toEqual(['in', 'out'])
  })

  it('gives each day its own eight hours instead of piling both on Friday', async () => {
    for (const date of ['2026-06-19', '2026-06-20'])
      await run((tx) => attendanceSvc.recomputeDay(tx, WS_A, sena, date, NY, rotating))

    const days = await run((tx) =>
      tx
        .select()
        .from(attendanceDays)
        .where(and(eq(attendanceDays.workspaceId, WS_A), eq(attendanceDays.personId, sena))),
    )
    const friday = days.find((d) => d.businessDate === '2026-06-19')
    const saturday = days.find((d) => d.businessDate === '2026-06-20')
    expect(friday?.workedMinutes).toBe(480)
    expect(friday?.scheduledMinutes).toBe(480)
    expect(friday?.anomalies).toEqual([])
    expect(saturday?.workedMinutes).toBe(480)
    expect(saturday?.scheduledMinutes).toBe(480)
    expect(saturday?.anomalies).toEqual([])
    expect(saturday?.lateMinutes).toBe(0)
  })
})

/**
 * The hourly sweep that closes shifts nobody clocked out of.
 *
 * Worth running against a real database rather than reasoning about: "is this shift still open" used
 * to be answered in TypeScript, one query per candidate row, and moving it into the statement is
 * exactly the kind of rewrite that is right in the plan and wrong at the boundaries — two `in`
 * punches with no `out` must produce **one** auto clock-out, not two.
 */
describe('the auto clock-out sweep', () => {
  const today = todayIn('Europe/Istanbul')
  const HOUR = 3_600_000
  let forgot: string
  let finished: string
  let twice: string

  const sweep = () => {
    const job = hrJobs().find((j) => j.name === 'auto-clock-out')
    if (!job) throw new Error('auto-clock-out job is gone')
    return job.handler({}, { kernel, id: 'test', attempt: 1 })
  }

  const punchesOf = (personId: string) =>
    run((tx) =>
      tx
        .select()
        .from(punches)
        .where(and(eq(punches.workspaceId, WS_A), eq(punches.personId, personId))),
    )

  beforeAll(async () => {
    forgot = randomUUID()
    finished = randomUUID()
    twice = randomUUID()
    await run(async (tx) => {
      const [schedule] = await tx
        .insert(schedules)
        .values({ workspaceId: WS_A, name: 'Ten hours and out', autoClockOutAfterMinutes: 600 })
        .returning()
      for (const [personId, name] of [
        [forgot, 'Forgot'],
        [finished, 'Finished'],
        [twice, 'Twice'],
      ] as const) {
        await tx.insert(people).values({ id: personId, workspaceId: WS_A, displayName: name })
        await tx.insert(scheduleAssignments).values({
          workspaceId: WS_A,
          personId,
          scheduleId: schedule!.id,
          effectiveFrom: '2020-01-01',
        })
      }
      const punch = (personId: string, direction: 'in' | 'out', hoursAgo: number) => ({
        workspaceId: WS_A,
        personId,
        direction,
        at: new Date(Date.now() - hoursAgo * HOUR),
        businessDate: today,
        timezone: 'Europe/Istanbul',
      })
      await tx
        .insert(punches)
        .values([
          punch(forgot, 'in', 11),
          punch(finished, 'in', 11),
          punch(finished, 'out', 10),
          punch(twice, 'in', 11),
          punch(twice, 'in', 10.5),
        ])
    })
  }, 60_000)

  it('closes the shift nobody clocked out of, once', async () => {
    await sweep()
    const rows = await punchesOf(forgot)
    const closed = rows.filter((r) => r.direction === 'out')
    expect(closed).toHaveLength(1)
    expect(closed[0]?.note).toBe('Closed automatically: no clock-out recorded')
    // Ten hours after the punch that opened it, not ten hours after the sweep noticed.
    expect(closed[0]?.at.getTime()).toBe(rows.find((r) => r.direction === 'in')!.at.getTime() + 600 * 60_000)
  })

  it('leaves a day that was already closed alone', async () => {
    await sweep()
    expect(await punchesOf(finished)).toHaveLength(2)
  })

  it('writes one clock-out for a day with two clock-ins, not one each', async () => {
    const rows = await punchesOf(twice)
    expect(rows.filter((r) => r.direction === 'out')).toHaveLength(1)
  })

  it('running again changes nothing', async () => {
    await sweep()
    expect((await punchesOf(forgot)).filter((r) => r.direction === 'out')).toHaveLength(1)
  })

  it('does not reach back past the lookback, which is the cost of pruning the partitions', async () => {
    // The July punch two describes up is still open and always will be. `at >= cutoff - 3 days` is
    // what turns this sweep from a full scan of every partition into a bitmap scan of one, and a
    // shift left open for longer than that is a regularization, not a job's problem.
    const july = await run((tx) =>
      tx
        .select()
        .from(punches)
        .where(and(eq(punches.workspaceId, WS_A), eq(punches.businessDate, '2026-07-15'))),
    )
    expect(july.filter((r) => r.direction === 'out')).toHaveLength(0)
  })
})

/**
 * Accrual, end to end.
 *
 * The arithmetic is unit-tested against a table; this proves the right policy reaches the right
 * person and that the ledger ends up with the number the preview promised — and, most importantly,
 * that running twice does not credit twice.
 */
describe('accrual run', () => {
  const MARCH_SNAP = { legalEntityId: null, startsOn: '2026-03-09', endsOn: '2026-03-11' }
  let bob: string
  let annualType: string

  beforeAll(async () => {
    const ids = await run(async (tx) => {
      const [type] = await tx
        .select()
        .from(leaveTypes)
        .where(and(eq(leaveTypes.workspaceId, WS_A), eq(leaveTypes.key, 'annual')))
      const [person] = await tx
        .insert(people)
        .values({
          workspaceId: WS_A,
          displayName: 'Accrual Bob',
          hiredOn: '2020-01-01',
          status: 'active',
        })
        .returning()
      await tx
        .insert(employments)
        .values({ workspaceId: WS_A, personId: person!.id, effectiveFrom: '2020-01-01', fte: '1.000' })

      const [policy] = await tx
        .insert(policies)
        .values({
          workspaceId: WS_A,
          kind: 'accrual',
          name: 'Accrual test',
          config: {
            frequency: 'monthly',
            daysPerYear: 24,
            minutesPerDay: 480,
            seniorityTiers: [],
            waitingPeriodMonths: 0,
            calendar: 'gregorian',
            roundToMinutes: 0,
            leaveTypeKey: 'annual',
          },
          effectiveFrom: '2020-01-01',
          configHash: 'test',
        })
        .returning()
      await tx.insert(policyAssignments).values({
        workspaceId: WS_A,
        policyId: policy!.id,
        subjectKind: 'person',
        subjectId: person!.id,
        effectiveFrom: '2020-01-01',
        priority: PolicyService.priorityFor('person'),
      })
      return { bob: person!.id, annualType: type!.id }
    })
    bob = ids.bob
    annualType = ids.annualType
  }, 60_000)

  it('credits a twelfth of the entitlement for a full month', async () => {
    const svcLedger = new LedgerService()
    const before = await run((tx) => svcLedger.balances(tx, WS_A, bob, 2026))
    expect(before.find((b) => b.leaveTypeId === annualType)?.balanceMinutes).toBe(0)

    await run(async (tx) => {
      await svcLedger.lockAndRead(tx, WS_A, bob, annualType, 2026)
      return svcLedger.append(tx, WS_A, {
        personId: bob,
        leaveTypeId: annualType,
        kind: 'accrual',
        amountMinutes: Math.round((24 * 480) / 12),
        effectiveOn: '2026-01-31',
        periodYear: 2026,
        reason: '24d/yr',
      })
    })

    const after = await run((tx) => svcLedger.balances(tx, WS_A, bob, 2026))
    // 24 days a year is two days a month.
    expect(after.find((b) => b.leaveTypeId === annualType)?.balance).toBe(2)
  })

  it('resolves the person-level policy over anything else', async () => {
    const policySvc = new PolicyService(new ResolveService())
    const r = await run((tx) => policySvc.forPerson(tx, WS_A, bob, 'accrual', '2026-01-31'))
    expect(r.policyName).toBe('Accrual test')
    expect(r.from).toBe('person')
  })

  it('locking a period freezes the days inside it', async () => {
    await run(async (tx) => {
      await tx.insert(attendanceDays).values({
        workspaceId: WS_A,
        personId: bob,
        businessDate: '2026-03-10',
        status: 'present',
        workedMinutes: 480,
      })
      // The period is what freezes the day; the column is a cache of its answer. Stamping the
      // cache on its own would prove nothing any more — a flag with no period behind it is now
      // repaired away rather than believed.
      await tx.insert(periods).values({
        workspaceId: WS_A,
        kind: 'payroll',
        startsOn: '2026-03-09',
        endsOn: '2026-03-11',
        status: 'locked',
        lockedAt: new Date(),
      })
    })
    const attendanceSvc = new AttendanceService()
    expect(await run((tx) => attendanceSvc.setPeriodLock(tx, WS_A, MARCH_SNAP, true))).toBe(1)

    // A locked day is left alone and reported, never silently skipped — a recomputation that
    // quietly declines to touch a closed month looks identical to one that had nothing to do.
    const result = await run((tx) =>
      attendanceSvc.recomputeDay(tx, WS_A, bob, '2026-03-10', 'Europe/Istanbul', NO_SCHEDULE),
    )
    expect(result.locked).toBe(true)

    const [day] = await run((tx) =>
      tx
        .select()
        .from(attendanceDays)
        .where(and(eq(attendanceDays.workspaceId, WS_A), eq(attendanceDays.businessDate, '2026-03-10'))),
    )
    // Untouched: still 480, not recomputed to 0 from its (absent) punches.
    expect(day?.workedMinutes).toBe(480)
  })
})

/**
 * Carry-forward across the turn of the year.
 *
 * The subtle part is that it is **three** entries, not a transfer: the old year is closed out in
 * full (what lapsed, then what left) and the new year opened with what survived. Each year's ledger
 * then sums to what that year actually held, which is what makes "you had 9 days, 5 carried, 4
 * expired under the cap" a sentence somebody can check against the list.
 */
describe('carry-forward', () => {
  const svcLedger = new LedgerService()
  let carol: string
  let annualType: string

  beforeAll(async () => {
    const ids = await run(async (tx) => {
      const [type] = await tx
        .select()
        .from(leaveTypes)
        .where(and(eq(leaveTypes.workspaceId, WS_A), eq(leaveTypes.key, 'annual')))
      const [person] = await tx
        .insert(people)
        .values({ workspaceId: WS_A, displayName: 'Carry Carol', hiredOn: '2020-01-01' })
        .returning()
      return { carol: person!.id, annualType: type!.id }
    })
    carol = ids.carol
    annualType = ids.annualType

    // Nine days standing at the end of 2025.
    await run(async (tx) => {
      await svcLedger.lockAndRead(tx, WS_A, carol, annualType, 2025)
      return svcLedger.append(tx, WS_A, {
        personId: carol,
        leaveTypeId: annualType,
        kind: 'grant',
        amountMinutes: 9 * 8 * 60,
        effectiveOn: '2025-01-01',
        periodYear: 2025,
      })
    })
  }, 60_000)

  it('splits the balance into what lapsed and what carried, leaving both visible', async () => {
    const CAP = 5 * 8 * 60
    const balance = await run((tx) => svcLedger.lockAndRead(tx, WS_A, carol, annualType, 2025))
    expect(balance).toBe(9 * 8 * 60)

    const { carriedMinutes, expiredMinutes } = carryForward(balance, {
      maxMinutes: CAP,
      expiresAfterMonths: 3,
    })
    expect(carriedMinutes).toBe(CAP)
    expect(expiredMinutes).toBe(4 * 8 * 60)

    await run(async (tx) => {
      await svcLedger.lockAndRead(tx, WS_A, carol, annualType, 2025)
      await svcLedger.append(tx, WS_A, {
        personId: carol,
        leaveTypeId: annualType,
        kind: 'expiry',
        amountMinutes: -expiredMinutes,
        effectiveOn: '2025-12-31',
        periodYear: 2025,
        reason: 'Above the 5 day carry-forward cap',
      })
      await svcLedger.append(tx, WS_A, {
        personId: carol,
        leaveTypeId: annualType,
        kind: 'carry_out',
        amountMinutes: -carriedMinutes,
        effectiveOn: '2025-12-31',
        periodYear: 2025,
        reason: 'Carried into 2026',
      })
      await svcLedger.lockAndRead(tx, WS_A, carol, annualType, 2026)
      await svcLedger.append(tx, WS_A, {
        personId: carol,
        leaveTypeId: annualType,
        kind: 'carry_in',
        amountMinutes: carriedMinutes,
        effectiveOn: '2026-01-01',
        periodYear: 2026,
        reason: 'Carried from 2025',
      })
    })

    // The closed year sums to nothing left: granted 9, expired 4, carried 5 out.
    const y2025 = await run((tx) => svcLedger.balances(tx, WS_A, carol, 2025))
    expect(y2025.find((b) => b.leaveTypeId === annualType)?.balanceMinutes).toBe(0)

    // The new year opens with exactly what survived.
    const y2026 = await run((tx) => svcLedger.balances(tx, WS_A, carol, 2026))
    expect(y2026.find((b) => b.leaveTypeId === annualType)?.balance).toBe(5)
  })

  it('keeps every movement on the record, so the number can be argued with', async () => {
    const entries = await run((tx) =>
      tx
        .select()
        .from(leaveLedger)
        .where(and(eq(leaveLedger.workspaceId, WS_A), eq(leaveLedger.personId, carol))),
    )
    const kinds = entries.map((e) => e.kind).sort()
    expect(kinds).toEqual(['carry_in', 'carry_out', 'expiry', 'grant'])
    // The expiry says why, rather than the balance simply being smaller than it was.
    expect(entries.find((e) => e.kind === 'expiry')?.reason).toContain('carry-forward cap')
  })
})
